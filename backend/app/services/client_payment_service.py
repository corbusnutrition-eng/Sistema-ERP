"""Lógica de cobros CxC: numeración, asignación FIFO y ledger."""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy import func, nullslast
from sqlalchemy.orm import Session, joinedload

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.client_payment import ClientPayment, ClientPaymentStatus, PaymentAllocation
from app.models.sale import Sale, SaleStatus
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.timezone_utils import UTC, isoformat_z, now_ecuador
from app.wallet_recharge_helpers import (
    REQ_STATUS_APPROVED,
    REQ_STATUS_IN_REVIEW,
    REQ_STATUS_PARTIALLY_PAID,
    REQ_STATUS_PENDING,
)

_FP_EPS = Decimal("0.00005")
_WR_EPS = 1e-6
_CREDIT_BALANCES_CF_KEY = "credit_balance_by_currency"
logger = logging.getLogger(__name__)


def client_credit_balances_map(client: Client) -> dict[str, Decimal]:
    """Saldos a favor por moneda (ISO). Migra ``credit_balance`` legacy como USD."""
    out: dict[str, Decimal] = {}
    cf = getattr(client, "custom_fields", None) or {}
    raw = cf.get(_CREDIT_BALANCES_CF_KEY)
    if isinstance(raw, dict):
        for key, val in raw.items():
            try:
                cur = normalize_currency_code(str(key))
                amt = Decimal(str(val)).quantize(Decimal("0.01"))
                if amt > _FP_EPS:
                    out[cur] = amt
            except Exception:
                continue
    legacy = Decimal(str(getattr(client, "credit_balance", 0) or 0)).quantize(Decimal("0.01"))
    if legacy > _FP_EPS and "USD" not in out:
        out["USD"] = legacy
    return out


def get_client_credit_balance(
    client: Client,
    currency: str,
    *,
    db: Optional[Session] = None,
) -> Decimal:
    """Saldo a favor utilizable en la moneda (persistido + sobrepagos CxC no abonados)."""
    cur = normalize_currency_code(currency)
    if db is not None:
        return effective_client_credit_balances_map(db, client).get(cur, Decimal("0"))
    return client_credit_balances_map(client).get(cur, Decimal("0"))


def list_client_credit_balance_rows(
    client: Client,
    *,
    currency: Optional[str] = None,
    db: Optional[Session] = None,
) -> list[tuple[str, Decimal]]:
    source = (
        effective_client_credit_balances_map(db, client)
        if db is not None
        else client_credit_balances_map(client)
    )
    rows = [
        (cur, amt)
        for cur, amt in sorted(source.items())
        if amt > _FP_EPS
    ]
    if currency:
        cur = normalize_currency_code(currency)
        return [(c, a) for c, a in rows if c == cur]
    return rows


_SALE_STATUSES_FOR_OVERCREDIT = (
    SaleStatus.pending,
    SaleStatus.approved,
    SaleStatus.partially_paid,
    SaleStatus.payment_submitted,
)


def compute_client_sale_overcredit_by_currency(db: Session, client_id: int) -> dict[str, Decimal]:
    """
    Detecta cobros que exceden el total de factura (CxC negativo operativo).

    Cubre pagos legacy donde ``amount_paid`` o allocations superan el total facturado
    pero el excedente no quedó en ``credit_balance_by_currency``.
    """
    by_cur: dict[str, Decimal] = {}
    sales = (
        db.query(Sale)
        .options(joinedload(Sale.product), joinedload(Sale.screen_stock_row))
        .filter(
            Sale.client_id == int(client_id),
            Sale.status.in_(_SALE_STATUSES_FOR_OVERCREDIT),
        )
        .all()
    )
    for sale in sales:
        total = _sale_invoice_total(db, sale)
        if total <= _FP_EPS:
            continue
        approved = _approved_alloc_sum_for_sale(db, int(sale.id))
        try:
            paid_legacy = Decimal(str(sale.amount_paid or 0)).quantize(Decimal("0.0001"))
        except Exception:
            paid_legacy = Decimal("0")
        applied = max(approved, paid_legacy)
        over = (applied - total).quantize(Decimal("0.01"))
        if over <= _FP_EPS:
            continue
        cur = normalize_currency_code(str(sale.currency or "USD"))
        by_cur[cur] = by_cur.get(cur, Decimal("0")) + over
    return {k: v.quantize(Decimal("0.01")) for k, v in by_cur.items() if v > _FP_EPS}


def effective_client_credit_balances_map(db: Session, client: Client) -> dict[str, Decimal]:
    """Saldo a favor disponible derivado del libro de cobros (pagos − allocations)."""
    return compute_client_credit_from_payment_ledger(db, int(client.id))


def sync_client_credit_from_overpay(db: Session, client: Client) -> None:
    """Alinea ``credit_balance_by_currency`` con el saldo real (cobros aprobados − allocations)."""
    target = compute_client_credit_from_payment_ledger(db, int(client.id))
    _persist_client_credit_balances_map(client, target)


def compute_client_credit_summary(
    db: Session,
    client_id: int,
    *,
    sync: bool = False,
) -> dict[str, object]:
    """
    Resumen de saldos a favor por moneda para API / portal.

    ``credit_balance`` legacy: monto en la moneda de mayor crédito (o USD si no hay).
    """
    client = db.get(Client, int(client_id))
    if client is None:
        return {
            "credit_balance": 0.0,
            "credit_balance_currency": "USD",
            "credit_balances_by_currency": [],
            "available_credit_by_currency": [],
        }
    if sync:
        sync_client_credit_from_overpay(db, client)
        db.flush()
    effective = effective_client_credit_balances_map(db, client)
    rows = [
        {"currency": cur, "amount": round(float(amt), 2)}
        for cur, amt in sorted(effective.items(), key=lambda x: (-x[1], x[0]))
        if amt > _FP_EPS
    ]
    if not rows:
        return {
            "credit_balance": 0.0,
            "credit_balance_currency": "USD",
            "credit_balances_by_currency": [],
            "available_credit_by_currency": [],
        }
    primary = rows[0]
    return {
        "credit_balance": float(primary["amount"]),
        "credit_balance_currency": str(primary["currency"]),
        "credit_balances_by_currency": rows,
        "available_credit_by_currency": rows,
    }


def _persist_client_credit_balances_map(client: Client, balances: dict[str, Decimal]) -> None:
    cleaned = {
        cur: float(amt.quantize(Decimal("0.01")))
        for cur, amt in balances.items()
        if amt > _FP_EPS
    }
    cf = dict(getattr(client, "custom_fields", None) or {})
    if cleaned:
        cf[_CREDIT_BALANCES_CF_KEY] = cleaned
    elif _CREDIT_BALANCES_CF_KEY in cf:
        del cf[_CREDIT_BALANCES_CF_KEY]
    client.custom_fields = cf
    client.credit_balance = float(cleaned.get("USD", 0.0))


def add_client_credit_balance(
    db: Session,
    client: Client,
    currency: str,
    delta: Decimal,
) -> None:
    """Incrementa saldo a favor del cliente en la moneda indicada."""
    add = delta.quantize(Decimal("0.01"))
    if add <= _FP_EPS:
        return
    cur = normalize_currency_code(currency)
    _increment_client_credit_balance(db, client, cur, add)
    sweep_client_unallocated_funds_to_obligations_fifo(db, client, currency=cur)


def _increment_client_credit_balance(
    db: Session,
    client: Client,
    currency: str,
    delta: Decimal,
) -> None:
    """Persiste incremento de saldo a favor sin barrido FIFO (uso interno en aprobaciones)."""
    add = delta.quantize(Decimal("0.01"))
    if add <= _FP_EPS:
        return
    cur = normalize_currency_code(currency)
    balances = client_credit_balances_map(client)
    prev = balances.get(cur, Decimal("0"))
    balances[cur] = (prev + add).quantize(Decimal("0.01"))
    _persist_client_credit_balances_map(client, balances)
    db.flush()


def subtract_client_credit_balance(
    db: Session,
    client: Client,
    currency: str,
    amount: Decimal,
) -> Decimal:
    """Resta hasta ``amount`` del saldo a favor; devuelve lo efectivamente descontado."""
    take = amount.quantize(Decimal("0.01"))
    if take <= _FP_EPS:
        return Decimal("0")
    cur = normalize_currency_code(currency)
    balances = client_credit_balances_map(client)
    prev = balances.get(cur, Decimal("0"))
    applied = min(prev, take).quantize(Decimal("0.01"))
    if applied <= _FP_EPS:
        return Decimal("0")
    balances[cur] = (prev - applied).quantize(Decimal("0.01"))
    if balances[cur] <= _FP_EPS:
        balances.pop(cur, None)
    _persist_client_credit_balances_map(client, balances)
    db.flush()
    return applied


def _pending_review_alloc_sum_for_sale(
    db: Session,
    sale_id: int,
    *,
    exclude_payment_id: Optional[int] = None,
) -> Decimal:
    """Suma allocations en revisión hacia una factura (opcionalmente excluye un pago)."""
    q = (
        db.query(func.coalesce(func.sum(PaymentAllocation.amount_applied), 0))
        .join(ClientPayment, PaymentAllocation.payment_id == ClientPayment.id)
        .filter(
            PaymentAllocation.sale_id == int(sale_id),
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
    )
    if exclude_payment_id is not None:
        q = q.filter(ClientPayment.id != int(exclude_payment_id))
    agg = q.scalar()
    try:
        return Decimal(str(agg or 0)).quantize(Decimal("0.0001"))
    except Exception:
        return Decimal("0")


def _approved_alloc_sum_for_wallet_recharge(
    db: Session,
    wallet_recharge_id: int,
    *,
    exclude_payment_id: Optional[int] = None,
) -> Decimal:
    """Suma cobros aprobados aplicados a una recarga BaaS."""
    q = (
        db.query(func.coalesce(func.sum(PaymentAllocation.amount_applied), 0))
        .join(ClientPayment, PaymentAllocation.payment_id == ClientPayment.id)
        .filter(
            PaymentAllocation.wallet_recharge_id == int(wallet_recharge_id),
            ClientPayment.status == ClientPaymentStatus.approved,
        )
    )
    if exclude_payment_id is not None:
        q = q.filter(ClientPayment.id != int(exclude_payment_id))
    agg = q.scalar()
    try:
        return Decimal(str(agg or 0)).quantize(Decimal("0.0001"))
    except Exception:
        return Decimal("0")


def _pending_review_alloc_sum_for_wallet_recharge(
    db: Session,
    wallet_recharge_id: int,
    *,
    exclude_payment_id: Optional[int] = None,
) -> Decimal:
    """Suma allocations en revisión hacia una recarga BaaS."""
    q = (
        db.query(func.coalesce(func.sum(PaymentAllocation.amount_applied), 0))
        .join(ClientPayment, PaymentAllocation.payment_id == ClientPayment.id)
        .filter(
            PaymentAllocation.wallet_recharge_id == int(wallet_recharge_id),
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
    )
    if exclude_payment_id is not None:
        q = q.filter(ClientPayment.id != int(exclude_payment_id))
    agg = q.scalar()
    try:
        return Decimal(str(agg or 0)).quantize(Decimal("0.0001"))
    except Exception:
        return Decimal("0")


def _load_client_wallet_recharge_for_payment(
    db: Session,
    payment: ClientPayment,
    wallet_recharge_id: int,
) -> Optional[WalletRechargeRequest]:
    req = db.get(WalletRechargeRequest, int(wallet_recharge_id))
    if req is None or int(req.client_id) != int(payment.client_id):
        return None
    return req


def _effective_open_balance_for_wallet_recharge_apply(
    db: Session,
    req: WalletRechargeRequest,
    payment: Optional[ClientPayment],
    session_allocated_wr: Optional[dict[int, Decimal]] = None,
) -> Decimal:
    """Saldo CxC vivo de recarga BaaS al aplicar un cobro."""
    from app.wallet_recharge_helpers import wallet_recharge_open_balance

    product_total = Decimal(str(getattr(req, "amount_requested", 0) or 0)).quantize(Decimal("0.0001"))
    if product_total <= _FP_EPS:
        bp = Decimal(str(wallet_recharge_open_balance(req))).quantize(Decimal("0.0001"))
    else:
        excl = int(payment.id) if payment is not None else None
        approved = _approved_alloc_sum_for_wallet_recharge(db, int(req.id), exclude_payment_id=excl)
        pending = _pending_review_alloc_sum_for_wallet_recharge(db, int(req.id), exclude_payment_id=excl)
        bp = max(Decimal("0"), (product_total - approved - pending).quantize(Decimal("0.0001")))
        legacy_bp = Decimal(str(wallet_recharge_open_balance(req))).quantize(Decimal("0.0001"))
        if legacy_bp > _FP_EPS:
            bp = min(bp, legacy_bp) if bp > _FP_EPS else legacy_bp
    if session_allocated_wr:
        consumed = _q_amt(session_allocated_wr.get(int(req.id), Decimal("0")))
        bp = max(Decimal("0"), _q_amt(bp - consumed))
    return bp


def sync_wallet_recharge_amount_paid_from_allocations(
    db: Session,
    req: WalletRechargeRequest,
) -> None:
    """Alinea ``amount_paid`` / ``balance_pending`` con allocations CxC."""
    from app.wallet_recharge_helpers import (
        REQ_STATUS_APPROVED,
        REQ_STATUS_PARTIALLY_PAID,
        clear_wallet_recharge_retiro_instant_cxc,
        wallet_recharge_open_balance,
    )

    approved = _approved_alloc_sum_for_wallet_recharge(db, int(req.id))
    pending = _pending_review_alloc_sum_for_wallet_recharge(db, int(req.id))
    paid = (approved + pending).quantize(Decimal("0.0001"))
    product_total = Decimal(str(getattr(req, "amount_requested", 0) or 0)).quantize(Decimal("0.0001"))
    if product_total <= _FP_EPS:
        product_total = Decimal(str(wallet_recharge_open_balance(req) + float(paid))).quantize(
            Decimal("0.0001")
        )
    req.amount_paid = float(paid)
    open_bal = max(Decimal("0"), product_total - paid).quantize(Decimal("0.0001"))
    req.balance_pending = float(open_bal)
    if open_bal <= _FP_EPS:
        req.balance_pending = 0.0
        req.status = REQ_STATUS_APPROVED
        clear_wallet_recharge_retiro_instant_cxc(req)
    elif paid > _FP_EPS:
        req.status = REQ_STATUS_PARTIALLY_PAID


def refresh_wallet_recharge_after_payment(db: Session, req: WalletRechargeRequest) -> None:
    """Actualiza saldos CxC de recarga BaaS tras aplicar cobros."""
    sync_wallet_recharge_amount_paid_from_allocations(db, req)


def _apply_amount_to_wallet_recharge(
    db: Session,
    req: WalletRechargeRequest,
    payment: ClientPayment,
    apply: Decimal,
) -> None:
    """Reduce CxC de recarga BaaS (entrega virtual al primer abono vía ``credit_wallet_on_baas_fifo_allocation``)."""
    from app.wallet_recharge_helpers import (
        REQ_STATUS_APPROVED,
        REQ_STATUS_PARTIALLY_PAID,
        clear_wallet_recharge_retiro_instant_cxc,
        wallet_recharge_open_balance,
    )

    applied_f = float(_q_amt(apply))
    pending_before = wallet_recharge_open_balance(req)
    actual = min(applied_f, pending_before) if pending_before > _WR_EPS else applied_f
    req.amount_paid = float(getattr(req, "amount_paid", 0) or 0) + actual
    req.balance_pending = max(0.0, pending_before - actual)
    if req.balance_pending <= _WR_EPS:
        req.balance_pending = 0.0
        req.status = REQ_STATUS_APPROVED
        clear_wallet_recharge_retiro_instant_cxc(req)
    else:
        req.status = REQ_STATUS_PARTIALLY_PAID
    db.flush()


def _approved_alloc_sum_for_sale(
    db: Session,
    sale_id: int,
    *,
    exclude_payment_id: Optional[int] = None,
) -> Decimal:
    """Suma cobros ya aprobados aplicados a la factura (fuente de verdad CxC)."""
    q = (
        db.query(func.coalesce(func.sum(PaymentAllocation.amount_applied), 0))
        .join(ClientPayment, PaymentAllocation.payment_id == ClientPayment.id)
        .filter(
            PaymentAllocation.sale_id == int(sale_id),
            ClientPayment.status == ClientPaymentStatus.approved,
        )
    )
    if exclude_payment_id is not None:
        q = q.filter(ClientPayment.id != int(exclude_payment_id))
    agg = q.scalar()
    try:
        return Decimal(str(agg or 0)).quantize(Decimal("0.0001"))
    except Exception:
        return Decimal("0")


def _sale_cxc_open_balance(
    db: Session,
    sale: Sale,
    payment: Optional[ClientPayment] = None,
) -> Decimal:
    """
    Saldo CxC pendiente en moneda de la factura.

    Usa allocations aprobadas (no ``sale.amount_paid``), para no quedar en cero cuando
    el campo legacy fue inflado antes de registrar el cobro en el libro mayor.
    """
    real_total = _sale_invoice_total(db, sale)
    if real_total <= _FP_EPS:
        return Decimal("0")
    excl = int(payment.id) if payment is not None else None
    approved = _approved_alloc_sum_for_sale(db, int(sale.id), exclude_payment_id=excl)
    pend = _pending_review_alloc_sum_for_sale(db, int(sale.id), exclude_payment_id=excl)
    return max(Decimal("0"), (real_total - approved - pend).quantize(Decimal("0.0001")))


def sync_sale_amount_paid_from_allocations(db: Session, sale: Sale) -> None:
    """Alinea ``sale.amount_paid`` con cobros aprobados + allocations en revisión."""
    approved = _approved_alloc_sum_for_sale(db, int(sale.id))
    pending = _pending_review_alloc_sum_for_sale(db, int(sale.id))
    sale.amount_paid = (approved + pending).quantize(Decimal("0.0001"))


def _sale_invoice_total(db: Session, sale: Sale) -> Decimal:
    """Total facturado con fallbacks (líneas → checkout → local_amount/amount)."""
    from app.api.v1.portal import (
        _checkout_lines_public,
        _infer_local_amount_for_checkout,
        _real_total_from_raw_lines,
    )

    raw_total = _real_total_from_raw_lines(sale)
    if raw_total > _FP_EPS:
        return raw_total
    lines = _checkout_lines_public(db, sale, product=sale.product, stock_row=sale.screen_stock_row)
    inferred = _infer_local_amount_for_checkout(sale, lines)
    if inferred and inferred > _FP_EPS:
        return inferred
    for attr in ("local_amount", "amount"):
        val = getattr(sale, attr, None)
        if val is None:
            continue
        try:
            fallback = Decimal(str(val)).quantize(Decimal("0.0001"))
            if fallback > _FP_EPS:
                return fallback
        except Exception:
            continue
    return Decimal("0")


def _sale_open_ar_balance(
    db: Session,
    sale: Sale,
    payment: Optional[ClientPayment] = None,
) -> Decimal:
    """Saldo CxC pendiente de la factura al aplicar un cobro (misma lógica que portal)."""
    return _sale_cxc_open_balance(db, sale, payment)


def _sale_balance_for_payment_apply(
    db: Session, sale: Sale, payment: ClientPayment
) -> tuple[Decimal, Decimal]:
    """
    Saldo CxC al aplicar un cobro: ignora allocations ``pending_review`` del propio pago
    para no «liquidar» ficticiamente la factura antes de registrar el abono real.
    """
    real_total = _sale_invoice_total(db, sale)
    balance = _sale_open_ar_balance(db, sale, payment)
    return real_total, balance


def _sale_balance(
    db: Session, sale: Sale, payment: Optional[ClientPayment] = None
) -> tuple[Decimal, Decimal]:
    if payment is not None:
        return _sale_balance_for_payment_apply(db, sale, payment)
    real_total = _sale_invoice_total(db, sale)
    balance = _sale_cxc_open_balance(db, sale, payment=None)
    return real_total, balance


def _effective_open_balance_for_apply(
    db: Session,
    sale: Sale,
    payment: ClientPayment,
    session_allocated: Optional[dict[int, Decimal]] = None,
) -> Decimal:
    """
    Saldo CxC disponible al repartir un cobro, descontando asignaciones ya hechas
    en la misma operación (evita doble asignación fase objetivo + waterfall).
    """
    base = _sale_open_ar_balance(db, sale, payment)
    if session_allocated:
        consumed = _q_amt(session_allocated.get(int(sale.id), Decimal("0")))
        base = max(Decimal("0"), _q_amt(base - consumed))
    return base


def _payment_applied_total(db: Session, payment: ClientPayment) -> Decimal:
    """Suma de ``PaymentAllocation`` persistidas para un cobro."""
    agg = (
        db.query(func.coalesce(func.sum(PaymentAllocation.amount_applied), 0))
        .filter(PaymentAllocation.payment_id == int(payment.id))
        .scalar()
    )
    return _q_amt(agg)


def cap_allocation_for_sale(
    db: Session,
    payment: ClientPayment,
    sale: Sale,
    requested: Decimal | float | str,
    *,
    session_allocated: Optional[dict[int, Decimal]] = None,
) -> Decimal:
    """
    Tope seguro antes de crear ``PaymentAllocation``.

    Devuelve 0 si la factura ya no tiene saldo CxC pendiente.
    """
    balance = _effective_open_balance_for_apply(db, sale, payment, session_allocated)
    if balance <= _FP_EPS:
        return Decimal("0")
    req = _q_amt(requested)
    if req <= _FP_EPS:
        return Decimal("0")
    return min(req, balance)


def cap_allocation_for_wallet_recharge(
    db: Session,
    payment: ClientPayment,
    req: WalletRechargeRequest,
    requested: Decimal | float | str,
    *,
    session_allocated_wr: Optional[dict[int, Decimal]] = None,
) -> Decimal:
    """Tope seguro antes de crear ``PaymentAllocation`` hacia recarga BaaS."""
    balance = _effective_open_balance_for_wallet_recharge_apply(
        db, req, payment, session_allocated_wr
    )
    if balance <= _FP_EPS:
        return Decimal("0")
    req_amt = _q_amt(requested)
    if req_amt <= _FP_EPS:
        return Decimal("0")
    return min(req_amt, balance)


def _payment_unallocated_balance(db: Session, payment: ClientPayment) -> Decimal:
    """Remanente de un cobro aprobado (depósito) no asignado a facturas."""
    if payment.status != ClientPaymentStatus.approved:
        return Decimal("0")
    if is_client_payment_credit_only(payment):
        return Decimal("0")
    paid = _q_amt(payment.amount)
    applied = _payment_applied_total(db, payment)
    return max(Decimal("0"), _q_amt(paid - applied))


def list_client_payments_with_unallocated_balance(
    db: Session,
    client_id: int,
    currency: str,
) -> list[tuple[ClientPayment, Decimal]]:
    """Cobros aprobados con remanente disponible (FIFO: más antiguo primero)."""
    cur = normalize_currency_code(currency)
    payments = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == int(client_id),
            ClientPayment.status == ClientPaymentStatus.approved,
        )
        .order_by(ClientPayment.created_at.asc(), ClientPayment.id.asc())
        .all()
    )
    out: list[tuple[ClientPayment, Decimal]] = []
    for payment in payments:
        if normalize_currency_code(str(payment.currency or "USD")) != cur:
            continue
        rem = _payment_unallocated_balance(db, payment)
        if rem > _FP_EPS:
            out.append((payment, rem))
    return out


def _sum_unallocated_deposit_payments(db: Session, client_id: int, currency: str) -> Decimal:
    """Saldo a favor real = suma de remanentes en cobros depósito aprobados."""
    total = sum((rem for _, rem in list_client_payments_with_unallocated_balance(db, client_id, currency)), Decimal("0"))
    return _q_amt(total)


def allocate_client_credit_remainder_to_sale(
    db: Session,
    client: Client,
    sale: Sale,
    amount: Decimal,
) -> tuple[Decimal, list[PaymentAllocation], list[ClientPayment]]:
    """
    Cruza saldo a favor consumiendo remanentes de cobros previos (sin pagos fantasma).

    Crea ``PaymentAllocation`` desde cada cobro con ``monto − asignaciones > 0`` (FIFO)
    hasta cubrir ``amount`` o agotar el pool.
    """
    cap = _q_amt(amount)
    if cap <= _FP_EPS:
        return Decimal("0"), [], []

    balance = _sale_cxc_open_balance(db, sale, payment=None)
    if balance <= _FP_EPS:
        return Decimal("0"), [], []

    to_apply = min(cap, balance)
    cur = normalize_currency_code(str(sale.currency or "USD"))
    now_iso = isoformat_z(now_ecuador())

    created: list[PaymentAllocation] = []
    touched_payments: list[ClientPayment] = []
    remaining = _q_amt(to_apply)
    session_allocated: dict[int, Decimal] = {}

    for source_pay, _avail_hint in list_client_payments_with_unallocated_balance(
        db, int(client.id), cur
    ):
        if remaining <= _FP_EPS:
            break
        avail = min(_payment_unallocated_balance(db, source_pay), remaining)
        if avail <= _FP_EPS:
            continue
        slice_amt = cap_allocation_for_sale(
            db, source_pay, sale, avail, session_allocated=session_allocated
        )
        if slice_amt <= _FP_EPS:
            continue

        _apply_amount_to_sale(db, sale, source_pay, slice_amt, cur, now_iso)
        alloc = _record_payment_allocation(
            db,
            source_pay,
            sale_id=int(sale.id),
            amount=slice_amt,
        )
        created.append(alloc)
        if source_pay not in touched_payments:
            touched_payments.append(source_pay)
        session_allocated[int(sale.id)] = _q_amt(
            session_allocated.get(int(sale.id), Decimal("0")) + slice_amt
        )
        remaining = _q_amt(remaining - slice_amt)

    if not created:
        return Decimal("0"), [], []

    db.flush()

    from app.services.client_payment_accounting_sync import sync_client_payment_accounting_ledgers

    for source_pay in touched_payments:
        try:
            sync_client_payment_accounting_ledgers(db, source_pay, strict=False)
        except Exception:
            pass

    sync_sale_amount_paid_from_allocations(db, sale)
    refresh_sale_status_after_payment(db, sale)

    applied_total = _q_amt(to_apply - remaining)
    if applied_total > _FP_EPS:
        subtract_client_credit_balance(db, client, cur, applied_total)
    sync_client_credit_from_overpay(db, client)
    db.flush()

    return applied_total, created, touched_payments


_UNPAID_INVOICE_STATUSES = (
    SaleStatus.pending,
    SaleStatus.approved,
    SaleStatus.partially_paid,
    SaleStatus.payment_submitted,
)

_OPEN_SALE_STATUSES = (
    SaleStatus.partially_paid,
    SaleStatus.pending,
    SaleStatus.payment_submitted,
    SaleStatus.approved,
)


def next_payment_number(db: Session) -> str:
    """Genera PAG-1001, PAG-1002, …"""
    last_id = db.query(func.max(ClientPayment.id)).scalar()
    seq = int(last_id or 0) + 1
    return f"PAG-{1000 + seq}"


def _q_amt(v: object) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.0001"))


def list_unpaid_invoices(
    db: Session,
    client_id: int,
    *,
    currency: Optional[str] = None,
    payment: Optional[ClientPayment] = None,
) -> list[dict]:
    """Facturas con saldo CxC > 0, orden FIFO (``created_at`` asc)."""
    cur_filter = normalize_currency_code(currency) if currency else None
    sales = (
        db.query(Sale)
        .options(joinedload(Sale.product), joinedload(Sale.screen_stock_row))
        .filter(
            Sale.client_id == int(client_id),
            Sale.status.in_(_UNPAID_INVOICE_STATUSES),
        )
        .order_by(Sale.created_at.asc(), Sale.id.asc())
        .all()
    )
    rows: list[dict] = []
    for s in sales:
        if cur_filter and normalize_currency_code(str(s.currency or "USD")) != cur_filter:
            continue
        if payment is not None:
            real_total, balance = _sale_balance(db, s, payment)
        else:
            real_total, balance = _sale_balance(db, s)
        if balance <= _FP_EPS:
            continue
        total_f = float(real_total)
        bal_f = float(balance)
        rows.append(
            {
                "obligation_kind": "sale",
                "sale_id": int(s.id),
                "wallet_recharge_id": None,
                "reference": sale_ref_number(s.id),
                "date": s.created_at,
                "total_amount": total_f,
                "open_balance": bal_f,
                "currency": normalize_currency_code(str(s.currency or "USD")),
            }
        )
    return rows


def list_unpaid_wallet_recharges(
    db: Session,
    client_id: int,
    *,
    currency: Optional[str] = None,
) -> list[dict]:
    """Recargas BaaS con saldo CxC vivo (``balance_pending`` tras abonos aprobados)."""
    from app.wallet_recharge_helpers import wallet_recharge_contributes_to_client_debt

    cur_filter = normalize_currency_code(currency) if currency else None
    rows: list[dict] = []
    wrs = (
        db.query(WalletRechargeRequest)
        .filter(WalletRechargeRequest.client_id == int(client_id))
        .order_by(WalletRechargeRequest.created_at.asc(), WalletRechargeRequest.id.asc())
        .all()
    )
    for r in wrs:
        if not wallet_recharge_contributes_to_client_debt(r):
            continue
        bp = float(getattr(r, "balance_pending", 0) or 0)
        if bp <= 1e-6:
            continue
        cur = normalize_currency_code(str(getattr(r, "recharge_currency", None) or "USD"))
        if cur_filter and cur != cur_filter:
            continue
        rows.append(
            {
                "obligation_kind": "wallet_recharge",
                "sale_id": None,
                "wallet_recharge_id": int(r.id),
                "reference": wallet_recharge_ref_number(int(r.id)),
                "date": r.created_at,
                "total_amount": round(float(r.amount_requested or 0), 2),
                "open_balance": round(bp, 2),
                "currency": cur,
                "_wallet_recharge_row": r,
            }
        )
    return rows


def list_client_ar_open_obligations(
    db: Session,
    client_id: int,
    *,
    currency: Optional[str] = None,
) -> list[dict]:
    """Facturas y recargas BaaS con saldo CxC > 0 (FIFO por fecha)."""
    merged = list_unpaid_invoices(db, client_id, currency=currency) + list_unpaid_wallet_recharges(
        db, client_id, currency=currency
    )
    merged.sort(
        key=lambda row: (
            row.get("date") or datetime.min.replace(tzinfo=UTC),
            int(row.get("wallet_recharge_id") or row.get("sale_id") or 0),
        )
    )
    return merged


def _load_client_sale_for_payment(db: Session, payment: ClientPayment, sale_id: int) -> Optional[Sale]:
    return (
        db.query(Sale)
        .options(joinedload(Sale.product), joinedload(Sale.screen_stock_row))
        .filter(Sale.id == int(sale_id), Sale.client_id == int(payment.client_id))
        .first()
    )


def _allocation_amount(row: dict) -> Decimal:
    raw = row.get("applied_amount")
    if raw is None:
        raw = row.get("amount_applied")
    return _q_amt(raw or 0)


def _find_payment_allocation_for_obligation(
    db: Session,
    payment_id: int,
    *,
    sale_id: Optional[int] = None,
    wallet_recharge_id: Optional[int] = None,
) -> Optional[PaymentAllocation]:
    """Localiza allocation existente del mismo cobro hacia la misma obligación (sesión o BD)."""
    pid = int(payment_id)
    sid = int(sale_id) if sale_id is not None else None
    wr_id = int(wallet_recharge_id) if wallet_recharge_id is not None else None

    for obj in db:
        if not isinstance(obj, PaymentAllocation):
            continue
        if int(obj.payment_id) != pid:
            continue
        if sid is not None and obj.sale_id is not None and int(obj.sale_id) == sid:
            return obj
        if wr_id is not None and obj.wallet_recharge_id is not None and int(obj.wallet_recharge_id) == wr_id:
            return obj

    q = db.query(PaymentAllocation).filter(PaymentAllocation.payment_id == pid)
    if sid is not None:
        return q.filter(PaymentAllocation.sale_id == sid).first()
    if wr_id is not None:
        return q.filter(PaymentAllocation.wallet_recharge_id == wr_id).first()
    return None


def _record_payment_allocation(
    db: Session,
    payment: ClientPayment,
    *,
    sale_id: Optional[int] = None,
    wallet_recharge_id: Optional[int] = None,
    amount: Decimal,
) -> PaymentAllocation:
    """
    Registra monto aplicado consolidando en una sola fila por (cobro, obligación).

    Evita duplicados visuales cuando el FIFO o el barrido aplican varios tramos
    del mismo pago a la misma factura/recarga en un mismo ciclo.
    """
    amt = _q_amt(amount)
    existing = _find_payment_allocation_for_obligation(
        db,
        int(payment.id),
        sale_id=sale_id,
        wallet_recharge_id=wallet_recharge_id,
    )
    if existing is not None:
        existing.amount_applied = _q_amt(_q_amt(existing.amount_applied) + amt)
        return existing

    kwargs: dict = {
        "payment_id": int(payment.id),
        "amount_applied": amt,
    }
    if sale_id is not None:
        kwargs["sale_id"] = int(sale_id)
    if wallet_recharge_id is not None:
        kwargs["wallet_recharge_id"] = int(wallet_recharge_id)
    alloc = PaymentAllocation(**kwargs)
    db.add(alloc)
    return alloc


def _apply_allocation_slice_to_obligation(
    db: Session,
    payment: ClientPayment,
    *,
    sale: Optional[Sale] = None,
    wallet_recharge: Optional[WalletRechargeRequest] = None,
    amount: Decimal,
    session_allocated: Optional[dict[int, Decimal]] = None,
    session_allocated_wr: Optional[dict[int, Decimal]] = None,
) -> Optional[PaymentAllocation]:
    """Crea una ``PaymentAllocation`` polimórfica hacia venta o recarga BaaS."""
    cur = normalize_currency_code(str(payment.currency or "USD"))
    now_iso = isoformat_z(now_ecuador())

    if sale is not None:
        cap = cap_allocation_for_sale(
            db, payment, sale, amount, session_allocated=session_allocated
        )
        if cap <= _FP_EPS:
            return None
        _apply_amount_to_sale(db, sale, payment, cap, cur, now_iso)
        alloc = _record_payment_allocation(
            db,
            payment,
            sale_id=int(sale.id),
            amount=cap,
        )
        if session_allocated is not None:
            sid = int(sale.id)
            session_allocated[sid] = _q_amt(session_allocated.get(sid, Decimal("0")) + cap)
        return alloc

    if wallet_recharge is not None:
        cap = cap_allocation_for_wallet_recharge(
            db,
            payment,
            wallet_recharge,
            amount,
            session_allocated_wr=session_allocated_wr,
        )
        if cap <= _FP_EPS:
            return None
        try:
            amount_paid_before = float(getattr(wallet_recharge, "amount_paid", 0) or 0)
        except (TypeError, ValueError):
            amount_paid_before = 0.0
        credit_wallet_on_baas_fifo_allocation(
            db,
            wallet_recharge,
            cap,
            payment=payment,
            amount_paid_before=amount_paid_before,
        )
        _apply_amount_to_wallet_recharge(db, wallet_recharge, payment, cap)
        alloc = _record_payment_allocation(
            db,
            payment,
            wallet_recharge_id=int(wallet_recharge.id),
            amount=cap,
        )
        if session_allocated_wr is not None:
            rid = int(wallet_recharge.id)
            session_allocated_wr[rid] = _q_amt(session_allocated_wr.get(rid, Decimal("0")) + cap)
        return alloc

    return None


def _resolve_obligation_entity(
    db: Session,
    client_id: int,
    obl: dict,
) -> tuple[Optional[Sale], Optional[WalletRechargeRequest]]:
    kind = str(obl.get("obligation_kind") or "")
    if kind == "wallet_recharge":
        wr_id = int(obl.get("wallet_recharge_id") or 0)
        if wr_id < 1:
            return None, None
        req = db.get(WalletRechargeRequest, int(wr_id))
        if req is None or int(req.client_id) != int(client_id):
            return None, None
        return None, req
    sid = int(obl.get("sale_id") or 0)
    if sid < 1:
        return None, None
    sale = (
        db.query(Sale)
        .options(joinedload(Sale.product), joinedload(Sale.screen_stock_row))
        .filter(Sale.id == int(sid), Sale.client_id == int(client_id))
        .first()
    )
    return sale, None


def _refresh_obligations_after_allocations(
    db: Session,
    *,
    sale_ids: set[int],
    wallet_recharge_ids: set[int],
    strict_accounting: bool = False,
) -> None:
    """Sincroniza saldos CxC y devengos tras asignaciones."""
    from app.services.accounting_engine import ensure_wallet_recharge_accrual_journal
    from app.services.client_payment_accounting_sync import sync_client_payment_accounting_ledgers

    touched_payments: set[int] = set()
    for sid in sale_ids:
        sale = db.get(Sale, int(sid))
        if sale is None:
            continue
        sync_sale_amount_paid_from_allocations(db, sale)
        refresh_sale_status_after_payment(db, sale)
    for wr_id in wallet_recharge_ids:
        wr = db.get(WalletRechargeRequest, int(wr_id))
        if wr is None:
            continue
        ensure_wallet_recharge_accrual_journal(db, wr, strict=strict_accounting)
        refresh_wallet_recharge_after_payment(db, wr)
    db.flush()


def allocate_client_payment_fifo_cross_module(
    db: Session,
    payment: ClientPayment,
    *,
    pool: Optional[Decimal] = None,
    priority_targets: Optional[list[dict]] = None,
    fifo_cross_module: bool = True,
    session_allocated: Optional[dict[int, Decimal]] = None,
    session_allocated_wr: Optional[dict[int, Decimal]] = None,
    skip_sale_ids: Optional[set[int]] = None,
    skip_wallet_recharge_ids: Optional[set[int]] = None,
) -> tuple[list[PaymentAllocation], Decimal]:
    """
    Función maestra de asignación CxC cruzada (ventas + recargas BaaS).

    1. Consulta ``list_client_ar_open_obligations`` (FIFO cronológico estricto).
    2. Si hay ``priority_targets`` (comprobante / webhook), aplica primero ahí.
    3. Con excedente, liquida deudas más antiguas sin importar módulo de origen.
    4. Ventas → ``PaymentAllocation(sale_id=...)``; BaaS → ``PaymentAllocation(wallet_recharge_id=...)``.
    5. Devuelve allocations creadas y remanente (saldo a favor flotante en el cobro).
    """
    created: list[PaymentAllocation] = []
    cur = normalize_currency_code(str(payment.currency or "USD"))
    pool_amt = _q_amt(pool if pool is not None else payment.amount)
    in_session: dict[int, Decimal] = dict(session_allocated or {})
    in_session_wr: dict[int, Decimal] = dict(session_allocated_wr or {})
    skip_ids: set[int] = set(skip_sale_ids or ())
    skip_wr_ids: set[int] = set(skip_wallet_recharge_ids or ())
    touched_sale_ids: set[int] = set()
    touched_wr_ids: set[int] = set()

    def _track_alloc(alloc: Optional[PaymentAllocation]) -> bool:
        if alloc is None:
            return False
        created.append(alloc)
        if alloc.sale_id is not None:
            touched_sale_ids.add(int(alloc.sale_id))
        if alloc.wallet_recharge_id is not None:
            touched_wr_ids.add(int(alloc.wallet_recharge_id))
        return True

    def _apply_to_row(row: dict, cap: Decimal) -> Decimal:
        nonlocal pool_amt
        if pool_amt <= _FP_EPS or cap <= _FP_EPS:
            return Decimal("0")
        wr_id = int(row.get("wallet_recharge_id") or 0)
        sid = int(row.get("sale_id") or 0)
        sale: Optional[Sale] = None
        req: Optional[WalletRechargeRequest] = None
        if wr_id >= 1:
            if wr_id in skip_wr_ids or wr_id in touched_wr_ids:
                return Decimal("0")
            req = _load_client_wallet_recharge_for_payment(db, payment, wr_id)
            if req is None:
                return Decimal("0")
            wr_cur = normalize_currency_code(str(getattr(req, "recharge_currency", None) or "USD"))
            if wr_cur != cur:
                return Decimal("0")
        elif sid >= 1:
            if sid in skip_ids or sid in touched_sale_ids:
                return Decimal("0")
            sale = _load_client_sale_for_payment(db, payment, sid)
            if sale is None:
                return Decimal("0")
            if normalize_currency_code(str(sale.currency or "USD")) != cur:
                return Decimal("0")
        else:
            return Decimal("0")

        slice_cap = min(_q_amt(cap), pool_amt)
        alloc = _apply_allocation_slice_to_obligation(
            db,
            payment,
            sale=sale,
            wallet_recharge=req,
            amount=slice_cap,
            session_allocated=in_session,
            session_allocated_wr=in_session_wr,
        )
        if not _track_alloc(alloc):
            return Decimal("0")
        applied = _q_amt(alloc.amount_applied)
        pool_amt = _q_amt(pool_amt - applied)
        return applied

    rows = list(priority_targets or [])
    explicit_total = sum(_allocation_amount(r) for r in rows) if rows else Decimal("0")
    multi_target = len(rows) > 1
    intentional_split = (
        multi_target
        and explicit_total > _FP_EPS
        and explicit_total <= pool_amt + _FP_EPS
    )
    for row in rows:
        if pool_amt <= _FP_EPS:
            break
        row_amt = _allocation_amount(row)
        if intentional_split and row_amt > _FP_EPS:
            cap = min(_q_amt(row_amt), pool_amt)
        else:
            cap = pool_amt
        _apply_to_row(row, cap)

    if fifo_cross_module and pool_amt > _FP_EPS:
        for obl in list_client_ar_open_obligations(db, payment.client_id, currency=cur):
            if pool_amt <= _FP_EPS:
                break
            kind = str(obl.get("obligation_kind") or "")
            if kind == "wallet_recharge":
                wr_id = int(obl.get("wallet_recharge_id") or 0)
                if wr_id in touched_wr_ids or wr_id in skip_wr_ids:
                    continue
                row = {"wallet_recharge_id": wr_id}
            else:
                sid = int(obl.get("sale_id") or 0)
                if sid in touched_sale_ids or sid in skip_ids:
                    continue
                row = {"sale_id": sid}
            _apply_to_row(row, pool_amt)

    if created:
        db.flush()
    return created, pool_amt


def sweep_client_unallocated_funds_to_obligations_fifo(
    db: Session,
    client: Client,
    *,
    currency: Optional[str] = None,
    strict_accounting: bool = False,
) -> list[PaymentAllocation]:
    """
    Cruza automáticamente saldo a favor (remanentes de cobros aprobados) contra
    deudas CxC abiertas del cliente en orden FIFO cronológico estricto.

    Se dispara tras aprobar un cobro o cuando hay fondos disponibles sin asignar.
    """
    cid = int(client.id)
    cur_filter = normalize_currency_code(currency) if currency else None
    currencies: set[str] = set()
    if cur_filter:
        currencies.add(cur_filter)
    else:
        approved_pays = (
            db.query(ClientPayment)
            .filter(
                ClientPayment.client_id == cid,
                ClientPayment.status == ClientPaymentStatus.approved,
            )
            .all()
        )
        for pay in approved_pays:
            if _payment_unallocated_balance(db, pay) > _FP_EPS:
                currencies.add(normalize_currency_code(str(pay.currency or "USD")))
        for obl in list_client_ar_open_obligations(db, cid):
            currencies.add(normalize_currency_code(str(obl.get("currency") or "USD")))

    created_all: list[PaymentAllocation] = []
    touched_sale_ids: set[int] = set()
    touched_wr_ids: set[int] = set()
    touched_payment_ids: set[int] = set()

    for cur in sorted(currencies):
        obligations = list_client_ar_open_obligations(db, cid, currency=cur)
        if not obligations:
            continue

        session_allocated: dict[int, Decimal] = {}
        session_allocated_wr: dict[int, Decimal] = {}

        for obl in obligations:
            sale, req = _resolve_obligation_entity(db, cid, obl)
            if sale is None and req is None:
                continue

            while True:
                if sale is not None:
                    open_bal = _effective_open_balance_for_apply(
                        db, sale, None, session_allocated
                    )
                else:
                    assert req is not None
                    open_bal = _effective_open_balance_for_wallet_recharge_apply(
                        db, req, None, session_allocated_wr
                    )
                if open_bal <= _FP_EPS:
                    break

                sources = list_client_payments_with_unallocated_balance(db, cid, cur)
                if not sources:
                    break

                source_pay, _hint = sources[0]
                avail = _payment_unallocated_balance(db, source_pay)
                if avail <= _FP_EPS:
                    break

                apply_amt = min(avail, open_bal)
                alloc = _apply_allocation_slice_to_obligation(
                    db,
                    source_pay,
                    sale=sale,
                    wallet_recharge=req,
                    amount=apply_amt,
                    session_allocated=session_allocated,
                    session_allocated_wr=session_allocated_wr,
                )
                if alloc is None:
                    break

                created_all.append(alloc)
                touched_payment_ids.add(int(source_pay.id))
                if alloc.sale_id is not None:
                    touched_sale_ids.add(int(alloc.sale_id))
                if alloc.wallet_recharge_id is not None:
                    touched_wr_ids.add(int(alloc.wallet_recharge_id))

        if created_all:
            db.flush()

    if not created_all:
        return []

    _refresh_obligations_after_allocations(
        db,
        sale_ids=touched_sale_ids,
        wallet_recharge_ids=touched_wr_ids,
        strict_accounting=strict_accounting,
    )

    from app.services.client_payment_accounting_sync import sync_client_payment_accounting_ledgers

    for pid in sorted(touched_payment_ids):
        pay = db.get(ClientPayment, int(pid))
        if pay is not None:
            try:
                sync_client_payment_accounting_ledgers(db, pay, strict=strict_accounting)
            except Exception:
                if strict_accounting:
                    raise

    sync_client_credit_from_overpay(db, client)
    db.flush()

    from app.services.codigos_retiro_erp_notify import (
        schedule_codigos_retiro_erp_notify_for_allocations_batch,
    )

    schedule_codigos_retiro_erp_notify_for_allocations_batch(db, created_all)
    return created_all


def try_sweep_client_credit_on_new_cxc(
    db: Session,
    client: Client,
    *,
    currency: str,
    strict_accounting: bool = False,
) -> None:
    """Tras consolidar una nueva deuda CxC, cruza saldo a favor disponible (FIFO)."""
    try:
        sweep_client_unallocated_funds_to_obligations_fifo(
            db,
            client,
            currency=normalize_currency_code(currency),
            strict_accounting=strict_accounting,
        )
    except Exception:
        logger.exception(
            "Sweep saldo a favor tras nueva CxC falló client_id=%s currency=%s",
            getattr(client, "id", None),
            currency,
        )


def apply_payment_allocations(
    db: Session,
    payment: ClientPayment,
    allocations: Optional[list[dict]] = None,
    *,
    fifo_fallback: bool = True,
    initial_pool: Optional[Decimal] = None,
    session_allocated: Optional[dict[int, Decimal]] = None,
    session_allocated_wr: Optional[dict[int, Decimal]] = None,
    skip_sale_ids: Optional[set[int]] = None,
    skip_wallet_recharge_ids: Optional[set[int]] = None,
) -> tuple[list[PaymentAllocation], Decimal]:
    """Delega en ``allocate_client_payment_fifo_cross_module`` (compatibilidad)."""
    return allocate_client_payment_fifo_cross_module(
        db,
        payment,
        pool=initial_pool,
        priority_targets=allocations,
        fifo_cross_module=fifo_fallback,
        session_allocated=session_allocated,
        session_allocated_wr=session_allocated_wr,
        skip_sale_ids=skip_sale_ids,
        skip_wallet_recharge_ids=skip_wallet_recharge_ids,
    )


def compute_payment_credit_excess(
    payment: ClientPayment,
    created: Optional[list[PaymentAllocation]] = None,
    pool_remainder: Optional[Decimal] = None,
    *,
    db: Optional[Session] = None,
) -> Decimal:
    """
    Excedente real del cobro: ``monto_total − suma(asignaciones)``, tomando también
    el remanente devuelto por el motor FIFO cuando aún no está persistido en BD.
    """
    paid_total = _q_amt(payment.amount)
    if db is not None:
        applied = _payment_applied_total(db, payment)
    elif created is not None:
        applied = sum((_q_amt(a.amount_applied) for a in created), Decimal("0"))
    else:
        applied = Decimal("0")
    ledger_excess = (paid_total - applied).quantize(Decimal("0.01"))
    pool_left = _q_amt(pool_remainder) if pool_remainder is not None else Decimal("0")
    excess = max(ledger_excess, pool_left)
    return excess if excess > _FP_EPS else Decimal("0")


def add_payment_remainder_to_client_credit_balance(
    db: Session, payment: ClientPayment, remaining: Decimal | None
) -> None:
    """Suma el excedente no aplicado a CxC como saldo a favor en la moneda del pago."""
    if remaining is None or remaining <= _FP_EPS:
        return
    add = remaining.quantize(Decimal("0.01"))
    if add <= _FP_EPS:
        return
    c = db.get(Client, int(payment.client_id))
    if c is None:
        return
    cur = normalize_currency_code(str(payment.currency or "USD"))
    _increment_client_credit_balance(db, c, cur, add)


def apply_payment_to_sales_fifo(
    db: Session,
    payment: ClientPayment,
    *,
    manual_allocations: Optional[list[dict]] = None,
) -> tuple[list[PaymentAllocation], Decimal]:
    """Compatibilidad: delega en ``apply_payment_allocations``."""
    return apply_payment_allocations(
        db,
        payment,
        manual_allocations,
        fifo_fallback=not manual_allocations,
    )


_META_CRE_RESV_DEDUCTED = re.compile(r"META_CRE_RESV_DEDUCTED=1", re.IGNORECASE)


def credit_was_reserved_at_submit(notes: Optional[str]) -> bool:
    """True si el saldo a favor ya se descontó al encolar el pago (anti doble gasto)."""
    return bool(_META_CRE_RESV_DEDUCTED.search(str(notes or "")))


def reserve_client_credit_for_pending_payment(
    db: Session,
    client: Client,
    payment: ClientPayment,
    credit_amount: Decimal,
) -> Decimal:
    """
    Resta ``credit_balance`` al registrar un pago en revisión que usa saldo a favor.

    Marca ``META_CRE_RESV_DEDUCTED=1`` en las notas para evitar doble descuento al aprobar
    y para habilitar reembolso exacto si se rechaza la solicitud.
    """
    if credit_was_reserved_at_submit(payment.notes):
        return credit_reserved_restore_from_notes(payment.notes)
    amt = Decimal(str(credit_amount)).quantize(Decimal("0.01"))
    if amt <= _FP_EPS:
        return Decimal("0")
    cur = normalize_currency_code(str(payment.currency or "USD"))
    taken = subtract_client_credit_balance(db, client, cur, amt)
    if taken <= _FP_EPS:
        return Decimal("0")
    stamp = f"META_CRE_RESV={float(taken):.2f}\nMETA_CRE_RESV_DEDUCTED=1"
    base = str(payment.notes or "").strip()
    payment.notes = f"{base}\n{stamp}".strip() if base else stamp
    db.flush()
    return taken


def restore_client_credit_from_pending_payment(
    db: Session,
    payment: ClientPayment,
    *,
    reason: str = "",
) -> Decimal:
    """Devuelve al ``credit_balance`` el monto reservado en un pago rechazado/anulado."""
    if not credit_was_reserved_at_submit(payment.notes):
        return Decimal("0")
    amount = credit_reserved_restore_from_notes(payment.notes)
    if amount <= _FP_EPS:
        return Decimal("0")
    client = db.get(Client, int(payment.client_id))
    if client is None:
        return Decimal("0")
    cur = normalize_currency_code(str(payment.currency or "USD"))
    add_client_credit_balance(db, client, cur, amount)
    base = str(payment.notes or "").strip()
    payment.notes = (base + f"\nMETA_CRE_RESV_RELEASED=1").strip()
    db.flush()
    return amount


def _deduct_reserved_credit_on_payment_approval(
    db: Session,
    payment: ClientPayment,
) -> Decimal:
    """
    Descuenta saldo a favor al aprobar solo si no se reservó al enviar el pago (legacy).
    """
    if credit_was_reserved_at_submit(payment.notes):
        return Decimal("0")
    reserved = credit_reserved_restore_from_notes(payment.notes)
    if reserved <= _FP_EPS and is_client_payment_credit_only(payment):
        reserved = Decimal(str(payment.amount or 0)).quantize(Decimal("0.01"))
    if reserved <= _FP_EPS:
        return Decimal("0")
    client = db.get(Client, int(payment.client_id))
    if client is None:
        raise ValueError("Cliente del pago no encontrado.")
    cur = normalize_currency_code(str(payment.currency or "USD"))
    subtract_client_credit_balance(db, client, cur, reserved)
    return reserved


def submit_client_credit_to_sale_for_review(
    db: Session,
    client: Client,
    sale: Sale,
    *,
    credit_amount: Optional[float] = None,
) -> tuple[Decimal, Optional[ClientPayment]]:
    """
    Cruza saldo a favor contra una venta usando remanentes de cobros previos (FIFO).

    Prohibido crear pagos fantasma ``credit_auto_portal``: sólo ``PaymentAllocation``
    desde cobros aprobados con ``monto − asignaciones > 0``.
    """
    real_total = _sale_invoice_total(db, sale)
    if real_total <= _FP_EPS:
        return Decimal("0"), None
    balance = _sale_cxc_open_balance(db, sale, payment=None)
    if balance <= _FP_EPS:
        return Decimal("0"), None

    cur = normalize_currency_code(str(sale.currency or "USD"))
    pool = _sum_unallocated_deposit_payments(db, int(client.id), cur)
    if pool <= _FP_EPS:
        return Decimal("0"), None

    if credit_amount is not None:
        try:
            req_amt = Decimal(str(credit_amount)).quantize(Decimal("0.01"))
        except Exception:
            req_amt = Decimal("0")
        credit_apply = min(pool, balance, req_amt).quantize(Decimal("0.01"))
    else:
        credit_apply = min(pool, balance).quantize(Decimal("0.01"))
    if credit_apply <= _FP_EPS:
        return Decimal("0"), None

    applied, _allocs, source_payments = allocate_client_credit_remainder_to_sale(
        db, client, sale, credit_apply
    )
    if applied <= _FP_EPS or not source_payments:
        return Decimal("0"), None

    now_iso = isoformat_z(now_ecuador())
    primary_source = source_payments[0]
    source_labels = [
        str(p.payment_number or f"PAG-{p.id}").strip() for p in source_payments
    ]
    events: list[dict] = list(sale.payment_events or [])
    events.append(
        {
            "occurred_at": now_iso,
            "amount": float(applied),
            "currency": cur,
            "status": "Cruce saldo a favor — Aplicado",
            "receipt_url": None,
            "credit_portion": float(applied),
            "deposit_portion": 0.0,
            "payment_number": primary_source.payment_number,
            "payment_id": int(primary_source.id),
            "source_payment_numbers": source_labels,
            "composite_method": "Saldo a Favor",
        }
    )
    sale.payment_events = events
    if sale.status in (SaleStatus.pending, SaleStatus.partially_paid):
        sale.status = SaleStatus.payment_submitted
    sale.expires_at = None
    db.flush()
    return applied, primary_source


def apply_client_credit_to_sale_portal(
    db: Session,
    client: Client,
    sale: Sale,
    *,
    credit_amount: Optional[float] = None,
    strict_accounting: bool = True,
) -> tuple[Decimal, Optional[ClientPayment]]:
    """Portal: cruza saldo a favor al instante (allocations desde cobros aprobados con remanente)."""
    _ = strict_accounting
    return submit_client_credit_to_sale_for_review(
        db, client, sale, credit_amount=credit_amount
    )


def submit_client_credit_to_wallet_recharge_for_review(
    db: Session,
    client: Client,
    req: WalletRechargeRequest,
    *,
    credit_amount: Optional[float] = None,
) -> tuple[float, Optional[ClientPayment]]:
    """
    Encola cruce de saldo a favor contra recarga BaaS (portal → ``pending_review`` + ``in_review``).
    """
    from app.wallet_recharge_helpers import REQ_STATUS_IN_REVIEW

    pending_before = float(getattr(req, "balance_pending", 0) or 0)
    if pending_before <= _WR_EPS:
        return 0.0, None
    cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
    cb = float(get_client_credit_balance(client, cur, db=db))
    if credit_amount is not None:
        try:
            req_f = float(credit_amount)
        except (TypeError, ValueError):
            req_f = 0.0
        to_request = min(cb, pending_before, req_f)
    else:
        to_request = min(cb, pending_before)
    if to_request <= _WR_EPS:
        return 0.0, None

    from app.services.wallet_recharge_client_payment import ensure_pending_wallet_recharge_credit_payment

    cp = ensure_pending_wallet_recharge_credit_payment(
        db,
        req,
        client=client,
        credit_amount=to_request,
    )
    if cp is None:
        return 0.0, None
    if not credit_was_reserved_at_submit(cp.notes):
        return 0.0, None
    to_request = float(credit_reserved_restore_from_notes(cp.notes))
    if to_request <= _WR_EPS:
        return 0.0, None
    req.status = REQ_STATUS_IN_REVIEW
    db.flush()
    return to_request, cp


def apply_client_credit_to_wallet_recharge_portal(
    db: Session,
    client: Client,
    req: WalletRechargeRequest,
    *,
    credit_amount: Optional[float] = None,
    strict_accounting: bool = True,
) -> tuple[float, Optional[ClientPayment]]:
    """
    Portal: pago exclusivo con saldo a favor → cobro aprobado al instante + asignación FIFO.
    """
    applied, cp = submit_client_credit_to_wallet_recharge_for_review(
        db, client, req, credit_amount=credit_amount
    )
    if applied <= _WR_EPS or cp is None:
        return 0.0, None
    finalize_client_payment_approval(
        db,
        cp,
        manual_rows=[{"wallet_recharge_id": int(req.id)}],
        fifo_fallback=True,
        strict_accounting=strict_accounting,
    )
    db.refresh(req)
    db.refresh(cp)
    return applied, cp


def refresh_sale_status_after_payment(db: Session, sale: Sale) -> None:
    """Actualiza estado de la venta tras aplicar cobros (incl. ``payment_submitted`` → saldada)."""
    real_total = _sale_invoice_total(db, sale)
    if real_total <= _FP_EPS:
        return
    sync_sale_amount_paid_from_allocations(db, sale)
    paid = Decimal(str(sale.amount_paid or 0)) if sale.amount_paid is not None else Decimal("0")
    open_bal = _sale_cxc_open_balance(db, sale, payment=None)

    if open_bal <= _FP_EPS or paid >= real_total - _FP_EPS:
        if sale.status in (
            SaleStatus.partially_paid,
            SaleStatus.payment_submitted,
            SaleStatus.pending,
        ):
            sale.status = SaleStatus.approved
    elif paid > _FP_EPS and sale.status in (
        SaleStatus.pending,
        SaleStatus.payment_submitted,
        SaleStatus.approved,
    ):
        sale.status = SaleStatus.partially_paid


def _apply_amount_to_sale(
    db: Session,
    sale: Sale,
    payment: ClientPayment,
    apply: Decimal,
    currency: str,
    now_iso: str,
) -> None:
    events: list[dict] = list(sale.payment_events or [])
    events.append(
        {
            "occurred_at": now_iso,
            "amount": float(apply),
            "currency": currency,
            "status": "Aprobado",
            "receipt_url": payment.receipt_file_url,
            "payment_number": payment.payment_number,
            "payment_id": payment.id,
        }
    )
    sale.payment_events = events

    sync_sale_amount_paid_from_allocations(db, sale)
    refresh_sale_status_after_payment(db, sale)


def sale_ref_number(sale_id: int) -> str:
    return str(sale_id).zfill(4)


def wallet_recharge_ref_number(request_id: int) -> str:
    return f"REC-{int(request_id):05d}"


def _wallet_recharge_status_label_es(status: str) -> str:
    s = str(status or "").strip().lower()
    labels = {
        REQ_STATUS_PENDING: "Pendiente",
        REQ_STATUS_IN_REVIEW: "En revisión",
        REQ_STATUS_PARTIALLY_PAID: "Activado",
        "approved": "Activado",
        "rejected": "Rechazado",
        "canceled": "Cancelado",
    }
    return labels.get(s, str(status or "—"))


# ── Portal helpers ─────────────────────────────────────────────────────────────

def parse_notes_meta_sale_id(notes: Optional[str]) -> Optional[int]:
    """Extrae META_SALE_ID de las notas de un pago del portal (ej. «META_SALE_ID=42»)."""
    if not notes:
        return None
    m = re.search(r"META_SALE_ID=(\d+)", str(notes))
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


# Ventas cuya revisión staff ocurre en la fila «Activar», no como abono suelto.
_OPEN_SALE_REVIEW_STATUSES = (
    SaleStatus.pending,
    SaleStatus.payment_submitted,
)


def _normalize_storage_path(raw: Optional[str]) -> str:
    """Normaliza rutas de comprobante (/uploads/…) para comparación tolerante."""
    s = str(raw or "").strip()
    if not s:
        return ""
    if "://" in s:
        from urllib.parse import urlparse

        parsed = urlparse(s)
        s = parsed.path or s
    s = s.split("?", 1)[0].strip()
    if s and not s.startswith("/"):
        s = f"/{s}"
    return s.lower().rstrip("/")


def _receipt_paths_match(a: Optional[str], b: Optional[str]) -> bool:
    na, nb = _normalize_storage_path(a), _normalize_storage_path(b)
    if not na or not nb:
        return False
    return na == nb or na.endswith(nb) or nb.endswith(na)


def _payment_linked_in_sale_events(sale: Sale, payment_id: int) -> bool:
    events = getattr(sale, "payment_events", None)
    if not isinstance(events, list):
        return False
    pid = int(payment_id)
    for ev in events:
        if not isinstance(ev, dict):
            continue
        try:
            if int(ev.get("pending_payment_id") or 0) == pid:
                return True
        except (TypeError, ValueError):
            continue
    return False


def _open_review_sales_for_client(db: Session, client_id: int) -> list[Sale]:
    return (
        db.query(Sale)
        .filter(
            Sale.client_id == int(client_id),
            Sale.status.in_(_OPEN_SALE_REVIEW_STATUSES),
        )
        .all()
    )


def is_wallet_recharge_client_payment(payment: ClientPayment) -> bool:
    """True si el pago pertenece al módulo BaaS (no debe aparecer en Ventas «En revisión»)."""
    notes = str(getattr(payment, "notes", None) or "")
    if "portal_wallet_recharge" in notes.lower():
        return True
    if "meta_wallet_recharge_id=" in notes.lower():
        return True
    from app.services.wallet_recharge_client_payment import parse_notes_meta_wallet_recharge_id

    return parse_notes_meta_wallet_recharge_id(notes) is not None


def payment_encapsulated_in_open_sale_review(db: Session, payment: ClientPayment) -> bool:
    """
    True si el pago inicial / comprobante de una preventa debe ocultarse de la bandeja
    de abonos sueltos y procesarse al activar la venta vinculada.
    """
    notes = str(payment.notes or "")
    pid = int(payment.id)
    cid = int(payment.client_id)

    for alloc in list(payment.allocations or []):
        sale = db.get(Sale, int(alloc.sale_id))
        if sale is not None and sale.status in _OPEN_SALE_REVIEW_STATUSES:
            return True

    meta_sid = parse_notes_meta_sale_id(notes)
    if meta_sid is not None:
        sale = db.get(Sale, int(meta_sid))
        if sale is not None and sale.status in _OPEN_SALE_REVIEW_STATUSES:
            return True

    if re.search(r"\bIS_INITIAL_SALE_PAYMENT\s*=", notes, flags=re.IGNORECASE):
        if meta_sid is not None:
            sale = db.get(Sale, int(meta_sid))
            if sale is not None and sale.status in _OPEN_SALE_REVIEW_STATUSES:
                return True

    # Depósito portal / checkout inicial referenciado en eventos de la venta o mismo comprobante.
    for sale in _open_review_sales_for_client(db, cid):
        if _payment_linked_in_sale_events(sale, pid):
            return True
        if _receipt_paths_match(sale.receipt_url, payment.receipt_file_url):
            return True

    return False


def portal_deposit_review_notes(notes: Optional[str]) -> bool:
    """Devuelve True si las notas indican que es un depósito de efectivo del portal pendiente de revisión."""
    if not notes:
        return False
    n = str(notes)
    return "PARTE_EFECTIVO=" in n or "META_SALE_ID=" in n


# Prefijos línea del bloque técnico de notas portal (minus./mayús. en comparación).
_TECH_NOTE_LINE_PREFIXES: tuple[str, ...] = (
    "portal_general_abono",
    "origin_sale_ref=",
    "meta_sale_id=",
    "parte_efectivo=",
    "parte_saldo_favor=",
    "credit_auto_portal",
)


def sanitize_portal_deposit_optional_user_notes(raw: Optional[str]) -> str:
    """
    Quita líneas que repiten marcadores META del servidor del texto libre del Form «notes»
    (doble POST, cliente bug, pegado del payload completo, etc.).
    """
    if not raw:
        return ""
    lines_out: list[str] = []
    for raw_line in str(raw).replace("\r\n", "\n").split("\n"):
        s = raw_line.strip()
        if not s:
            continue
        low = s.lower()
        if any(low.startswith(p) for p in _TECH_NOTE_LINE_PREFIXES):
            continue
        lines_out.append(raw_line.rstrip())
    return "\n".join(lines_out).strip()


def _normalize_notes_ws_for_compare(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def dedupe_notes_portal_general_abono_chunks(text: Optional[str]) -> str:
    """
    Colapsa bloques repetidos que empiezan por ``portal_general_abono`` + ORIGIN/PARTE
    (en una línea o varias, separados por espacio o nueva línea).
    """
    if text is None:
        return ""
    t = str(text).replace("\r\n", "\n").strip()
    if not t or not re.search(r"portal_general_abono\b", t, flags=re.IGNORECASE):
        return t
    chunks = [
        chunk.strip()
        for chunk in re.split(r"(?<=\s)(?=portal_general_abono\b)", t, flags=re.IGNORECASE)
        if chunk.strip()
    ]
    if not chunks:
        return t
    seen: set[str] = set()
    out: list[str] = []
    for ch in chunks:
        sig = _normalize_notes_ws_for_compare(ch)
        if not sig:
            continue
        if sig in seen:
            continue
        seen.add(sig)
        out.append(ch.strip())
    if not out:
        return ""
    return "\n".join(out).strip()


def append_client_payment_notes_unique(existing: Optional[str], addition: Optional[str]) -> str:
    """
    Concatena observaciones evitando duplicar contenido ya presente ni repetir blobs ``portal_general_abono``.
    """
    cur = dedupe_notes_portal_general_abono_chunks((existing or "").strip())
    extra = (addition or "").strip()
    if not extra:
        return cur
    norm_extra = _normalize_notes_ws_for_compare(extra)
    norm_cur = _normalize_notes_ws_for_compare(cur)
    if norm_extra and norm_extra == norm_cur:
        return cur
    if norm_extra and norm_extra in norm_cur:
        return cur

    sanitized = sanitize_portal_deposit_optional_user_notes(extra)
    if sanitized:
        merged = (f"{cur}\n{sanitized}" if cur else sanitized).strip()
    elif "portal_general_abono" in extra.lower():
        # Texto repetido sólo marcadores servidor (sanitizado vacío): no contaminar ni duplicar.
        merged = cur
    else:
        merged = (f"{cur}\n{extra}" if cur else extra).strip()
    return dedupe_notes_portal_general_abono_chunks(merged)


def resolve_client_payment_deposit_account_id(db: Session, payment: ClientPayment) -> Optional[int]:
    """Cuenta bancaria del cobro: la del pago o, si falta, la de la venta vinculada."""
    dep_id = getattr(payment, "deposit_account_id", None)
    if dep_id is not None:
        return int(dep_id)

    meta_sid = parse_notes_meta_sale_id(payment.notes)
    if meta_sid is not None:
        sale = db.get(Sale, int(meta_sid))
        if sale is not None and sale.deposit_account_id is not None:
            return int(sale.deposit_account_id)

    for alloc in db.query(PaymentAllocation).filter(PaymentAllocation.payment_id == int(payment.id)).all():
        sale = db.get(Sale, int(alloc.sale_id))
        if sale is not None and sale.deposit_account_id is not None:
            return int(sale.deposit_account_id)

    return None


def _confirm_existing_payment_allocations(
    db: Session,
    payment: ClientPayment,
) -> tuple[list[PaymentAllocation], Decimal, dict[int, Decimal], dict[int, Decimal]]:
    """
    Confirma allocations ``pending_review`` ya persistidas al aprobar un cobro.

    - Capa cada fila al saldo CxC real (venta o recarga BaaS).
    - Consolida duplicados por obligación en una sola fila.
    - Devuelve allocations válidas, pool restante y mapas de lo ya aplicado en sesión.
    """
    existing = (
        db.query(PaymentAllocation)
        .filter(PaymentAllocation.payment_id == int(payment.id))
        .order_by(PaymentAllocation.id.asc())
        .all()
    )
    pool = _q_amt(payment.amount)
    confirmed: list[PaymentAllocation] = []
    session_allocated: dict[int, Decimal] = {}
    session_allocated_wr: dict[int, Decimal] = {}

    by_sale: dict[int, list[PaymentAllocation]] = {}
    by_wr: dict[int, list[PaymentAllocation]] = {}
    for alloc in existing:
        if alloc.wallet_recharge_id is not None:
            by_wr.setdefault(int(alloc.wallet_recharge_id), []).append(alloc)
        elif alloc.sale_id is not None:
            by_sale.setdefault(int(alloc.sale_id), []).append(alloc)
        else:
            db.delete(alloc)

    for sale_id, allocs in sorted(by_sale.items(), key=lambda x: x[0]):
        if pool <= _FP_EPS:
            for stale in allocs:
                db.delete(stale)
            continue

        sale = _load_client_sale_for_payment(db, payment, sale_id)
        if sale is None:
            for stale in allocs:
                db.delete(stale)
            continue

        if len(allocs) > 1:
            merged_amt = sum((_q_amt(a.amount_applied) for a in allocs), Decimal("0"))
            keep = allocs[0]
            keep.amount_applied = merged_amt
            for dup in allocs[1:]:
                db.delete(dup)
            allocs = [keep]

        alloc = allocs[0]
        balance = _effective_open_balance_for_apply(db, sale, payment, session_allocated)
        if balance <= _FP_EPS:
            db.delete(alloc)
            continue

        cap = min(_q_amt(alloc.amount_applied), balance, pool)
        if cap <= _FP_EPS:
            db.delete(alloc)
            continue

        if cap != _q_amt(alloc.amount_applied):
            alloc.amount_applied = cap

        confirmed.append(alloc)
        session_allocated[sale_id] = _q_amt(session_allocated.get(sale_id, Decimal("0")) + cap)
        pool = _q_amt(pool - cap)

    for wr_id, allocs in sorted(by_wr.items(), key=lambda x: x[0]):
        if pool <= _FP_EPS:
            for stale in allocs:
                db.delete(stale)
            continue

        req = _load_client_wallet_recharge_for_payment(db, payment, wr_id)
        if req is None:
            for stale in allocs:
                db.delete(stale)
            continue

        if len(allocs) > 1:
            merged_amt = sum((_q_amt(a.amount_applied) for a in allocs), Decimal("0"))
            keep = allocs[0]
            keep.amount_applied = merged_amt
            for dup in allocs[1:]:
                db.delete(dup)
            allocs = [keep]

        alloc = allocs[0]
        balance = _effective_open_balance_for_wallet_recharge_apply(
            db, req, payment, session_allocated_wr
        )
        if balance <= _FP_EPS:
            db.delete(alloc)
            continue

        cap = min(_q_amt(alloc.amount_applied), balance, pool)
        if cap <= _FP_EPS:
            db.delete(alloc)
            continue

        if cap != _q_amt(alloc.amount_applied):
            alloc.amount_applied = cap

        confirmed.append(alloc)
        session_allocated_wr[wr_id] = _q_amt(session_allocated_wr.get(wr_id, Decimal("0")) + cap)
        pool = _q_amt(pool - cap)

    db.flush()
    return confirmed, pool, session_allocated, session_allocated_wr


def finalize_client_payment_approval(
    db: Session,
    payment: ClientPayment,
    *,
    manual_rows: Optional[list[dict]] = None,
    fifo_fallback: bool = True,
    strict_accounting: bool = True,
) -> tuple[list[PaymentAllocation], Decimal]:
    """
    Aprueba un ``ClientPayment`` en revisión dentro de la sesión actual (sin ``commit``):

    1. Confirma allocations en revisión existentes (sin duplicar).
    2. Asignación FIFO cruzada (ventas + BaaS) vía ``allocate_client_payment_fifo_cross_module``.
    3. Marca aprobado, sincroniza contabilidad y cruza saldo a favor remanente contra deudas.
    """
    if payment.status != ClientPaymentStatus.pending_review:
        raise ValueError(f"El pago {payment.payment_number} no está en revisión.")

    _deduct_reserved_credit_on_payment_approval(db, payment)

    resolved_dep = resolve_client_payment_deposit_account_id(db, payment)
    if resolved_dep is not None and payment.deposit_account_id is None:
        payment.deposit_account_id = int(resolved_dep)

    confirmed, pool, session_allocated, session_allocated_wr = _confirm_existing_payment_allocations(
        db, payment
    )
    skip_sale_ids = set(session_allocated.keys())
    skip_wr_ids = set(session_allocated_wr.keys())
    rows = list(manual_rows or [])

    new_created: list[PaymentAllocation] = []
    remainder = pool

    if confirmed:
        if pool > _FP_EPS:
            new_created, remainder = apply_payment_allocations(
                db,
                payment,
                None,
                fifo_fallback=True,
                initial_pool=pool,
                session_allocated=session_allocated,
                session_allocated_wr=session_allocated_wr,
                skip_sale_ids=skip_sale_ids,
                skip_wallet_recharge_ids=skip_wr_ids,
            )
        created = confirmed + new_created
    else:
        created, remainder = allocate_client_payment_fifo_cross_module(
            db,
            payment,
            priority_targets=rows or None,
            fifo_cross_module=True,
            session_allocated=session_allocated,
            session_allocated_wr=session_allocated_wr,
            skip_sale_ids=skip_sale_ids,
            skip_wallet_recharge_ids=skip_wr_ids,
        )

    meta_sid = parse_notes_meta_sale_id(payment.notes)
    if meta_sid is not None and not any(a.sale_id for a in created):
        linked_sale = db.get(Sale, int(meta_sid))
        if linked_sale is not None and int(linked_sale.client_id) == int(payment.client_id):
            created, remainder = _reconcile_initial_payment_allocations(
                db, payment, linked_sale, created, remainder
            )

    from app.services.wallet_recharge_client_payment import parse_notes_meta_wallet_recharge_id

    meta_wr_id = parse_notes_meta_wallet_recharge_id(payment.notes)
    if meta_wr_id is not None and not any(a.wallet_recharge_id for a in created):
        linked_wr = db.get(WalletRechargeRequest, int(meta_wr_id))
        if linked_wr is not None and int(linked_wr.client_id) == int(payment.client_id):
            extra, remainder = allocate_client_payment_fifo_cross_module(
                db,
                payment,
                pool=remainder if confirmed else None,
                priority_targets=[{"wallet_recharge_id": int(meta_wr_id)}],
                fifo_cross_module=True,
            )
            created = created + extra

    touched_sale_ids: set[int] = {int(a.sale_id) for a in created if a.sale_id is not None}
    if meta_sid is not None:
        touched_sale_ids.add(int(meta_sid))

    touched_wr_ids: set[int] = {
        int(a.wallet_recharge_id) for a in created if a.wallet_recharge_id is not None
    }
    if meta_wr_id is not None:
        touched_wr_ids.add(int(meta_wr_id))

    db.flush()

    now = now_ecuador()
    payment.status = ClientPaymentStatus.approved
    payment.approved_at = now

    db.flush()

    for sid in touched_sale_ids:
        s = db.get(Sale, int(sid))
        if s is not None:
            sync_sale_amount_paid_from_allocations(db, s)
            refresh_sale_status_after_payment(db, s)

    for wr_id in touched_wr_ids:
        wr = db.get(WalletRechargeRequest, int(wr_id))
        if wr is not None:
            refresh_wallet_recharge_after_payment(db, wr)

    db.flush()

    from app.services.client_payment_accounting_sync import sync_client_payment_accounting_ledgers

    sync_client_payment_accounting_ledgers(db, payment, strict=strict_accounting)

    client = db.get(Client, int(payment.client_id))
    if client is not None:
        excess = compute_payment_credit_excess(payment, created, remainder, db=db)
        add_payment_remainder_to_client_credit_balance(db, payment, excess)
        sync_client_credit_from_overpay(db, client)
        sweep_client_unallocated_funds_to_obligations_fifo(
            db,
            client,
            currency=normalize_currency_code(str(payment.currency or "USD")),
            strict_accounting=strict_accounting,
        )

    from app.services.codigos_retiro_erp_notify import (
        schedule_codigos_retiro_erp_notify_from_payment_approval,
    )

    schedule_codigos_retiro_erp_notify_from_payment_approval(db, payment, created)

    return created, remainder


def credit_reserved_restore_from_notes(notes: Optional[str]) -> Decimal:
    """Monto a devolver al saldo a favor desde notas (``META_CRE_RESV`` / ``PARTE_SALDO_FAVOR``)."""
    if not notes:
        return Decimal("0")
    m = re.search(r"PARTE_SALDO_FAVOR=([\d.]+)", str(notes))
    if m:
        try:
            return Decimal(str(m.group(1))).quantize(Decimal("0.01"))
        except Exception:
            pass
    m = re.search(r"META_CRE_RESV=([\d.]+)", str(notes))
    if not m:
        return Decimal("0")
    try:
        return Decimal(str(m.group(1))).quantize(Decimal("0.01"))
    except Exception:
        return Decimal("0")


def is_client_payment_credit_only(payment: ClientPayment) -> bool:
    """Pago sin banco: cruza saldo a favor del cliente (incl. ``credit_auto_portal``)."""
    from app.services.accounting_engine import is_credit_only_client_payment

    return is_credit_only_client_payment(payment)


def _credit_amount_to_restore_on_void(
    db: Session,
    payment: ClientPayment,
    allocations: list[PaymentAllocation],
) -> Decimal:
    """Monto a devolver a ``credit_balance`` al anular un pago con saldo a favor."""
    if not is_client_payment_credit_only(payment):
        return Decimal("0")
    total = sum(
        (Decimal(str(a.amount_applied or 0)).quantize(Decimal("0.01")) for a in allocations),
        Decimal("0"),
    )
    if total > _FP_EPS:
        return total
    return Decimal(str(payment.amount or 0)).quantize(Decimal("0.01"))


def void_client_payment(
    db: Session,
    payment: ClientPayment,
    *,
    reason: str = "",
    allow_approved_non_credit: bool = False,
) -> None:
    """
    Rechaza un pago, revierte sus asientos contables y ajusta facturas / saldo a favor.

    No hace ``commit``; el llamador confirma la transacción.
    """
    if payment.status == ClientPaymentStatus.rejected:
        return

    is_credit = is_client_payment_credit_only(payment)
    if payment.status == ClientPaymentStatus.approved and not is_credit and not allow_approved_non_credit:
        raise ValueError(
            f"El pago {payment.payment_number} ya está aprobado; "
            "solo se puede anular si es saldo a favor o está en revisión."
        )

    pid = int(payment.id)
    pnum = (payment.payment_number or f"PAG-{pid}").strip()
    rev_reason = (reason or "").strip() or f"Anulación/rechazo {pnum}"

    from app.services.accounting_engine import reverse_client_payment_journal

    reverse_client_payment_journal(db, pid, reason=rev_reason)

    allocs = db.query(PaymentAllocation).filter(PaymentAllocation.payment_id == pid).all()
    touched_sales: list[Sale] = []
    for alloc in allocs:
        sale = db.get(Sale, int(alloc.sale_id))
        if sale is None:
            continue
        old_ap = Decimal(str(sale.amount_paid or 0)).quantize(Decimal("0.0001"))
        applied = Decimal(str(alloc.amount_applied or 0)).quantize(Decimal("0.0001"))
        sale.amount_paid = max(Decimal("0"), old_ap - applied)
        touched_sales.append(sale)

    credit_back = Decimal("0")
    if credit_was_reserved_at_submit(payment.notes):
        credit_back = credit_reserved_restore_from_notes(payment.notes)
    else:
        credit_back = _credit_amount_to_restore_on_void(db, payment, allocs)
        if credit_back <= _FP_EPS:
            credit_back = credit_reserved_restore_from_notes(payment.notes)
    if credit_back > _FP_EPS:
        client = db.get(Client, int(payment.client_id))
        if client is not None:
            pay_cur = normalize_currency_code(str(payment.currency or "USD"))
            add_client_credit_balance(db, client, pay_cur, credit_back)

    db.query(PaymentAllocation).filter(PaymentAllocation.payment_id == pid).delete()
    payment.status = ClientPaymentStatus.rejected
    terminal = (
        SaleStatus.rejected,
        SaleStatus.annulled,
        SaleStatus.cancelled,
        SaleStatus.expired,
    )
    for sale in touched_sales:
        if sale.status not in terminal:
            refresh_sale_status_after_payment(db, sale)
    db.flush()


def linked_client_payment_ids_for_sale(db: Session, sale_id: int) -> list[int]:
    """Ids de pagos vinculados a una venta (allocations + notas ``META_SALE_ID``)."""
    sid = int(sale_id)
    ids: set[int] = set()

    for (pid,) in (
        db.query(PaymentAllocation.payment_id)
        .filter(PaymentAllocation.sale_id == sid)
        .distinct()
        .all()
    ):
        ids.add(int(pid))

    candidates = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.status.in_(
                (ClientPaymentStatus.pending_review, ClientPaymentStatus.approved)
            ),
        )
        .all()
    )
    for cp in candidates:
        if parse_notes_meta_sale_id(cp.notes) == sid:
            ids.add(int(cp.id))

    return sorted(ids)


def void_sale_linked_client_payments(
    db: Session,
    sale: Sale,
    *,
    reason: str = "",
) -> None:
    """Revierte y rechaza todos los pagos CxC vinculados a una venta (incl. saldo a favor)."""
    sid = int(sale.id)
    ref = f"FAC-{sid:04d}"
    base_reason = (reason or "").strip() or f"Reversión por anulación/rechazo {ref}"

    seen: set[int] = set()
    for pid in linked_client_payment_ids_for_sale(db, sid):
        if pid in seen:
            continue
        seen.add(pid)
        cp = db.get(ClientPayment, pid)
        if cp is None or cp.status == ClientPaymentStatus.rejected:
            continue
        void_client_payment(
            db,
            cp,
            reason=f"{base_reason} — {cp.payment_number or pid}",
            allow_approved_non_credit=True,
        )

    sale.amount_paid = Decimal("0")
    db.flush()


def void_sale_accounting_state(
    db: Session,
    sale: Sale,
    *,
    reason: str = "",
) -> None:
    """
    Revierte asientos de la venta y de todos sus pagos; deja la factura sin cobros registrados.
    """
    sid = int(sale.id)
    ref = f"FAC-{sid:04d}"
    base_reason = (reason or "").strip() or f"Anulación/rechazo {ref}"

    void_sale_linked_client_payments(db, sale, reason=base_reason)

    from app.services.accounting_engine import reverse_sale_journal

    reverse_sale_journal(db, sid, reason=base_reason)
    db.flush()


def _is_initial_encapsulated_payment(payment: ClientPayment) -> bool:
    """Solo el cobro encapsulado del checkout / primer depósito de la venta."""
    notes = str(payment.notes or "")
    if re.search(r"\bIS_INITIAL_SALE_PAYMENT\s*=", notes, flags=re.IGNORECASE):
        return True
    if re.search(r"\bcheckout_encapsulated\s*=", notes, flags=re.IGNORECASE):
        return True
    return False


def _reconcile_initial_payment_allocations(
    db: Session,
    payment: ClientPayment,
    sale: Sale,
    created: list[PaymentAllocation],
    pool_remainder: Decimal,
) -> tuple[list[PaymentAllocation], Decimal]:
    """
    Si el pago inicial encapsulado no generó allocations (saldo mal calculado en revisión),
    aplica manualmente a la venta vinculada antes del asiento contable.
    """
    if created:
        return created, pool_remainder
    if not _is_initial_encapsulated_payment(payment):
        return created, pool_remainder

    sid = parse_notes_meta_sale_id(payment.notes)
    if sid is None or int(sid) != int(sale.id):
        return created, pool_remainder

    pay_cur = normalize_currency_code(str(payment.currency or "USD"))
    sale_cur = normalize_currency_code(str(sale.currency or "USD"))
    if pay_cur != sale_cur:
        return created, pool_remainder

    pool = _q_amt(payment.amount)
    if pool <= _FP_EPS:
        return created, pool_remainder

    target = _load_client_sale_for_payment(db, payment, int(sale.id))
    if target is None:
        return created, pool_remainder

    balance = _effective_open_balance_for_apply(db, target, payment, None)
    if balance <= _FP_EPS:
        return created, pool_remainder

    apply = min(pool, balance)
    if apply <= _FP_EPS:
        return created, pool_remainder

    cur = normalize_currency_code(str(payment.currency or "USD"))
    now_iso = isoformat_z(now_ecuador())
    _apply_amount_to_sale(db, target, payment, apply, cur, now_iso)
    alloc = _record_payment_allocation(
        db,
        payment,
        sale_id=int(sale.id),
        amount=apply,
    )
    db.flush()
    return [alloc], _q_amt(pool - apply)


def materialize_encapsulated_initial_payment_if_needed(
    db: Session,
    sale: Sale,
) -> Optional[ClientPayment]:
    """
    Crea ``ClientPayment`` pending_review si la venta trae comprobante encapsulado
    (checkout / receipt en venta) pero aún no hay fila CxC.
    """
    if sale.status not in (
        SaleStatus.pending,
        SaleStatus.payment_submitted,
        SaleStatus.partially_paid,
    ):
        return None

    sid = int(sale.id)
    pending_same = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == int(sale.client_id),
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
        .all()
    )
    for cp in pending_same:
        if parse_notes_meta_sale_id(cp.notes) == sid:
            return None
        if _payment_linked_in_sale_events(sale, int(cp.id)):
            return None
        if _receipt_paths_match(sale.receipt_url, cp.receipt_file_url):
            return None

    amount: Optional[Decimal] = None
    receipt = (str(sale.receipt_url or "").strip() or None)
    cur = normalize_currency_code(str(sale.currency or "USD"))

    events = getattr(sale, "payment_events", None)
    if isinstance(events, list):
        for ev in events:
            if not isinstance(ev, dict):
                continue
            try:
                if int(ev.get("pending_payment_id") or 0) > 0:
                    return None
            except (TypeError, ValueError):
                pass
            st = str(ev.get("status") or "").lower()
            if "revisión" in st or "revision" in st or "depósito" in st or "deposito" in st:
                for key in ("deposit_portion", "amount"):
                    raw = ev.get(key)
                    if raw is None:
                        continue
                    try:
                        cand = Decimal(str(raw)).quantize(Decimal("0.01"))
                        if cand > _FP_EPS:
                            amount = cand
                            break
                    except Exception:
                        continue
                if not receipt:
                    rc = ev.get("receipt_url")
                    if rc:
                        receipt = str(rc).strip() or None

    if amount is None or amount <= _FP_EPS:
        total = _sale_invoice_total(db, sale)
        paid = Decimal(str(sale.amount_paid or 0)) if sale.amount_paid is not None else Decimal("0")
        open_b = max(Decimal("0"), total - paid)
        if receipt and open_b > _FP_EPS:
            amount = open_b.quantize(Decimal("0.01"))

    if amount is None or amount <= _FP_EPS:
        return None
    if not receipt and sale.deposit_account_id is None:
        return None

    notes_body = dedupe_notes_portal_general_abono_chunks(
        "\n".join(
            [
                "portal_general_abono",
                f"META_SALE_ID={sid}",
                f"ORIGIN_SALE_REF={sid}",
                "IS_INITIAL_SALE_PAYMENT=1",
                f"PARTE_EFECTIVO={float(amount):.2f} {cur}",
                "materialized_on_activate=1",
            ]
        )
    )
    now = now_ecuador()
    dep_id = int(sale.deposit_account_id) if sale.deposit_account_id is not None else None
    from app.services.currency_consolidation import sale_exchange_rate

    cp = ClientPayment(
        payment_number=next_payment_number(db),
        client_id=int(sale.client_id),
        amount=amount,
        currency=cur,
        exchange_rate=float(sale_exchange_rate(sale)),
        receipt_file_url=receipt,
        payment_method_id=int(sale.payment_method_id) if sale.payment_method_id else None,
        deposit_account_id=dep_id,
        status=ClientPaymentStatus.pending_review,
        notes=notes_body,
        created_at=now,
    )
    db.add(cp)
    db.flush()
    return cp


def collect_pending_payments_for_sale_activation(
    db: Session,
    sale: Sale,
) -> list[ClientPayment]:
    """Localiza todos los ``ClientPayment`` encapsulados pendientes de una venta."""
    sid = int(sale.id)
    by_id: dict[int, ClientPayment] = {}

    def _track(cp: Optional[ClientPayment]) -> None:
        if cp is None or cp.status != ClientPaymentStatus.pending_review:
            return
        by_id[int(cp.id)] = cp

    linked = (
        db.query(ClientPayment)
        .join(PaymentAllocation, PaymentAllocation.payment_id == ClientPayment.id)
        .filter(
            PaymentAllocation.sale_id == sid,
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
        .all()
    )
    for cp in linked:
        _track(cp)

    client_pending = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == int(sale.client_id),
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
        .all()
    )
    for cp in client_pending:
        if parse_notes_meta_sale_id(cp.notes) == sid:
            _track(cp)
            continue
        if _payment_linked_in_sale_events(sale, int(cp.id)):
            _track(cp)
            continue
        if _receipt_paths_match(sale.receipt_url, cp.receipt_file_url):
            _track(cp)
            continue
        if payment_encapsulated_in_open_sale_review(db, cp):
            meta = parse_notes_meta_sale_id(cp.notes)
            if meta == sid:
                _track(cp)

    events = getattr(sale, "payment_events", None)
    if isinstance(events, list):
        for ev in events:
            if not isinstance(ev, dict):
                continue
            try:
                pid = int(ev.get("pending_payment_id") or 0)
            except (TypeError, ValueError):
                pid = 0
            if pid > 0:
                _track(db.get(ClientPayment, pid))

    _track(materialize_encapsulated_initial_payment_if_needed(db, sale))

    return list(by_id.values())


def infer_client_payment_applied_to_ar(db: Session, payment: ClientPayment) -> Decimal:
    """
    Monto del cobro que reduce CxC.

    Fuente de verdad: suma de ``PaymentAllocation``. Las notas (``PARTE_EFECTIVO``,
    ``META_WR_CXC_APPLIED``) solo se usan cuando aún no hay filas de asignación.
    """
    applied_alloc = _payment_applied_total(db, payment)
    amt = _q_amt(payment.amount)
    if applied_alloc > _FP_EPS:
        return min(applied_alloc, amt)

    wr_inferred = _infer_ar_from_wallet_recharge_payment_notes(payment, amt)
    if wr_inferred > _FP_EPS:
        return min(wr_inferred, amt)

    if _is_initial_encapsulated_payment(payment):
        inferred = _infer_ar_from_linked_sale_notes(db, payment, amt)
        if inferred > _FP_EPS:
            return inferred

    return _infer_ar_from_linked_sale_notes(db, payment, amt)


def compute_client_credit_from_payment_ledger(
    db: Session,
    client_id: int,
) -> dict[str, Decimal]:
    """
    Saldo a favor real del cliente por moneda.

    Fórmula: Σ cobros aprobados (depósito) − Σ asignaciones CxC exitosas
    (``PaymentAllocation`` / inferencia BaaS), más excedentes BaaS legacy no
    reflejados en cobros, menos reservas de saldo a favor en pagos ``pending_review``.
    """
    by_cur: dict[str, Decimal] = {}
    cid = int(client_id)

    approved = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == cid,
            ClientPayment.status == ClientPaymentStatus.approved,
        )
        .order_by(ClientPayment.id.asc())
        .all()
    )

    for payment in approved:
        if is_client_payment_credit_only(payment):
            continue
        cur = normalize_currency_code(str(payment.currency or "USD"))
        paid = _q_amt(payment.amount)
        if paid <= _FP_EPS:
            continue
        applied = infer_client_payment_applied_to_ar(db, payment)
        excess = (paid - applied).quantize(Decimal("0.01"))
        if excess <= _FP_EPS:
            continue
        by_cur[cur] = by_cur.get(cur, Decimal("0")) + excess

    linked_wr_ids: set[int] = set()
    for payment in approved:
        from app.services.wallet_recharge_client_payment import parse_notes_meta_wallet_recharge_id

        wr_id = parse_notes_meta_wallet_recharge_id(payment.notes)
        if wr_id is not None:
            linked_wr_ids.add(int(wr_id))

    wr_rows = (
        db.query(WalletRechargeRequest)
        .filter(WalletRechargeRequest.client_id == cid)
        .all()
    )
    for req in wr_rows:
        if int(req.id) in linked_wr_ids:
            continue
        try:
            surplus = Decimal(str(getattr(req, "surplus_credited", 0) or 0)).quantize(Decimal("0.01"))
        except Exception:
            surplus = Decimal("0")
        if surplus <= _FP_EPS:
            continue
        wr_cur = normalize_currency_code(str(getattr(req, "recharge_currency", None) or "USD"))
        by_cur[wr_cur] = by_cur.get(wr_cur, Decimal("0")) + surplus

    pending = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == cid,
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
        .all()
    )
    for payment in pending:
        if not credit_was_reserved_at_submit(payment.notes):
            continue
        reserved = credit_reserved_restore_from_notes(payment.notes)
        if reserved <= _FP_EPS:
            continue
        cur = normalize_currency_code(str(payment.currency or "USD"))
        prev = by_cur.get(cur, Decimal("0"))
        by_cur[cur] = max(Decimal("0"), (prev - reserved).quantize(Decimal("0.01")))

    return {
        cur: amt.quantize(Decimal("0.01"))
        for cur, amt in by_cur.items()
        if amt > _FP_EPS
    }


def _infer_ar_from_wallet_recharge_payment_notes(
    payment: ClientPayment,
    amt: Decimal,
) -> Decimal:
    """Monto del cobro que reduce CxC de una solicitud BaaS (``META_WALLET_RECHARGE_ID``)."""
    from app.services.wallet_recharge_client_payment import parse_notes_meta_wallet_recharge_id

    if parse_notes_meta_wallet_recharge_id(payment.notes) is None:
        return Decimal("0")
    notes = str(payment.notes or "")
    for pat in (_RE_META_WR_CXC_APPLIED, _RE_PARTE_EFECTIVO):
        m = pat.search(notes)
        if m is None:
            continue
        try:
            applied = _q_amt(m.group(1))
            if applied > _FP_EPS:
                return min(applied, amt)
        except Exception:
            continue
    return Decimal("0")


def _stamp_wallet_recharge_cxc_applied_notes(
    notes: Optional[str],
    *,
    applied_to_cxc: float,
    received_amount: float,
    currency: str,
) -> str:
    """Anota el monto aplicado a CxC para que ``sync_client_payment_journal`` lo infiera."""
    from app.services.wallet_recharge_client_payment import parse_notes_meta_wallet_recharge_id

    base = str(notes or "").strip()
    rid = parse_notes_meta_wallet_recharge_id(base)
    cur = normalize_currency_code(currency, "USD")
    kept: list[str] = []
    for ln in base.splitlines():
        s = ln.strip()
        if not s:
            continue
        if _RE_META_WR_CXC_APPLIED.search(s):
            continue
        if _RE_PARTE_EFECTIVO.search(s):
            continue
        kept.append(s)
    if not any("portal_wallet_recharge" in ln for ln in kept):
        kept.insert(0, "portal_wallet_recharge")
    if rid is not None and not any(f"META_WALLET_RECHARGE_ID={rid}" in ln for ln in kept):
        kept.append(f"META_WALLET_RECHARGE_ID={int(rid)}")
    kept.append(f"PARTE_EFECTIVO={float(received_amount):.2f} {cur}")
    kept.append(f"META_WR_CXC_APPLIED={float(applied_to_cxc):.2f}")
    surplus = round(float(received_amount) - float(applied_to_cxc), 2)
    if surplus > _WR_EPS:
        kept.append(f"META_WR_SURPLUS={surplus:.2f} {cur}")
    return "\n".join(kept)


def _infer_ar_from_linked_sale_notes(db: Session, payment: ClientPayment, amt: Decimal) -> Decimal:
    """Respaldo: pago con ``META_SALE_ID`` sin allocations persistidas."""
    sid = parse_notes_meta_sale_id(payment.notes)
    if sid is None:
        return Decimal("0")
    sale = _load_client_sale_for_payment(db, payment, int(sid))
    if sale is None:
        return Decimal("0")
    pay_cur = normalize_currency_code(str(payment.currency or "USD"))
    if normalize_currency_code(str(sale.currency or "USD")) != pay_cur:
        return Decimal("0")
    open_bal = _sale_cxc_open_balance(db, sale, payment)
    if open_bal <= _FP_EPS:
        return Decimal("0")
    return min(amt, open_bal)


def approve_pending_linked_client_payments_for_sale(
    db: Session,
    sale: Sale,
    *,
    strict_accounting: bool = True,
) -> None:
    """
    Al activar una venta con cobro en revisión: aprueba pagos vinculados y aplica waterfall CxC.

    1. Localiza ``ClientPayment`` pending_review vinculados a esta venta.
    2. Los aprueba y reparte cada pago: factura objetivo → FIFO → saldo a favor.
    """
    sid = int(sale.id)
    now = now_ecuador()

    approved_now = collect_pending_payments_for_sale_activation(db, sale)

    for cp in sorted(approved_now, key=lambda p: (p.created_at or now, int(p.id))):
        target_ids: list[int] = [sid]
        target_wr_ids: list[int] = []
        for alloc in db.query(PaymentAllocation).filter(PaymentAllocation.payment_id == cp.id).all():
            if alloc.sale_id is not None:
                target_ids.append(int(alloc.sale_id))
            elif alloc.wallet_recharge_id is not None:
                target_wr_ids.append(int(alloc.wallet_recharge_id))
        if parse_notes_meta_sale_id(cp.notes) == sid and sid not in target_ids:
            target_ids.insert(0, sid)

        seen: set[int] = set()
        primary_rows: list[dict] = []
        for ts in target_ids:
            if ts in seen:
                continue
            seen.add(ts)
            primary_rows.append({"sale_id": ts})
        for wr_id in target_wr_ids:
            primary_rows.append({"wallet_recharge_id": wr_id})

        finalize_client_payment_approval(
            db,
            cp,
            manual_rows=primary_rows,
            fifo_fallback=True,
            strict_accounting=strict_accounting,
        )

    db.flush()


def linked_payments_for_sale(db: Session, sale_id: int) -> list[dict]:
    """Pagos aprobados aplicados a una factura, ordenados por fecha de pago."""
    sale = db.get(Sale, int(sale_id))
    sale_cur = normalize_currency_code(str(getattr(sale, "currency", None) or "USD")) if sale else None
    rows = (
        db.query(PaymentAllocation, ClientPayment)
        .join(ClientPayment, PaymentAllocation.payment_id == ClientPayment.id)
        .filter(
            PaymentAllocation.sale_id == int(sale_id),
            ClientPayment.status == ClientPaymentStatus.approved,
        )
        .order_by(
            nullslast(ClientPayment.approved_at.asc()),
            ClientPayment.created_at.asc(),
        )
        .all()
    )
    out: list[dict] = []
    for alloc, payment in rows:
        if sale_cur is not None:
            pay_cur = normalize_currency_code(str(getattr(payment, "currency", None) or "USD"))
            if pay_cur != sale_cur:
                continue
        dt = payment.approved_at or payment.created_at
        out.append(
            {
                "payment_id": int(payment.id),
                "date": dt,
                "amount_applied": float(alloc.amount_applied),
                "payment_number": payment.payment_number,
            }
        )
    return out


def compute_client_pending_balance(db: Session, client_id: int) -> dict:
    """
    Saldo total pendiente del cliente: facturas con saldo CxC abierto
    más saldo ``balance_pending`` de solicitudes de recarga BaaS (pendiente / parcial / en revisión).

    Incluye ``pending_balances_by_currency`` (todas las divisas) y campos legacy con la
    moneda de mayor deuda pendiente.
    """
    by_currency: dict[str, float] = {}

    for row in list_unpaid_invoices(db, client_id):
        cur = normalize_currency_code(str(row.get("currency") or "USD"))
        by_currency[cur] = by_currency.get(cur, 0.0) + float(row.get("open_balance") or 0)

    from app.wallet_recharge_helpers import wallet_recharge_contributes_to_client_debt

    wr_rows = (
        db.query(WalletRechargeRequest)
        .filter(WalletRechargeRequest.client_id == int(client_id))
        .all()
    )
    for r in wr_rows:
        if not wallet_recharge_contributes_to_client_debt(r):
            continue
        bp = float(getattr(r, "balance_pending", 0) or 0)
        if bp <= 1e-9:
            continue
        cur = normalize_currency_code(str(getattr(r, "recharge_currency", None) or "USD"))
        by_currency[cur] = by_currency.get(cur, 0.0) + bp

    pending_balances_by_currency = [
        {"currency": cur, "amount": round(amt, 2)}
        for cur, amt in sorted(by_currency.items(), key=lambda x: (-x[1], x[0]))
    ]

    credit_summary = compute_client_credit_summary(db, client_id, sync=False)

    if not by_currency:
        return {
            "total_pending_balance": 0.0,
            "pending_balance_currency": "USD",
            "pending_balances_by_currency": [],
            **credit_summary,
        }

    if len(by_currency) == 1:
        cur = next(iter(by_currency))
        return {
            "total_pending_balance": round(by_currency[cur], 2),
            "pending_balance_currency": cur,
            "pending_balances_by_currency": pending_balances_by_currency,
            **credit_summary,
        }

    primary_cur = max(by_currency, key=lambda c: by_currency[c])
    return {
        "total_pending_balance": round(by_currency[primary_cur], 2),
        "pending_balance_currency": primary_cur,
        "pending_balances_by_currency": pending_balances_by_currency,
        **credit_summary,
    }


def list_client_pending_debt_lines_for_webhook(db: Session, client_id: int) -> list[dict]:
    """
    Lista maestra de deudas pendientes para el portal / Render: una fila por factura con saldo
    abierto y una por recarga BaaS con ``balance_pending`` > 0 en estado ``pending`` o ``partially_paid``.

    Formato unificado (además de claves legacy): ``id_erp``, ``concepto``, ``monto_total``,
    ``saldo_pendiente``, ``moneda``, ``tipo``.
    """
    out: list[dict] = []
    for inv in list_unpaid_invoices(db, client_id):
        sale_id = int(inv["sale_id"])
        total = round(float(inv.get("total_amount") or 0), 2)
        open_b = round(float(inv.get("open_balance") or 0), 2)
        cur = normalize_currency_code(str(inv.get("currency") or "USD"))
        ref = str(inv.get("reference") or sale_ref_number(sale_id))
        out.append(
            {
                "tipo": "FACTURA",
                "id_erp": str(sale_id),
                "concepto": f"Factura / venta #{ref}",
                "monto_total": total,
                "saldo_pendiente": open_b,
                "moneda": cur,
                "referencia": ref,
                "sale_id": sale_id,
                "id": sale_id,
                "saldo_abierto": open_b,
            }
        )

    from app.wallet_recharge_helpers import wallet_recharge_contributes_to_client_debt

    wr_rows = (
        db.query(WalletRechargeRequest)
        .filter(WalletRechargeRequest.client_id == int(client_id))
        .all()
    )
    for r in wr_rows:
        if not wallet_recharge_contributes_to_client_debt(r):
            continue
        bp = float(getattr(r, "balance_pending", 0) or 0)
        if bp <= 1e-9:
            continue
        rid = int(r.id)
        total_r = round(float(r.amount_requested or 0), 2)
        bp_r = round(bp, 2)
        cur = normalize_currency_code(str(getattr(r, "recharge_currency", None) or "USD"))
        ref = wallet_recharge_ref_number(rid)
        out.append(
            {
                "tipo": "RECARGA_BAAS",
                "id_erp": str(rid),
                "concepto": "Recarga de saldo BaaS",
                "monto_total": total_r,
                "saldo_pendiente": bp_r,
                "moneda": cur,
                "referencia": ref,
                "importe_objetivo": total_r,
                "estado": str(r.status or ""),
                "id": rid,
            }
        )
    return out


def build_client_ledger(db: Session, client_id: int) -> list[dict]:
    """Lista unificada facturas + pagos + recargas BaaS ordenada por fecha DESC."""
    sales = (
        db.query(Sale)
        .filter(Sale.client_id == client_id)
        .order_by(Sale.created_at.desc())
        .all()
    )
    payments = (
        db.query(ClientPayment)
        .options(joinedload(ClientPayment.allocations).joinedload(PaymentAllocation.sale))
        .filter(ClientPayment.client_id == client_id)
        .order_by(ClientPayment.created_at.desc())
        .all()
    )

    entries: list[dict] = []

    for s in sales:
        dt = s.created_at
        date_str = dt.isoformat() if dt else ""
        amt = float(s.local_amount or s.amount or 0)
        note = (s.notes or "").strip() if hasattr(s, "notes") else ""
        if not note and s.rejection_reason:
            note = str(s.rejection_reason)[:200]
        related: list[dict] = []
        for p in payments:
            if p.status != ClientPaymentStatus.approved:
                continue
            for a in p.allocations or []:
                if a.sale_id is None:
                    continue
                try:
                    if int(a.sale_id) != int(s.id):
                        continue
                except (TypeError, ValueError):
                    continue
                related.append(
                    {
                        "type": "Pago",
                        "ref_number": str(p.payment_number or f"PAG-{p.id}"),
                        "amount": float(a.amount_applied or 0),
                        "sale_id": None,
                    }
                )
        entries.append(
            {
                "date": date_str,
                "type": "Factura",
                "ref_number": sale_ref_number(s.id),
                "note": note or f"Venta #{s.id}",
                "amount": amt,
                "currency": normalize_currency_code(str(s.currency or "USD")),
                "status": s.status.value if hasattr(s.status, "value") else str(s.status),
                "entity_id": s.id,
                "entity_kind": "sale",
                "related_docs": related,
                "_sort": dt,
            }
        )

    for p in payments:
        dt = p.created_at
        date_str = dt.isoformat() if dt else ""
        related: list[dict] = []
        for a in p.allocations or []:
            try:
                applied_f = float(a.amount_applied or 0)
            except (TypeError, ValueError):
                applied_f = 0.0
            if a.sale_id is not None:
                try:
                    sid = int(a.sale_id)
                except (TypeError, ValueError):
                    continue
                related.append(
                    {
                        "type": "Factura",
                        "ref_number": sale_ref_number(sid),
                        "amount": applied_f,
                        "sale_id": sid,
                    }
                )
            elif a.wallet_recharge_id is not None:
                try:
                    wr_id = int(a.wallet_recharge_id)
                except (TypeError, ValueError):
                    continue
                related.append(
                    {
                        "type": "RECARGA",
                        "ref_number": wallet_recharge_ref_number(wr_id),
                        "amount": applied_f,
                        "sale_id": None,
                    }
                )
        status_label = p.status.value if hasattr(p.status, "value") else str(p.status)
        if status_label == "pending_review":
            status_label = "En revisión"
        elif status_label == "approved":
            status_label = "Aprobado"
        elif status_label == "rejected":
            status_label = "Rechazado"
        is_wr_pay = is_wallet_recharge_client_payment(p)
        wr_rid = None
        if is_wr_pay:
            from app.services.wallet_recharge_client_payment import parse_notes_meta_wallet_recharge_id

            wr_rid = parse_notes_meta_wallet_recharge_id(p.notes)
        pay_cur = normalize_currency_code(str(p.currency or "USD"))
        if is_wr_pay:
            ref_suffix = f" (solicitud #{wr_rid})" if wr_rid is not None else ""
            pay_note = f"Recarga BaaS — cobro {float(p.amount):.2f} {pay_cur}{ref_suffix}"
        else:
            pay_note = (p.notes or p.payment_method or "").strip() or "Abono cliente"
        entries.append(
            {
                "date": date_str,
                "type": "Recarga BaaS" if is_wr_pay else "Pago",
                "ref_number": p.payment_number,
                "note": pay_note,
                "amount": float(p.amount),
                "currency": pay_cur,
                "status": status_label,
                "entity_id": p.id,
                "entity_kind": "wallet_recharge_payment" if is_wr_pay else "payment",
                "payment_id": int(p.id),
                "receipt_file_url": (p.receipt_file_url or "").strip() or None,
                "related_docs": related,
                "_sort": dt,
            }
        )

    recharges = (
        db.query(WalletRechargeRequest)
        .filter(WalletRechargeRequest.client_id == int(client_id))
        .order_by(WalletRechargeRequest.created_at.desc())
        .all()
    )
    for wr in recharges:
        dt = wr.created_at
        date_str = dt.isoformat() if dt else ""
        admin_note = (getattr(wr, "admin_note", None) or "").strip()
        base_note = f"Recarga saldo BaaS (objetivo {float(wr.amount_requested or 0):.2f} {normalize_currency_code(str(wr.recharge_currency or 'USD'))})"
        note = f"{base_note}. {admin_note}".strip() if admin_note else base_note
        status_raw = str(wr.status or "")
        entries.append(
            {
                "date": date_str,
                "type": "RECARGA",
                "ref_number": wallet_recharge_ref_number(int(wr.id)),
                "note": note,
                "amount": float(wr.amount_requested or 0),
                "currency": normalize_currency_code(str(wr.recharge_currency or "USD")),
                "status": _wallet_recharge_status_label_es(status_raw),
                "entity_id": int(wr.id),
                "entity_kind": "wallet_recharge",
                "receipt_file_url": (wr.receipt_url or "").strip() or None,
                "related_docs": [],
                "_sort": dt,
            }
        )

    from app.models.wallet_transaction import WalletTransaction
    from app.services.client_reseller_service import (
        TX_BAAS_TRANSFER_IN,
        TX_BAAS_TRANSFER_OUT,
        TX_BAAS_TRANSFER_REVERT_IN,
        TX_BAAS_TRANSFER_REVERT_OUT,
        BAAS_TRANSFER_LEDGER_TYPES,
        baas_transfer_already_reverted,
        baas_transfer_ref_number,
        can_revert_baas_transfer,
        get_baas_transfer_counterparty,
        resolve_baas_transfer_parties,
    )

    wallet_txs = (
        db.query(WalletTransaction)
        .filter(
            WalletTransaction.client_id == int(client_id),
            WalletTransaction.transaction_type.in_(tuple(BAAS_TRANSFER_LEDGER_TYPES)),
        )
        .order_by(WalletTransaction.created_at.desc())
        .all()
    )
    for wtx in wallet_txs:
        dt = wtx.created_at
        date_str = dt.isoformat() if dt else ""
        tx_type = str(wtx.transaction_type or "")
        amt = float(wtx.amount or 0)
        cp_id, cp_name = get_baas_transfer_counterparty(db, wtx)
        note = (wtx.description or "").strip() or "Movimiento BaaS"
        if cp_name:
            if tx_type == TX_BAAS_TRANSFER_IN:
                note = f"{note} · Emisor: {cp_name}"
            elif tx_type == TX_BAAS_TRANSFER_OUT:
                note = f"{note} · Receptor: {cp_name}"
        if tx_type in (TX_BAAS_TRANSFER_IN, TX_BAAS_TRANSFER_OUT):
            type_label = "Transferencia BaaS"
            try:
                _, _, _, canonical_id = resolve_baas_transfer_parties(db, wtx)
                reverted = baas_transfer_already_reverted(db, canonical_id)
            except Exception:
                reverted = False
            status_label = "Revertida" if reverted else "Completada"
            revert_ok = can_revert_baas_transfer(db, wtx) if not reverted else False
        elif tx_type == TX_BAAS_TRANSFER_REVERT_OUT:
            type_label = "Reversión transferencia BaaS"
            status_label = "Revertida"
            revert_ok = False
        elif tx_type == TX_BAAS_TRANSFER_REVERT_IN:
            type_label = "Reversión transferencia BaaS"
            status_label = "Revertida"
            revert_ok = False
        else:
            type_label = "Transferencia BaaS"
            status_label = "Completada"
            revert_ok = False

        entries.append(
            {
                "date": date_str,
                "type": type_label,
                "ref_number": baas_transfer_ref_number(int(wtx.id)),
                "note": note,
                "amount": amt,
                "currency": "USD",
                "status": status_label,
                "entity_id": int(wtx.id),
                "entity_kind": "wallet_transfer",
                "wallet_transaction_id": int(wtx.id),
                "can_revert": revert_ok,
                "revert_counterparty_id": cp_id,
                "revert_counterparty_name": cp_name,
                "baas_transfer_amount": round(abs(amt), 2),
                "related_docs": [],
                "_sort": dt,
            }
        )

    entries.sort(key=lambda e: e.get("_sort") or datetime.min.replace(tzinfo=UTC), reverse=True)
    for e in entries:
        e.pop("_sort", None)
    return entries


_RE_WR_SOLICITUD_REF = re.compile(r"Recarga abono\s*\(\s*solicitud\s*#\s*(\d+)\s*\)", re.IGNORECASE)
_RE_WR_APLICADO = re.compile(r"aplicado(?:\s*CxC)?\s*([\d.]+)", re.IGNORECASE)
_RE_PARTE_EFECTIVO = re.compile(r"PARTE_EFECTIVO=([\d.]+)", re.IGNORECASE)
_RE_PARTE_SALDO_FAVOR = re.compile(r"PARTE_SALDO_FAVOR=([\d.]+)", re.IGNORECASE)
_RE_META_WR_CXC_APPLIED = re.compile(r"META_WR_CXC_APPLIED=([\d.]+)", re.IGNORECASE)
_RE_WR_BILLETERA = re.compile(r"billetera\s*\+([\d.]+)", re.IGNORECASE)


def _wallet_recharge_applied_from_payment_notes(notes: Optional[str], fallback: float) -> float:
    raw = str(notes or "")
    for pat in (_RE_PARTE_SALDO_FAVOR, _RE_PARTE_EFECTIVO, _RE_WR_APLICADO):
        m = pat.search(raw)
        if m:
            try:
                return round(float(m.group(1)), 2)
            except (TypeError, ValueError):
                continue
    return round(float(fallback), 2)


def linked_payments_financial_for_wallet_recharge(
    db: Session,
    req: WalletRechargeRequest,
) -> tuple[list[dict], list[dict]]:
    """
    Pagos vinculados a una solicitud BaaS en el mismo shape que ventas:

    - ``approved``: ``linked_payments`` (aprobados, con comprobante si existe).
    - ``pending_review``: comprobantes en revisión (portal / admin).
    """
    from app.models.wallet_transaction import WalletTransaction
    from app.services.wallet_recharge_client_payment import parse_notes_meta_wallet_recharge_id

    rid = int(req.id)
    cid = int(req.client_id)
    cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")

    approved: list[dict] = []
    pending: list[dict] = []

    payments = (
        db.query(ClientPayment)
        .filter(ClientPayment.client_id == cid)
        .order_by(
            nullslast(ClientPayment.approved_at.asc()),
            ClientPayment.created_at.asc(),
        )
        .all()
    )
    for cp in payments:
        if parse_notes_meta_wallet_recharge_id(cp.notes) != rid:
            continue
        receipt = (str(cp.receipt_file_url or "")).strip() or None
        if cp.status == ClientPaymentStatus.approved:
            applied = _wallet_recharge_applied_from_payment_notes(cp.notes, float(cp.amount or 0))
            approved.append(
                {
                    "payment_id": int(cp.id),
                    "payment_number": (cp.payment_number or f"PAG-{cp.id}").strip(),
                    "date": cp.approved_at or cp.created_at,
                    "amount_applied": applied,
                    "receipt_file_url": receipt,
                }
            )
        elif cp.status == ClientPaymentStatus.pending_review:
            amt = float(cp.amount or 0)
            pending.append(
                {
                    "payment_id": int(cp.id),
                    "payment_number": (cp.payment_number or f"PAG-{cp.id}").strip(),
                    "amount": amt,
                    "currency": normalize_currency_code(str(cp.currency or cur)),
                    "payment_method": cp.payment_method,
                    "receipt_file_url": receipt,
                    "created_at": cp.created_at,
                    "amount_applied_to_sale": amt,
                }
            )

    txs = (
        db.query(WalletTransaction)
        .filter(
            WalletTransaction.client_id == cid,
            WalletTransaction.transaction_type == "recharge",
        )
        .order_by(WalletTransaction.created_at.asc())
        .all()
    )
    for tx in txs:
        desc = str(tx.description or "")
        mm = _RE_WR_SOLICITUD_REF.search(desc)
        if not mm or int(mm.group(1)) != rid:
            continue
        ma = _RE_WR_APLICADO.search(desc)
        try:
            applied = float(ma.group(1)) if ma is not None else float(tx.amount)
        except (TypeError, ValueError):
            applied = float(tx.amount)
        if any(abs(float(a.get("amount_applied") or 0) - applied) < 0.02 for a in approved):
            continue
        approved.append(
            {
                "payment_id": int(1_000_000_000 + int(tx.id)),
                "payment_number": f"Abono #{int(tx.id)}",
                "date": tx.created_at,
                "amount_applied": round(applied, 2),
                "receipt_file_url": None,
            }
        )

    receipt = (str(getattr(req, "receipt_url", None) or "")).strip()
    status_raw = str(getattr(req, "status", "") or "")
    if status_raw == REQ_STATUS_IN_REVIEW and receipt and not pending:
        declared = getattr(req, "portal_declared_payment_amount", None)
        try:
            amt_f = float(declared) if declared is not None else 0.0
        except (TypeError, ValueError):
            amt_f = 0.0
        if amt_f <= 1e-9:
            amt_f = float(getattr(req, "balance_pending", 0) or 0)
        pending.append(
            {
                "payment_id": int(2_000_000_000 + rid),
                "payment_number": "Comprobante en revisión",
                "amount": round(amt_f, 2),
                "currency": cur,
                "payment_method": None,
                "receipt_file_url": receipt,
                "created_at": None,
                "amount_applied_to_sale": round(amt_f, 2),
            }
        )

    return approved, pending


# ── Recargas BaaS (mismo waterfall CxC que ventas) ─────────────────────────────

_WR_EPS = 1e-6
_TX_RECHARGE = "recharge"


def apply_wallet_recharge_credit_on_create(
    db: Session,
    req: WalletRechargeRequest,
    client: Client,
    *,
    credit_amount: float,
    strict_accounting: bool = True,
) -> float:
    """
    Aplica saldo a favor del cliente al crear una solicitud BaaS (admin).

    Acredita billetera, reduce ``balance_pending`` y registra ``ClientPayment`` aprobado.
    """
    try:
        requested = float(credit_amount)
    except (TypeError, ValueError):
        return 0.0
    if requested <= _WR_EPS:
        return 0.0

    pending_before = float(getattr(req, "balance_pending", 0) or 0)
    if pending_before <= _WR_EPS:
        return 0.0

    cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
    to_apply = min(requested, pending_before)
    take = subtract_client_credit_balance(db, client, cur, Decimal(str(to_apply)))
    applied_to_req = float(take)
    if applied_to_req <= _WR_EPS:
        return 0.0

    from app.services.client_currency_service import maybe_set_client_base_currency_from_recharge

    maybe_set_client_base_currency_from_recharge(
        db,
        client,
        cur,
        recharge_request_id=int(req.id),
    )

    from app.services.wallet_balance_service import add_client_wallet_balance

    add_client_wallet_balance(db, client, cur, applied_to_req)
    req.amount_paid = float(getattr(req, "amount_paid", 0) or 0) + applied_to_req
    pending_after = max(0.0, pending_before - applied_to_req)
    req.balance_pending = pending_after

    if pending_after <= _WR_EPS:
        req.balance_pending = 0.0
        req.status = REQ_STATUS_APPROVED
    else:
        req.status = REQ_STATUS_PARTIALLY_PAID

    now_ts = now_ecuador()
    credit_notes = (
        "credit_auto_admin\n"
        f"META_WALLET_RECHARGE_ID={int(req.id)}\n"
        f"PARTE_SALDO_FAVOR={applied_to_req:.2f} {cur}"
    )
    credit_pay = ClientPayment(
        payment_number=next_payment_number(db),
        client_id=int(client.id),
        amount=Decimal(str(applied_to_req)).quantize(Decimal("0.0001")),
        currency=cur,
        exchange_rate=float(getattr(req, "recharge_exchange_rate", None) or 1.0),
        receipt_file_url=None,
        payment_method_id=None,
        payment_method="Saldo a Favor",
        deposit_account_id=None,
        status=ClientPaymentStatus.approved,
        notes=credit_notes,
        created_at=now_ts,
        approved_at=now_ts,
    )
    db.add(credit_pay)
    db.flush()

    from app.models.wallet_transaction import WalletTransaction
    from app.services.accounting_engine import ensure_wallet_recharge_accrual_journal
    from app.services.client_payment_accounting_sync import sync_client_payment_accounting_ledgers

    ensure_wallet_recharge_accrual_journal(db, req, strict=strict_accounting)
    credit_pay.notes = _stamp_wallet_recharge_cxc_applied_notes(
        credit_pay.notes,
        applied_to_cxc=applied_to_req,
        received_amount=applied_to_req,
        currency=cur,
    )
    db.flush()
    sync_client_payment_accounting_ledgers(db, credit_pay, strict=strict_accounting)

    desc = (
        f"Recarga abono (solicitud #{req.id}): saldo a favor {applied_to_req:.2f}"
        f" · aplicado {applied_to_req:.2f} · saldo solicitud {pending_after:.2f}"
    )
    tx = WalletTransaction(
        user_id=None,
        client_id=int(client.id),
        amount=applied_to_req,
        transaction_type=_TX_RECHARGE,
        description=desc,
    )
    db.add(tx)
    db.flush()
    sync_client_credit_from_overpay(db, client)
    return applied_to_req


def credit_wallet_on_baas_fifo_allocation(
    db: Session,
    req: WalletRechargeRequest,
    allocated_amount: Decimal,
    *,
    payment: Optional[ClientPayment] = None,
    amount_paid_before: Optional[float] = None,
) -> float:
    """
    Modelo crédito BaaS: en el **primer** abono FIFO entrega el 100% del producto solicitado.

    - Abono parcial (p. ej. $12 sobre solicitud $100) → billetera +$100 de una vez.
    - Abonos posteriores solo reducen ``balance_pending`` (sin nueva entrega).
    - Omite ``META_RETIRO_INSTANT_CXC`` (producto ya entregado al activar).
    """
    from app.wallet_recharge_helpers import (
        wallet_recharge_is_retiro_instant_cxc,
        wallet_recharge_virtual_product_already_delivered,
    )

    if wallet_recharge_is_retiro_instant_cxc(req):
        return 0.0
    if _q_amt(allocated_amount) <= _FP_EPS:
        return 0.0
    if wallet_recharge_virtual_product_already_delivered(db, req):
        return 0.0

    if amount_paid_before is None:
        try:
            amount_paid_before = float(getattr(req, "amount_paid", 0) or 0)
        except (TypeError, ValueError):
            amount_paid_before = 0.0

    excl_pid = int(payment.id) if payment is not None and getattr(payment, "id", None) else None
    approved_before = _approved_alloc_sum_for_wallet_recharge(
        db, int(req.id), exclude_payment_id=excl_pid
    )
    is_first_abono = amount_paid_before <= _WR_EPS and approved_before <= _FP_EPS
    if not is_first_abono:
        return 0.0

    client = db.get(Client, int(req.client_id))
    if client is None:
        return 0.0

    wr_cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
    return credit_wallet_recharge_product_if_pending(db, req, client, wr_cur)


def credit_wallet_recharge_product_if_pending(
    db: Session,
    req: WalletRechargeRequest,
    client: Client,
    currency: str,
) -> float:
    """
    Entrega única del producto virtual (``amount_requested`` completo) al primer abono.

    Usa movimientos de billetera vinculados a la solicitud como candado anti doble entrega.
    """
    from app.wallet_recharge_helpers import wallet_recharge_virtual_product_already_delivered

    if wallet_recharge_virtual_product_already_delivered(db, req):
        return 0.0

    try:
        product_total = float(getattr(req, "amount_requested", 0) or 0)
    except (TypeError, ValueError):
        product_total = 0.0
    credited_so_far = _wallet_credited_for_recharge_request(db, req)
    wallet_to_add = max(0.0, round(product_total - credited_so_far, 2))
    if wallet_to_add <= _WR_EPS:
        return 0.0

    from app.models.wallet_transaction import WalletTransaction
    from app.services.wallet_balance_service import add_client_wallet_balance

    wr_cur = normalize_currency_code(currency)
    add_client_wallet_balance(db, client, wr_cur, wallet_to_add)
    db.add(
        WalletTransaction(
            user_id=None,
            client_id=int(client.id),
            amount=wallet_to_add,
            transaction_type=_TX_RECHARGE,
            description=(
                f"Recarga abono (solicitud #{int(req.id)}): entrega producto · "
                f"billetera +{wallet_to_add:.2f}"
            ),
        )
    )
    db.flush()
    return wallet_to_add


def _wallet_credited_for_recharge_request(db: Session, req: WalletRechargeRequest) -> float:
    """Saldo virtual ya entregado por esta solicitud (suma de movimientos de billetera vinculados)."""
    from app.models.wallet_transaction import WalletTransaction

    cid = int(req.client_id)
    rid = int(req.id)
    txs = (
        db.query(WalletTransaction)
        .filter(
            WalletTransaction.client_id == cid,
            WalletTransaction.transaction_type == _TX_RECHARGE,
        )
        .all()
    )
    total = 0.0
    for tx in txs:
        desc = str(tx.description or "")
        mm = _RE_WR_SOLICITUD_REF.search(desc)
        if not mm or int(mm.group(1)) != rid:
            continue
        mb = _RE_WR_BILLETERA.search(desc)
        if mb is not None:
            try:
                total += float(mb.group(1))
                continue
            except (TypeError, ValueError):
                pass
        ma = _RE_WR_APLICADO.search(desc)
        if ma is not None:
            try:
                total += float(ma.group(1))
                continue
            except (TypeError, ValueError):
                pass
        try:
            total += float(tx.amount or 0)
        except (TypeError, ValueError):
            continue
    return round(total, 2)


def _resolve_wallet_recharge_received_default(req: WalletRechargeRequest, pending_before: float) -> float:
    """Monto sugerido al aprobar: declaración del portal (permite sobrepago), o saldo pendiente."""
    declared = getattr(req, "portal_declared_payment_amount", None)
    if declared is not None:
        try:
            decl_f = float(declared)
            if decl_f > _WR_EPS:
                return decl_f
        except (TypeError, ValueError):
            pass
    return pending_before


def finalize_wallet_recharge_payment_approval(
    db: Session,
    req: WalletRechargeRequest,
    client: Client,
    received_amount: float,
    *,
    wallet_tx_type: str = _TX_RECHARGE,
    strict_accounting: bool = True,
) -> tuple["WalletTransaction", Optional[ClientPayment], float, float, float]:
    """
    Aprueba un comprobante BaaS en revisión (admin):

    - Recargas estándar: entrega total al primer abono FIFO (``credit_wallet_on_baas_fifo_allocation``).
    - Retiro instantáneo CxC: entrega virtual pendiente vía ``credit_wallet_recharge_product_if_pending``.
    - Aprueba ``ClientPayment`` vía ``finalize_client_payment_approval`` + FIFO cruzado.
    - Excedente → remanente en cobro (saldo a favor vía ledger).
    """
    from app.models.wallet_transaction import WalletTransaction
    from app.services.accounting_engine import ensure_wallet_recharge_accrual_journal
    from app.services.wallet_recharge_client_payment import (
        ensure_pending_client_payment_for_wallet_recharge,
        finalize_wallet_recharge_client_payment_on_approval,
    )

    recv = float(received_amount)
    pending_before = float(getattr(req, "balance_pending", 0) or 0)
    wr_cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")

    from app.wallet_recharge_helpers import wallet_recharge_is_retiro_instant_cxc

    credited_before = _wallet_credited_for_recharge_request(db, req)
    wallet_to_add = 0.0
    if wallet_recharge_is_retiro_instant_cxc(req):
        wallet_to_add = credit_wallet_recharge_product_if_pending(db, req, client, wr_cur)

    ensure_wallet_recharge_accrual_journal(db, req, strict=strict_accounting)

    cp = finalize_wallet_recharge_client_payment_on_approval(
        db,
        req,
        client=client,
        received_amount=recv,
        strict_accounting=strict_accounting,
    )
    if cp is None:
        cp = ensure_pending_client_payment_for_wallet_recharge(
            db,
            req,
            client=client,
            declared_amount=recv,
        )
        if cp is not None:
            cp = finalize_wallet_recharge_client_payment_on_approval(
                db,
                req,
                client=client,
                received_amount=recv,
                strict_accounting=strict_accounting,
            )

    db.refresh(req)
    pending_after = float(getattr(req, "balance_pending", 0) or 0)
    applied = max(0.0, round(pending_before - pending_after, 2))
    if cp is not None:
        applied = float(_payment_applied_total(db, cp))
    if not wallet_recharge_is_retiro_instant_cxc(req):
        credited_after = _wallet_credited_for_recharge_request(db, req)
        wallet_to_add = max(0.0, round(credited_after - credited_before, 2))
    surplus = float(compute_payment_credit_excess(cp, db=db)) if cp is not None else max(0.0, recv - applied)

    desc = (
        f"Recarga abono (solicitud #{req.id}): percibido {recv:.2f}"
        f" · aplicado CxC {applied:.2f} · billetera +{wallet_to_add:.2f}"
        f" · saldo solicitud {pending_after:.2f}"
    )
    if surplus > _WR_EPS:
        desc += f" · excedente sin asignar (saldo a favor) +{surplus:.2f}"

    tx = WalletTransaction(
        user_id=None,
        client_id=int(client.id),
        amount=wallet_to_add if wallet_to_add > _WR_EPS else recv,
        transaction_type=wallet_tx_type,
        description=desc,
    )
    db.add(tx)
    db.flush()

    if pending_after > _WR_EPS:
        req.receipt_url = None
        req.portal_declared_payment_amount = None
        req.portal_submitted_deposit_account_id = None

    sync_client_credit_from_overpay(db, client)
    db.flush()
    return tx, cp, applied, surplus, wallet_to_add
