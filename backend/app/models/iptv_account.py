from __future__ import annotations

import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Date, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

if TYPE_CHECKING:
    from app.models.product import Product

SERVICE_TYPES = ("full", "screens")


class IPTVAccount(Base):
    __tablename__ = "iptv_accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    #: Inventario «Recarga total» asociado a un producto de catálogo (opcional).
    product_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("products.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    catalog_product: Mapped[Optional["Product"]] = relationship(
        "Product",
        foreign_keys=[product_id],
        lazy="select",
        viewonly=True,
    )
    provider_name: Mapped[str] = mapped_column(String(50), nullable=False)
    panel_account_code: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    username: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    password: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    expiration_date: Mapped[Optional[datetime.date]] = mapped_column(Date, nullable=True)

    service_type: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="screens",
        server_default="screens",
        comment="'full' = Servicio Completo, 'screens' = Bodega por Pantallas",
    )
    # ── Shared ────────────────────────────────────────────────────────────────
    credits_spent: Mapped[Optional[float]] = mapped_column(
        Float, nullable=True, comment="Créditos totales comprados/invertidos"
    )
    # ── Full-service recharge fields ──────────────────────────────────────────
    cost_per_credit: Mapped[Optional[float]] = mapped_column(
        Float, nullable=True, comment="Costo por crédito en USD (solo service_type='full')"
    )
    total_cost: Mapped[Optional[float]] = mapped_column(
        Float, nullable=True, comment="Total invertido en USD = credits_spent * cost_per_credit"
    )
    recharge_date: Mapped[Optional[datetime.date]] = mapped_column(
        Date, nullable=True, comment="Fecha de cierre de recarga (solo service_type='full')"
    )

    screens: Mapped[list["IPTVScreen"]] = relationship(back_populates="iptv_account")
