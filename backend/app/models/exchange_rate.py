from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.timezone_utils import now_ecuador


class ExchangeRate(Base):
    """Tasa USD/fiat de mercado con override manual opcional."""

    __tablename__ = "exchange_rates"

    currency_code: Mapped[str] = mapped_column(String(10), primary_key=True)
    binance_rate: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    manual_rate: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    use_manual_override: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="false",
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default="true",
    )
    display_order: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
    )
    tolerance_type: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    tolerance_value: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=now_ecuador,
    )
