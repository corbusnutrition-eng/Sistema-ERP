"""Consumo de créditos Recarga Total al generar pantallas en bodega (despiece por lote)."""

from __future__ import annotations

import datetime

from typing import Optional

from sqlalchemy import DateTime, Float, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.timezone_utils import now_ecuador


class InventoryScreenCreditDrawdown(Base):
    """
    Cada registro representa los «paquetes» de Recarga Total consumidos al crear
    un lote de ScreenStock (Cantidad del formulario de bodega).
    """

    __tablename__ = "inventory_screen_credit_drawdown"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    provider: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    credits_units: Mapped[float] = mapped_column(
        Float,
        nullable=False,
        comment="Unidades descontadas del pool (típicamente = cantidad de paquetes comprados)",
    )
    batch_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    sale_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("sales.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
        comment="Si aplica: venta por créditos mayorista que consumió el pool",
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=now_ecuador,
    )
