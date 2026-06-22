from __future__ import annotations

import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.timezone_utils import now_ecuador

if TYPE_CHECKING:
    from app.models.client import Client
    from app.models.sale import Sale

SCREEN_STATUSES = ("free", "reserved", "assigned")


class ScreenStock(Base):
    """
    Represents one individual screen unit in the bodega.
    A single recharge creates N independent ScreenStock rows,
    each ready to be sold to a different client.
    """

    __tablename__ = "screen_stock"

    id: Mapped[int] = mapped_column(primary_key=True)

    # Purchase info
    provider: Mapped[str] = mapped_column(String(50), nullable=False, comment="Flujo o Stella")
    package: Mapped[str] = mapped_column(String(120), nullable=False, comment="Paquete: '1 mes', '3 meses', etc.")
    expiration_date: Mapped[Optional[datetime.date]] = mapped_column(Date, nullable=True)

    #: Credenciales del panel IPTV asociadas a esta unidad de bodega (nullable por registros previos).
    iptv_username: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    iptv_password: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    # State
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="free", server_default="free",
        comment="'free' = disponible, 'reserved' = reservada (preventa / venta pendiente), "
        "'assigned' = confirmada",
    )

    # Cost reference
    cost_per_package: Mapped[Optional[float]] = mapped_column(
        Float, nullable=True, comment="Costo del paquete en USD"
    )

    # Batch traceability — all screens from the same form submission share a batch_id
    batch_id: Mapped[str] = mapped_column(
        String(36), nullable=False, index=True,
        comment="UUID del lote de compra al que pertenece esta pantalla"
    )
    batch_size: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1,
        comment="Cuántas pantallas tenía el lote original"
    )

    #: Producto catálogo al que pertenece esta unidad (crédito por pantalla); NULL = legado o carga sin producto.
    product_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("products.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    sale_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey(
            "sales.id",
            ondelete="SET NULL",
            name="fk_screen_stock_sale_id",
            use_alter=True,
        ),
        nullable=True,
        index=True,
        comment="Venta que reservó o asignó esta pantalla",
    )

    client_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("clients.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        server_default=func.now(),
        default=now_ecuador,
    )

    sale: Mapped[Optional["Sale"]] = relationship(
        "Sale",
        foreign_keys=[sale_id],
        lazy="select",
        viewonly=True,
        post_update=True,
    )
    assigned_client: Mapped[Optional["Client"]] = relationship(
        "Client",
        foreign_keys=[client_id],
        lazy="select",
    )
    catalog_product: Mapped[Optional["Product"]] = relationship(
        "Product",
        foreign_keys=[product_id],
        viewonly=True,
    )
