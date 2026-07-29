"""Historial paginado de comisiones por red (portal BaaS)."""

from __future__ import annotations

import math
from datetime import datetime, timedelta

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.wallet_transaction import WalletTransaction
from app.services.baas_commission_cascade_service import (
    TX_NETWORK_PROFIT,
    TX_WALLET_DEPOSIT,
    _convert_amount_to_currency,
)
from app.services.client_currency_service import get_client_currency
from app.timezone_utils import ensure_aware, now_ecuador


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


def list_portal_earnings_history(
    db: Session,
    client: Client,
    *,
    page: int = 1,
    limit: int = 10,
) -> dict[str, object]:
    """
    Comisiones de red del distribuidor con acumulados rolling y lista paginada.

    Ventanas (máx. 30 días):
    - daily: últimas 24 horas
    - weekly: últimos 7 días
    - monthly: últimos 30 días
    """
    cid = int(client.id)
    page_i = max(1, int(page))
    limit_i = max(1, min(50, int(limit)))
    target_cur = normalize_currency_code(get_client_currency(client), "USD")

    now = now_ecuador()
    day_start = now - timedelta(hours=24)
    week_start = now - timedelta(days=7)
    month_start = now - timedelta(days=30)

    base_q = db.query(WalletTransaction).filter(
        WalletTransaction.client_id == cid,
        _commission_tx_filter(),
    )

    total_items = int(base_q.count())
    total_pages = max(1, math.ceil(total_items / limit_i)) if total_items else 1
    if page_i > total_pages and total_items > 0:
        page_i = total_pages

    offset = (page_i - 1) * limit_i
    page_rows = (
        base_q.order_by(WalletTransaction.created_at.desc(), WalletTransaction.id.desc())
        .offset(offset)
        .limit(limit_i)
        .all()
    )

    summary_rows = (
        db.query(WalletTransaction)
        .filter(
            WalletTransaction.client_id == cid,
            _commission_tx_filter(),
            WalletTransaction.created_at >= month_start,
        )
        .order_by(WalletTransaction.created_at.desc(), WalletTransaction.id.desc())
        .all()
    )

    buckets = {"daily": 0.0, "weekly": 0.0, "monthly": 0.0}
    for tx in summary_rows:
        try:
            amt = float(tx.amount or 0)
        except (TypeError, ValueError):
            continue
        if amt <= 1e-9:
            continue
        tx_cur = _wallet_tx_currency(tx.description)
        converted = _convert_amount_to_currency(db, amt, tx_cur, target_cur)
        ts = ensure_aware(getattr(tx, "created_at", None) or now)
        if ts >= month_start:
            buckets["monthly"] += converted
        if ts >= week_start:
            buckets["weekly"] += converted
        if ts >= day_start:
            buckets["daily"] += converted

    items: list[dict[str, object]] = []
    for tx in page_rows:
        try:
            amt = round(float(tx.amount or 0), 2)
        except (TypeError, ValueError):
            amt = 0.0
        cur = _wallet_tx_currency(tx.description)
        created = getattr(tx, "created_at", None)
        items.append(
            {
                "id": int(tx.id),
                "date": created if isinstance(created, datetime) else now,
                "description": _display_description(tx.description),
                "amount": amt,
                "currency": cur,
            }
        )

    return {
        "summaries": {
            "daily": round(buckets["daily"], 2),
            "weekly": round(buckets["weekly"], 2),
            "monthly": round(buckets["monthly"], 2),
            "currency": target_cur,
        },
        "items": items,
        "page": page_i,
        "limit": limit_i,
        "total_pages": total_pages,
        "total_items": total_items,
    }
