"""Cuentas por pagar — proveedores, facturas y pagos tipo QuickBooks."""

from __future__ import annotations

import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

if TYPE_CHECKING:
    from app.models.account import Account


class Vendor(Base):
    __tablename__ = "vendors"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    company_name: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(254), nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    address: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    currency: Mapped[str] = mapped_column(String(10), nullable=False, server_default="USD")
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    bills: Mapped[list["VendorBill"]] = relationship(back_populates="vendor")
    payments: Mapped[list["VendorPayment"]] = relationship(back_populates="vendor")


class VendorBill(Base):
    __tablename__ = "vendor_bills"

    id: Mapped[int] = mapped_column(primary_key=True)
    vendor_id: Mapped[int] = mapped_column(ForeignKey("vendors.id", ondelete="CASCADE"), nullable=False, index=True)
    bill_number: Mapped[Optional[str]] = mapped_column(String(80), nullable=True, index=True)
    bill_date: Mapped[datetime.date] = mapped_column(Date, nullable=False, index=True)
    due_date: Mapped[Optional[datetime.date]] = mapped_column(Date, nullable=True, index=True)
    terms: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    memo: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    total_amount: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    balance_due: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    #: Abierta | Parcial | Pagada
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="Abierta", index=True)

    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    vendor: Mapped["Vendor"] = relationship(back_populates="bills")
    lines: Mapped[list["VendorBillLine"]] = relationship(
        back_populates="bill",
        cascade="all, delete-orphan",
    )
    payment_allocations: Mapped[list["VendorPaymentLine"]] = relationship(back_populates="bill")

    __table_args__ = (UniqueConstraint("vendor_id", "bill_number", name="uq_vendor_bills_vendor_number"),)


class VendorBillLine(Base):
    __tablename__ = "vendor_bill_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    bill_id: Mapped[int] = mapped_column(ForeignKey("vendor_bills.id", ondelete="CASCADE"), nullable=False, index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    line_no: Mapped[int] = mapped_column(nullable=False, server_default="0")

    bill: Mapped["VendorBill"] = relationship(back_populates="lines")
    account: Mapped["Account"] = relationship(foreign_keys=[account_id])


class VendorPayment(Base):
    __tablename__ = "vendor_payments"

    id: Mapped[int] = mapped_column(primary_key=True)
    vendor_id: Mapped[int] = mapped_column(ForeignKey("vendors.id", ondelete="CASCADE"), nullable=False, index=True)
    payment_account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    payment_date: Mapped[datetime.date] = mapped_column(Date, nullable=False, index=True)
    reference_number: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    memo: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    total_amount: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)

    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    vendor: Mapped["Vendor"] = relationship(back_populates="payments")
    payment_account: Mapped["Account"] = relationship(foreign_keys=[payment_account_id])
    lines: Mapped[list["VendorPaymentLine"]] = relationship(
        back_populates="payment",
        cascade="all, delete-orphan",
    )


class VendorPaymentLine(Base):
    __tablename__ = "vendor_payment_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    payment_id: Mapped[int] = mapped_column(ForeignKey("vendor_payments.id", ondelete="CASCADE"), nullable=False, index=True)
    bill_id: Mapped[int] = mapped_column(ForeignKey("vendor_bills.id", ondelete="CASCADE"), nullable=False, index=True)
    amount_applied: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)

    payment: Mapped["VendorPayment"] = relationship(back_populates="lines")
    bill: Mapped["VendorBill"] = relationship(back_populates="payment_allocations")
