from __future__ import annotations

import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id"), nullable=False, index=True)
    occurred_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
    )

    related_account_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    description: Mapped[Optional[str]] = mapped_column(String(255))

    # Regla multimoneda requerida.
    monto_original: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    moneda_original: Mapped[str] = mapped_column(String(10), nullable=False)
    tasa_cambio_del_dia: Mapped[Decimal] = mapped_column(Numeric(18, 6), nullable=False)
    monto_convertido_a_base: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)

    account: Mapped["Account"] = relationship(
        back_populates="transactions",
        foreign_keys=[account_id],
    )
