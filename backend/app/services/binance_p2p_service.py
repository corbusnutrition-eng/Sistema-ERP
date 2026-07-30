"""
Proveedor de tasas de cambio USD → fiat (Open Exchange Rates).

Mantiene nombres legacy ``fetch_binance_p2p_*`` para no romper imports del scheduler
y ``exchange_rate_service``; la columna BD ``binance_rate`` almacena la tasa de mercado.
"""

from __future__ import annotations

import logging
from typing import Iterable

import httpx

logger = logging.getLogger(__name__)

OPEN_EXCHANGE_RATES_URL = "https://open.er-api.com/v6/latest/USD"
DEFAULT_TIMEOUT = 15.0


def _response_debug_snippet(response: httpx.Response, *, limit: int = 500) -> str:
    try:
        body = response.json()
        return str(body)[:limit]
    except Exception:
        return (response.text or "")[:limit]


def fetch_usd_market_rates(*, timeout: float = DEFAULT_TIMEOUT) -> dict[str, float] | None:
    """
    GET único a Open Exchange Rates (base USD).

    Returns:
        Diccionario ``{ "BOB": 6.91, "COP": 3950.5, ... }`` o ``None`` si falla.
    """
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.get(OPEN_EXCHANGE_RATES_URL)
        status = int(response.status_code)
        if status != 200:
            logger.warning(
                "Open Exchange Rates HTTP %s — cuerpo: %s",
                status,
                _response_debug_snippet(response),
            )
            return None
        body = response.json()
    except Exception:
        logger.exception("Error de red consultando Open Exchange Rates")
        return None

    if not isinstance(body, dict):
        logger.warning("Open Exchange Rates respuesta no-JSON: %s", str(body)[:500])
        return None

    if str(body.get("result") or "").lower() != "success":
        logger.warning(
            "Open Exchange Rates result=%s — respuesta: %s",
            body.get("result"),
            str(body)[:500],
        )
        return None

    raw_rates = body.get("rates")
    if not isinstance(raw_rates, dict) or not raw_rates:
        logger.warning(
            "Open Exchange Rates sin diccionario rates — respuesta: %s",
            str(body)[:500],
        )
        return None

    parsed: dict[str, float] = {}
    for code, value in raw_rates.items():
        cur = str(code or "").strip().upper()
        if not cur:
            continue
        try:
            rate = float(value)
        except (TypeError, ValueError):
            continue
        if rate > 0:
            parsed[cur] = round(rate, 6)

    if not parsed:
        logger.warning("Open Exchange Rates: ninguna tasa parseable en la respuesta.")
        return None

    logger.info("Open Exchange Rates: %s monedas cargadas (base USD).", len(parsed))
    return parsed


def fetch_market_rates_for_currencies(
    fiat_codes: Iterable[str],
    *,
    timeout: float = DEFAULT_TIMEOUT,
) -> dict[str, float | None]:
    """Resuelve tasas USD→fiat para una lista de códigos con una sola petición HTTP."""
    codes = [str(c or "").strip().upper() for c in fiat_codes if str(c or "").strip()]
    market = fetch_usd_market_rates(timeout=timeout)
    if market is None:
        return {code: None for code in codes}

    out: dict[str, float | None] = {}
    for code in codes:
        if code in {"USD", "USDT", "USDC"}:
            out[code] = 1.0
            continue
        rate = market.get(code)
        if rate is None or rate <= 0:
            logger.warning("Open Exchange Rates: moneda %s no encontrada en rates.", code)
            out[code] = None
        else:
            out[code] = rate
    return out


def fetch_binance_p2p_rate(
    fiat_code: str,
    *,
    timeout: float = DEFAULT_TIMEOUT,
    **_legacy_kwargs: object,
) -> float | None:
    """Alias legacy: devuelve tasa de mercado USD→``fiat_code`` vía Open Exchange Rates."""
    fiat = str(fiat_code or "").strip().upper()
    if not fiat or fiat in {"USD", "USDT", "USDC"}:
        return None
    rates = fetch_market_rates_for_currencies([fiat], timeout=timeout)
    return rates.get(fiat)


def fetch_binance_p2p_rates(
    fiat_codes: Iterable[str],
    *,
    timeout: float = DEFAULT_TIMEOUT,
    **_legacy_kwargs: object,
) -> dict[str, float | None]:
    """Alias legacy: tasas de mercado para múltiples monedas (una sola petición)."""
    return fetch_market_rates_for_currencies(fiat_codes, timeout=timeout)
