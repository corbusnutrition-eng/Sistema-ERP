"""Model for generic client debt payments (CxC abonos)."""
from __future__ import annotations

import enum
from decimal import Decimal
from typing import TYPE_CHECKING, Optional

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

if TYPE_CHECKING:
    from app.models.client import Client


class DebtPaymentStatus(str, enum.Enum):
    pending_review = "pending_review"
    approved = "approved"
    rejected = "rejected"


class ClientDebtPayment(Base):
    __tablename__ = "client_debt_payments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    client_id: Mapped[int] = mapped_column(Integer, ForeignKey("clients.id"), nullable=False, index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    currency: Mapped[str] = mapped_column(String(10), nullable=False, default="USD")
    receipt_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    payment_method_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("payment_methods.id", ondelete="SET NULL"), nullable=True
    )
    deposit_account_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[DebtPaymentStatus] = mapped_column(
        Enum(DebtPaymentStatus, name="debt_payment_status_enum"),
        nullable=False,
        default=DebtPaymentStatus.pending_review,
    )
    notes: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    created_at: Mapped[Optional[object]] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_at: Mapped[Optional[object]] = mapped_column(DateTime(timezone=True), nullable=True)

    client: Mapped["Client"] = relationship("Client", back_populates="debt_payments", lazy="select")
