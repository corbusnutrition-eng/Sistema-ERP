"""Esquemas API — seguimiento de clientes (créditos normales)."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class ClientFollowUpItem(BaseModel):
    id: int
    username: str
    name: Optional[str] = None
    phone: Optional[str] = None
    email: str
    last_recharge_date: datetime
    last_recharge_credits: float = Field(ge=0)
    days_since_last_recharge: int = Field(ge=0)
    last_sale_id: Optional[int] = None
    product_name: Optional[str] = None


class ClientFollowUpListResponse(BaseModel):
    items: list[ClientFollowUpItem]
    total: int
