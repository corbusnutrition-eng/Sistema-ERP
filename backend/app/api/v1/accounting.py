from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.account_constants import is_liquid_deposit_account
from app.api.v1.accounts import _build_account_reconciliation
from app.api.v1.dependencies import require_permission
from app.database import get_db
from app.ledger_verification import LEDGER_VERIFICATION_CONFIRMED, normalize_ledger_verification_status
from app.services.inventory_reconciliation_service import run_inventory_reconciliation_audit
from app.timezone_utils import now_utc
from app.models.account import Account
from app.models.expense import Expense
from app.models.journal_entry import JournalEntryLine
from app.models.sale import Sale
from app.permissions import (
    ACCOUNTING_CHART_VIEW,
    ACCOUNTING_RECONCILE_CREATE,
    ACCOUNTING_RECONCILE_DELETE,
    ACCOUNTING_RECONCILE_EDIT,
    ACCOUNTING_RECONCILE_VIEW,
)
from app.schemas.chart_accounts import (
    AccountReconciliationResponse,
    InventoryAuditBulkDeleteRequest,
    InventoryAuditBulkDeleteResponse,
    InventoryAuditReportCreate,
    InventoryAuditReportResponse,
    InventoryReconciliationAuditResponse,
    LedgerVerificationResponse,
    LedgerVerificationUpdate,
)
from app.models.inventory_audit_report import InventoryAuditReport

router = APIRouter(prefix="/accounting", tags=["accounting"])

DbDep = Annotated[Session, Depends(get_db)]
AccountingChartViewDep = Annotated[dict, Depends(require_permission(ACCOUNTING_CHART_VIEW))]
ReconcileViewDep = Annotated[dict, Depends(require_permission(ACCOUNTING_RECONCILE_VIEW))]
ReconcileEditDep = Annotated[dict, Depends(require_permission(ACCOUNTING_RECONCILE_EDIT))]
ReconcileDeleteDep = Annotated[dict, Depends(require_permission(ACCOUNTING_RECONCILE_DELETE))]


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


@router.get(
    "/accounts/{account_id}/reconciliation",
    response_model=AccountReconciliationResponse,
)
def get_account_reconciliation(
    account_id: int,
    db: DbDep,
    _: ReconcileViewDep,
    start_date: date = Query(..., description="Fecha inicio (YYYY-MM-DD, inclusive)."),
    end_date: date = Query(..., description="Fecha fin (YYYY-MM-DD, inclusive)."),
) -> AccountReconciliationResponse:
    """Reporte de cuadre bancario por rango de fechas (fecha del asiento contable)."""
    if start_date > end_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La fecha inicio debe ser anterior o igual a la fecha fin.",
        )
    acc = db.get(Account, account_id)
    if acc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta no encontrada.")
    if not is_liquid_deposit_account(acc):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="La conciliación bancaria solo aplica a cuentas de Efectivo y equivalentes.",
        )
    return _build_account_reconciliation(db, account_id, start_date=start_date, end_date=end_date)


@router.post(
    "/accounts/{account_id}/inventory-reconciliation",
    response_model=InventoryReconciliationAuditResponse,
)
async def post_inventory_reconciliation(
    account_id: int,
    db: DbDep,
    _: ReconcileViewDep,
    start_date: date = Form(..., description="Fecha inicio (YYYY-MM-DD)."),
    end_date: date = Form(..., description="Fecha fin (YYYY-MM-DD)."),
    service_name: str = Form(..., description="Servicio IPTV (ej. FLUJO TV, STELLA TV)."),
    files: list[UploadFile] = File(..., description="Capturas de la tabla de consumos del proveedor."),
) -> InventoryReconciliationAuditResponse:
    """Auditoría de inventario: extrae consumos de imágenes (OpenAI Vision) y cruza con el ERP."""
    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Sube al menos una imagen.",
        )

    images: list[tuple[bytes, str]] = []
    for upload in files:
        image_bytes = await upload.read()
        media_type = upload.content_type or "image/png"
        images.append((image_bytes, media_type))

    return await run_inventory_reconciliation_audit(
        db,
        account_id,
        start_date=start_date,
        end_date=end_date,
        service_name=service_name,
        images=images,
    )


@router.post(
    "/inventory-audits",
    response_model=InventoryAuditReportResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_inventory_audit_report(
    body: InventoryAuditReportCreate,
    db: DbDep,
    _: Annotated[dict, Depends(require_permission(ACCOUNTING_RECONCILE_CREATE))],
) -> InventoryAuditReportResponse:
    """Persiste el resultado de una auditoría de inventario (IA vs ERP)."""
    if body.start_date > body.end_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La fecha inicio debe ser anterior o igual a la fecha fin.",
        )
    acc = db.get(Account, body.account_id)
    if acc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta no encontrada.")

    svc = (body.service_name or "").strip()
    if not svc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Indica el servicio.")

    row = InventoryAuditReport(
        account_id=body.account_id,
        service_name=svc,
        start_date=body.start_date,
        end_date=body.end_date,
        matched_data=[r.model_dump() for r in body.matched_data],
        missing_erp_data=[r.model_dump() for r in body.missing_erp_data],
        missing_platform_data=[r.model_dump() for r in body.missing_platform_data],
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _inventory_audit_report_to_schema(row, acc.name)


@router.get(
    "/inventory-audits",
    response_model=list[InventoryAuditReportResponse],
)
def list_inventory_audit_reports(
    db: DbDep,
    _: ReconcileViewDep,
    account_id: Optional[int] = Query(None, description="Filtrar por cuenta contable."),
    date_from: Optional[date] = Query(None, description="Filtro inclusive sobre created_at (fecha)."),
    date_to: Optional[date] = Query(None, description="Filtro inclusive sobre created_at (fecha)."),
) -> list[InventoryAuditReportResponse]:
    """Lista reportes de auditoría de inventario guardados."""
    if date_from is not None and date_to is not None and date_from > date_to:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="date_from debe ser anterior o igual a date_to.",
        )

    q = db.query(InventoryAuditReport).options(joinedload(InventoryAuditReport.account))
    if account_id is not None:
        q = q.filter(InventoryAuditReport.account_id == account_id)
    if date_from is not None:
        q = q.filter(func.date(InventoryAuditReport.created_at) >= date_from)
    if date_to is not None:
        q = q.filter(func.date(InventoryAuditReport.created_at) <= date_to)

    rows = q.order_by(InventoryAuditReport.created_at.desc()).all()
    return [_inventory_audit_report_to_schema(r, r.account.name if r.account else None) for r in rows]


@router.post(
    "/inventory-audits/bulk-delete",
    response_model=InventoryAuditBulkDeleteResponse,
)
def bulk_delete_inventory_audit_reports(
    body: InventoryAuditBulkDeleteRequest,
    db: DbDep,
    _: ReconcileDeleteDep,
) -> InventoryAuditBulkDeleteResponse:
    """Elimina varios reportes de auditoría de inventario."""
    ids = sorted({int(i) for i in body.ids if int(i) > 0})
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Indica al menos un id válido.",
        )

    deleted_count = (
        db.query(InventoryAuditReport)
        .filter(InventoryAuditReport.id.in_(ids))
        .delete(synchronize_session=False)
    )
    db.commit()
    return InventoryAuditBulkDeleteResponse(deleted_count=int(deleted_count or 0))


@router.delete(
    "/inventory-audits/{audit_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_inventory_audit_report(
    audit_id: int,
    db: DbDep,
    _: ReconcileDeleteDep,
) -> None:
    """Elimina un reporte de auditoría de inventario."""
    row = db.get(InventoryAuditReport, audit_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reporte no encontrado.")
    db.delete(row)
    db.commit()


def _inventory_audit_report_to_schema(
    row: InventoryAuditReport,
    account_name: Optional[str],
) -> InventoryAuditReportResponse:
    return InventoryAuditReportResponse(
        id=row.id,
        account_id=row.account_id,
        account_name=account_name,
        service_name=row.service_name,
        start_date=row.start_date,
        end_date=row.end_date,
        matched_data=row.matched_data or [],
        missing_erp_data=row.missing_erp_data or [],
        missing_platform_data=row.missing_platform_data or [],
        created_at=row.created_at,
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
