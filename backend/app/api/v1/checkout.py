"""Public checkout endpoints (no admin JWT): pay a single pending sale by ``Sale.payment_token``."""

from __future__ import annotations

import uuid as uuid_pkg
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.api.v1.sales import (
    _persist_receipt_upload,
    _resolve_deposit_account_id,
    expire_pending_sales_if_needed,
)
from app.account_constants import is_liquid_deposit_account
from app.currency_utils import normalize_currency_code
from app.database import get_db
from app.models.account import Account
from app.models.payment_method import PaymentMethod
from app.models.product import Product
from app.models.sale import Sale, SaleStatus
from app.models.screen_stock import ScreenStock
from app.schemas.checkout_public import (
    CheckoutDepositAccountPublic,
    CheckoutDetailResponse,
    CheckoutLinePublic,
    CheckoutPayResponse,
    CheckoutPaymentMethodOption,
)
from app.schemas.sales import SaleInvoiceLineItem
from app.services.sale_accounting_sync import commit_db_or_rollback, sync_sale_accounting_ledgers
from app.models.client_payment import ClientPayment, ClientPaymentStatus, PaymentAllocation
from app.timezone_utils import now_ecuador
from app.services.client_payment_service import (
    dedupe_notes_portal_general_abono_chunks,
    next_payment_number,
)

router = APIRouter(prefix="/checkout", tags=["public-checkout"])

DbDep = Annotated[Session, Depends(get_db)]


def _sale_allowed_payment_labels(sale: Sale) -> list[str]:
    raw = getattr(sale, "allowed_payment_methods", None)
    if not isinstance(raw, list):
        return []
    return [str(x).strip() for x in raw if str(x).strip()]


def _sale_allowed_deposit_ids(sale: Sale) -> list[int]:
    raw = getattr(sale, "allowed_deposit_accounts", None)
    if not isinstance(raw, list):
        return []
    seen: set[int] = set()
    out: list[int] = []
    for x in raw:
        try:
            aid = int(x)
        except (TypeError, ValueError):
            continue
        if aid < 1 or aid in seen:
            continue
        seen.add(aid)
        out.append(aid)
    return out


def _checkout_payment_method_options(db: Session, labels: list[str]) -> list[CheckoutPaymentMethodOption]:
    out: list[CheckoutPaymentMethodOption] = []
    seen: set[int] = set()
    for lab in labels[:40]:
        s = str(lab).strip()
        if not s:
            continue
        pm = (
            db.query(PaymentMethod)
            .filter(
                PaymentMethod.is_active.is_(True),
                func.lower(func.trim(PaymentMethod.name)) == s.lower(),
            )
            .first()
        )
        if pm is None or int(pm.id) in seen:
            continue
        seen.add(int(pm.id))
        out.append(CheckoutPaymentMethodOption(id=int(pm.id), name=(pm.name or "").strip()))
    return out


def _effective_linked_pm_lower(db: Session, acc: Account) -> str:
    v = (getattr(acc, "linked_payment_method", None) or "").strip().lower()
    if v:
        return v
    pid = getattr(acc, "parent_id", None)
    if pid is not None and int(pid) >= 1:
        parent = db.get(Account, int(pid))
        if parent is not None:
            pv = (getattr(parent, "linked_payment_method", None) or "").strip().lower()
            return pv or ""
    return ""


def _checkout_deposit_accounts_public(db: Session, ids: list[int]) -> list[CheckoutDepositAccountPublic]:
    rows: list[CheckoutDepositAccountPublic] = []
    for aid in ids:
        a = db.get(Account, aid)
        if a is None or not a.is_active or not is_liquid_deposit_account(a):
            continue
        cur = normalize_currency_code(str(a.currency or "USD"))
        nm = (a.name or "").strip() or f"Cuenta {a.id}"
        desc_raw = getattr(a, "description", None)
        holder = (desc_raw.strip() if isinstance(desc_raw, str) else "") or None
        if holder == "":
            holder = None
        rows.append(
            CheckoutDepositAccountPublic(
                id=int(a.id),
                bank_name=nm,
                account_holder_hint=holder,
                account_number=(str(a.account_number).strip() if getattr(a, "account_number", None) else None)
                or None,
                currency=cur,
                linked_payment_method=_effective_linked_pm_lower(db, a),
            )
        )
    return rows


def _account_allowed_for_payment_method(db: Session, acc: Account, pm: PaymentMethod) -> bool:
    link = _effective_linked_pm_lower(db, acc)
    if not link:
        return False
    return link == (pm.name or "").strip().lower()


def _product_headline_public(
    sale: Sale,
    product: Optional[Product],
    stock_row: Optional[ScreenStock],
) -> Optional[str]:
    if product is not None:
        return product.name.strip() if (product.name or "").strip() else None
    if stock_row is not None:
        return f"{stock_row.provider} — {stock_row.package}"
    if sale.inventory_channel == "screen_stock" and (sale.inventory_package or "").strip():
        prov = sale.inventory_provider or "—"
        return f"{prov} — {sale.inventory_package}"
    if sale.credits_quantity is not None and (sale.inventory_provider or "").strip():
        cq = float(sale.credits_quantity)
        cq_fmt = cq if cq == int(cq) else round(cq, 4)
        return f"{sale.inventory_provider} — Recarga total ({cq_fmt} créditos)"
    return None


def _finalize_checkout_line_amount(ln: CheckoutLinePublic) -> CheckoutLinePublic:
    if ln.amount is not None:
        return ln
    if ln.qty is not None and ln.rate is not None:
        try:
            return ln.model_copy(
                update={"amount": float(Decimal(str(ln.qty)) * Decimal(str(ln.rate)))},
            )
        except Exception:
            return ln
    return ln


def _checkout_lines_sum_local(lines: list[CheckoutLinePublic]) -> Optional[Decimal]:
    """Suma de subtotales (``amount`` o ``qty × rate``). ``None`` si no hay nada cotizable."""
    if not lines:
        return None
    acc = Decimal("0")
    counted = False
    for ln in lines:
        if ln.amount is not None:
            acc += Decimal(str(ln.amount))
            counted = True
        elif ln.qty is not None and ln.rate is not None:
            acc += Decimal(str(ln.qty)) * Decimal(str(ln.rate))
            counted = True
    return acc.quantize(Decimal("0.0001")) if counted else None


def _infer_local_amount_for_checkout(sale: Sale, lines: list[CheckoutLinePublic]) -> Optional[Decimal]:
    """
    Cobro en moneda de venta para el cliente: DB ``local_amount``, suma de líneas o
    ``amount_usd × exchange_rate`` (como en el ERP al crear la venta).
    """
    if sale.local_amount is not None:
        try:
            return Decimal(str(sale.local_amount)).quantize(Decimal("0.0001"))
        except Exception:
            pass
    line_sum = _checkout_lines_sum_local(lines)
    if line_sum is not None:
        return line_sum.quantize(Decimal("0.0001"))
    if sale.amount is not None:
        try:
            usd_amt = Decimal(str(sale.amount))
            if usd_amt != Decimal("0"):
                er = Decimal(str(sale.exchange_rate or 1))
                return (usd_amt * er).quantize(Decimal("0.0001"))
        except Exception:
            return None
    return None


def _create_encapsulated_checkout_payment(
    db: Session,
    sale: Sale,
    *,
    receipt_url: str,
    payment_method: PaymentMethod,
    deposit_account_id: Optional[int],
) -> None:
    """Registra ClientPayment encapsulado para que la activación contabilice DR banco / CR CxC."""
    lines = _checkout_lines_public(db, sale, product=sale.product, stock_row=sale.screen_stock_row)
    amt_opt = _infer_local_amount_for_checkout(sale, lines)
    if amt_opt is None or amt_opt <= Decimal("0.0001"):
        return

    cur = normalize_currency_code(str(sale.currency or "USD"))
    sid = int(sale.id)
    notes = dedupe_notes_portal_general_abono_chunks(
        "\n".join(
            [
                "portal_general_abono",
                f"META_SALE_ID={sid}",
                f"ORIGIN_SALE_REF={sid}",
                "IS_INITIAL_SALE_PAYMENT=1",
                f"PARTE_EFECTIVO={float(amt_opt):.2f} {cur}",
                "checkout_encapsulated=1",
            ]
        )
    )
    now = now_ecuador()
    cp = ClientPayment(
        payment_number=next_payment_number(db),
        client_id=int(sale.client_id),
        amount=amt_opt.quantize(Decimal("0.01")),
        currency=cur,
        receipt_file_url=(receipt_url or "").strip() or None,
        payment_method_id=int(payment_method.id),
        payment_method=(payment_method.name or "").strip()[:120] or None,
        deposit_account_id=int(deposit_account_id) if deposit_account_id is not None else None,
        status=ClientPaymentStatus.pending_review,
        notes=notes,
        created_at=now,
    )
    db.add(cp)
    db.flush()
    db.add(
        PaymentAllocation(
            payment_id=int(cp.id),
            sale_id=sid,
            amount_applied=amt_opt.quantize(Decimal("0.0001")),
        )
    )


def _checkout_lines_public(
    db: Session,
    sale: Sale,
    *,
    product: Optional[Product],
    stock_row: Optional[ScreenStock],
) -> list[CheckoutLinePublic]:
    headline = _product_headline_public(sale, product, stock_row)
    raw = getattr(sale, "invoice_lines", None)
    if isinstance(raw, list) and len(raw) > 0:
        out: list[CheckoutLinePublic] = []
        for chunk in raw[:100]:
            try:
                ln = SaleInvoiceLineItem.model_validate(chunk)
            except Exception:
                continue
            stripped = (ln.description or "").strip()
            title = stripped or headline
            out.append(
                _finalize_checkout_line_amount(
                    CheckoutLinePublic(
                        description=(title.strip() if title else None),
                        qty=float(ln.qty) if ln.qty is not None else None,
                        rate=float(ln.rate) if ln.rate is not None else None,
                    )
                )
            )
        if out:
            return out

    qty = getattr(sale, "inventory_screen_units", None)
    qty_f = float(qty or 1) if qty else 1.0
    la_float: Optional[float] = None
    if sale.local_amount is not None:
        try:
            la_float = float(Decimal(str(sale.local_amount)))
        except Exception:
            la_float = None
    if la_float is None and sale.amount is not None:
        try:
            la_float = float(Decimal(str(sale.amount)) * Decimal(str(sale.exchange_rate or 1)))
        except Exception:
            la_float = None
    rate: Optional[float] = None
    if la_float is not None and qty_f > 0:
        try:
            rate = la_float / qty_f
        except Exception:
            rate = la_float
    elif la_float is not None:
        rate = la_float
    desc = headline or ("Pedido" if sale.product_id else "Servicio")
    return [
        _finalize_checkout_line_amount(
            CheckoutLinePublic(description=desc, qty=qty_f, rate=rate),
        )
    ]


@router.get(
    "/{payment_token}",
    response_model=CheckoutDetailResponse,
    summary="Detalle público del pedido (solo pendiente)",
)
def checkout_detail(payment_token: uuid_pkg.UUID, db: DbDep) -> CheckoutDetailResponse:
    expire_pending_sales_if_needed(db)
    sale = (
        db.query(Sale)
        .options(
            joinedload(Sale.product),
            joinedload(Sale.screen_stock_row),
        )
        .filter(Sale.payment_token == payment_token)
        .first()
    )
    if sale is None or sale.status != SaleStatus.pending:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No encontramos un pedido disponible para pagar con este enlace.",
        )

    pm_labels = _sale_allowed_payment_labels(sale)
    payment_method_rows = _checkout_payment_method_options(db, pm_labels)
    dep_ids = _sale_allowed_deposit_ids(sale)
    deposit_rows = _checkout_deposit_accounts_public(db, dep_ids)

    lines = _checkout_lines_public(
        db,
        sale,
        product=sale.product,
        stock_row=sale.screen_stock_row,
    )

    la_inferred = _infer_local_amount_for_checkout(sale, lines)
    ap_raw = getattr(sale, "amount_paid", None)

    local_amount_out: Optional[Decimal] = None
    if sale.local_amount is not None:
        try:
            local_amount_out = Decimal(str(sale.local_amount)).quantize(Decimal("0.0001"))
        except Exception:
            local_amount_out = None
    elif la_inferred is not None:
        local_amount_out = la_inferred

    if la_inferred is None:
        amount_paid_out = Decimal(str(ap_raw)) if ap_raw is not None else Decimal("0")
        balance_due_out = Decimal("0")
    else:
        la_d = la_inferred
        if sale.local_amount is not None:
            ap_d = Decimal(str(ap_raw)) if ap_raw is not None else la_d
        else:
            ap_d = Decimal(str(ap_raw)) if ap_raw is not None else Decimal("0")
        amount_paid_out = ap_d
        balance_due_out = (la_d - ap_d).quantize(Decimal("0.0001"))

    return CheckoutDetailResponse(
        sale_id=sale.id,
        status=sale.status.value,
        expires_at=getattr(sale, "expires_at", None),
        currency=sale.currency,
        exchange_rate=float(sale.exchange_rate or 1.0),
        local_amount=local_amount_out,
        amount_usd=sale.amount,
        amount_paid=amount_paid_out,
        balance_due=balance_due_out,
        lines=lines,
        payment_methods=payment_method_rows,
        deposit_accounts=deposit_rows,
        allowed_payment_methods=[str(x).strip() for x in pm_labels if str(x).strip()],
        allowed_deposit_accounts=dep_ids,
    )


@router.post(
    "/{payment_token}/pay",
    response_model=CheckoutPayResponse,
    summary="Enviar comprobante de pago (cliente público)",
)
async def checkout_pay(
    payment_token: uuid_pkg.UUID,
    db: DbDep,
    payment_method_id: Annotated[int, Form(...)],
    payment_receipt: Annotated[UploadFile, File(...)],
    deposit_account_id: Annotated[Optional[int], Form()] = None,
) -> CheckoutPayResponse:
    expire_pending_sales_if_needed(db)
    sale = (
        db.query(Sale).options(joinedload(Sale.product), joinedload(Sale.screen_stock_row)).filter(Sale.payment_token == payment_token).first()
    )
    if sale is None or sale.status != SaleStatus.pending:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Este enlace ya no está disponible para enviar pagos.",
        )

    labels_allowed = _sale_allowed_payment_labels(sale)
    if not labels_allowed:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Este pedido no tiene métodos de pago habilitados para este enlace.",
        )

    pm = db.get(PaymentMethod, payment_method_id)
    if pm is None or not bool(pm.is_active):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Método de pago inválido o inactivo.",
        )

    pname = (pm.name or "").strip().lower()
    ok_pm = any(pname == lab.lower() for lab in labels_allowed)
    if not ok_pm:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Este método de pago no está habilitado para este pedido.",
        )

    dep_ids_allowed = _sale_allowed_deposit_ids(sale)

    if dep_ids_allowed:
        if deposit_account_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Indica en qué cuenta realizaste el depósito.",
            )
        dep_resolved = _resolve_deposit_account_id(db, deposit_account_id)
        if int(dep_resolved) not in set(dep_ids_allowed):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Esta cuenta de depósito no está habilitada para este pedido.",
            )
        acc = db.get(Account, int(dep_resolved))
        if acc is None or not _account_allowed_for_payment_method(db, acc, pm):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La cuenta elegida no corresponde al método de pago seleccionado.",
            )
        sale.deposit_account_id = int(dep_resolved)
    elif deposit_account_id is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Este pedido no requiere indicar cuenta de depósito.",
        )

    if not getattr(payment_receipt, "filename", None):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Adjunta una imagen o PDF del comprobante.",
        )

    receipt_url = await _persist_receipt_upload(payment_receipt)
    sale.payment_method_id = pm.id
    sale.receipt_url = (receipt_url or "").strip() or None
    # Pendiente → comprobante recibido (operador debe aprobar).
    sale.status = SaleStatus.payment_submitted
    sale.expires_at = None
    dep_for_payment = int(sale.deposit_account_id) if sale.deposit_account_id is not None else None
    _create_encapsulated_checkout_payment(
        db,
        sale,
        receipt_url=sale.receipt_url or "",
        payment_method=pm,
        deposit_account_id=dep_for_payment,
    )
    try:
        sync_sale_accounting_ledgers(db, sale, strict=False)
        commit_db_or_rollback(db)
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al registrar el comprobante y el asiento contable.",
        ) from exc
    db.refresh(sale)

    return CheckoutPayResponse(
        status=sale.status.value,
        message="Gracias. Recibimos tu comprobante; un operador revisará el pago y activará tu pedido en breve.",
        receipt_url=sale.receipt_url,
    )
