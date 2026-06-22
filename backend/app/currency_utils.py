"""Normalización de códigos de moneda (ISO 4217 + códigos extendidos ej. USDT)."""

from __future__ import annotations

MAX_CURRENCY_CODE_LEN = 10


def normalize_currency_code(value: object | None, default: str = "USD") -> str:
    """
    Trim, mayúsculas y hasta ``MAX_CURRENCY_CODE_LEN`` caracteres.
    Soporta ISO 4217 (USD, PEN) y extendidos/uso interno (USDT, USDC, etc.).
    """
    if value is None:
        return default[:MAX_CURRENCY_CODE_LEN]
    s = str(value).strip().upper()
    if not s:
        return default[:MAX_CURRENCY_CODE_LEN]
    return s[:MAX_CURRENCY_CODE_LEN]
