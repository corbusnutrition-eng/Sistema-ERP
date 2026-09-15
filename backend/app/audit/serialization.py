"""Serialización JSON-segura + redacción de secretos para la bitácora."""

from __future__ import annotations

import datetime as _dt
import enum
import json
import re
import uuid
from decimal import Decimal
from typing import Any

REDACTED = "***REDACTED***"

#: Fragmentos largos: coincidencia por SUBCADENA (seguro — no colisionan con
#: nombres de columna legítimos como "shipping_address" o "hashtag").
_SENSITIVE_SUBSTR: tuple[str, ...] = (
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "private_key",
    "credential",
    "authorization",
    "cookie",
    "signature",
    "session_id",
    "bearer",
    "access_key",
)

#: Fragmentos cortos: coincidencia SOLO por token exacto (partido por "_").
#: Nunca por subcadena: "pin" ⊂ "shipping", "key" ⊂ "monkey", "hash" ⊂ "hashtag".
_SENSITIVE_TOKENS: frozenset[str] = frozenset({"pin", "otp", "cvv", "cvc", "salt", "key", "hash", "nonce", "seed"})

#: Falsos positivos conocidos que SÍ queremos auditar en claro.
_ALLOWLIST: frozenset[str] = frozenset({"hash_algorithm", "hashtag", "keywords", "public_key"})

MAX_PAYLOAD_BYTES = 32 * 1024
MAX_STRING_LEN = 2000
_SPLIT = re.compile(r"[^a-z0-9]+")


def is_sensitive_key(key: Any) -> bool:
    k = str(key or "").strip().lower()
    if not k or k in _ALLOWLIST:
        return False
    if any(frag in k for frag in _SENSITIVE_SUBSTR):
        return True
    return bool(set(_SPLIT.split(k)) & _SENSITIVE_TOKENS)


def to_jsonable(value: Any, *, _depth: int = 0) -> Any:
    """Decimal / datetime / date / UUID / Enum / bytes → JSON, con scrub recursivo."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, str):
        return value if len(value) <= MAX_STRING_LEN else value[:MAX_STRING_LEN] + "…"
    if isinstance(value, Decimal):
        # str exacto, NO float: los importes son Numeric(18,4) y float pierde precisión.
        return format(value, "f")
    if isinstance(value, enum.Enum):
        return to_jsonable(value.value, _depth=_depth + 1)
    if isinstance(value, _dt.datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=_dt.timezone.utc)
        return dt.astimezone(_dt.timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, (_dt.date, _dt.time)):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"<bytes:{len(bytes(value))}>"
    if _depth >= 6:
        return "<max-depth>"
    if isinstance(value, dict):
        # Scrub RECURSIVO: p.ej. sale.invoice_lines (JSON) lleva credenciales
        # IPTV anidadas, y clients.custom_fields es JSONB de forma libre.
        return {
            str(k): (REDACTED if is_sensitive_key(k) else to_jsonable(v, _depth=_depth + 1))
            for k, v in list(value.items())[:200]
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_jsonable(v, _depth=_depth + 1) for v in list(value)[:200]]
    return str(value)[:MAX_STRING_LEN]


def redact_and_serialize(column_name: str, value: Any) -> Any:
    """Valor de una columna: redacta por nombre, o serializa con scrub recursivo."""
    if is_sensitive_key(column_name):
        # Se conserva la SEÑAL de que cambió (el nombre va en `changed_fields`)
        # pero nunca el valor, ni el viejo ni el nuevo.
        return None if value is None else REDACTED
    return to_jsonable(value)


def cap_payload(payload: dict[str, Any] | None) -> tuple[dict[str, Any] | None, bool]:
    """Trunca payloads gigantes (invoice_lines / payment_events pueden ser enormes)."""
    if not payload:
        return None, False
    raw = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    if len(raw) <= MAX_PAYLOAD_BYTES:
        return payload, False
    out: dict[str, Any] = {}
    size = 0
    for k, v in payload.items():
        chunk = len(json.dumps({k: v}, ensure_ascii=False, default=str).encode("utf-8"))
        if size + chunk > MAX_PAYLOAD_BYTES:
            out[k] = "<omitted:too-large>"
            continue
        out[k] = v
        size += chunk
    return out, True
