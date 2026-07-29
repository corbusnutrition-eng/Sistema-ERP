"""Métricas del mini-dashboard del portal BaaS (distribuidor)."""

from __future__ import annotations

from datetime import datetime, time, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.sale import Sale
from app.models.wallet_transaction import WalletTransaction
from app.services.baas_commission_cascade_service import (
    TX_NETWORK_PROFIT,
    TX_WALLET_DEPOSIT,
    _convert_amount_to_currency,
)
from app.services.sale_accounting_sync import is_baas_wallet_auto_purchase_sale
from app.timezone_utils import ECUADOR_TZ, ensure_aware, now_ecuador


def _period_starts_ecuador(now: datetime) -> tuple[datetime, datetime, datetime]:
    today = now.date()
    day_start = datetime.combine(today, time.min, tzinfo=ECUADOR_TZ)
    week_start = day_start - timedelta(days=int(now.weekday()))
    month_start = datetime(now.year, now.month, 1, tzinfo=ECUADOR_TZ)
    return day_start, week_start, month_start


def _wallet_tx_currency(description: str | None) -> str:
    desc_raw = (description or "").strip()
    if " · " in desc_raw:
        tail = desc_raw.rsplit(" · ", 1)[-1].strip()
        if len(tail) >= 3:
            return normalize_currency_code(tail, "USD")
    return "USD"


def _is_network_commission_tx(tx: WalletTransaction) -> bool:
    tx_type = str(tx.transaction_type or "")
    if tx_type == TX_NETWORK_PROFIT:
        return True
    if tx_type == TX_WALLET_DEPOSIT:
        desc = (tx.description or "").strip()
        return desc.startswith("Comisión por red")
    return False


def _add_profit_bucket(
    buckets: dict[str, float],
    *,
    amount: float,
    currency: str,
    target_currency: str,
    ts: datetime,
    day_start: datetime,
    week_start: datetime,
    month_start: datetime,
    db: Session,
) -> None:
    if amount <= 1e-9:
        return
    converted = _convert_amount_to_currency(db, float(amount), currency, target_currency)
    aware_ts = ensure_aware(ts)
    if aware_ts >= month_start:
        buckets["mensual"] += converted
    if aware_ts >= week_start:
        buckets["semanal"] += converted
    if aware_ts >= day_start:
        buckets["diario"] += converted


from app.services.portal_home_fast_service import compute_portal_dashboard_metrics_fast


def compute_portal_dashboard_metrics(
    db: Session,
    client_id: int,
    *,
    wallet_balance: float,
    wallet_balance_currency: str,
    tracked_purchase_items: list | None = None,
) -> dict[str, object]:
    """Mini-dashboard del distribuidor (delega a versión optimizada)."""
    if tracked_purchase_items:
        target_cur = normalize_currency_code(wallet_balance_currency, "USD")
        pantallas_activas = 0
        vencimientos_semana = 0
        for item in tracked_purchase_items:
            days = getattr(item, "days_remaining", None)
            if days is None:
                days = getattr(item, "days_until_expiration", None)
            if days is None:
                continue
            try:
                days_i = int(days)
            except (TypeError, ValueError):
                continue
            if days_i > 0:
                pantallas_activas += 1
            if 0 <= days_i <= 7:
                vencimientos_semana += 1
        fast = compute_portal_dashboard_metrics_fast(
            db,
            client_id,
            wallet_balance=wallet_balance,
            wallet_balance_currency=wallet_balance_currency,
        )
        fast["pantallas_activas"] = pantallas_activas
        fast["vencimientos_semana"] = vencimientos_semana
        return fast
    return compute_portal_dashboard_metrics_fast(
        db,
        client_id,
        wallet_balance=wallet_balance,
        wallet_balance_currency=wallet_balance_currency,
    )
