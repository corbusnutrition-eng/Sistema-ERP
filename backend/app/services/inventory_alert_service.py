"""Alertas de inventario bajo para créditos por pantalla (bodega ``ScreenStock``)."""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.v1.inventory import SCREEN_STOCK_AVAILABLE_STATUS, _norm_prov_key
from app.models.screen_stock import ScreenStock
from app.models.system_notification import SystemNotification
from app.timezone_utils import now_ecuador

if TYPE_CHECKING:
    from fastapi import BackgroundTasks

LOW_SCREEN_INVENTORY_THRESHOLD = 4
SYSTEM_NOTIFICATION_KIND_INVENTORY_LOW = "inventory_low"


def count_free_screen_stock(db: Session, *, provider: str, package: str) -> int:
    """Cuenta pantallas disponibles (``free``) para proveedor + paquete exactos."""
    pv = _norm_prov_key(provider)
    pk = (package or "").strip().lower()
    if not pv or not pk:
        return 0
    q = db.query(func.count(ScreenStock.id)).filter(
        ScreenStock.status == SCREEN_STOCK_AVAILABLE_STATUS,
        ScreenStock.sale_id.is_(None),
        func.lower(func.trim(func.coalesce(ScreenStock.provider, ""))) == pv,
        func.lower(func.trim(func.coalesce(ScreenStock.package, ""))) == pk,
    )
    return int(q.scalar() or 0)


def _unique_provider_packages(rows: list[ScreenStock]) -> list[tuple[str, str]]:
    seen: set[tuple[str, str]] = set()
    out: list[tuple[str, str]] = []
    for row in rows:
        prov = (row.provider or "").strip()
        pkg = (row.package or "").strip()
        if not prov or not pkg:
            continue
        key = (prov.lower(), pkg.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append((prov, pkg))
    return out


def build_low_inventory_telegram_message(*, provider: str, package_name: str, remaining: int) -> str:
    return (
        "🚨 *ALERTA DE INVENTARIO BAJO* 🚨\n"
        f"📦 *Proveedor:* {provider}\n"
        f"🏷️ *Paquete:* {package_name}\n"
        f"📉 *Disponibles:* {remaining}\n\n"
        "⏳ Recarga pronto para evitar ventas fallidas."
    )


def maybe_record_low_screen_inventory_alert(
    db: Session,
    *,
    provider: str,
    package: str,
) -> Optional[str]:
    """
    Si quedan menos de 4 pantallas libres, persiste alerta ERP y devuelve texto Telegram.
    Debe llamarse dentro de la transacción, después de reservar/asignar unidades.
    """
    prov = (provider or "").strip()
    pkg = (package or "").strip()
    if not prov or not pkg:
        return None

    db.flush()
    remaining = count_free_screen_stock(db, provider=prov, package=pkg)
    if remaining >= LOW_SCREEN_INVENTORY_THRESHOLD:
        return None

    title = f"⚠️ Inventario Bajo: {prov}"
    message = (
        f'Solo quedan {remaining} pantallas disponibles del paquete "{pkg}". '
        "Por favor, recarga créditos pronto."
    )
    db.add(
        SystemNotification(
            kind=SYSTEM_NOTIFICATION_KIND_INVENTORY_LOW,
            title=title,
            message=message,
            provider=prov,
            package_name=pkg,
            remaining_count=int(remaining),
            is_read=False,
            created_at=now_ecuador(),
        )
    )
    db.flush()
    return build_low_inventory_telegram_message(
        provider=prov,
        package_name=pkg,
        remaining=int(remaining),
    )


def collect_low_inventory_telegram_messages(
    db: Session,
    rows: list[ScreenStock],
) -> list[str]:
    """Evalúa inventario bajo para cada par proveedor/paquete de filas recién reservadas."""
    messages: list[str] = []
    for prov, pkg in _unique_provider_packages(rows):
        msg = maybe_record_low_screen_inventory_alert(db, provider=prov, package=pkg)
        if msg:
            messages.append(msg)
    return messages


def schedule_inventory_telegram_messages(
    background_tasks: Optional["BackgroundTasks"],
    messages: list[str],
) -> None:
    if not messages:
        return
    from app.services.telegram_service import schedule_telegram_markdown_notification

    for msg in messages:
        schedule_telegram_markdown_notification(background_tasks, msg)
