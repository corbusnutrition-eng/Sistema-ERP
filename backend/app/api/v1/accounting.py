from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.account_constants import is_liquid_deposit_account
from app.api.v1.dependencies import require_permission
from app.database import get_db
from app.ledger_verification import LEDGER_VERIFICATION_CONFIRMED, normalize_ledger_verification_status
from app.timezone_utils import now_utc
from app.models.account import Account
from app.models.expense import Expense
from app.models.journal_entry import JournalEntryLine
from app.models.sale import Sale
from app.permissions import ACCOUNTING_CHART_VIEW, ACCOUNTING_RECONCILE_EDIT
from app.schemas.chart_accounts import LedgerVerificationResponse, LedgerVerificationUpdate

router = APIRouter(prefix="/accounting", tags=["accounting"])

DbDep = Annotated[Session, Depends(get_db)]
AccountingChartViewDep = Annotated[dict, Depends(require_permission(ACCOUNTING_CHART_VIEW))]
ReconcileEditDep = Annotated[dict, Depends(require_permission(ACCOUNTING_RECONCILE_EDIT))]


class BalanceResponse(BaseModel):
    total_income: Decimal
    total_expenses: Decimal
    net_profit: Decimal


@router.get("/balance/", response_model=BalanceResponse)
def get_balance(db: DbDep, _: AccountingChartViewDep) -> BalanceResponse:
    total_income: Decimal = db.query(func.coalesce(func.sum(Sale.amount), 0)).scalar()
    total_expenses: Decimal = (
        db.query(func.coalesce(func.sum(Expense.total_amount), 0))
        .filter(Expense.status == "posted")
        .scalar()
    )
    return BalanceResponse(
        total_income=total_income,
        total_expenses=total_expenses,
        net_profit=total_income - total_expenses,
    )


@router.patch("/ledger/{line_id}/verify", response_model=LedgerVerificationResponse)
def patch_ledger_line_verification(
    line_id: int,
    body: LedgerVerificationUpdate,
    db: DbDep,
    _: ReconcileEditDep,
) -> LedgerVerificationResponse:
    """Actualiza el estado de verificación bancaria de una línea del libro mayor."""
    line = (
        db.query(JournalEntryLine)
        .options(joinedload(JournalEntryLine.account))
        .filter(JournalEntryLine.id == int(line_id))
        .first()
    )
    if line is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Línea contable no encontrada.")

    acc: Account | None = line.account
    if acc is None:
        acc = db.get(Account, int(line.account_id))
    if acc is None or not is_liquid_deposit_account(acc):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="La verificación bancaria solo aplica a cuentas de Efectivo y equivalentes.",
        )

    try:
        normalized = normalize_ledger_verification_status(body.verification_status)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    line.verification_status = normalized
    if normalized == LEDGER_VERIFICATION_CONFIRMED:
        line.verified_at = now_utc()
    else:
        line.verified_at = None
    db.add(line)
    db.commit()
    db.refresh(line)

    return LedgerVerificationResponse(
        line_id=int(line.id),
        verification_status=_verification_status_out(line),
        verified_at=getattr(line, "verified_at", None),
    )


def _verification_status_out(line: JournalEntryLine) -> Optional[str]:
    raw = getattr(line, "verification_status", None)
    if raw is None:
        return None
    s = str(raw).strip()
    return s if s else None
