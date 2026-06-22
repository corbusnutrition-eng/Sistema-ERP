"""Saldo virtual BaaS por moneda (``clients.custom_fields``)."""

from __future__ import annotations

from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client

_WALLET_BALANCES_CF_KEY = "wallet_balances_by_currency"
_WALLET_EPS = Decimal("0.00005")


def client_wallet_balances_map(client: Client) -> dict[str, Decimal]:
    """Saldos BaaS por moneda. Migra ``wallet_balance`` legacy como USD."""
    out: dict[str, Decimal] = {}
    cf = getattr(client, "custom_fields", None) or {}
    raw = cf.get(_WALLET_BALANCES_CF_KEY)
    if isinstance(raw, dict):
        for key, val in raw.items():
            try:
                cur = normalize_currency_code(str(key))
                amt = Decimal(str(val)).quantize(Decimal("0.01"))
                if amt > _WALLET_EPS:
                    out[cur] = amt
            except Exception:
                continue
    legacy = Decimal(str(getattr(client, "wallet_balance", 0) or 0)).quantize(Decimal("0.01"))
    if legacy > _WALLET_EPS:
        prev = out.get("USD", Decimal("0"))
        if legacy > prev + _WALLET_EPS:
            out["USD"] = legacy
    return out


def _persist_client_wallet_balances_map(client: Client, balances: dict[str, Decimal]) -> None:
    cleaned = {
        cur: float(amt.quantize(Decimal("0.01")))
        for cur, amt in balances.items()
        if amt > _WALLET_EPS
    }
    cf = dict(getattr(client, "custom_fields", None) or {})
    if cleaned:
        cf[_WALLET_BALANCES_CF_KEY] = cleaned
    elif _WALLET_BALANCES_CF_KEY in cf:
        del cf[_WALLET_BALANCES_CF_KEY]
    client.custom_fields = cf
    client.wallet_balance = float(cleaned.get("USD", 0.0))


def get_client_wallet_balance(client: Client, currency: str) -> Decimal:
    cur = normalize_currency_code(currency)
    return client_wallet_balances_map(client).get(cur, Decimal("0"))


def list_client_wallet_balance_rows(
    client: Client,
    *,
    currency: Optional[str] = None,
) -> list[tuple[str, Decimal]]:
    rows = [
        (cur, amt)
        for cur, amt in sorted(client_wallet_balances_map(client).items())
        if amt > _WALLET_EPS
    ]
    if currency:
        cur = normalize_currency_code(currency)
        return [(c, a) for c, a in rows if c == cur]
    return rows


def compute_client_wallet_summary(client: Client) -> dict[str, object]:
    from app.services.client_currency_service import get_client_currency

    rows = list_client_wallet_balance_rows(client)
    base_cur = get_client_currency(client)
    balances = client_wallet_balances_map(client)
    primary_cur = base_cur
    primary_dec = balances.get(base_cur, Decimal("0"))
    if primary_dec <= _WALLET_EPS and rows:
        primary_cur, primary_dec = max(rows, key=lambda x: float(x[1]))
    elif primary_dec <= _WALLET_EPS and not rows:
        primary_amt = 0.0
        return {
            "wallet_balance": primary_amt,
            "wallet_balance_currency": base_cur,
            "wallet_balances_by_currency": [
                {"currency": cur, "amount": float(amt)} for cur, amt in rows
            ],
        }
    primary_amt = float(primary_dec)
    return {
        "wallet_balance": primary_amt,
        "wallet_balance_currency": primary_cur,
        "wallet_balances_by_currency": [
            {"currency": cur, "amount": float(amt)} for cur, amt in rows
        ],
    }


def add_client_wallet_balance(
    db: Session,
    client: Client,
    currency: str,
    amount: float,
) -> float:
    """Acredita saldo BaaS en la moneda de la recarga / operación."""
    try:
        delta = Decimal(str(amount)).quantize(Decimal("0.01"))
    except Exception:
        return 0.0
    if delta <= _WALLET_EPS:
        return 0.0
    cur = normalize_currency_code(currency)
    if not cur:
        raise ValueError("Moneda de billetera inválida.")
    balances = client_wallet_balances_map(client)
    prev = balances.get(cur, Decimal("0"))
    balances[cur] = (prev + delta).quantize(Decimal("0.01"))
    _persist_client_wallet_balances_map(client, balances)
    db.flush()
    return float(balances[cur])


def subtract_client_wallet_balance(
    db: Session,
    client: Client,
    currency: str,
    amount: float,
) -> float:
    """Debita saldo BaaS en la moneda indicada; devuelve lo efectivamente descontado."""
    try:
        take = Decimal(str(amount)).quantize(Decimal("0.01"))
    except Exception:
        return 0.0
    if take <= _WALLET_EPS:
        return 0.0
    cur = normalize_currency_code(currency)
    balances = client_wallet_balances_map(client)
    prev = balances.get(cur, Decimal("0"))
    applied = min(prev, take).quantize(Decimal("0.01"))
    if applied <= _WALLET_EPS:
        return 0.0
    balances[cur] = (prev - applied).quantize(Decimal("0.01"))
    if balances[cur] <= _WALLET_EPS:
        balances.pop(cur, None)
    _persist_client_wallet_balances_map(client, balances)
    db.flush()
    return float(applied)
