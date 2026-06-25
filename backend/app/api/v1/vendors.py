"""Cuentas por pagar: proveedores, facturas y pagos."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.api.v1.dependencies import require_permission
from app.permissions import (
    ACCOUNTING_VENDORS_CREATE,
    ACCOUNTING_VENDORS_DELETE,
    ACCOUNTING_VENDORS_EDIT,
    ACCOUNTING_VENDORS_VIEW,
)
from app.currency_utils import normalize_currency_code
from app.database import get_db
from app.models.account import Account
from app.models.vendor import Vendor, VendorBill, VendorBillLine, VendorPayment, VendorPaymentLine
from app.schemas.vendors import (
    VendorBillCreate,
    VendorBillLineResponse,
    VendorBillResponse,
    VendorCreate,
    VendorDashboardStats,
    VendorDetailResponse,
    VendorLedgerRow,
    VendorListRow,
    VendorPaymentCreate,
    VendorPaymentLineResponse,
    VendorPaymentResponse,
    VendorResponse,
    VendorUpdate,
)
from app.services.vendor_ap_journal import post_vendor_bill_journal, post_vendor_payment_journal

router = APIRouter(prefix="/vendors", tags=["vendors"])
bill_router = APIRouter(prefix="/vendor-bills", tags=["vendor-bills"])
pay_router = APIRouter(prefix="/vendor-payments", tags=["vendor-payments"])

DbDep = Annotated[Session, Depends(get_db)]
VendorsViewDep = Annotated[dict, Depends(require_permission(ACCOUNTING_VENDORS_VIEW))]
VendorsCreateDep = Annotated[dict, Depends(require_permission(ACCOUNTING_VENDORS_CREATE))]
VendorsEditDep = Annotated[dict, Depends(require_permission(ACCOUNTING_VENDORS_EDIT))]
VendorsDeleteDep = Annotated[dict, Depends(require_permission(ACCOUNTING_VENDORS_DELETE))]


def _maybe_with_for_update(q, db: Session):
    bind = db.get_bind()
    if bind is not None and getattr(bind.dialect, "name", None) == "postgresql":
        return q.with_for_update()
    return q


def _q(v: object) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.0001"))


def _norm_bill_number(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip()
    return s if s else None


def _sync_bill_status(bill: VendorBill) -> None:
    bd = _q(bill.balance_due)
    tot = _q(bill.total_amount)
    if bd <= 0:
        bill.balance_due = Decimal("0")
        bill.status = "Pagada"
    elif bd >= tot:
        bill.balance_due = bd
        bill.status = "Abierta"
    else:
        bill.status = "Parcial"


def _vendor_to_row(
    v: Vendor,
    pending: Decimal,
    bill_count: int,
    has_overdue: bool,
) -> VendorListRow:
    return VendorListRow(
        id=v.id,
        name=v.name,
        company_name=v.company_name,
        email=v.email,
        phone=v.phone,
        address=v.address,
        currency=v.currency,
        notes=v.notes,
        created_at=v.created_at,
        balance_pending=pending,
        bill_count=bill_count,
        has_overdue=has_overdue,
    )


def _bill_line_response(ln: VendorBillLine) -> VendorBillLineResponse:
    acc = ln.account
    return VendorBillLineResponse(
        id=ln.id,
        bill_id=ln.bill_id,
        account_id=ln.account_id,
        account_name=(acc.name if acc else "") or "",
        description=ln.description,
        amount=Decimal(str(ln.amount)),
        line_no=int(ln.line_no),
    )


def _bill_response(b: VendorBill) -> VendorBillResponse:
    vn = b.vendor.name if b.vendor else ""
    return VendorBillResponse(
        id=b.id,
        vendor_id=b.vendor_id,
        vendor_name=vn,
        bill_number=b.bill_number,
        bill_date=b.bill_date,
        due_date=b.due_date,
        terms=b.terms,
        memo=b.memo,
        total_amount=Decimal(str(b.total_amount)),
        balance_due=Decimal(str(b.balance_due)),
        status=b.status,
        created_at=b.created_at,
        lines=[_bill_line_response(x) for x in sorted(b.lines, key=lambda x: (x.line_no, x.id))],
    )


def _payment_response(p: VendorPayment) -> VendorPaymentResponse:
    return VendorPaymentResponse(
        id=p.id,
        vendor_id=p.vendor_id,
        vendor_name=p.vendor.name if p.vendor else "",
        payment_account_id=p.payment_account_id,
        payment_account_name=(p.payment_account.name if p.payment_account else "") or "",
        payment_date=p.payment_date,
        reference_number=p.reference_number,
        memo=p.memo,
        total_amount=Decimal(str(p.total_amount)),
        created_at=p.created_at,
        lines=[
            VendorPaymentLineResponse(
                id=ln.id,
                payment_id=ln.payment_id,
                bill_id=ln.bill_id,
                bill_reference=ln.bill.bill_number if ln.bill else None,
                amount_applied=Decimal(str(ln.amount_applied)),
            )
            for ln in sorted(p.lines, key=lambda x: x.id)
        ],
    )


# ─── Vendors CRUD ────────────────────────────────────────────────────────────


@router.get("/stats/dashboard/", response_model=VendorDashboardStats)
def vendor_dashboard_stats(db: DbDep, _: VendorsViewDep) -> VendorDashboardStats:
    vendors = db.query(Vendor.id).all()
    vids = [int(x[0]) for x in vendors]
    if not vids:
        return VendorDashboardStats(never_billed=0, with_open_balance=0, paid_up=0)

    bal_rows = (
        db.query(
            VendorBill.vendor_id,
            func.count(VendorBill.id),
            func.coalesce(func.sum(VendorBill.balance_due), 0),
        )
        .group_by(VendorBill.vendor_id)
        .all()
    )
    agg: dict[int, tuple[int, Decimal]] = {}
    for vid, cnt, bal in bal_rows:
        agg[int(vid)] = (int(cnt or 0), _q(bal))

    never_billed = 0
    with_open = 0
    paid_up = 0
    for vid in vids:
        cnt, owed = agg.get(vid, (0, Decimal("0")))
        if cnt == 0:
            never_billed += 1
        elif owed > 0:
            with_open += 1
        else:
            paid_up += 1

    return VendorDashboardStats(
        never_billed=never_billed,
        with_open_balance=with_open,
        paid_up=paid_up,
    )


@router.get("/", response_model=list[VendorListRow])
def list_vendors(db: DbDep, _: VendorsViewDep) -> list[VendorListRow]:
    vendors = db.query(Vendor).order_by(Vendor.name.asc()).all()
    if not vendors:
        return []

    bal_rows = (
        db.query(
            VendorBill.vendor_id,
            func.count(VendorBill.id),
            func.coalesce(func.sum(VendorBill.balance_due), 0),
        )
        .group_by(VendorBill.vendor_id)
        .all()
    )
    agg: dict[int, tuple[int, Decimal]] = {}
    for vid, cnt, bal in bal_rows:
        agg[int(vid)] = (int(cnt or 0), _q(bal))

    today = dt.date.today()
    overdue_candidates = (
        db.query(VendorBill.vendor_id)
        .filter(
            VendorBill.balance_due > 0,
            VendorBill.due_date.is_not(None),
            VendorBill.due_date < today,
        )
        .distinct()
        .all()
    )
    overdue_set = {int(r[0]) for r in overdue_candidates}

    out: list[VendorListRow] = []
    for v in vendors:
        cnt, owed = agg.get(v.id, (0, Decimal("0")))
        out.append(_vendor_to_row(v, owed, cnt, bool(v.id in overdue_set)))
    return out


@router.post("/", response_model=VendorResponse, status_code=status.HTTP_201_CREATED)
def create_vendor(payload: VendorCreate, db: DbDep, _: VendorsCreateDep) -> VendorResponse:
    cur = normalize_currency_code(payload.currency)
    vendor = Vendor(
        name=payload.name.strip(),
        company_name=payload.company_name.strip() if payload.company_name else None,
        email=payload.email.strip() if payload.email else None,
        phone=payload.phone.strip() if payload.phone else None,
        address=payload.address.strip() if payload.address else None,
        currency=cur,
        notes=payload.notes.strip() if payload.notes else None,
    )
    db.add(vendor)
    db.commit()
    db.refresh(vendor)
    return VendorResponse.model_validate(vendor)


@router.get("/{vendor_id}", response_model=VendorDetailResponse)
def get_vendor(vendor_id: int, db: DbDep, _: VendorsViewDep) -> VendorDetailResponse:
    v = db.get(Vendor, vendor_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proveedor no encontrado.")
    owed_raw = (
        db.query(func.coalesce(func.sum(VendorBill.balance_due), 0))
        .filter(VendorBill.vendor_id == vendor_id)
        .scalar()
    )
    owed = _q(owed_raw or 0)
    base = VendorResponse.model_validate(v)
    return VendorDetailResponse(**{**base.model_dump(), "balance_pending": owed})


@router.patch("/{vendor_id}", response_model=VendorResponse)
def update_vendor(vendor_id: int, payload: VendorUpdate, db: DbDep, _: VendorsEditDep) -> VendorResponse:
    v = db.get(Vendor, vendor_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proveedor no encontrado.")
    if payload.name is not None:
        v.name = payload.name.strip()
    if payload.company_name is not None:
        v.company_name = payload.company_name.strip() if payload.company_name.strip() else None
    if payload.email is not None:
        v.email = payload.email.strip() if payload.email.strip() else None
    if payload.phone is not None:
        v.phone = payload.phone.strip() if payload.phone.strip() else None
    if payload.address is not None:
        v.address = payload.address.strip() if payload.address.strip() else None
    if payload.currency is not None:
        v.currency = normalize_currency_code(payload.currency)
    if payload.notes is not None:
        v.notes = payload.notes.strip() if payload.notes.strip() else None
    db.commit()
    db.refresh(v)
    return VendorResponse.model_validate(v)


@router.delete("/{vendor_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_vendor(vendor_id: int, db: DbDep, _: VendorsDeleteDep) -> None:
    """Elimina un proveedor solo si no tiene facturas ni pagos (historial contable)."""
    v = db.get(Vendor, vendor_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proveedor no encontrado.")

    bill_count = (
        db.query(func.count(VendorBill.id)).filter(VendorBill.vendor_id == vendor_id).scalar() or 0
    )
    pay_count = (
        db.query(func.count(VendorPayment.id)).filter(VendorPayment.vendor_id == vendor_id).scalar() or 0
    )
    if int(bill_count) > 0 or int(pay_count) > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "No se puede eliminar este proveedor porque tiene facturas o pagos registrados. "
                "Solo puede eliminarse si nunca tuvo movimientos en cuentas por pagar."
            ),
        )

    db.delete(v)
    db.commit()


@router.get("/{vendor_id}/ledger/", response_model=list[VendorLedgerRow])
def vendor_ledger(
    vendor_id: int,
    db: DbDep,
    _: VendorsViewDep,
    date_from: Optional[dt.date] = Query(None),
    date_to: Optional[dt.date] = Query(None),
) -> list[VendorLedgerRow]:
    v = db.get(Vendor, vendor_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proveedor no encontrado.")

    bq = (
        db.query(VendorBill)
        .options(joinedload(VendorBill.lines).joinedload(VendorBillLine.account))
        .filter(VendorBill.vendor_id == vendor_id)
    )
    pq = (
        db.query(VendorPayment)
        .options(joinedload(VendorPayment.payment_account))
        .filter(VendorPayment.vendor_id == vendor_id)
    )
    if date_from is not None:
        bq = bq.filter(VendorBill.bill_date >= date_from)
        pq = pq.filter(VendorPayment.payment_date >= date_from)
    if date_to is not None:
        bq = bq.filter(VendorBill.bill_date <= date_to)
        pq = pq.filter(VendorPayment.payment_date <= date_to)

    bills = bq.all()
    pays = pq.all()

    today = dt.date.today()
    rows: list[VendorLedgerRow] = []

    for b in bills:
        cats = []
        for ln in sorted(b.lines, key=lambda x: (x.line_no, x.id)):
            if ln.account and ln.account.name and ln.account.name not in cats:
                cats.append(ln.account.name)
        ref = b.bill_number or f"FB-{b.id}"
        overdue = bool(
            b.balance_due
            and _q(b.balance_due) > 0
            and b.due_date
            and b.due_date < today,
        )
        rows.append(
            VendorLedgerRow(
                date=b.bill_date,
                sort_ts=b.created_at,
                row_kind="vendor_bill",
                record_id=b.id,
                transaction_type_label="Factura de proveedores",
                reference_display=str(ref),
                category_label=", ".join(cats) if cats else "—",
                beneficiary_label=v.name,
                amount_signed=_q(b.total_amount),
                bill_balance_due=_q(b.balance_due),
                overdue=overdue,
            ),
        )

    for p in pays:
        ref = p.reference_number or f"FP-{p.id}"
        bk = (p.payment_account.name if p.payment_account else "") or "—"
        rows.append(
            VendorLedgerRow(
                date=p.payment_date,
                sort_ts=p.created_at,
                row_kind="vendor_payment",
                record_id=p.id,
                transaction_type_label="Pago de facturas",
                reference_display=str(ref),
                category_label=bk,
                beneficiary_label=v.name,
                amount_signed=-_q(p.total_amount),
                bill_balance_due=None,
                overdue=None,
            ),
        )

    rows.sort(key=lambda r: (-r.sort_ts.timestamp(), -r.record_id))
    return rows


# ─── Bills ───────────────────────────────────────────────────────────────────


@bill_router.get("/open/", response_model=list[VendorBillResponse])
def list_open_bills(
    db: DbDep,
    _: VendorsViewDep,
    vendor_id: Optional[int] = Query(None, ge=1),
) -> list[VendorBillResponse]:
    """Facturas con saldo pendiente (para modal Pagar facturas)."""
    q = (
        db.query(VendorBill)
        .options(
            joinedload(VendorBill.vendor),
            joinedload(VendorBill.lines).joinedload(VendorBillLine.account),
        )
        .filter(VendorBill.balance_due > 0)
        .order_by(VendorBill.bill_date.asc(), VendorBill.id.asc())
    )
    if vendor_id is not None:
        q = q.filter(VendorBill.vendor_id == vendor_id)
    bills = q.all()
    return [_bill_response(b) for b in bills]


@bill_router.get("/{bill_id}", response_model=VendorBillResponse)
def get_bill(bill_id: int, db: DbDep, _: VendorsViewDep) -> VendorBillResponse:
    row = (
        db.query(VendorBill)
        .options(
            joinedload(VendorBill.vendor),
            joinedload(VendorBill.lines).joinedload(VendorBillLine.account),
        )
        .filter(VendorBill.id == bill_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Factura no encontrada.")
    return _bill_response(row)


@bill_router.post("/", response_model=VendorBillResponse, status_code=status.HTTP_201_CREATED)
def create_vendor_bill(payload: VendorBillCreate, db: DbDep, _: VendorsCreateDep) -> VendorBillResponse:
    vendor = db.get(Vendor, payload.vendor_id)
    if vendor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proveedor no encontrado.")

    bn = _norm_bill_number(payload.bill_number)
    lines_total = sum(_q(ln.amount) for ln in payload.lines)
    bill = VendorBill(
        vendor_id=payload.vendor_id,
        bill_number=bn,
        bill_date=payload.bill_date,
        due_date=payload.due_date,
        terms=payload.terms.strip() if payload.terms else None,
        memo=payload.memo.strip() if payload.memo else None,
        total_amount=_q(lines_total),
        balance_due=_q(lines_total),
        status="Abierta",
    )
    db.add(bill)
    try:
        db.flush()
    except IntegrityError as e:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ya existe una factura con ese número para este proveedor.",
        ) from e

    try:
        for i, ln in enumerate(payload.lines):
            db.add(
                VendorBillLine(
                    bill_id=bill.id,
                    account_id=ln.account_id,
                    description=ln.description.strip() if ln.description else None,
                    amount=_q(ln.amount),
                    line_no=i + 1,
                ),
            )
        db.flush()

        bill = (
            db.query(VendorBill)
            .options(
                joinedload(VendorBill.vendor),
                joinedload(VendorBill.lines).joinedload(VendorBillLine.account),
            )
            .filter(VendorBill.id == bill.id)
            .first()
        )
        if bill is None:
            raise RuntimeError("Factura inconsistente tras creación.")

        post_vendor_bill_journal(db, bill)
        db.commit()
    except Exception:
        db.rollback()
        raise

    bill = (
        db.query(VendorBill)
        .options(
            joinedload(VendorBill.vendor),
            joinedload(VendorBill.lines).joinedload(VendorBillLine.account),
        )
        .filter(VendorBill.id == bill.id)
        .first()
    )
    if bill is None:
        raise HTTPException(status_code=500, detail="Error interno.")
    return _bill_response(bill)


# ─── Payments ─────────────────────────────────────────────────────────────────


@pay_router.get("/{payment_id}", response_model=VendorPaymentResponse)
def get_payment(payment_id: int, db: DbDep, _: VendorsViewDep) -> VendorPaymentResponse:
    row = (
        db.query(VendorPayment)
        .options(
            joinedload(VendorPayment.vendor),
            joinedload(VendorPayment.payment_account),
            joinedload(VendorPayment.lines).joinedload(VendorPaymentLine.bill),
        )
        .filter(VendorPayment.id == payment_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pago no encontrado.")
    return _payment_response(row)


@pay_router.post("/", response_model=VendorPaymentResponse, status_code=status.HTTP_201_CREATED)
def create_vendor_payment(payload: VendorPaymentCreate, db: DbDep, _: VendorsCreateDep) -> VendorPaymentResponse:
    vendor = db.get(Vendor, payload.vendor_id)
    if vendor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proveedor no encontrado.")

    pa = db.get(Account, payload.payment_account_id)
    if pa is None or not pa.is_active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta de pago no encontrada.")

    vcur = normalize_currency_code(vendor.currency)
    pcur = normalize_currency_code(pa.currency)
    if vcur != pcur:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La moneda del proveedor y la cuenta bancaria deben coincidir.",
        )

    bill_ids_ordered = [pl.bill_id for pl in payload.lines]
    if len(bill_ids_ordered) != len(set(bill_ids_ordered)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No puede haber líneas duplicadas para la misma factura; consolida el importe en una sola línea.",
        )

    total_computed = _q(Decimal("0"))
    line_entries: list[tuple[VendorBill, Decimal]] = []

    for pl in payload.lines:
        amt = _q(pl.amount_applied)
        total_computed += amt
        qbill = db.query(VendorBill).options(joinedload(VendorBill.vendor)).filter(VendorBill.id == pl.bill_id)
        qbill = _maybe_with_for_update(qbill, db)
        bill = qbill.first()
        if bill is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Factura {pl.bill_id} no encontrada.")
        if bill.vendor_id != payload.vendor_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La factura no pertenece al proveedor seleccionado.",
            )
        if amt <= 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Importe aplicado inválido.")
        if amt > _q(bill.balance_due):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"El abono ({amt}) supera el saldo de la factura {bill.bill_number or bill.id}.",
            )
        line_entries.append((bill, amt))

    if total_computed <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El total del pago debe ser mayor que cero.")

    pay_id: Optional[int] = None
    try:
        pay = VendorPayment(
            vendor_id=payload.vendor_id,
            payment_account_id=payload.payment_account_id,
            payment_date=payload.payment_date,
            reference_number=payload.reference_number.strip() if payload.reference_number else None,
            memo=payload.memo.strip() if payload.memo else None,
            total_amount=total_computed,
        )
        db.add(pay)
        db.flush()
        pay_id = int(pay.id)

        for bill, amt in line_entries:
            db.add(VendorPaymentLine(payment_id=pay_id, bill_id=bill.id, amount_applied=amt))

        db.flush()

        for bill, amt in line_entries:
            bill.balance_due = _q(_q(bill.balance_due) - amt)
            _sync_bill_status(bill)

        pay_reload = (
            db.query(VendorPayment)
            .options(
                joinedload(VendorPayment.vendor),
                joinedload(VendorPayment.payment_account),
                joinedload(VendorPayment.lines).joinedload(VendorPaymentLine.bill),
            )
            .filter(VendorPayment.id == pay_id)
            .first()
        )

        assert pay_reload is not None
        post_vendor_payment_journal(db, pay_reload)
        db.commit()
    except Exception:
        db.rollback()
        raise

    if pay_id is None:
        raise HTTPException(status_code=500, detail="Error interno.")

    pay_f = (
        db.query(VendorPayment)
        .options(
            joinedload(VendorPayment.vendor),
            joinedload(VendorPayment.payment_account),
            joinedload(VendorPayment.lines).joinedload(VendorPaymentLine.bill),
        )
        .filter(VendorPayment.id == pay_id)
        .first()
    )
    if pay_f is None:
        raise HTTPException(status_code=500, detail="Error interno.")
    return _payment_response(pay_f)
