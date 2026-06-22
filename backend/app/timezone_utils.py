"""
Zona horaria operativa del ERP: Ecuador (America/Guayaquil, UTC-5, sin DST).

- ``now_ecuador()``: timestamps de negocio (ventas, pagos, notas).
- ``now_utc()``: normalización / JWT (instante absoluto).
- Las fechas calendario (``date``) se interpretan en horario ecuatoriano.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

ECUADOR_TZ = ZoneInfo("America/Guayaquil")
UTC = timezone.utc


def now_ecuador() -> datetime:
    """Momento actual en Ecuador (timezone-aware)."""
    return datetime.now(ECUADOR_TZ)


def now_utc() -> datetime:
    """Momento actual en UTC (timezone-aware)."""
    return datetime.now(UTC)


def ensure_aware(
    dt: datetime,
    *,
    assume_tz: ZoneInfo = ECUADOR_TZ,
) -> datetime:
    """Convierte naive → aware asumiendo Ecuador por defecto."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=assume_tz)
    return dt


def to_utc(dt: datetime) -> datetime:
    """Convierte cualquier datetime aware a UTC."""
    return ensure_aware(dt).astimezone(UTC)


def datetime_at_ecuador_midnight(d: date) -> datetime:
    """00:00:00 del día calendario en Ecuador (aware)."""
    return datetime.combine(d, time.min, tzinfo=ECUADOR_TZ)


def ecuador_day_range_utc(start: date, end: date) -> tuple[datetime, datetime]:
    """
    Rango semiabierto [inicio, fin+1 día) en instantes UTC para filtros SQL.

    ``start`` y ``end`` son fechas calendario en horario Ecuador.
    """
    start_local = datetime.combine(start, time.min, tzinfo=ECUADOR_TZ)
    end_local = datetime.combine(end + timedelta(days=1), time.min, tzinfo=ECUADOR_TZ)
    return start_local.astimezone(UTC), end_local.astimezone(UTC)


def isoformat_z(dt: Optional[datetime]) -> Optional[str]:
    """ISO 8601 en UTC con sufijo ``Z`` (para JSON / eventos)."""
    if dt is None:
        return None
    return to_utc(dt).isoformat().replace("+00:00", "Z")
