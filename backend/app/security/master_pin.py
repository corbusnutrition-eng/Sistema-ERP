"""Validación del PIN maestro de administración (``MASTER_ADMIN_PIN``)."""

from __future__ import annotations

import os
import secrets

from fastapi import HTTPException, status

from app.audit.forensic import record_forensic_event


def configured_master_pin() -> str:
    pin = (os.getenv("MASTER_ADMIN_PIN") or "").strip()
    if not pin:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="PIN maestro no configurado (variable MASTER_ADMIN_PIN).",
        )
    return pin


def require_master_pin(pin: str | None) -> None:
    """
    Valida el PIN maestro en tiempo constante (``secrets.compare_digest``) para
    no filtrar por temporización cuántos caracteres iniciales coinciden.

    El PIN es de solo 6 dígitos: esto por sí solo NO evita la fuerza bruta —
    los endpoints que lo exigen deben además llevar rate limiting propio
    (ver ``app.rate_limit``) y quedar registrados en la auditoría forense.
    """
    expected = configured_master_pin()
    provided = str(pin or "").strip()
    if not secrets.compare_digest(provided.encode("utf-8"), expected.encode("utf-8")):
        record_forensic_event("master_pin.rejected")
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="PIN maestro incorrecto.",
        )
    record_forensic_event("master_pin.used")
