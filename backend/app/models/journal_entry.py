from __future__ import annotations

import datetime
import enum
from decimal import Decimal
from typing import Optional

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class JournalReferenceType(str, enum.Enum):
    """Origen del asiento contable."""

    venta = "venta"
    venta_cogs = "venta_cogs"
    recarga = "recarga"
    tarifa = "tarifa"
    ajuste_fx = "ajuste_fx"
    gasto = "gasto"
    ingreso = "ingreso"
    vendor_bill = "vendor_bill"
    vendor_payment = "vendor_payment"
    client_payment = "client_payment"
    reversal = "reversal"


class JournalEntry(Base):
    """Asiento contable (cabecera)."""

    __tablename__ = "journal_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    date: Mapped[datetime.date] = mapped_column(Date, nullable=False, index=True)
    reference_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    reference_id: Mapped[Optional[int]] = mapped_column(nullable=True, index=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    lines: Mapped[list["JournalEntryLine"]] = relationship(
        back_populates="journal_entry",
        cascade="all, delete-orphan",
    )


class JournalEntryLine(Base):
    """Línea de asiento (partida doble: débito / crédito)."""

    __tablename__ = "journal_entry_lines"

    id: Mapped[int] = mapped_column(primary_key=True)
    journal_entry_id: Mapped[int] = mapped_column(
        ForeignKey("journal_entries.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    account_id: Mapped[int] = mapped_column(
        ForeignKey("accounts.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    debit: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=0)
    credit: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=0)
    exchange_rate: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False, default=1)
    #: Conciliación bancaria (módulo Aprobaciones): el dueño confirmó el ingreso en el banco.
    is_bank_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")

    journal_entry: Mapped["JournalEntry"] = relationship(back_populates="lines")
    account: Mapped["Account"] = relationship(
        "Account",
        foreign_keys=[account_id],
        back_populates="journal_lines",
    )
