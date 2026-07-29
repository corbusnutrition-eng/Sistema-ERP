"""Optimizaciones de carga inicial del portal (GET /portal/{token})."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.client_payment import ClientPayment
from app.models.sale import Sale
from app.models.screen_stock import ScreenStock
from app.models.wallet_transaction import WalletTransaction
from app.services.baas_commission_cascade_service import (
    TX_NETWORK_PROFIT,
    TX_WALLET_DEPOSIT,
    _convert_amount_to_currency,
)
from app.services.client_payment_service import parse_notes_meta_sale_id
from app.services.sale_accounting_sync import is_baas_wallet_auto_purchase_sale
from app.services.screen_package_expiration import calculate_screen_expiration_stats
from app.timezone_utils import ensure_aware, now_ecuador

_FP_EPS = Decimal("0.00005")


def _commission_tx_sql_filter():
    return or_(
        WalletTransaction.transaction_type == TX_NETWORK_PROFIT,
        and_(
            WalletTransaction.transaction_type == TX_WALLET_DEPOSIT,
            WalletTransaction.description.like("Comisión por red%"),
        ),
    )


def _wallet_tx_currency(description: str | None) -> str:
    desc_raw = (description or "").strip()
    if " · " in desc_raw:
        tail = desc_raw.rsplit(" · ", 1)[-1].strip()
        if len(tail) >= 3:
            return normalize_currency_code(tail, "USD")
    return "USD"


def _fast_sale_invoice_total(sale: Sale) -> Decimal:
    """Total facturado sin consultas extra (líneas JSON → montos del modelo)."""
    raw = getattr(sale, "invoice_lines", None)
    if isinstance(raw, list) and raw:
        acc = Decimal("0")
        for chunk in raw[:200]:
            if not isinstance(chunk, dict):
                continue
            q_val = chunk.get("qty") if chunk.get("qty") is not None else chunk.get("quantity")
            p_val = (
                chunk.get("rate")
                if chunk.get("rate") is not None
                else chunk.get("price")
                if chunk.get("price") is not None
                else chunk.get("unit_price")
            )
            if q_val is not None and p_val is not None:
                try:
                    dq, dp = Decimal(str(q_val)), Decimal(str(p_val))
                    if dq > Decimal("0"):
                        acc += dq * dp
                        continue
                except Exception:
                    pass
            for ak in ("amount", "subtotal", "line_total", "total"):
                v = chunk.get(ak)
                if v is None:
                    continue
                try:
                    dv = Decimal(str(v))
                    if dv > Decimal("0"):
                        acc += dv
                except Exception:
                    pass
                break
        total = acc.quantize(Decimal("0.0001"))
        if total > _FP_EPS:
            return total
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


def sale_open_balance_from_batch(
    sale: Sale,
    approved_by_sale: dict[int, Decimal],
    pending_by_sale: dict[int, Decimal],
) -> tuple[Decimal, Decimal]:
    """Saldo CxC usando allocations pre-agregadas (sin N+1)."""
    real_total = _fast_sale_invoice_total(sale)
    if real_total <= _FP_EPS:
        return real_total, Decimal("0")
    sid = int(sale.id)
    approved = approved_by_sale.get(sid, Decimal("0"))
    pending = pending_by_sale.get(sid, Decimal("0"))
    balance = max(Decimal("0"), (real_total - approved - pending).quantize(Decimal("0.0001")))
    return real_total, balance


def build_meta_sale_payments_index(db: Session, client_id: int) -> dict[int, list[ClientPayment]]:
    """Una sola consulta de cobros del cliente indexada por META_SALE_ID."""
    rows = db.query(ClientPayment).filter(ClientPayment.client_id == int(client_id)).all()
    index: dict[int, list[ClientPayment]] = defaultdict(list)
    for cp in rows:
        sid = parse_notes_meta_sale_id(cp.notes)
        if sid is not None:
            index[int(sid)].append(cp)
    return dict(index)


def compute_tracked_purchase_metrics_fast(db: Session, client_id: int) -> tuple[int, int]:
    """
    (pantallas_activas, vencimientos_semana) con 2 consultas batch en lugar de N+1 por venta.
    """
    sales = (
        db.query(Sale)
        .filter(
            Sale.client_id == int(client_id),
            Sale.end_customer_name.isnot(None),
            func.trim(Sale.end_customer_name) != "",
        )
        .all()
    )
    baas_sales = [s for s in sales if is_baas_wallet_auto_purchase_sale(s)]
    if not baas_sales:
        return 0, 0

    sale_ids = [int(s.id) for s in baas_sales]
    screens = db.query(ScreenStock).filter(ScreenStock.sale_id.in_(sale_ids)).all()
    screens_by_sale: dict[int, list[ScreenStock]] = defaultdict(list)
    for stk in screens:
        if stk.sale_id is not None:
            screens_by_sale[int(stk.sale_id)].append(stk)

    dismissed_by_sale = {int(s.id): _sale_dismissed_keys(s) for s in baas_sales}

    pantallas_activas = 0
    vencimientos_semana = 0

    for sale in baas_sales:
        sid = int(sale.id)
        dismissed = dismissed_by_sale.get(sid, set())
        stk_rows = screens_by_sale.get(sid, [])
        if stk_rows:
            for stk in stk_rows:
                key = int(stk.id)
                if key in dismissed:
                    continue
                package_raw = (stk.package or sale.inventory_package or "").strip()
                stats = calculate_screen_expiration_stats(stk.created_at, package_raw)
                if stats is None:
                    continue
                days_i = int(stats.days_remaining)
                if days_i > 0:
                    pantallas_activas += 1
                if 0 <= days_i <= 7:
                    vencimientos_semana += 1
        elif 0 not in dismissed:
            package_raw = (sale.inventory_package or "").strip()
            stats = calculate_screen_expiration_stats(sale.created_at, package_raw)
            if stats is None:
                continue
            days_i = int(stats.days_remaining)
            if days_i > 0:
                pantallas_activas += 1
            if 0 <= days_i <= 7:
                vencimientos_semana += 1

    return pantallas_activas, vencimientos_semana


def _sale_dismissed_keys(sale: Sale) -> set[int]:
    raw = getattr(sale, "dismissed_tracked_screen_stock_ids", None)
    if not isinstance(raw, list):
        return set()
    out: set[int] = set()
    for item in raw:
        try:
            out.add(int(item))
        except (TypeError, ValueError):
            continue
    return out


def compute_portal_dashboard_metrics_fast(
    db: Session,
    client_id: int,
    *,
    wallet_balance: float,
    wallet_balance_currency: str,
) -> dict[str, object]:
    """
    Mini-dashboard optimizado: solo datos del mes calendario actual + comisiones filtradas en SQL.
    """
    target_cur = normalize_currency_code(wallet_balance_currency, "USD")
    now = now_ecuador()
    month_start = datetime(now.year, now.month, 1, tzinfo=now.tzinfo)
    week_start = now - timedelta(days=7)
    day_start = now - timedelta(hours=24)

    profit_buckets = {"diario": 0.0, "semanal": 0.0, "mensual": 0.0}

    margin_sales = (
        db.query(Sale)
        .filter(
            Sale.client_id == int(client_id),
            Sale.end_customer_name.isnot(None),
            func.trim(Sale.end_customer_name) != "",
            Sale.end_customer_sale_price.isnot(None),
            Sale.created_at >= month_start,
        )
        .all()
    )
    for sale in margin_sales:
        if not is_baas_wallet_auto_purchase_sale(sale):
            continue
        try:
            charged = float(sale.end_customer_sale_price or 0)
            cost = float(sale.local_amount if sale.local_amount is not None else sale.amount or 0)
        except (TypeError, ValueError):
            continue
        profit = round(charged - cost, 4)
        if profit <= 1e-9:
            continue
        sale_cur = normalize_currency_code(str(getattr(sale, "currency", None) or "USD"))
        created = ensure_aware(getattr(sale, "created_at", None) or now)
        converted = _convert_amount_to_currency(db, profit, sale_cur, target_cur)
        if created >= month_start:
            profit_buckets["mensual"] += converted
        if created >= week_start:
            profit_buckets["semanal"] += converted
        if created >= day_start:
            profit_buckets["diario"] += converted

    commission_txs = (
        db.query(WalletTransaction)
        .filter(
            WalletTransaction.client_id == int(client_id),
            _commission_tx_sql_filter(),
            WalletTransaction.created_at >= month_start,
        )
        .all()
    )
    for tx in commission_txs:
        try:
            amt = float(tx.amount or 0)
        except (TypeError, ValueError):
            continue
        if amt <= 1e-9:
            continue
        tx_cur = _wallet_tx_currency(tx.description)
        created = ensure_aware(getattr(tx, "created_at", None) or now)
        converted = _convert_amount_to_currency(db, amt, tx_cur, target_cur)
        if created >= month_start:
            profit_buckets["mensual"] += converted
        if created >= week_start:
            profit_buckets["semanal"] += converted
        if created >= day_start:
            profit_buckets["diario"] += converted

    pantallas_activas, vencimientos_semana = compute_tracked_purchase_metrics_fast(db, int(client_id))

    return {
        "ganancias_totales": {
            "diario": round(profit_buckets["diario"], 2),
            "semanal": round(profit_buckets["semanal"], 2),
            "mensual": round(profit_buckets["mensual"], 2),
            "currency": target_cur,
        },
        "pantallas_activas": int(pantallas_activas),
        "vencimientos_semana": int(vencimientos_semana),
        "saldo_baas": round(max(0.0, float(wallet_balance)), 2),
        "saldo_baas_currency": target_cur,
    }
