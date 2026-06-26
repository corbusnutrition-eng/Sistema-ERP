"""API — Aprobaciones bancarias (conciliación en dos pasos)."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import ValidationError
from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, joinedload

from app.account_constants import is_liquid_deposit_account
from app.api.v1.dependencies import require_permission
from app.database import get_db
from app.models.account import Account
from app.models.client import Client
from app.models.client_payment import ClientPayment, ClientPaymentStatus, PaymentAllocation
from app.models.journal_entry import JournalEntry, JournalEntryLine, JournalReferenceType
from app.models.sale import Sale
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.permissions import APPROVALS_BANK_VERIFY, APPROVALS_BANK_VIEW
from app.schemas.approvals import ApprovalAccountRow, ApprovalPendingRow, ApprovalVerifyResponse
from app.services.approvals_helpers import (
    is_missing_bank_verified_column_error,
    journal_line_bank_verified_column_exists,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/approvals", tags=["approvals"])

DbDep = Annotated[Session, Depends(get_db)]
ApprovalsViewDep = Annotated[dict, Depends(require_permission(APPROVALS_BANK_VIEW))]
ApprovalsVerifyDep = Annotated[dict, Depends(require_permission(APPROVALS_BANK_VERIFY))]

_EPS = Decimal("0.0001")

_MIGRATION_HINT = (
    "Falta la columna is_bank_verified en journal_entry_lines. "
    "Ejecuta: alembic upgrade head "
    "o python scripts/apply_journal_line_bank_verified_pg.py"
)


def _ensure_bank_verified_schema(db: Session) -> None:
    if journal_line_bank_verified_column_exists(db):
        return
    raise HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=_MIGRATION_HINT,
    )


def _format_sale_ref(sale_id: int) -> str:
    return f"Venta #{int(sale_id):04d}"


def _format_recharge_ref(req_id: int) -> str:
    return f"Recarga #{int(req_id)}"


def _resolve_origin(db: Session, payment: ClientPayment) -> tuple[str, str, Optional[int]]:
    """Devuelve (origin_type, origin_label, origin_id)."""
    allocs = (
        db.query(PaymentAllocation)
        .filter(PaymentAllocation.payment_id == int(payment.id))
        .order_by(PaymentAllocation.id.asc())
        .all()
    )
    for alloc in allocs:
        if alloc.sale_id is not None:
            return "venta", _format_sale_ref(int(alloc.sale_id)), int(alloc.sale_id)
        if alloc.wallet_recharge_id is not None:
            rid = int(alloc.wallet_recharge_id)
            return "recarga", _format_recharge_ref(rid), rid
    pn = (payment.payment_number or f"PAG-{payment.id}").strip()
    return "pago", pn, int(payment.id)


def _receipt_for_payment(db: Session, payment: ClientPayment, origin_type: str, origin_id: Optional[int]) -> Optional[str]:
    url = (payment.receipt_file_url or "").strip()
    if url:
        return url
    if origin_type == "venta" and origin_id is not None:
        sale = db.get(Sale, int(origin_id))
        if sale and sale.receipt_url:
            return str(sale.receipt_url).strip() or None
    if origin_type == "recarga" and origin_id is not None:
        req = db.get(WalletRechargeRequest, int(origin_id))
        if req:
            for attr in ("receipt_url", "admin_precheck_receipt_url"):
                raw = getattr(req, attr, None)
                if raw and str(raw).strip():
                    return str(raw).strip()
    return None


def _pending_lines_filter(db: Session, account_id: int):
    """Filtro base (sin ORDER BY ni joinedload) — apto para COUNT."""
    return (
        db.query(JournalEntryLine)
        .join(JournalEntry, JournalEntryLine.journal_entry_id == JournalEntry.id)
        .filter(
            JournalEntryLine.account_id == int(account_id),
            JournalEntryLine.debit > _EPS,
            JournalEntryLine.is_bank_verified.is_(False),
            JournalEntry.reference_type == JournalReferenceType.client_payment.value,
            JournalEntry.reference_id.isnot(None),
        )
    )


def _pending_lines_query(db: Session, account_id: int):
    """Listado de líneas pendientes (con eager load y orden)."""
    return (
        _pending_lines_filter(db, account_id)
        .options(joinedload(JournalEntryLine.journal_entry))
        .order_by(JournalEntry.date.desc(), JournalEntryLine.id.desc())
    )


def _count_pending_for_account(db: Session, account_id: int) -> int:
    if not journal_line_bank_verified_column_exists(db):
        return 0
    try:
        return int(
            _pending_lines_filter(db, account_id)
            .with_entities(func.count(JournalEntryLine.id))
            .scalar()
            or 0
        )
    except SQLAlchemyError as exc:
        if is_missing_bank_verified_column_error(exc):
            return 0
        raise


def _account_to_approval_row(db: Session, acc: Account) -> ApprovalAccountRow:
    code_raw = acc.code or acc.account_number
    code = str(code_raw).strip() if code_raw is not None else None
    return ApprovalAccountRow(
        id=int(acc.id),
        code=code or None,
        name=str(acc.name or "").strip() or f"Cuenta {acc.id}",
        currency=str(acc.currency or "USD").upper(),
        detail_type=acc.detail_type,
        linked_payment_method=getattr(acc, "linked_payment_method", None),
        pending_count=_count_pending_for_account(db, int(acc.id)),
    )


def _row_from_line(db: Session, line: JournalEntryLine) -> Optional[ApprovalPendingRow]:
    entry = line.journal_entry
    if entry is None or entry.reference_id is None:
        return None
    payment = db.get(ClientPayment, int(entry.reference_id))
    if payment is None or payment.status != ClientPaymentStatus.approved:
        return None

    origin_type, origin_label, origin_id = _resolve_origin(db, payment)
    client_name: Optional[str] = None
    if payment.client_id is not None:
        client = db.get(Client, int(payment.client_id))
        if client is not None:
            client_name = getattr(client, "display_name", None) or (client.name or client.email or "").strip() or None

    ref = (payment.payment_number or payment.reference_number or f"PAG-{payment.id}").strip()
    receipt_url = _receipt_for_payment(db, payment, origin_type, origin_id)

    return ApprovalPendingRow(
        transaction_id=int(line.id),
        journal_entry_id=int(entry.id),
        date=entry.date,
        reference=ref,
        origin_type=origin_type,
        origin_label=origin_label,
        origin_id=origin_id,
        client_name=client_name,
        amount=Decimal(str(line.debit)),
        currency=str(payment.currency or "USD").upper(),
        receipt_url=receipt_url,
        description=entry.description,
        payment_id=int(payment.id),
        created_at=payment.approved_at or payment.created_at,
    )


@router.get("/accounts", response_model=list[ApprovalAccountRow])
def list_approval_accounts(db: DbDep, _: ApprovalsViewDep) -> list[ApprovalAccountRow]:
    """Cuentas activas de Efectivo y equivalentes (activos líquidos)."""
    try:
        rows = (
            db.query(Account)
            .filter(Account.is_active.is_(True))
            .order_by(Account.name.asc(), Account.id.asc())
            .all()
        )
        out: list[ApprovalAccountRow] = []
        for acc in rows:
            if not is_liquid_deposit_account(acc):
                continue
            out.append(_account_to_approval_row(db, acc))
        return out
    except HTTPException:
        raise
    except ValidationError as exc:
        logger.exception("Validación Pydantic en GET /approvals/accounts")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al serializar cuentas de aprobaciones.",
        ) from exc
    except SQLAlchemyError as exc:
        logger.exception("SQLAlchemy en GET /approvals/accounts")
        if is_missing_bank_verified_column_error(exc):
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=_MIGRATION_HINT) from exc
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="No se pudieron cargar las cuentas de aprobaciones.",
        ) from exc
    except Exception as exc:
        logger.exception("Error inesperado en GET /approvals/accounts")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="No se pudieron cargar las cuentas de aprobaciones.",
        ) from exc


@router.get("/pending/{account_id}", response_model=list[ApprovalPendingRow])
def list_pending_for_account(
    account_id: int,
    db: DbDep,
    _: ApprovalsViewDep,
) -> list[ApprovalPendingRow]:
    """Ingresos en la cuenta bancaria aún no verificados por el titular."""
    _ensure_bank_verified_schema(db)
    try:
        acc = db.get(Account, int(account_id))
        if acc is None or not acc.is_active:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta no encontrada.")
        if not is_liquid_deposit_account(acc):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="La cuenta no es de Efectivo y equivalentes.",
            )

        lines = _pending_lines_query(db, int(account_id)).all()
        result: list[ApprovalPendingRow] = []
        for line in lines:
            row = _row_from_line(db, line)
            if row is not None:
                result.append(row)
        return result
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        if is_missing_bank_verified_column_error(exc):
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=_MIGRATION_HINT) from exc
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="No se pudieron cargar los ingresos pendientes.",
        ) from exc


@router.post("/{transaction_id}/verify", response_model=ApprovalVerifyResponse)
def verify_bank_transaction(
    transaction_id: int,
    db: DbDep,
    _: ApprovalsVerifyDep,
) -> ApprovalVerifyResponse:
    """Marca un ingreso bancario como confirmado en el extracto."""
    _ensure_bank_verified_schema(db)
    try:
        line = (
            db.query(JournalEntryLine)
            .options(joinedload(JournalEntryLine.journal_entry), joinedload(JournalEntryLine.account))
            .filter(JournalEntryLine.id == int(transaction_id))
            .first()
        )
        if line is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transacción no encontrada.")

        if line.is_bank_verified:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Esta transacción ya fue verificada.")

        acc = line.account
        if acc is None or not is_liquid_deposit_account(acc):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Solo se pueden verificar ingresos en cuentas de Efectivo y equivalentes.",
            )

        if Decimal(str(line.debit or 0)) <= _EPS:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Solo se verifican líneas de débito (ingresos).",
            )

        entry = line.journal_entry
        if entry is None or entry.reference_type != JournalReferenceType.client_payment.value:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Solo cobros de clientes pueden verificarse en este módulo.",
            )

        line.is_bank_verified = True
        db.add(line)
        db.commit()

        now = datetime.now(timezone.utc)
        return ApprovalVerifyResponse(
            transaction_id=int(line.id),
            is_bank_verified=True,
            verified_at=now,
        )
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        if is_missing_bank_verified_column_error(exc):
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=_MIGRATION_HINT) from exc
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="No se pudo verificar el ingreso.",
        ) from exc
