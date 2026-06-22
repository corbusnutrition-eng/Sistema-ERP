from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel


class NotificationType(str, Enum):
    payment_due = "payment_due"
    subscription_expiring = "subscription_expiring"
    new_sale = "new_sale"
    system = "system"


class NotificationResponse(BaseModel):
    id: int
    type: NotificationType
    title: str
    message: str
    client_id: Optional[int] = None
    client_name: Optional[str] = None
    is_read: bool = False
    created_at: datetime

    model_config = {"from_attributes": True}


class NotificationSummary(BaseModel):
    """Resumen ligero para el badge del header."""
    unread_count: int
    notifications: list[NotificationResponse]


class PendingPaymentNotificationKind(str, Enum):
    sale = "sale"
    wallet_recharge = "wallet_recharge"
    client_payment = "client_payment"


class PendingPaymentNotification(BaseModel):
    """Comprobante o pago del portal pendiente de aprobación administrativa."""

    id: int
    kind: PendingPaymentNotificationKind
    label: str
    client_id: Optional[int] = None
    client_name: str
    amount: float
    currency: str
    created_at: datetime
    path: str


class PendingPaymentsNotificationResponse(BaseModel):
    count: int
    items: list[PendingPaymentNotification]
