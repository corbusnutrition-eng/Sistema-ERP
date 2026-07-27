"""Validación del PIN maestro de administración (``MASTER_ADMIN_PIN``)."""

from __future__ import annotations

import os

from fastapi import HTTPException, status


def configured_master_pin() -> str:
    pin = (os.getenv("MASTER_ADMIN_PIN") or "").strip()
    if not pin:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="PIN maestro no configurado (variable MASTER_ADMIN_PIN).",
        )
    return pin


def require_master_pin(pin: str | None) -> None:
    expected = configured_master_pin()
    if str(pin or "").strip() != expected:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="PIN maestro incorrecto.",
        )
