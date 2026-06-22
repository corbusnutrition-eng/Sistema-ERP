"""Esquemas para ``POST /api/v1/webhooks/codigos-retiro``."""

from __future__ import annotations

from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


class CodigosRetiroWebhookIn(BaseModel):
    """Cuerpo enviado por el socio de recaudo físico al confirmar o fallar un retiro."""

    cliente: str = Field(..., min_length=1, max_length=255)
    estado: str = Field(..., min_length=1, max_length=64)
    monto: Decimal = Field(..., gt=0)
    referencia_externa: Optional[str] = Field(default=None, max_length=64)
    es_prueba: bool = Field(default=False)

    @field_validator("cliente")
    @classmethod
    def strip_cliente(cls, v: str) -> str:
        s = str(v or "").strip()
        if not s:
            raise ValueError("cliente no puede estar vacío.")
        return s

    @field_validator("referencia_externa")
    @classmethod
    def strip_referencia_externa(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        s = str(v).strip()
        return s or None

    @field_validator("estado")
    @classmethod
    def normalize_estado(cls, v: str) -> Literal["completado", "fallido", "fallido_revision"]:
        s = str(v or "").strip().lower()
        if s == "completado":
            return "completado"
        if s == "fallido":
            return "fallido"
        if s in ("fallido_revision", "fallido-revision", "fallido revision"):
            return "fallido_revision"
        raise ValueError('estado debe ser "completado", "fallido" o "fallido_revision".')

    @field_validator("monto", mode="before")
    @classmethod
    def normalize_monto(cls, v: object) -> Decimal:
        try:
            amt = Decimal(str(v)).quantize(Decimal("0.01"))
        except Exception as exc:
            raise ValueError("monto inválido.") from exc
        if amt <= 0:
            raise ValueError("monto debe ser mayor a 0.")
        return amt

    @field_validator("es_prueba", mode="before")
    @classmethod
    def normalize_es_prueba(cls, v: object) -> bool:
        if v is None:
            return False
        if isinstance(v, bool):
            return v
        s = str(v).strip().lower()
        if s in ("1", "true", "yes", "si", "sí"):
            return True
        if s in ("0", "false", "no", ""):
            return False
        return bool(v)


class CodigosRetiroWebhookOut(BaseModel):
    ok: bool = True
    accepted: bool = True
    message: str = "Webhook recibido."
    sale_id: Optional[int] = None
    client_id: Optional[int] = None
