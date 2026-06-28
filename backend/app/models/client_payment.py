"""Pagos de cliente (CxC) separados de facturas — estilo QuickBooks."""
from __future__ import annotations

import enum
from decimal import Decimal
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Boolean, DateTime, Enum, Float, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

if TYPE_CHECKING:
    from app.models.client import Client
    from app.models.sale import Sale
    from app.models.wallet_recharge_request import WalletRechargeRequest


class ClientPaymentStatus(str, enum.Enum):
    pending_review = "pending_review"
    approved = "approved"
    rejected = "rejected"


class ClientPayment(Base):
    __tablename__ = "client_payments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    payment_number: Mapped[str] = mapped_column(String(32), nullable=False, unique=True, index=True)
    client_id: Mapped[int] = mapped_column(Integer, ForeignKey("clients.id"), nullable=False, index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    currency: Mapped[str] = mapped_column(String(10), nullable=False, default="USD")
    #: Unidades de moneda local por 1 USD (consolidación P&L / libro mayor).
    exchange_rate: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    status: Mapped[ClientPaymentStatus] = mapped_column(
        Enum(ClientPaymentStatus, name="client_payment_status_enum"),
        nullable=False,
        default=ClientPaymentStatus.pending_review,
    )
    payment_method_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("payment_methods.id", ondelete="SET NULL"), nullable=True
    )
    payment_method: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    reference_number: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    receipt_file_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    deposit_account_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_manually_edited: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    ai_confidence_score: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, default=100)
    created_at: Mapped[Optional[object]] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_at: Mapped[Optional[object]] = mapped_column(DateTime(timezone=True), nullable=True)

    client: Mapped["Client"] = relationship("Client", back_populates="client_payments", lazy="select")
    allocations: Mapped[list["PaymentAllocation"]] = relationship(
        "PaymentAllocation",
        back_populates="payment",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class PaymentAllocation(Base):
    """Vincula un pago a una o más obligaciones CxC (venta o recarga BaaS)."""

    __tablename__ = "payment_allocations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    payment_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("client_payments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sale_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("sales.id", ondelete="CASCADE"), nullable=True, index=True
    )
    wallet_recharge_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("wallet_recharge_requests.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    amount_applied: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)

    payment: Mapped["ClientPayment"] = relationship("ClientPayment", back_populates="allocations")
    sale: Mapped[Optional["Sale"]] = relationship("Sale", lazy="select")
    wallet_recharge: Mapped[Optional["WalletRechargeRequest"]] = relationship(
        "WalletRechargeRequest", lazy="select"
    )
