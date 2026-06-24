"""Seguimiento CRM: última compra de créditos normales por cliente."""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session, joinedload

from app.models.client import Client
from app.models.product import Product
from app.models.sale import Sale, SaleStatus
from app.models.tag import Tag
from app.services.sale_accounting_sync import is_baas_wallet_auto_purchase_sale
from app.timezone_utils import ECUADOR_TZ, ensure_aware, now_ecuador

FOLLOW_UP_SALE_STATUSES: tuple[SaleStatus, ...] = (
    SaleStatus.approved,
    SaleStatus.partially_paid,
)

_CN_KEY_RE = re.compile(r"^cn:(\d+)$", re.I)
_FP = 1e-12


def _catalog_product_kind(product: Product | None) -> str:
    """Misma semántica que ``inventory._catalog_product_kind``."""
    if product is None:
        return "credito_normal"
    if product.product_type:
        return str(product.product_type).strip().lower()
    st = (product.service_type or "").strip().lower()
    return "credito_pantalla" if st == "paquete pantalla" else "credito_normal"


def _invoice_line_dicts(sale: Sale) -> list[dict[str, Any]]:
    raw = sale.invoice_lines
    if not isinstance(raw, list):
        return []
    return [x for x in raw if isinstance(x, dict)]


def _line_is_normal_credit_chunk(chunk: dict[str, Any]) -> bool:
    key = str(chunk.get("inventory_option_key") or "").strip().lower()
    lik = str(chunk.get("line_inventory_kind") or "").strip().lower()
    return key.startswith(("cn:", "fc:")) or lik == "full_credits"


def _line_is_screen_chunk(chunk: dict[str, Any]) -> bool:
    key = str(chunk.get("inventory_option_key") or "").strip().lower()
    lik = str(chunk.get("line_inventory_kind") or "").strip().lower()
    return key.startswith(("cp|", "ss:")) or lik == "screen_stock"


def _chunk_qty(chunk: dict[str, Any]) -> float:
    for field in ("qty", "quantity", "cantidad"):
        raw = chunk.get(field)
        if raw is None:
            continue
        try:
            q = float(raw)
        except (TypeError, ValueError):
            continue
        if q > _FP:
            return q
    return 0.0


def _sale_effective_inventory_channel(sale: Sale) -> str:
    """
    Canal ERP alineado con ``sales._effective_inventory_channel``, incluyendo inferencia
    desde ``invoice_lines`` (cn:/fc:/cp|/ss:) cuando la cabecera viene vacía.
    """
    ch = (sale.inventory_channel or "").strip().lower()
    if ch == "mixed":
        return "mixed"
    if ch in ("full_credits", "screen_stock"):
        return ch
    if sale.screen_stock_id is not None:
        return "screen_stock"

    lines = _invoice_line_dicts(sale)
    has_credit = any(_line_is_normal_credit_chunk(x) for x in lines)
    has_screen = any(_line_is_screen_chunk(x) for x in lines)
    if has_credit and has_screen:
        return "mixed"
    if has_credit:
        return "full_credits"
    if has_screen:
        return "screen_stock"

    try:
        cq = float(sale.credits_quantity or 0)
    except (TypeError, ValueError):
        cq = 0.0
    if cq > _FP:
        if sale.product_id is not None or (sale.inventory_provider or "").strip():
            return "full_credits"
    return "legacy"


def _normal_credits_qty_from_sale(sale: Sale) -> float:
    """Créditos normales vendidos: cabecera ``credits_quantity`` o suma de líneas cn:/fc:."""
    try:
        header = float(sale.credits_quantity or 0)
    except (TypeError, ValueError):
        header = 0.0
    if header > _FP:
        return header

    total = 0.0
    for chunk in _invoice_line_dicts(sale):
        if not _line_is_normal_credit_chunk(chunk):
            continue
        total += _chunk_qty(chunk)
    return total


def sale_normal_credits_quantity(sale: Sale) -> float:
    """Cantidad de créditos normales en una venta (cabecera o líneas ``cn:/fc:``)."""
    return _normal_credits_qty_from_sale(sale)


def _product_id_from_invoice_lines(sale: Sale) -> Optional[int]:
    for chunk in _invoice_line_dicts(sale):
        key = str(chunk.get("inventory_option_key") or "").strip()
        m = _CN_KEY_RE.match(key)
        if m:
            return int(m.group(1))
        raw_pid = chunk.get("product_id")
        if raw_pid is not None:
            try:
                pid = int(raw_pid)
                if pid >= 1:
                    return pid
            except (TypeError, ValueError):
                pass
    return None


def _sale_invoice_total(sale: Sale) -> tuple[float, str]:
    """Monto total cobrado al cliente: ``local_amount`` en ``currency`` o ``amount`` en USD."""
    currency = (sale.currency or "USD").strip().upper() or "USD"
    if sale.local_amount is not None:
        try:
            local_total = float(sale.local_amount)
            if local_total >= 0:
                return local_total, currency
        except (TypeError, ValueError):
            pass
    try:
        return float(sale.amount), "USD"
    except (TypeError, ValueError):
        return 0.0, "USD"


def _resolve_sale_product(db: Session, sale: Sale) -> Optional[Product]:
    if sale.product is not None:
        return sale.product
    if sale.product_id is not None:
        return db.get(Product, int(sale.product_id))
    pid = _product_id_from_invoice_lines(sale)
    if pid is not None:
        return db.get(Product, pid)
    return None


def _is_normal_credit_sale(db: Session, sale: Sale) -> bool:
    """
    Venta ERP de crédito normal (cn:/fc:, ``full_credits`` / ``mixed`` con créditos).

    Excluye: pantallas (``screen_stock``), autocompras BaaS y productos ``credito_pantalla``.
    """
    if is_baas_wallet_auto_purchase_sale(sale):
        return False

    channel = _sale_effective_inventory_channel(sale)
    if channel == "screen_stock":
        return False

    credits_qty = _normal_credits_qty_from_sale(sale)
    if credits_qty <= _FP:
        return False

    product = _resolve_sale_product(db, sale)
    if _catalog_product_kind(product) == "credito_pantalla":
        return False

    if channel in ("full_credits", "mixed", "legacy"):
        return True

    # Cabecera legacy con créditos inferidos solo desde líneas.
    return credits_qty > _FP


def _tag_catalog_by_name(db: Session) -> dict[str, Tag]:
    return {str(t.name): t for t in db.query(Tag).all()}


def _resolve_client_tags(client: Client, catalog: dict[str, Tag]) -> list[dict]:
    """Etiquetas asignadas al cliente (nombre en ``clients.tags`` → catálogo global)."""
    raw = client.tags if isinstance(client.tags, list) else []
    out: list[dict] = []
    for item in raw:
        name = str(item or "").strip()
        if not name:
            continue
        tag_row = catalog.get(name)
        if tag_row is not None:
            out.append({"id": tag_row.id, "name": tag_row.name, "color": tag_row.color})
        else:
            out.append({"id": None, "name": name, "color": None})
    return out


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
        .filter(
            Sale.status.in_(FOLLOW_UP_SALE_STATUSES),
            or_(
                Sale.inventory_channel.in_(("full_credits", "mixed")),
                and_(Sale.credits_quantity.isnot(None), Sale.credits_quantity > _FP),
                Sale.invoice_lines.isnot(None),
            ),
        )
        .order_by(Sale.created_at.desc())
        .all()
    )

    tag_catalog = _tag_catalog_by_name(db)
    best_by_client: dict[int, tuple[Sale, Client, Optional[Product], float, float, str]] = {}

    for sale in sales_rows:
        if not _is_normal_credit_sale(db, sale):
            continue
        cid = int(sale.client_id)
        existing = best_by_client.get(cid)
        if existing is not None and sale.created_at <= existing[0].created_at:
            continue
        client = db.get(Client, cid)
        if client is None:
            continue
        product = _resolve_sale_product(db, sale)
        credits = _normal_credits_qty_from_sale(sale)
        total_amount, total_currency = _sale_invoice_total(sale)
        best_by_client[cid] = (sale, client, product, credits, total_amount, total_currency)

    out: list[dict] = []
    for sale, client, product, credits, total_amount, total_currency in best_by_client.values():
        recharge_dt = ensure_aware(sale.created_at)
        out.append(
            {
                "id": int(client.id),
                "username": client.username,
                "name": (client.name or "").strip() or None,
                "phone": (client.phone or "").strip() or None,
                "email": client.email,
                "last_recharge_date": recharge_dt,
                "last_recharge_credits": credits,
                "last_recharge_total_amount": total_amount,
                "last_recharge_currency": total_currency,
                "days_since_last_recharge": days_since_recharge_ecuador(recharge_dt),
                "last_sale_id": int(sale.id),
                "product_name": (product.name if product else None),
                "tags": _resolve_client_tags(client, tag_catalog),
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
    tag_name: Optional[str] = None,
) -> list[dict]:
    """Filtros opcionales sobre el listado de seguimiento (query string API)."""
    q = (search or "").strip().lower()
    filtered = rows
    if tag_name:
        want = str(tag_name).strip()
        if want:
            filtered = [
                r
                for r in filtered
                if any(str(t.get("name") or "") == want for t in (r.get("tags") or []))
            ]
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
