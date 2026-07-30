"""Reglas de vencimiento y fechas maestras al reponer stock en lotes de bodega."""

from __future__ import annotations

from datetime import date
from typing import Optional

from sqlalchemy.orm import Session

from app.models.screen_stock import ScreenStock
from app.services.screen_package_expiration import calculate_screen_expiration_stats
from app.timezone_utils import now_ecuador


def batch_free_count(rows: list[ScreenStock]) -> int:
    return sum(1 for row in rows if str(row.status or "free") == "free")


def batch_is_expired(
    rows: list[ScreenStock],
    package_label: str,
    *,
    reference_date: Optional[date] = None,
) -> bool:
    if not rows:
        return False
    rep = rows[0]
    if str(getattr(rep, "status", "") or "").strip().lower() == "expired":
        return True
    today = reference_date or now_ecuador().date()
    stats = calculate_screen_expiration_stats(rep.created_at, package_label, reference_date=today)
    if stats is not None and stats.expired:
        return True
    exp = rep.expiration_date
    if exp is not None and exp < today:
        return True
    return False


def batch_should_reset_expiration_on_restock(
    rows: list[ScreenStock],
    package_label: str,
    *,
    reference_date: Optional[date] = None,
) -> bool:
    """
    Reinicia fechas maestras del lote solo si estaba vencido o sin pantallas libres
    **antes** de inyectar stock nuevo.
    """
    if not rows:
        return False
    today = reference_date or now_ecuador().date()
    if batch_is_expired(rows, package_label, reference_date=today):
        return True
    return batch_free_count(rows) == 0


def resolve_batch_master_expiration_date(
    package_label: str,
    opening_date: Optional[date],
) -> date:
    if opening_date is not None:
        return opening_date
    return now_ecuador().date()


def reset_batch_lot_dates(
    rows: list[ScreenStock],
    *,
    package_label: str,
    opening_date: Optional[date] = None,
) -> None:
    """Reinicia ``created_at`` y ``expiration_date`` en todas las filas del lote."""
    if not rows:
        return
    now = now_ecuador()
    exp = resolve_batch_master_expiration_date(package_label, opening_date)
    for row in rows:
        row.created_at = now
        row.expiration_date = exp


def inherit_batch_master_dates(rep: ScreenStock) -> tuple[object, Optional[date]]:
    return rep.created_at, rep.expiration_date


def find_replenishable_batch_for_package(
    db: Session,
    *,
    product_id: int,
    package_label: str,
    provider: str,
) -> tuple[Optional[str], list[ScreenStock]]:
    """
    Busca un lote existente del producto/paquete apto para reponer (vencido o sin libres).
    """
    from sqlalchemy import func

    pkg = str(package_label or "").strip()
    pv = str(provider or "").strip().lower()
    if not pkg or not pv:
        return None, []

    rows = (
        db.query(ScreenStock)
        .filter(
            ScreenStock.product_id == int(product_id),
            func.lower(func.trim(func.coalesce(ScreenStock.provider, ""))) == pv,
            func.lower(func.trim(func.coalesce(ScreenStock.package, ""))) == pkg.lower(),
        )
        .order_by(ScreenStock.created_at.asc(), ScreenStock.id.asc())
        .all()
    )
    batches: dict[str, list[ScreenStock]] = {}
    for row in rows:
        batches.setdefault(str(row.batch_id), []).append(row)

    ordered = sorted(
        batches.items(),
        key=lambda item: min(int(r.id) for r in item[1]),
    )
    for batch_id, batch_rows in ordered:
        if batch_should_reset_expiration_on_restock(batch_rows, pkg):
            return batch_id, batch_rows
    return None, []
