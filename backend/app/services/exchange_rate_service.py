"""Persistencia y sincronización de tasas de mercado USD con override manual."""

from __future__ import annotations

import logging
import os
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


def _ensure_row(db: Session, currency_code: str) -> ExchangeRate:
    code = normalize_currency_code(currency_code)
    row = db.get(ExchangeRate, code)
    if row is None:
        row = ExchangeRate(
            currency_code=code,
            binance_rate=None,
            manual_rate=None,
            use_manual_override=False,
            updated_at=now_ecuador(),
        )
        db.add(row)
        db.flush()
    return row


def list_exchange_rates(db: Session) -> list[ExchangeRate]:
    configured = get_configured_fiat_codes()
    changed = False
    for code in configured:
        if db.get(ExchangeRate, code) is None:
            db.add(
                ExchangeRate(
                    currency_code=code,
                    binance_rate=None,
                    manual_rate=None,
                    use_manual_override=False,
                    updated_at=now_ecuador(),
                )
            )
            changed = True
    if changed:
        db.commit()

    rows = (
        db.query(ExchangeRate)
        .filter(ExchangeRate.currency_code.in_(configured))
        .all()
    )
    order_map = {code: idx for idx, code in enumerate(configured)}
    rows.sort(key=lambda r: order_map.get(r.currency_code, 999))
    return rows


def update_exchange_rate(
    db: Session,
    *,
    currency_code: str,
    manual_rate: float | None = None,
    use_manual_override: bool | None = None,
) -> ExchangeRate:
    code = normalize_currency_code(currency_code)
    row = _ensure_row(db, code)

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
                detail="Indica una tasa manual válida antes de activar el override.",
            )

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
    codes = [normalize_currency_code(c) for c in (fiat_codes or get_configured_fiat_codes())]
    active_codes = [c for c in codes if c not in {"USD", "USDT", "USDC"}]
    market_rates = fetch_market_rates_for_currencies(active_codes)
    synced = 0
    failed: list[str] = []

    for code in active_codes:
        row = _ensure_row(db, code)
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
