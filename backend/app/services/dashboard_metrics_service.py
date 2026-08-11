"""KPIs agregados del panel principal (Dashboard ERP)."""

from __future__ import annotations

from calendar import monthrange
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.client_payment import ClientPayment, ClientPaymentStatus
from app.models.sale import Sale, SaleStatus
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.services.client_payment_service import (
    is_wallet_recharge_client_payment,
    list_client_ar_firm_obligations_for_report,
    payment_encapsulated_in_open_sale_review,
)
from app.timezone_utils import now_ecuador
from app.wallet_recharge_helpers import REQ_STATUS_IN_REVIEW

_FP_EPS = Decimal("0.005")


def _obligation_open_balance_usd(db: Session, inv: dict) -> Decimal:
    """Convierte saldo CxC abierto a USD (consolidación del dashboard)."""
    open_b = Decimal(str(inv.get("open_balance") or 0)).quantize(Decimal("0.0001"))
    if open_b <= _FP_EPS:
        return Decimal("0")

    cur = normalize_currency_code(str(inv.get("currency") or "USD"))
    if cur == "USD":
        return open_b.quantize(Decimal("0.01"))

    kind = str(inv.get("obligation_kind") or "sale")
    if kind == "wallet_recharge":
        wr = inv.get("_wallet_recharge_row")
        if wr is not None:
            xr = float(getattr(wr, "recharge_exchange_rate", None) or 1) or 1.0
            if xr > 0:
                return (open_b / Decimal(str(xr))).quantize(Decimal("0.01"))
    elif kind == "sale":
        sale_id = inv.get("sale_id")
        if sale_id is not None:
            sale = db.get(Sale, int(sale_id))
            if sale is not None:
                xr = float(getattr(sale, "exchange_rate", None) or 1) or 1.0
                if xr > 0:
                    return (open_b / Decimal(str(xr))).quantize(Decimal("0.01"))

    return open_b.quantize(Decimal("0.01"))


def compute_monthly_revenue_usd(db: Session) -> Decimal:
    """Abonos CxC aprobados liquidados en el mes calendario actual (Ecuador)."""
    now = now_ecuador()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).date()
    last_day = monthrange(now.year, now.month)[1]
    month_end = now.replace(day=last_day).date()

    when = func.coalesce(ClientPayment.approved_at, ClientPayment.created_at)
    total = (
        db.query(
            func.coalesce(
                func.sum(ClientPayment.amount / func.nullif(ClientPayment.exchange_rate, 0)),
                0,
            )
        )
        .filter(
            ClientPayment.status == ClientPaymentStatus.approved,
            when.isnot(None),
            func.date(when) >= month_start,
            func.date(when) <= month_end,
        )
        .scalar()
    )
    return Decimal(str(total or 0)).quantize(Decimal("0.01"))


def compute_accounts_receivable_usd(db: Session) -> Decimal:
    """
    Suma global de saldos CxC firmes (Activado / parcial) en USD.

    Usa la misma cartera y filtros que ``GET /reports/accounts-receivable``:
    solo clientes directos del admin (``parent_id`` nulo) y obligaciones con deuda
    firme (excluye Pendiente y En revisión). Montos en otras monedas se convierten
    con la misma lógica de ``_obligation_open_balance_usd``.
    """
    total = Decimal("0")
    client_ids = [
        int(row[0])
        for row in db.query(Client.id).filter(Client.parent_id.is_(None)).all()
    ]
    for cid in client_ids:
        for inv in list_client_ar_firm_obligations_for_report(db, cid):
            total += _obligation_open_balance_usd(db, inv)
    return total.quantize(Decimal("0.01"))


def compute_pending_reviews_count(db: Session) -> int:
    """
    Transacciones en bandeja de revisión admin:
    ventas ``payment_submitted``, recargas ``in_review`` y abonos standalone ``pending_review``.
    """
    sales_count = (
        db.query(func.count(Sale.id))
        .filter(Sale.status == SaleStatus.payment_submitted)
        .scalar()
        or 0
    )
    recharges_count = (
        db.query(func.count(WalletRechargeRequest.id))
        .filter(WalletRechargeRequest.status == REQ_STATUS_IN_REVIEW)
        .scalar()
        or 0
    )

    pending_payments = (
        db.query(ClientPayment)
        .filter(ClientPayment.status == ClientPaymentStatus.pending_review)
        .all()
    )
    standalone_count = sum(
        1
        for payment in pending_payments
        if not payment_encapsulated_in_open_sale_review(db, payment)
        and not is_wallet_recharge_client_payment(payment)
    )

    return int(sales_count) + int(recharges_count) + int(standalone_count)
