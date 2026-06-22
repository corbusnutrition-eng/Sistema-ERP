from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from sqlalchemy import Float, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

if TYPE_CHECKING:
    from app.models.client import Client
    from app.models.product import Product, ProductPackageCatalog


class ClientProductPrice(Base):
    """Precio de venta personalizado por cliente y paquete Flujo (catálogo crédito por pantalla)."""

    __tablename__ = "client_product_prices"
    __table_args__ = (
        UniqueConstraint("client_id", "package_catalog_id", name="uq_client_product_price_pkg"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    product_id: Mapped[int] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    package_catalog_id: Mapped[int] = mapped_column(
        ForeignKey("product_package_catalog.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    custom_price: Mapped[float] = mapped_column(Float, nullable=False)
    #: Precio de venta en moneda del cliente (portal BaaS); si es null, se deriva de ``custom_price`` (USD).
    sale_price_local: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    price_currency: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)

    client: Mapped["Client"] = relationship()
    product: Mapped["Product"] = relationship()
    package_catalog: Mapped["ProductPackageCatalog"] = relationship()
