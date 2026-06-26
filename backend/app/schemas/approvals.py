"""Esquemas del módulo Aprobaciones (verificación bancaria)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field


class ApprovalAccountRow(BaseModel):
    id: int
    code: Optional[str] = None
    name: str
    currency: str
    detail_type: Optional[str] = None
    linked_payment_method: Optional[str] = None
    pending_count: int = 0


class ApprovalPendingRow(BaseModel):
    """Línea de débito en cuenta bancaria pendiente de verificación."""

    transaction_id: int = Field(description="ID de journal_entry_lines")
    journal_entry_id: int
    date: date
    reference: str
    origin_type: str = Field(description="venta | recarga | pago")
    origin_label: str
    origin_id: Optional[int] = None
    client_name: Optional[str] = None
    iptv_username: Optional[str] = Field(default=None, description="Usuario IPTV del cliente que pagó.")
    amount: Decimal
    currency: str
    receipt_url: Optional[str] = None
    description: Optional[str] = None
    payment_id: Optional[int] = None
    created_at: Optional[datetime] = None


class ApprovalVerifyResponse(BaseModel):
    transaction_id: int
    is_bank_verified: bool
    verified_at: datetime


class ApprovalRejectResponse(BaseModel):
    transaction_id: int
    payment_id: int
    status: str
    rejected_at: datetime
