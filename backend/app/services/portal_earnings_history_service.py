"""Historial paginado de ganancias BaaS (comisiones de red + ventas directas)."""

from __future__ import annotations

import math
from datetime import datetime, timedelta

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.sale import Sale
from app.models.wallet_transaction import WalletTransaction
from app.services.baas_commission_cascade_service import (
    TX_NETWORK_PROFIT,
    TX_WALLET_DEPOSIT,
    _convert_amount_to_currency,
)
from app.services.sale_accounting_sync import is_baas_wallet_auto_purchase_sale
from app.timezone_utils import ensure_aware, now_ecuador

PORTAL_EARNINGS_DISPLAY_CURRENCY = "USD"


def _wallet_tx_currency(description: str | None) -> str:
    desc_raw = (description or "").strip()
    if " · " in desc_raw:
        tail = desc_raw.rsplit(" · ", 1)[-1].strip()
        if len(tail) >= 3:
            return normalize_currency_code(tail, "USD")
    return "USD"


def _commission_tx_filter():
    return or_(
        WalletTransaction.transaction_type == TX_NETWORK_PROFIT,
        and_(
            WalletTransaction.transaction_type == TX_WALLET_DEPOSIT,
            WalletTransaction.description.like("Comisión por red%"),
        ),
    )


def _display_description(raw: str | None) -> str:
    desc = (raw or "").strip()
    if " · " in desc:
        desc = desc.rsplit(" · ", 1)[0].strip()
    return desc or "Comisión por red"


def _direct_sale_profit_usd(db: Session, sale: Sale) -> float | None:
    """Margen de venta directa (precio cobrado al cliente final − costo BaaS)."""
    if not is_baas_wallet_auto_purchase_sale(sale):
        return None
    ec_name = (getattr(sale, "end_customer_name", None) or "").strip()
    if not ec_name:
        return None
    if getattr(sale, "end_customer_sale_price", None) is None:
        return None
    try:
        charged = float(sale.end_customer_sale_price or 0)
        cost = float(sale.local_amount if sale.local_amount is not None else sale.amount or 0)
    except (TypeError, ValueError):
        return None
    profit = round(charged - cost, 4)
    if profit <= 1e-9:
        return None
    sale_cur = normalize_currency_code(str(getattr(sale, "currency", None) or "USD"))
    return round(
        _convert_amount_to_currency(db, profit, sale_cur, PORTAL_EARNINGS_DISPLAY_CURRENCY),
        2,
    )


def _direct_sale_description(sale: Sale) -> str:
    name = (getattr(sale, "end_customer_name", None) or "").strip()
    pkg = (getattr(sale, "inventory_package", None) or "").strip()
    base = f"Venta Directa — {name}" if name else "Venta Directa"
    return f"{base} ({pkg})" if pkg else base


def _commission_item(db: Session, tx: WalletTransaction) -> dict[str, object]:
    try:
        amt = float(tx.amount or 0)
    except (TypeError, ValueError):
        amt = 0.0
    tx_cur = _wallet_tx_currency(tx.description)
    usd_amt = round(
        _convert_amount_to_currency(db, amt, tx_cur, PORTAL_EARNINGS_DISPLAY_CURRENCY),
        2,
    )
    created = getattr(tx, "created_at", None)
    return {
        "id": int(tx.id),
        "date": created if isinstance(created, datetime) else now_ecuador(),
        "description": _display_description(tx.description),
        "amount": usd_amt,
        "currency": PORTAL_EARNINGS_DISPLAY_CURRENCY,
        "_sort_ts": ensure_aware(created if isinstance(created, datetime) else now_ecuador()),
    }


def _direct_sale_item(db: Session, sale: Sale) -> dict[str, object] | None:
    usd_amt = _direct_sale_profit_usd(db, sale)
    if usd_amt is None or usd_amt <= 1e-9:
        return None
    created = getattr(sale, "created_at", None)
    ts = created if isinstance(created, datetime) else now_ecuador()
    return {
        "id": -int(sale.id),
        "date": ts,
        "description": _direct_sale_description(sale),
        "amount": usd_amt,
        "currency": PORTAL_EARNINGS_DISPLAY_CURRENCY,
        "_sort_ts": ensure_aware(ts),
    }


def _add_bucket(buckets: dict[str, float], ts: datetime, amount_usd: float, *, day_start, week_start, month_start) -> None:
    if amount_usd <= 1e-9:
        return
    aware_ts = ensure_aware(ts)
    if aware_ts >= month_start:
        buckets["monthly"] += amount_usd
    if aware_ts >= week_start:
        buckets["weekly"] += amount_usd
    if aware_ts >= day_start:
        buckets["daily"] += amount_usd


def list_portal_earnings_history(
    db: Session,
    client: Client,
    *,
    page: int = 1,
    limit: int = 10,
) -> dict[str, object]:
    """
    Ganancias del distribuidor: comisiones de red + márgenes de venta directa.

    Ventanas (máx. 30 días):
    - daily: últimas 24 horas
    - weekly: últimos 7 días
    - monthly: últimos 30 días

    Montos siempre en USD.
    """
    cid = int(client.id)
    page_i = max(1, int(page))
    limit_i = max(1, min(50, int(limit)))

    now = now_ecuador()
    day_start = now - timedelta(hours=24)
    week_start = now - timedelta(days=7)
    month_start = now - timedelta(days=30)

    commission_txs = (
        db.query(WalletTransaction)
        .filter(
            WalletTransaction.client_id == cid,
            _commission_tx_filter(),
        )
        .order_by(WalletTransaction.created_at.desc(), WalletTransaction.id.desc())
        .all()
    )

    direct_sales = (
        db.query(Sale)
        .filter(
            Sale.client_id == cid,
            Sale.end_customer_name.isnot(None),
            func.trim(Sale.end_customer_name) != "",
            Sale.end_customer_sale_price.isnot(None),
        )
        .order_by(Sale.created_at.desc(), Sale.id.desc())
        .all()
    )

    merged: list[dict[str, object]] = []
    for tx in commission_txs:
        merged.append(_commission_item(db, tx))
    for sale in direct_sales:
        row = _direct_sale_item(db, sale)
        if row is not None:
            merged.append(row)

    merged.sort(
        key=lambda r: (r["_sort_ts"], int(r["id"])),
        reverse=True,
    )

    total_items = len(merged)
    total_pages = max(1, math.ceil(total_items / limit_i)) if total_items else 1
    if page_i > total_pages and total_items > 0:
        page_i = total_pages

    offset = (page_i - 1) * limit_i
    page_rows = merged[offset : offset + limit_i]

    buckets = {"daily": 0.0, "weekly": 0.0, "monthly": 0.0}
    for tx in commission_txs:
        ts = getattr(tx, "created_at", None) or now
        if not isinstance(ts, datetime) or ensure_aware(ts) < month_start:
            continue
        try:
            amt = float(tx.amount or 0)
        except (TypeError, ValueError):
            continue
        if amt <= 1e-9:
            continue
        tx_cur = _wallet_tx_currency(tx.description)
        converted = _convert_amount_to_currency(db, amt, tx_cur, PORTAL_EARNINGS_DISPLAY_CURRENCY)
        _add_bucket(buckets, ts, converted, day_start=day_start, week_start=week_start, month_start=month_start)

    for sale in direct_sales:
        ts = getattr(sale, "created_at", None) or now
        if not isinstance(ts, datetime) or ensure_aware(ts) < month_start:
            continue
        usd_amt = _direct_sale_profit_usd(db, sale)
        if usd_amt is None:
            continue
        _add_bucket(buckets, ts, usd_amt, day_start=day_start, week_start=week_start, month_start=month_start)

    items: list[dict[str, object]] = []
    for row in page_rows:
        items.append(
            {
                "id": int(row["id"]),
                "date": row["date"],
                "description": str(row["description"]),
                "amount": float(row["amount"]),
                "currency": PORTAL_EARNINGS_DISPLAY_CURRENCY,
            }
        )

    return {
        "summaries": {
            "daily": round(buckets["daily"], 2),
            "weekly": round(buckets["weekly"], 2),
            "monthly": round(buckets["monthly"], 2),
            "currency": PORTAL_EARNINGS_DISPLAY_CURRENCY,
        },
        "items": items,
        "page": page_i,
        "limit": limit_i,
        "total_pages": total_pages,
        "total_items": total_items,
    }
