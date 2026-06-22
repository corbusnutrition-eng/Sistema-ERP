"""Cálculo de costo de ventas (COGS) para asientos automáticos."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.product import Product
from app.models.sale import Sale
from app.models.screen_stock import ScreenStock
from app.schemas.sales import SaleInvoiceLineItem

logger = logging.getLogger(__name__)

_FP = Decimal("0.0001")


@dataclass(frozen=True)
class SaleCogsLineDetail:
    product_id: Optional[int]
    quantity: Decimal
    unit_cost_usd: Decimal
    line_total_usd: Decimal
    source: str


@dataclass(frozen=True)
class SaleCogsBreakdown:
    total_usd: Decimal
    lines: tuple[SaleCogsLineDetail, ...]
    method: str


def _product_id_from_inventory_key(key: Optional[str]) -> Optional[int]:
    if not key:
        return None
    s = str(key).strip()
    m = re.match(r"^cn:(\d+)$", s, re.I)
    if m:
        return int(m.group(1))
    m = re.match(r"^cp\|(\d+)", s, re.I)
    if m:
        return int(m.group(1))
    return None


def _line_qty(ln: SaleInvoiceLineItem, raw: dict[str, Any]) -> Decimal:
    q = ln.qty
    if q is None:
        q = raw.get("quantity") or raw.get("cantidad") or raw.get("qty")
    if q is None:
        return Decimal("0")
    try:
        return Decimal(str(q))
    except Exception:
        return Decimal("0")


def _unit_cost_from_product_row(prod: Product) -> Optional[Decimal]:
    """
    Única fuente de costo unitario para productos de catálogo: ``products.purchase_cost_usd``.
    No usa precio de venta, porcentajes ni catálogo de paquetes.
    """
    raw = prod.purchase_cost_usd
    if raw is None:
        return None
    try:
        c = Decimal(str(raw))
    except Exception:
        return None
    if c > _FP:
        return c.quantize(Decimal("0.0001"))
    return None


def _product_for_cogs(db: Session, sale: Sale, product_id: int) -> Optional[Product]:
    """
    Producto de catálogo para COGS: usa ``sale.product`` (eager) o consulta ``products``.

    El costo unitario es ``Product.purchase_cost_usd`` (columna real en BD).
    """
    pid = int(product_id)
    if sale.product_id is not None and int(sale.product_id) == pid:
        loaded = sale.product
        if loaded is not None:
            return loaded
    return db.get(Product, pid)


def _load_products_by_id(db: Session, sale: Sale, product_ids: set[int]) -> dict[int, Product]:
    if not product_ids:
        return {}
    out: dict[int, Product] = {}
    missing: set[int] = set()
    for pid in product_ids:
        prod = _product_for_cogs(db, sale, pid)
        if prod is not None:
            out[pid] = prod
        else:
            missing.add(pid)
    if missing:
        for p in db.query(Product).filter(Product.id.in_(missing)).all():
            out[int(p.id)] = p
    return out


def _sale_header_quantity(sale: Sale) -> Decimal:
    cq = sale.credits_quantity
    if cq is not None:
        try:
            q = Decimal(str(cq))
            if q > _FP:
                return q
        except Exception:
            pass
    units = int(sale.inventory_screen_units or 0)
    if units > 0:
        return Decimal(str(units))
    return Decimal("0")


def _effective_channel(sale: Sale) -> str:
    return (sale.inventory_channel or "").strip().lower()


def _collect_sale_cogs_items(sale: Sale) -> list[tuple[int, Decimal, str]]:
    """(product_id, quantity, source) — cantidad de la venta, no del importe facturado."""
    raw_lines = sale.invoice_lines or []
    line_items: list[tuple[int, Decimal, str]] = []

    for chunk in raw_lines[:100]:
        if not isinstance(chunk, dict):
            continue
        try:
            ln = SaleInvoiceLineItem.model_validate(chunk)
        except Exception:
            continue
        qty = _line_qty(ln, chunk)
        if qty <= _FP:
            continue

        pid: Optional[int] = None
        if chunk.get("product_id") is not None:
            try:
                pid = int(chunk["product_id"])
            except (TypeError, ValueError):
                pid = None
        if pid is None:
            pid = _product_id_from_inventory_key(ln.inventory_option_key)
        if pid is None:
            continue
        line_items.append((pid, qty, "invoice_line"))

    header_qty = _sale_header_quantity(sale)
    header_pid = int(sale.product_id) if sale.product_id else None
    ch = _effective_channel(sale)

    if header_pid and header_qty > _FP:
        if ch in ("full_credits", "mixed", "") or sale.credits_quantity is not None:
            if len(line_items) <= 1:
                return [(header_pid, header_qty, "sale_header")]
        if not line_items:
            return [(header_pid, header_qty, "sale_header")]

    if line_items:
        return line_items

    if header_pid and header_qty > _FP:
        return [(header_pid, header_qty, "sale_header")]

    return []


def _screen_stock_cogs_lines(db: Session, sale: Sale) -> tuple[SaleCogsLineDetail, ...]:
    """Bodega pantalla: costo real por fila ``screen_stock.cost_per_package`` (1 unidad por fila)."""
    rows = (
        db.query(ScreenStock)
        .filter(ScreenStock.sale_id == int(sale.id))
        .order_by(ScreenStock.created_at.asc(), ScreenStock.id.asc())
        .all()
    )
    if not rows and sale.screen_stock_id:
        single = db.get(ScreenStock, int(sale.screen_stock_id))
        if single is not None:
            rows = [single]

    details: list[SaleCogsLineDetail] = []
    for row in rows:
        raw = row.cost_per_package
        if raw is None:
            continue
        try:
            unit = Decimal(str(raw))
        except Exception:
            continue
        if unit <= _FP:
            continue
        pid = int(row.product_id) if row.product_id else None
        line_total = unit.quantize(Decimal("0.0001"))
        details.append(
            SaleCogsLineDetail(
                product_id=pid,
                quantity=Decimal("1"),
                unit_cost_usd=unit,
                line_total_usd=line_total,
                source="screen_stock",
            )
        )
    return tuple(details)


def compute_sale_cogs_breakdown(db: Session, sale: Sale) -> SaleCogsBreakdown:
    """
    COGS = Σ (cantidad vendida × ``products.purchase_cost_usd``).

    Sin porcentajes sobre el importe de la venta, sin FIFO IPTV ni costos de paquete derivados.
    """
    ch = _effective_channel(sale)
    if ch in ("screen_stock", "mixed"):
        screen_lines = _screen_stock_cogs_lines(db, sale)
        if screen_lines:
            total = sum((ln.line_total_usd for ln in screen_lines), Decimal("0"))
            if total > _FP:
                return SaleCogsBreakdown(
                    total_usd=total.quantize(Decimal("0.01")),
                    lines=screen_lines,
                    method="screen_stock_db",
                )

    items = _collect_sale_cogs_items(sale)
    product_ids = {pid for pid, _, _ in items}
    products = _load_products_by_id(db, sale, product_ids)

    details: list[SaleCogsLineDetail] = []
    total = Decimal("0")

    for pid, qty, source in items:
        prod = products.get(pid)
        if prod is None:
            logger.warning(
                "COGS venta id=%s: producto id=%s no existe en BD (qty=%s)",
                sale.id,
                pid,
                qty,
            )
            continue

        unit = _unit_cost_from_product_row(prod)
        if unit is None:
            logger.warning(
                "COGS venta id=%s: producto id=%s «%s» sin purchase_cost_usd en BD (qty=%s)",
                sale.id,
                pid,
                prod.name,
                qty,
            )
            continue

        line_total = (qty * unit).quantize(Decimal("0.0001"))
        total += line_total
        details.append(
            SaleCogsLineDetail(
                product_id=pid,
                quantity=qty,
                unit_cost_usd=unit,
                line_total_usd=line_total,
                source=source,
            )
        )

    if total > _FP:
        return SaleCogsBreakdown(
            total_usd=total.quantize(Decimal("0.01")),
            lines=tuple(details),
            method="product_purchase_cost_usd",
        )

    return SaleCogsBreakdown(total_usd=Decimal("0"), lines=tuple(), method="none")


def compute_sale_cogs_usd(db: Session, sale: Sale) -> Decimal:
    return compute_sale_cogs_breakdown(db, sale).total_usd


def log_sale_cogs_before_journal(sale: Sale, breakdown: SaleCogsBreakdown) -> None:
    """Registro en terminal: cantidad, costo unitario leído de BD y total (sin % sobre venta)."""
    sale_amt = getattr(sale, "local_amount", None) or getattr(sale, "amount", None)
    for ln in breakdown.lines:
        logger.info(
            "COGS venta id=%s [%s] product_id=%s qty=%s unit_cost_usd(DB)=%s line_total=%s",
            sale.id,
            ln.source,
            ln.product_id,
            ln.quantity,
            ln.unit_cost_usd,
            ln.line_total_usd,
        )
    logger.info(
        "COGS venta id=%s método=%s total_cogs=%s | importe_venta=%s (NO se usa %% sobre venta)",
        sale.id,
        breakdown.method,
        breakdown.total_usd,
        sale_amt,
    )
