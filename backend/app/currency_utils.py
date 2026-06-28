"""Normalización de códigos de moneda (ISO 4217 + códigos extendidos ej. USDT)."""

from __future__ import annotations

MAX_CURRENCY_CODE_LEN = 10

# Símbolos y alias frecuentes en comprobantes → ISO 4217
_CURRENCY_SYMBOL_ALIASES: dict[str, str] = {
    "$": "USD",
    "US$": "USD",
    "U$S": "USD",
    "USD$": "USD",
    "€": "EUR",
    "£": "GBP",
}


def _resolve_currency_alias(code: str) -> str:
    compact = code.replace(" ", "")
    if compact in _CURRENCY_SYMBOL_ALIASES:
        return _CURRENCY_SYMBOL_ALIASES[compact]
    if code in _CURRENCY_SYMBOL_ALIASES:
        return _CURRENCY_SYMBOL_ALIASES[code]
    return code


def normalize_currency_code(value: object | None, default: str = "USD") -> str:
    """
    Trim, mayúsculas y hasta ``MAX_CURRENCY_CODE_LEN`` caracteres.
    Soporta ISO 4217 (USD, PEN) y extendidos/uso interno (USDT, USDC, etc.).
    Resuelve símbolos comunes ($ → USD) antes de comparar.
    """
    if value is None:
        return default[:MAX_CURRENCY_CODE_LEN]
    s = str(value).strip().upper()
    if not s:
        return default[:MAX_CURRENCY_CODE_LEN]
    s = _resolve_currency_alias(s)
    return s[:MAX_CURRENCY_CODE_LEN]
