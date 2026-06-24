"""Seguimiento CRM: última compra de créditos normales por cliente."""

from __future__ import annotations

from datetime import date, datetime
from typing import Optional

from sqlalchemy.orm import Session, joinedload

from app.models.client import Client
from app.models.product import Product
from app.models.sale import Sale, SaleStatus
from app.services.sale_accounting_sync import is_baas_wallet_auto_purchase_sale
from app.timezone_utils import ECUADOR_TZ, ensure_aware, now_ecuador

FOLLOW_UP_SALE_STATUSES: tuple[SaleStatus, ...] = (
    SaleStatus.approved,
    SaleStatus.partially_paid,
)


def _sale_effective_inventory_channel(sale: Sale) -> str:
    ch = (sale.inventory_channel or "").strip().lower()
    if ch == "mixed":
        return "mixed"
    if ch in ("full_credits", "screen_stock"):
        return ch
    if sale.screen_stock_id is not None:
        return "screen_stock"
    try:
        cq = float(sale.credits_quantity or 0)
    except (TypeError, ValueError):
        cq = 0.0
    if cq > 1e-12:
        if sale.product_id is not None:
            return "full_credits"
        if (sale.inventory_provider or "").strip():
            return "full_credits"
    return "legacy"


def _is_credito_normal_product(product: Product | None) -> bool:
    if product is None:
        return True
    pt = (getattr(product, "product_type", None) or "").strip().lower()
    if pt == "credito_pantalla":
        return False
    if pt == "credito_normal":
        return True
    st = (getattr(product, "service_type", None) or "").strip().lower()
    return st != "paquete pantalla"


def _is_normal_credit_sale(sale: Sale, product: Product | None) -> bool:
    """Venta ERP de crédito normal (excluye pantallas, BaaS autocompra y recargas wallet)."""
    if is_baas_wallet_auto_purchase_sale(sale):
        return False
    if not _is_credito_normal_product(product):
        return False
    ch = _sale_effective_inventory_channel(sale)
    if ch == "screen_stock":
        return False
    try:
        cq = float(sale.credits_quantity or 0)
    except (TypeError, ValueError):
        cq = 0.0
    if ch in ("full_credits", "mixed", "legacy"):
        return cq > 1e-12
    return False


def _normal_credits_from_sale(sale: Sale) -> float:
    try:
        return max(0.0, float(sale.credits_quantity or 0))
    except (TypeError, ValueError):
        return 0.0


def days_since_recharge_ecuador(recharge_dt: datetime) -> int:
    """Días calendario en horario Ecuador (hoy − fecha de recarga)."""
    ec_now = now_ecuador()
    ec_recharge = ensure_aware(recharge_dt).astimezone(ECUADOR_TZ)
    return max(0, (ec_now.date() - ec_recharge.date()).days)


def list_client_normal_credit_follow_up(db: Session) -> list[dict]:
    """
    Por cada cliente con al menos una venta aprobada de crédito normal,
    devuelve la última transacción qualifying (excluye pantallas y BaaS autocompra).
    """
    sales_rows = (
        db.query(Sale)
        .options(joinedload(Sale.product))
        .filter(Sale.status.in_(FOLLOW_UP_SALE_STATUSES))
        .order_by(Sale.created_at.desc())
        .all()
    )

    best_by_client: dict[int, tuple[Sale, Client, Product | None]] = {}

    for sale in sales_rows:
        if not _is_normal_credit_sale(sale, sale.product):
            continue
        cid = int(sale.client_id)
        existing = best_by_client.get(cid)
        if existing is not None and sale.created_at <= existing[0].created_at:
            continue
        client = db.get(Client, cid)
        if client is None:
            continue
        best_by_client[cid] = (sale, client, sale.product)

    out: list[dict] = []
    for sale, client, product in best_by_client.values():
        recharge_dt = ensure_aware(sale.created_at)
        credits = _normal_credits_from_sale(sale)
        out.append(
            {
                "id": int(client.id),
                "username": client.username,
                "name": (client.name or "").strip() or None,
                "phone": (client.phone or "").strip() or None,
                "email": client.email,
                "last_recharge_date": recharge_dt,
                "last_recharge_credits": credits,
                "days_since_last_recharge": days_since_recharge_ecuador(recharge_dt),
                "last_sale_id": int(sale.id),
                "product_name": (product.name if product else None),
            }
        )

    out.sort(
        key=lambda row: (
            -int(row["days_since_last_recharge"]),
            str(row.get("username") or "").lower(),
        ),
    )
    return out


def filter_follow_up_rows(
    rows: list[dict],
    *,
    search: Optional[str] = None,
    credits_min: Optional[float] = None,
    credits_max: Optional[float] = None,
    days_min: Optional[int] = None,
    days_max: Optional[int] = None,
    recharge_date_from: Optional[date] = None,
    recharge_date_to: Optional[date] = None,
) -> list[dict]:
    """Filtros opcionales sobre el listado de seguimiento (query string API)."""
    q = (search or "").strip().lower()
    filtered = rows
    if q:
        filtered = [
            r
            for r in filtered
            if q in str(r.get("username") or "").lower()
            or q in str(r.get("name") or "").lower()
            or q in str(r.get("email") or "").lower()
            or q in str(r.get("phone") or "").lower()
        ]
    if credits_min is not None:
        filtered = [r for r in filtered if float(r.get("last_recharge_credits") or 0) >= credits_min]
    if credits_max is not None:
        filtered = [r for r in filtered if float(r.get("last_recharge_credits") or 0) <= credits_max]
    if days_min is not None:
        filtered = [r for r in filtered if int(r.get("days_since_last_recharge") or 0) >= days_min]
    if days_max is not None:
        filtered = [r for r in filtered if int(r.get("days_since_last_recharge") or 0) <= days_max]
    if recharge_date_from is not None or recharge_date_to is not None:
        d_from = recharge_date_from
        d_to = recharge_date_to or recharge_date_from
        next_filtered = []
        for r in filtered:
            raw = r.get("last_recharge_date")
            if raw is None:
                continue
            if isinstance(raw, datetime):
                local_d = ensure_aware(raw).astimezone(ECUADOR_TZ).date()
            else:
                continue
            if d_from is not None and local_d < d_from:
                continue
            if d_to is not None and local_d > d_to:
                continue
            next_filtered.append(r)
        filtered = next_filtered
    return filtered
