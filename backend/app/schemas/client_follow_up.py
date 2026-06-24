"""Esquemas API — seguimiento de clientes (créditos normales)."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class ClientFollowUpTag(BaseModel):
    id: Optional[uuid.UUID] = None
    name: str
    color: Optional[str] = None


class ClientFollowUpItem(BaseModel):
    id: int
    username: str
    name: Optional[str] = None
    phone: Optional[str] = None
    email: str
    last_recharge_date: datetime
    last_recharge_credits: float = Field(ge=0)
    last_recharge_total_amount: float = Field(
        ge=0,
        description="Total de la última factura en moneda de la venta (``local_amount`` o ``amount`` USD).",
    )
    last_recharge_currency: str = Field(
        default="USD",
        description="Moneda ISO 4217 del total mostrado al cliente.",
    )
    days_since_last_recharge: int = Field(ge=0)
    last_sale_id: Optional[int] = None
    product_name: Optional[str] = None
    tags: list[ClientFollowUpTag] = Field(default_factory=list)


class ClientFollowUpListResponse(BaseModel):
    items: list[ClientFollowUpItem]
    total: int
