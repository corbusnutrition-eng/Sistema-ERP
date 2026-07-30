from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.timezone_utils import now_ecuador


class ExchangeRate(Base):
    """Tasa USDT/fiat desde Binance P2P con override manual opcional."""

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
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=now_ecuador,
    )
