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
                detail="Indica una tasa personalizada válida antes de activarla.",
            )

    if display_order is not None:
        row.display_order = int(display_order)

    row.updated_at = now_ecuador()
    db.commit()
    db.refresh(row)
    return row


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
    return synced, failed
