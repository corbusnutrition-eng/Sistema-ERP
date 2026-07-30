"""Extracción de tipos de cambio desde Binance P2P (USDT vs fiat)."""

from __future__ import annotations

import logging
from typing import Iterable

import httpx

logger = logging.getLogger(__name__)

BINANCE_P2P_SEARCH_URL = "https://p2p.binance.com/bapi/c2c/v2/public/c2c/adv/search"
DEFAULT_ROWS = 5
DEFAULT_SAMPLE_SIZE = 5


def _parse_prices(adv_list: list[dict]) -> list[float]:
    prices: list[float] = []
    for adv in adv_list:
        if not isinstance(adv, dict):
            continue
        raw = adv.get("adv", {}).get("price") if isinstance(adv.get("adv"), dict) else adv.get("price")
        try:
            price = float(raw)
        except (TypeError, ValueError):
            continue
        if price > 0:
            prices.append(price)
    return prices


def fetch_binance_p2p_rate(
    fiat_code: str,
    *,
    rows: int = DEFAULT_ROWS,
    sample_size: int = DEFAULT_SAMPLE_SIZE,
    timeout: float = 15.0,
) -> float | None:
    """
    Consulta Binance P2P y devuelve el promedio de los primeros anuncios BUY USDT.

    ``tradeType=BUY`` → precio en fiat por 1 USDT (equivalente operativo a 1 USD).
    """
    fiat = str(fiat_code or "").strip().upper()
    if not fiat or fiat in {"USD", "USDT", "USDC"}:
        return None

    payload = {
        "fiat": fiat,
        "page": 1,
        "rows": max(3, min(int(rows), 20)),
        "tradeType": "BUY",
        "asset": "USDT",
        "merchantCheck": False,
    }

    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(BINANCE_P2P_SEARCH_URL, json=payload)
        if response.status_code >= 400:
            logger.warning(
                "Binance P2P HTTP %s para %s: %s",
                response.status_code,
                fiat,
                (response.text or "")[:300],
            )
            return None
        body = response.json()
    except Exception:
        logger.exception("Error de red consultando Binance P2P para %s", fiat)
        return None

    if not isinstance(body, dict) or body.get("code") not in (None, "000000", 0, "0"):
        logger.warning("Binance P2P respuesta inválida para %s: %s", fiat, body)
        return None

    data = body.get("data")
    if not isinstance(data, list):
        logger.warning("Binance P2P sin lista data para %s", fiat)
        return None

    prices = _parse_prices(data)[: max(3, min(int(sample_size), len(data)))]
    if not prices:
        logger.warning("Binance P2P sin precios parseables para %s", fiat)
        return None

    avg = round(sum(prices) / len(prices), 6)
    logger.info("Binance P2P %s → %.6f (muestra n=%s)", fiat, avg, len(prices))
    return avg


def fetch_binance_p2p_rates(
    fiat_codes: Iterable[str],
    *,
    rows: int = DEFAULT_ROWS,
    sample_size: int = DEFAULT_SAMPLE_SIZE,
) -> dict[str, float | None]:
    out: dict[str, float | None] = {}
    for raw in fiat_codes:
        code = str(raw or "").strip().upper()
        if not code:
            continue
        out[code] = fetch_binance_p2p_rate(code, rows=rows, sample_size=sample_size)
    return out
