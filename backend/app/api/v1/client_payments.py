"""API de pagos de cliente (CxC) — separados de ventas/facturas."""
from __future__ import annotations

import json
import uuid as uuid_pkg
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from pydantic import ValidationError
from sqlalchemy.orm import Session, joinedload

from app.api.v1.dependencies import require_permission
from app.permissions import (
    ACCOUNTING_RECEIVABLES_CREATE,
    ACCOUNTING_RECEIVABLES_EDIT,
    ACCOUNTING_RECEIVABLES_VIEW,
)
from app.api.v1.sales import _persist_receipt_upload, _resolve_deposit_account_id
from app.currency_utils import normalize_currency_code
from app.database import get_db
from app.models.client import Client
from app.models.client_payment import ClientPayment, ClientPaymentStatus, PaymentAllocation
from app.models.payment_method import PaymentMethod
from app.schemas.client_payments import (
    ClientPaymentOut,
    PaymentAllocationOut,
    PaymentApproveBody,
    PaymentCreateBody,
    PortalAbonoResponse,
    VoidTransactionBody,
    VoidTransactionResponse,
)
from app.services.client_payment_service import (
    add_payment_remainder_to_client_credit_balance,
    append_client_payment_notes_unique,
    apply_payment_allocations,
    approve_pending_linked_client_payments_for_sale,
    compute_payment_credit_excess,
    finalize_client_payment_approval,
    is_client_payment_credit_only,
    next_payment_number,
    is_wallet_recharge_client_payment,
    payment_encapsulated_in_open_sale_review,
    sale_ref_number,
    void_client_payment,
)
from app.services.client_payment_accounting_sync import sync_client_payment_accounting_ledgers
from app.services.currency_consolidation import get_last_exchange_rate, normalize_exchange_rate
from app.timezone_utils import now_ecuador

router = APIRouter(prefix="/payments", tags=["client-payments"])

_FP_PAY_EPS = Decimal("0.005")


DbDep = Annotated[Session, Depends(get_db)]
ReceivablesViewDep = Annotated[dict, Depends(require_permission(ACCOUNTING_RECEIVABLES_VIEW))]
ReceivablesCreateDep = Annotated[dict, Depends(require_permission(ACCOUNTING_RECEIVABLES_CREATE))]
ReceivablesEditDep = Annotated[dict, Depends(require_permission(ACCOUNTING_RECEIVABLES_EDIT))]


def _payment_to_out(
    p: ClientPayment,
    client_name: str = "",
    *,
    db: Session | None = None,
) -> ClientPaymentOut:
    allocs = []
    for a in p.allocations or []:
        sale = getattr(a, "sale", None)
        inv_total: float | None = None
        sale_dt = None
        if sale is not None:
            sale_dt = getattr(sale, "created_at", None)
            try:
                la = sale.local_amount if sale.local_amount is not None else sale.amount
                inv_total = float(la) if la is not None else None
            except (TypeError, ValueError):
                inv_total = None
        allocs.append(
            PaymentAllocationOut(
                sale_id=a.sale_id,
                sale_ref=sale_ref_number(a.sale_id),
                amount_applied=a.amount_applied,
                currency=p.currency,
                sale_date=sale_dt,
                invoice_total=inv_total,
                open_balance=float(a.amount_applied),
            )
        )
    return ClientPaymentOut(
        id=p.id,
        payment_number=p.payment_number,
        client_id=p.client_id,
        client_name=client_name or None,
        amount=p.amount,
        currency=str(p.currency or "USD"),
        status=p.status.value if hasattr(p.status, "value") else str(p.status),
        payment_method=p.payment_method,
        payment_method_id=p.payment_method_id,
        reference_number=p.reference_number,
        receipt_file_url=p.receipt_file_url,
        deposit_account_id=p.deposit_account_id,
        notes=p.notes,
        created_at=p.created_at,
        approved_at=p.approved_at,
        allocations=allocs,
        encapsulated_in_sale_review=(
            payment_encapsulated_in_open_sale_review(db, p) if db is not None else False
        ),
        is_manually_edited=bool(getattr(p, "is_manually_edited", False)),
        ai_confidence_score=getattr(p, "ai_confidence_score", None),
    )


def _allocations_to_dicts(rows: list) -> list[dict]:
    out: list[dict] = []
    for row in rows:
        if hasattr(row, "model_dump"):
            d = row.model_dump()
        elif isinstance(row, dict):
            d = row
        else:
            continue
        entry: dict = {
            "applied_amount": d.get("applied_amount", d.get("amount_applied")),
        }
        if d.get("wallet_recharge_id") is not None:
            entry["wallet_recharge_id"] = d.get("wallet_recharge_id")
        if d.get("sale_id") is not None:
            entry["sale_id"] = d.get("sale_id")
        out.append(entry)
    return out


@router.post("/portal-abono", response_model=PortalAbonoResponse)
async def portal_abono(
    db: DbDep,
    portal_token: Annotated[str, Form(...)],
    payment_method_id: Annotated[int, Form(...)],
    deposit_account_id: Annotated[int, Form(...)],
    receipt_file: Annotated[UploadFile, File(...)],
    paid_amount: Annotated[float, Form(...)],
    currency: Annotated[str, Form()] = "USD",
    reference_number: Annotated[Optional[str], Form()] = None,
    notes: Annotated[Optional[str], Form()] = None,
) -> PortalAbonoResponse:
    try:
        token = uuid_pkg.UUID(str(portal_token).strip())
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Token de portal inválido.")

    client = db.query(Client).filter(Client.payment_token == token).first()
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Portal no encontrado.")

    if float(paid_amount) <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El monto debe ser mayor a 0.")

    pm = db.get(PaymentMethod, int(payment_method_id))
    if pm is None or not bool(pm.is_active):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Método de pago inválido.")

    dep_acc_id = _resolve_deposit_account_id(db, int(deposit_account_id))
    if not getattr(receipt_file, "filename", None):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Adjunta el comprobante.")

    receipt_url = await _persist_receipt_upload(receipt_file)
    cur = normalize_currency_code((currency or "USD").strip().upper())
    hist_rate, _ = get_last_exchange_rate(db, cur)
    xr_dec = float(normalize_exchange_rate(hist_rate, currency=cur))

    payment = ClientPayment(
        payment_number=next_payment_number(db),
        client_id=client.id,
        amount=Decimal(str(paid_amount)),
        currency=cur,
        exchange_rate=xr_dec,
        status=ClientPaymentStatus.pending_review,
        payment_method_id=int(pm.id),
        payment_method=(pm.name or "").strip() or None,
        reference_number=(reference_number or "").strip()[:120] or None,
        receipt_file_url=(receipt_url or "").strip() or None,
        deposit_account_id=int(dep_acc_id),
        notes=(notes or "").strip() or None,
        created_at=now_ecuador(),
    )
    db.add(payment)
    db.commit()
    db.refresh(payment)

    return PortalAbonoResponse(
        message="Recibimos tu abono. Un operador lo revisará y lo aplicará a tu saldo.",
        payment_id=payment.id,
        payment_number=payment.payment_number,
        status=payment.status.value,
    )


def _create_manual_payment_record(
    db: Session,
    body: PaymentCreateBody,
    *,
    receipt_file_url: Optional[str] = None,
) -> ClientPaymentOut:
    """Crea un pago manual ya aprobado con asignaciones a facturas."""
    client = db.get(Client, int(body.client_id))
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")

    cur = normalize_currency_code(str(body.currency or "USD"))
    if body.exchange_rate:
        xr_raw = body.exchange_rate
    else:
        xr_raw, _ = get_last_exchange_rate(db, cur)
    xr_dec = float(normalize_exchange_rate(xr_raw, currency=cur))
    dep_id = int(body.deposit_account_id) if body.deposit_account_id else None
    if dep_id:
        dep_id = _resolve_deposit_account_id(db, dep_id)

    payment = ClientPayment(
        payment_number=next_payment_number(db),
        client_id=int(body.client_id),
        amount=Decimal(str(body.amount)),
        currency=cur,
        exchange_rate=xr_dec,
        status=ClientPaymentStatus.approved,
        deposit_account_id=dep_id,
        reference_number=(body.reference_number or "").strip()[:120] or None,
        receipt_file_url=(receipt_file_url or "").strip() or None,
        notes=(body.notes or "").strip() or None,
        created_at=now_ecuador(),
        approved_at=now_ecuador(),
    )
    db.add(payment)
    db.flush()

    alloc_rows = _allocations_to_dicts(body.allocations)
    created, remainder = apply_payment_allocations(db, payment, alloc_rows, fifo_fallback=not alloc_rows)
    excess = compute_payment_credit_excess(payment, created, remainder, db=db)
    add_payment_remainder_to_client_credit_balance(db, payment, excess)

    try:
        sync_client_payment_accounting_ledgers(db, payment, strict=True)
    except HTTPException:
        db.rollback()
        raise

    db.commit()
    db.refresh(payment)

    return _payment_to_out(payment, client.display_name(), db=db)


@router.post("/", response_model=ClientPaymentOut)
async def create_payment(
    request: Request,
    db: DbDep,
    _: ReceivablesCreateDep,
    payload: Annotated[Optional[str], Form()] = None,
    receipt_file: Annotated[Optional[UploadFile], File()] = None,
) -> ClientPaymentOut:
    """
    Crea un pago manual (aprobado) con asignaciones.
    Acepta ``application/json`` o ``multipart/form-data`` con campo ``payload`` (JSON)
    y archivo opcional ``receipt_file``.
    """
    content_type = (request.headers.get("content-type") or "").lower()

    if "multipart/form-data" in content_type:
        if not payload:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Falta el campo payload (JSON del pago).",
            )
        try:
            body = PaymentCreateBody.model_validate(json.loads(payload))
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="El campo payload no es JSON válido.",
            ) from exc
        except ValidationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=exc.errors(),
            ) from exc
    else:
        try:
            raw = await request.json()
            body = PaymentCreateBody.model_validate(raw)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Cuerpo JSON inválido.",
            ) from exc
        except ValidationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=exc.errors(),
            ) from exc

    receipt_url: Optional[str] = None
    if receipt_file is not None and getattr(receipt_file, "filename", None):
        receipt_url = await _persist_receipt_upload(receipt_file)

    return _create_manual_payment_record(db, body, receipt_file_url=receipt_url)


@router.get("/", response_model=list[ClientPaymentOut])
def list_payments(
    db: DbDep,
    _: ReceivablesViewDep,
    status_filter: Optional[str] = None,
    client_id: Optional[int] = None,
    review_queue: Optional[str] = None,
) -> list[ClientPaymentOut]:
    """
    Lista pagos CxC.

    ``review_queue=standalone``: excluye comprobantes encapsulados en ventas
    ``pending`` / ``payment_submitted`` (pago inicial del checkout); esos se
    aprueban al activar la venta.
    """
    q = db.query(ClientPayment).options(
        joinedload(ClientPayment.client),
        joinedload(ClientPayment.allocations).joinedload(PaymentAllocation.sale),
    )
    if status_filter:
        try:
            st = ClientPaymentStatus(status_filter.strip().lower())
            q = q.filter(ClientPayment.status == st)
        except ValueError:
            pass
    if client_id is not None:
        q = q.filter(ClientPayment.client_id == int(client_id))
    rows = q.order_by(ClientPayment.created_at.desc()).all()

    st_pending = ClientPaymentStatus.pending_review
    rq = (review_queue or "").strip().lower()
    # Por defecto, la bandeja admin «En revisión» sólo muestra abonos standalone.
    if not rq and status_filter and status_filter.strip().lower() == st_pending.value:
        rq = "standalone"
    if rq == "standalone":
        rows = [
            p
            for p in rows
            if not payment_encapsulated_in_open_sale_review(db, p)
            and not is_wallet_recharge_client_payment(p)
        ]
    out: list[ClientPaymentOut] = []
    for p in rows:
        name = p.client.display_name() if p.client else ""
        out.append(_payment_to_out(p, name, db=db))
    return out


@router.get("/{payment_id}", response_model=ClientPaymentOut)
def get_payment(payment_id: int, db: DbDep, _: ReceivablesViewDep) -> ClientPaymentOut:
    p = (
        db.query(ClientPayment)
        .options(
            joinedload(ClientPayment.client),
            joinedload(ClientPayment.allocations).joinedload(PaymentAllocation.sale),
        )
        .filter(ClientPayment.id == payment_id)
        .first()
    )
    if p is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pago no encontrado.")
    name = p.client.display_name() if p.client else ""
    return _payment_to_out(p, name, db=db)


@router.patch("/{payment_id}/approve", response_model=ClientPaymentOut)
def approve_payment(
    payment_id: int,
    db: DbDep,
    _: ReceivablesEditDep,
    body: Optional[PaymentApproveBody] = None,
) -> ClientPaymentOut:
    p = (
        db.query(ClientPayment)
        .options(joinedload(ClientPayment.client), joinedload(ClientPayment.allocations))
        .filter(ClientPayment.id == payment_id)
        .first()
    )
    if p is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pago no encontrado.")
    if p.status != ClientPaymentStatus.pending_review:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"El pago ya fue procesado ({p.status.value}).",
        )

    if body:
        if body.amount is not None:
            p.amount = Decimal(str(body.amount)).quantize(Decimal("0.0001"))
        if body.reference_number:
            p.reference_number = body.reference_number.strip()[:120]
        if body.notes:
            p.notes = append_client_payment_notes_unique(p.notes, body.notes.strip())

    existing_allocs = (
        db.query(PaymentAllocation).filter(PaymentAllocation.payment_id == int(payment_id)).all()
    )

    # Comprobante portal vinculado a venta en revisión: reconciliar todos los pagos pendientes
    # de esa venta (waterfall + saldo a favor + asiento por el total cobrado).
    is_portal_deposit = "META_SALE_ID=" in str(p.notes or "") or "PARTE_EFECTIVO=" in str(p.notes or "")
    if is_portal_deposit and existing_allocs:
        from app.models.sale import Sale as _Sale, SaleStatus as _SaleStatus

        sale_ids = list({int(a.sale_id) for a in existing_allocs})
        for sid in sale_ids:
            linked_sale = db.get(_Sale, sid)
            if linked_sale is not None and linked_sale.status in (
                _SaleStatus.payment_submitted,
                _SaleStatus.partially_paid,
            ):
                try:
                    approve_pending_linked_client_payments_for_sale(
                        db, linked_sale, strict_accounting=True
                    )
                except HTTPException:
                    db.rollback()
                    raise
                db.commit()
                db.refresh(p)
                name = p.client.display_name() if p.client else ""
                return _payment_to_out(p, name, db=db)

    alloc_rows: list[dict] = []
    if body and body.allocations is not None:
        alloc_rows = _allocations_to_dicts(body.allocations)
    elif existing_allocs:
        alloc_rows = []
        for a in existing_allocs:
            if a.wallet_recharge_id is not None:
                alloc_rows.append({"wallet_recharge_id": int(a.wallet_recharge_id)})
            elif a.sale_id is not None:
                alloc_rows.append({"sale_id": int(a.sale_id)})

    try:
        finalize_client_payment_approval(
            db,
            p,
            manual_rows=alloc_rows,
            fifo_fallback=True,
            strict_accounting=True,
        )
    except HTTPException:
        db.rollback()
        raise

    db.commit()
    db.refresh(p)

    name = p.client.display_name() if p.client else ""
    return _payment_to_out(p, name, db=db)


@router.patch("/{payment_id}/reject")
def reject_payment(payment_id: int, db: DbDep, _: ReceivablesEditDep) -> dict:
    p = db.get(ClientPayment, payment_id)
    if p is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pago no encontrado.")

    if p.status == ClientPaymentStatus.rejected:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El pago ya fue rechazado.")
    if p.status == ClientPaymentStatus.approved and not is_client_payment_credit_only(p):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Solo se pueden revertir pagos en revisión o pagos de Saldo a Favor aprobados.",
        )

    try:
        void_client_payment(db, p, reason=f"Rechazo manual {p.payment_number or payment_id}")
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    db.commit()
    return {"message": "Pago rechazado, asientos revertidos y saldo restaurado.", "payment_id": payment_id}


@router.post("/{payment_id}/void", response_model=VoidTransactionResponse)
def void_payment(
    payment_id: int,
    db: DbDep,
    _: ReceivablesEditDep,
    body: Optional[VoidTransactionBody] = None,
) -> VoidTransactionResponse:
    """Anula un pago CxC: revierte asientos contables y restaura saldos / CxC."""
    p = db.get(ClientPayment, payment_id)
    if p is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pago no encontrado.")

    if p.status == ClientPaymentStatus.rejected:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El pago ya está anulado.")
    if is_wallet_recharge_client_payment(p):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Las recargas BaaS no se anulan desde pagos CxC; use el módulo de recargas.",
        )

    pnum = (p.payment_number or f"PAG-{payment_id}").strip()
    rev_reason = (body.reason if body else None) or f"Reversión por anulación de Pago #{pnum}"

    try:
        void_client_payment(
            db,
            p,
            reason=rev_reason,
            allow_approved_non_credit=True,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    db.commit()
    return VoidTransactionResponse(
        message="Pago anulado. Asientos revertidos y saldos actualizados.",
        status="voided",
        payment_id=payment_id,
    )
