"""Vencimiento efectivo de pantallas en bodega (misma lógica que Inventario IPTV / screenPackageExpiration.js)."""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional

from app.timezone_utils import ECUADOR_TZ, ensure_aware, now_ecuador


def parse_base_months_from_package(package_name: str) -> Optional[int]:
    """Meses base del paquete (sin promos). Orden: 12 → 6 → 3 → 1."""
    s = (package_name or "").lower()
    if re.search(r"\b12\s*mes(es)?\b", s):
        return 12
    if re.search(r"\b6\s*mes(es)?\b", s):
        return 6
    if re.search(r"\b3\s*mes(es)?\b", s):
        return 3
    if re.search(r"\b1\s*mes\b", s):
        return 1
    return None


def _to_ecuador_date(value: datetime | date) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    return ensure_aware(value).astimezone(ECUADOR_TZ).date()


def add_calendar_months(from_date: date, months: int) -> date:
    """Suma meses calendario clamping el día (equivalente a addCalendarMonthsFrom en el frontend)."""
    month_index = from_date.month - 1 + int(months)
    year = from_date.year + month_index // 12
    month = month_index % 12 + 1
    last_day = calendar.monthrange(year, month)[1]
    day = min(from_date.day, last_day)
    return date(year, month, day)


def diff_calendar_days(from_day: date, to_day: date) -> int:
    return (to_day - from_day).days


@dataclass(frozen=True)
class ScreenExpirationStats:
    base_months: int
    days_used: int
    effective_expiration_date: date
    days_remaining: int

    @property
    def expired(self) -> bool:
        return self.days_remaining < 0


def calculate_screen_expiration_stats(
    created_at: datetime | date | None,
    package_name: str | None,
    *,
    reference_date: date | None = None,
) -> Optional[ScreenExpirationStats]:
    """
    Calcula uso y días restantes según creación del ítem + duración base del paquete.
    Replica ``calculateExpirationStats`` del panel Inventario IPTV.
    """
    base_months = parse_base_months_from_package(package_name or "")
    if base_months is None or created_at is None:
        return None

    created_day = _to_ecuador_date(created_at)
    today = reference_date or now_ecuador().date()
    effective_expiration = add_calendar_months(created_day, base_months)
    days_used = diff_calendar_days(created_day, today)
    days_remaining = diff_calendar_days(today, effective_expiration)
    return ScreenExpirationStats(
        base_months=base_months,
        days_used=days_used,
        effective_expiration_date=effective_expiration,
        days_remaining=days_remaining,
    )
