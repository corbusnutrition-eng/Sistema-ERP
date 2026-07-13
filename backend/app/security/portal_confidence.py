"""Reglas de confianza OCR en el portal público (anti-bypass de montos cero)."""
from __future__ import annotations

from typing import Optional


def portal_stored_allows_zero_amount(stored_score: Optional[int]) -> bool:
    """
    Permite monto declarado cero solo si el score ya fue persistido en servidor.

    El cliente no puede enviar ``ai_confidence_score=0`` en formularios para activar
    este bypass; debe existir previamente en la entidad (admin / pipeline interno).
    """
    return stored_score is not None and int(stored_score) == 0


def portal_sanitize_client_confidence(
    stored: Optional[int],
    form_score: Optional[int],
) -> Optional[int]:
    """
    Acepta el score del formulario salvo ``0`` forjado por el cliente.

    Si el registro no tenía score 0 en BD, ignoramos un 0 enviado desde el portal.
    """
    if form_score is None:
        return stored
    try:
        submitted = int(form_score)
    except (TypeError, ValueError):
        return stored
    submitted = max(0, min(100, submitted))
    if submitted == 0 and not portal_stored_allows_zero_amount(stored):
        return stored if stored is not None else 100
    return submitted
