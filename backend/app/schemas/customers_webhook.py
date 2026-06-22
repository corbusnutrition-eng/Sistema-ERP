"""Esquemas para rutas `/api/v1/customers/` y webhooks desde la web."""

from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field


class WebCustomerRegisterWebhookIn(BaseModel):
    """Cuerpo de ``POST …/customers/webhook-register-web`` desde catalogo-vip."""

    email: EmailStr
    password_hash: str = Field(..., min_length=1, max_length=512, description="Hash ya calculado por la web.")


class WebCustomerRegisterWebhookOut(BaseModel):
    id: int
    email: EmailStr
