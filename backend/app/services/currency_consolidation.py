"""Conversión a moneda base (USD) para reportes y asientos multimoneda."""

from __future__ import annotations

from decimal import Decimal
from typing import Optional

from sqlalchemy import desc, nullslast
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client_payment import ClientPayment
from app.models.sale import Sale
from app.models.wallet_recharge_request import WalletRechargeRequest

_EPS = Decimal("0.000001")


def normalize_exchange_rate(value: object | None, *, currency: str = "USD") -> Decimal:
    """
    Unidades de moneda local por 1 USD (ej. BOB 6.9 → 100 BOB ≈ 14.49 USD).

    USD y equivalentes (USDT) usan 1.
    """
    cur = normalize_currency_code(currency)
    if cur in ("USD", "USDT", "USDC"):
        return Decimal("1")
    try:
        xr = Decimal(str(value if value is not None else "1"))
    except Exception:
        xr = Decimal("1")
    if xr <= _EPS:
        xr = Decimal("1")
    return xr.quantize(Decimal("0.000001"))


def local_to_usd(local_amount: Decimal | float | str, exchange_rate: Decimal | float | str) -> Decimal:
    """Convierte importe en moneda local a USD usando tasa histórica (local / rate)."""
    local = Decimal(str(local_amount))
    xr = Decimal(str(exchange_rate))
    if xr <= _EPS:
        xr = Decimal("1")
    return (local / xr).quantize(Decimal("0.01"))


def journal_line_pnl_usd(
    account_type: str,
    debit: Decimal | float | str,
    credit: Decimal | float | str,
    exchange_rate: Decimal | float | str,
) -> Decimal:
    """Contribución de una línea del libro mayor al P&L en USD."""
    d = Decimal(str(debit or 0))
    c = Decimal(str(credit or 0))
    xr = Decimal(str(exchange_rate or 1))
    if xr <= _EPS:
        xr = Decimal("1")
    if account_type == "income":
        local_net = c - d
    else:
        local_net = d - c
    return (local_net / xr).quantize(Decimal("0.01"))


def sale_exchange_rate(sale: Sale) -> Decimal:
    return normalize_exchange_rate(getattr(sale, "exchange_rate", None), currency=str(sale.currency or "USD"))


def payment_exchange_rate(payment: ClientPayment, db: Optional[Session] = None) -> Decimal:
    cur = normalize_currency_code(str(payment.currency or "USD"))
    xr = normalize_exchange_rate(getattr(payment, "exchange_rate", None), currency=cur)
    if xr != Decimal("1") or cur == "USD":
        return xr
    if db is None:
        return xr
    from app.services.client_payment_service import parse_notes_meta_sale_id

    sid = parse_notes_meta_sale_id(payment.notes)
    if sid is None:
        return xr
    sale = db.get(Sale, int(sid))
    if sale is None:
        return xr
    if normalize_currency_code(str(sale.currency or "USD")) != cur:
        return xr
    return sale_exchange_rate(sale)


def get_last_exchange_rate(db: Session, currency: str) -> tuple[float, bool]:
    """
    Última tasa usada en la moneda (venta, pago o recarga BaaS), para autollenar formularios.

    Returns:
        (exchange_rate, from_history) — ``from_history`` es False si no hay registros previos.
    """
    cur = normalize_currency_code(currency)
    if cur in ("USD", "USDT", "USDC"):
        return 1.0, True

    last_sale = (
        db.query(Sale.exchange_rate)
        .filter(Sale.currency == cur, Sale.exchange_rate > 0)
        .order_by(nullslast(desc(Sale.created_at)), desc(Sale.id))
        .first()
    )
    if last_sale is not None and last_sale[0] and float(last_sale[0]) > 0:
        return float(last_sale[0]), True

    last_pay = (
        db.query(ClientPayment.exchange_rate)
        .filter(ClientPayment.currency == cur, ClientPayment.exchange_rate > 0)
        .order_by(nullslast(desc(ClientPayment.created_at)), desc(ClientPayment.id))
        .first()
    )
    if last_pay is not None and last_pay[0] and float(last_pay[0]) > 0:
        return float(last_pay[0]), True

    last_wr = (
        db.query(WalletRechargeRequest.recharge_exchange_rate)
        .filter(WalletRechargeRequest.recharge_currency == cur)
        .order_by(nullslast(desc(WalletRechargeRequest.created_at)), desc(WalletRechargeRequest.id))
        .first()
    )
    if last_wr is not None and last_wr[0] and float(last_wr[0]) > 0:
        return float(last_wr[0]), True

    return 1.0, False
