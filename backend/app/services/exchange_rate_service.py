"""Persistencia y sincronización de tasas de mercado USD con override manual."""

from __future__ import annotations

import logging
import os
import re
from typing import Iterable

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.exchange_rate import ExchangeRate
from app.services.binance_p2p_service import fetch_market_rates_for_currencies
from app.services.telegram_service import send_telegram_alert
from app.timezone_utils import now_ecuador

logger = logging.getLogger(__name__)

DEFAULT_FIAT_CODES: tuple[str, ...] = (
    "BOB",
    "COP",
    "MXN",
    "PEN",
    "ARS",
    "BRL",
    "CLP",
    "GTQ",
    "DOP",
    "PYG",
    "UYU",
    "VES",
    "CRC",
    "HNL",
    "NIO",
)

_CURRENCY_CODE_RE = re.compile(r"^[A-Z]{3,10}$")


def get_configured_fiat_codes() -> list[str]:
    raw = (os.getenv("EXCHANGE_RATE_FIAT_CODES") or "").strip()
    if raw:
        codes = [normalize_currency_code(part) for part in raw.split(",") if part.strip()]
    else:
        codes = list(DEFAULT_FIAT_CODES)
    out: list[str] = []
    seen: set[str] = set()
    for code in codes:
        if code in {"USD", "USDT", "USDC"} or code in seen:
            continue
        seen.add(code)
        out.append(code)
    return out


def resolve_active_rate(row: ExchangeRate) -> float | None:
    if row.use_manual_override and row.manual_rate is not None and float(row.manual_rate) > 0:
        return round(float(row.manual_rate), 6)
    if row.binance_rate is not None and float(row.binance_rate) > 0:
        return round(float(row.binance_rate), 6)
    if row.manual_rate is not None and float(row.manual_rate) > 0:
        return round(float(row.manual_rate), 6)
    return None


def compute_tolerance_difference(row: ExchangeRate) -> float | None:
    """Calcula la diferencia según tolerance_type. None si no aplica."""
    tolerance_type = str(getattr(row, "tolerance_type", "") or "").strip().lower()
    tolerance_value = getattr(row, "tolerance_value", None)
    if tolerance_type not in {"percentage", "value"}:
        return None
    if tolerance_value is None or float(tolerance_value) <= 0:
        return None
    if not row.use_manual_override:
        return None

    official = row.binance_rate
    manual = row.manual_rate
    if official is None or manual is None:
        return None
    official_f = float(official)
    manual_f = float(manual)
    if official_f <= 0 or manual_f <= 0:
        return None

    if tolerance_type == "value":
        return abs(official_f - manual_f)
    return abs((official_f - manual_f) / manual_f) * 100


def is_tolerance_breached(row: ExchangeRate) -> bool:
    diff = compute_tolerance_difference(row)
    if diff is None:
        return False
    tolerance_value = float(row.tolerance_value)  # type: ignore[arg-type]
    return diff > tolerance_value


def _format_rate_for_telegram(value: float | None) -> str:
    if value is None or float(value) <= 0:
        return "—"
    return f"{float(value):,.4f}".rstrip("0").rstrip(".")


def _build_market_update_message(rows: list[ExchangeRate]) -> str:
    parts: list[str] = []
    for row in rows:
        if row.binance_rate is None or float(row.binance_rate) <= 0:
            continue
        parts.append(f"{row.currency_code}: {_format_rate_for_telegram(row.binance_rate)}")
    if not parts:
        return ""
    return "🔄 Actualización de mercado: " + ", ".join(parts)


def _send_tolerance_variation_alert(row: ExchangeRate) -> None:
    official = _format_rate_for_telegram(row.binance_rate)
    manual = _format_rate_for_telegram(row.manual_rate)
    message = (
        f"⚠️ ALERTA DE VARIACIÓN: La moneda {row.currency_code} tiene una brecha excesiva. "
        f"Tasa Oficial: {official} | Tu Tasa Manual: {manual}. "
        "Por favor, ingresa al panel para ajustar tu tasa manual."
    )
    send_telegram_alert(message)


def _notify_market_sync_and_evaluate_alerts(db: Session) -> None:
    rows = (
        db.query(ExchangeRate)
        .filter(ExchangeRate.is_active.is_(True))
        .order_by(ExchangeRate.display_order.asc(), ExchangeRate.currency_code.asc())
        .all()
    )
    summary = _build_market_update_message(rows)
    if summary:
        send_telegram_alert(summary)

    for row in rows:
        if is_tolerance_breached(row):
            _send_tolerance_variation_alert(row)


def _validate_currency_code(raw: str) -> str:
    code = normalize_currency_code(str(raw or "").strip())
    if code in {"USD", "USDT", "USDC"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="USD/USDT/USDC no requieren tasa de cambio.",
        )
    if not _CURRENCY_CODE_RE.match(code):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Código de moneda inválido. Use 3–10 letras (ej. EUR, JPY).",
        )
    return code


def _ensure_row(db: Session, currency_code: str, *, is_active: bool = True) -> ExchangeRate:
    code = normalize_currency_code(currency_code)
    row = db.get(ExchangeRate, code)
    if row is None:
        max_order = (
            db.query(ExchangeRate.display_order)
            .order_by(ExchangeRate.display_order.desc())
            .limit(1)
            .scalar()
        )
        row = ExchangeRate(
            currency_code=code,
            binance_rate=None,
            manual_rate=None,
            use_manual_override=False,
            is_active=bool(is_active),
            display_order=int(max_order or 0) + 1,
            updated_at=now_ecuador(),
        )
        db.add(row)
        db.flush()
    return row


def _normalize_display_orders(db: Session, rows: list[ExchangeRate]) -> bool:
    """Asigna orden secuencial si todas las filas tienen display_order=0."""
    if len(rows) <= 1:
        return False
    if not all(int(getattr(r, "display_order", 0) or 0) == 0 for r in rows):
        return False
    for idx, row in enumerate(sorted(rows, key=lambda r: str(r.currency_code))):
        row.display_order = idx
    return True


def _seed_default_rows(db: Session) -> bool:
    changed = False
    for idx, code in enumerate(get_configured_fiat_codes()):
        row = db.get(ExchangeRate, code)
        if row is None:
            db.add(
                ExchangeRate(
                    currency_code=code,
                    binance_rate=None,
                    manual_rate=None,
                    use_manual_override=False,
                    is_active=True,
                    display_order=idx,
                    updated_at=now_ecuador(),
                )
            )
            changed = True
    return changed


def _active_currency_codes(db: Session) -> list[str]:
    rows = (
        db.query(ExchangeRate.currency_code)
        .filter(ExchangeRate.is_active.is_(True))
        .order_by(ExchangeRate.currency_code.asc())
        .all()
    )
    codes = [str(r[0]) for r in rows if r and r[0]]
    if codes:
        return [c for c in codes if c not in {"USD", "USDT", "USDC"}]
    return get_configured_fiat_codes()


def list_exchange_rates(db: Session) -> list[ExchangeRate]:
    if _seed_default_rows(db):
        db.commit()

    rows = (
        db.query(ExchangeRate)
        .filter(ExchangeRate.is_active.is_(True))
        .order_by(ExchangeRate.display_order.asc(), ExchangeRate.currency_code.asc())
        .all()
    )
    if _normalize_display_orders(db, rows):
        db.commit()
        rows = (
            db.query(ExchangeRate)
            .filter(ExchangeRate.is_active.is_(True))
            .order_by(ExchangeRate.display_order.asc(), ExchangeRate.currency_code.asc())
            .all()
        )
    return rows


def create_exchange_rate(db: Session, *, currency_code: str) -> ExchangeRate:
    code = _validate_currency_code(currency_code)
    row = db.get(ExchangeRate, code)

    if row is not None and row.is_active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"La moneda {code} ya está en la lista activa.",
        )

    market_rates = fetch_market_rates_for_currencies([code])
    rate = market_rates.get(code)
    if rate is None or float(rate) <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"No se encontró tasa de mercado para {code} en Open Exchange Rates.",
        )

    now = now_ecuador()
    max_order = (
        db.query(ExchangeRate.display_order)
        .filter(ExchangeRate.is_active.is_(True))
        .order_by(ExchangeRate.display_order.desc())
        .limit(1)
        .scalar()
    )
    next_order = int(max_order if max_order is not None else -1) + 1

    if row is None:
        row = ExchangeRate(
            currency_code=code,
            binance_rate=float(rate),
            manual_rate=None,
            use_manual_override=False,
            is_active=True,
            display_order=next_order,
            updated_at=now,
        )
        db.add(row)
    else:
        row.is_active = True
        row.binance_rate = float(rate)
        row.display_order = next_order
        row.updated_at = now

    db.commit()
    db.refresh(row)
    return row


def update_exchange_rate(
    db: Session,
    *,
    currency_code: str,
    manual_rate: float | None = None,
    use_manual_override: bool | None = None,
    display_order: int | None = None,
    tolerance_type: str | None = None,
    tolerance_value: float | None = None,
    clear_tolerance: bool = False,
) -> ExchangeRate:
    code = normalize_currency_code(currency_code)
    row = db.get(ExchangeRate, code)
    if row is None or not row.is_active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Moneda no encontrada en la lista activa.",
        )

    if manual_rate is not None:
        if float(manual_rate) <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La tasa manual debe ser mayor que cero.",
            )
        row.manual_rate = round(float(manual_rate), 6)

    if use_manual_override is not None:
        row.use_manual_override = bool(use_manual_override)
        if row.use_manual_override and (row.manual_rate is None or float(row.manual_rate) <= 0):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Indica una tasa manual válida antes de activarla.",
            )

    if display_order is not None:
        row.display_order = int(display_order)

    if clear_tolerance:
        row.tolerance_type = None
        row.tolerance_value = None
    elif tolerance_type is not None:
        normalized_type = str(tolerance_type).strip().lower()
        if normalized_type not in {"percentage", "value"}:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="tolerance_type debe ser 'percentage' o 'value'.",
            )
        if tolerance_value is None or float(tolerance_value) <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Indica un valor de tolerancia válido.",
            )
        row.tolerance_type = normalized_type
        row.tolerance_value = round(float(tolerance_value), 6)
    elif tolerance_value is not None:
        if float(tolerance_value) <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Indica un valor de tolerancia válido.",
            )
        if not row.tolerance_type:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Selecciona un tipo de tolerancia antes de indicar el valor.",
            )
        row.tolerance_value = round(float(tolerance_value), 6)

    row.updated_at = now_ecuador()
    db.commit()
    db.refresh(row)
    return row


def reorder_exchange_rates(
    db: Session,
    *,
    order_updates: Iterable[tuple[str, int]],
) -> None:
    """Actualiza ``display_order`` de varias monedas en una sola transacción."""
    updates: list[tuple[str, int]] = []
    seen_codes: set[str] = set()
    for raw_code, raw_order in order_updates:
        code = normalize_currency_code(str(raw_code or "").strip())
        if not code or code in seen_codes:
            continue
        seen_codes.add(code)
        updates.append((code, int(raw_order)))

    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Debe indicar al menos una moneda para reordenar.",
        )

    now = now_ecuador()
    for code, display_order in updates:
        row = db.get(ExchangeRate, code)
        if row is None or not row.is_active:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Moneda {code} no encontrada en la lista activa.",
            )
        row.display_order = display_order
        row.updated_at = now

    db.commit()


def sync_exchange_rates_from_binance(
    db: Session,
    *,
    fiat_codes: Iterable[str] | None = None,
) -> tuple[int, list[str]]:
    """
    Actualiza ``binance_rate`` (tasa mercado USD) por moneda vía Open Exchange Rates.

    Si la API falla o una moneda no viene en la respuesta, conserva la tasa anterior.

    Returns:
        (synced_count, failed_codes)
    """
    if fiat_codes is None:
        active_codes = _active_currency_codes(db)
    else:
        active_codes = [
            normalize_currency_code(c)
            for c in fiat_codes
            if normalize_currency_code(c) not in {"USD", "USDT", "USDC"}
        ]

    if not active_codes:
        return 0, []

    market_rates = fetch_market_rates_for_currencies(active_codes)
    synced = 0
    failed: list[str] = []

    for code in active_codes:
        row = db.get(ExchangeRate, code)
        if row is None or not row.is_active:
            row = _ensure_row(db, code, is_active=True)
        rate = market_rates.get(code)
        if rate is None:
            failed.append(code)
            logger.warning("Sync mercado omitido para %s; se conserva tasa previa.", code)
            continue
        row.binance_rate = rate
        row.updated_at = now_ecuador()
        synced += 1

    db.commit()

    if synced > 0:
        try:
            _notify_market_sync_and_evaluate_alerts(db)
        except Exception:
            logger.exception("Error enviando alertas Telegram tras sync de exchange rates.")

    return synced, failed
