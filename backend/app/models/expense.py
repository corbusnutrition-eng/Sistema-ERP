from __future__ import annotations

import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Optional

from sqlalchemy import Date, DateTime, ForeignKey, Numeric, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

if TYPE_CHECKING:
    from app.models.account import Account
    from app.models.client import Client
    from app.models.transaction_class import TransactionClass
    from app.models.user import User


class Expense(Base):
    """Gasto tipo QuickBooks (cabecera): pago desde cuenta + líneas de categoría."""

    __tablename__ = "expenses"

    id: Mapped[int] = mapped_column(primary_key=True)
    payee_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    payment_account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    payment_date: Mapped[datetime.date] = mapped_column(Date, nullable=False, index=True)
    payment_method: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    reference_number: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    memo: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    subtotal_amount: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    tax_amount: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, server_default="0")
    total_amount: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)

    #: ``posted`` | ``voided``
    status: Mapped[str] = mapped_column(String(20), nullable=False, server_default="posted", index=True)

    attachments_json: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))

    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    payee: Mapped["User"] = relationship()
    payment_account: Mapped["Account"] = relationship(foreign_keys=[payment_account_id])
    lines: Mapped[list["ExpenseLine"]] = relationship(
        back_populates="expense",
        cascade="all, delete-orphan",
        order_by="ExpenseLine.line_no",
    )


class ExpenseLine(Base):
    __tablename__ = "expense_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    expense_id: Mapped[int] = mapped_column(ForeignKey("expenses.id", ondelete="CASCADE"), nullable=False, index=True)
    expense_account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    customer_id: Mapped[Optional[int]] = mapped_column(ForeignKey("clients.id", ondelete="SET NULL"), nullable=True)
    class_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("transaction_classes.id", ondelete="SET NULL"),
        nullable=True,
    )
    line_no: Mapped[int] = mapped_column(default=0, nullable=False)

    expense: Mapped["Expense"] = relationship(back_populates="lines")
    expense_account: Mapped["Account"] = relationship(foreign_keys=[expense_account_id])
    customer: Mapped[Optional["Client"]] = relationship()
    klass: Mapped[Optional["TransactionClass"]] = relationship()
