from __future__ import annotations

import datetime
import enum
from decimal import Decimal
from typing import Optional

from sqlalchemy import Boolean, Date, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class LedgerAccountType(str, enum.Enum):
    """Clasificación tipo QuickBooks (API/DB en inglés; UI en español)."""

    asset = "asset"
    liability = "liability"
    equity = "equity"
    income = "income"
    expense = "expense"
    cost_of_sales = "cost_of_sales"


class Account(Base):
    """
    Cuenta del plan contable.
    ``code`` clave interna única; ``account_number`` número visible opcional.
    """

    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(40), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    account_number: Mapped[Optional[str]] = mapped_column(String(40), nullable=True, index=True)

    account_type: Mapped[str] = mapped_column(String(32), nullable=False, default=LedgerAccountType.income.value)
    detail_type: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    #: Nombre del método de pago (tabla ``payment_methods``) cuando la cuenta es efectivo equivalente vinculado.
    linked_payment_method: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    #: Pasarela / método de pago vinculado (FK ``payment_methods.id``) para cuentas ACTIVOS de cobro.
    linked_wallet_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("payment_methods.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey("accounts.id"), nullable=True, index=True)

    currency: Mapped[str] = mapped_column(String(10), nullable=False, default="USD")
    opening_balance: Mapped[Optional[Decimal]] = mapped_column(Numeric(18, 4), nullable=True)
    opening_balance_date: Mapped[Optional[datetime.date]] = mapped_column(Date, nullable=True)
    current_balance: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=0)
    balance: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    parent: Mapped[Optional["Account"]] = relationship(
        "Account",
        remote_side="Account.id",
        foreign_keys=[parent_id],
        back_populates="children",
    )
    children: Mapped[list["Account"]] = relationship(
        "Account",
        foreign_keys=[parent_id],
        back_populates="parent",
    )

    transactions: Mapped[list["Transaction"]] = relationship(
        back_populates="account",
        foreign_keys="Transaction.account_id",
    )
    journal_lines: Mapped[list["JournalEntryLine"]] = relationship(
        "JournalEntryLine",
        foreign_keys="JournalEntryLine.account_id",
        back_populates="account",
    )
