from __future__ import annotations

import enum
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import Boolean, Date, DateTime, Enum as SAEnum, Float, ForeignKey, Integer, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class TargetAudience(str, enum.Enum):
    cliente = "Cliente"
    revendedor = "Revendedor"


class CatalogPackageType(Base):
    """Etiquetas de tipo de paquete definidas por el usuario (+ persistencia entre sesiones)."""

    __tablename__ = "catalog_package_types"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    label: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    #: IPTV — ``credito_normal`` | ``credito_pantalla`` (UI); legado puede ser NULL hasta migración.
    product_type: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    # Tipo de paquete (texto libre + valores estándar acordados en UI).
    service_type: Mapped[str] = mapped_column(String(120), nullable=False)
    # Nombre de proveedor tal como en inventario (cuentas / bodega).
    iptv_provider: Mapped[str] = mapped_column(String(64), nullable=False)
    target_audience: Mapped[TargetAudience] = mapped_column(
        SAEnum(TargetAudience, name="target_audience_enum"),
        nullable=False,
    )
    listing_price: Mapped[float] = mapped_column(Float, nullable=False)
    listing_currency: Mapped[str] = mapped_column(String(10), nullable=False)
    screens_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    #: QuickBooks-style extras (opcionales).
    sku: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    transaction_class_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("transaction_classes.id", ondelete="SET NULL"),
        nullable=True,
    )
    inventory_opening_qty: Mapped[Optional[Decimal]] = mapped_column(Numeric(18, 4), nullable=True)
    inventory_as_of_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    #: Umbral numérico para alertas de reabastecimiento (API: decimal; UI entero).
    reorder_point: Mapped[Optional[Decimal]] = mapped_column(Numeric(18, 4), nullable=True)
    inventory_asset_account_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"),
        nullable=True,
    )
    inventory_credit_reserved_qty: Mapped[Decimal] = mapped_column(
        Numeric(18, 4),
        nullable=False,
        default=Decimal("0"),
        server_default="0",
        comment="Créditos normales (catálogo) reservados por preventas pendientes.",
    )
    inventory_credit_assigned_qty: Mapped[Decimal] = mapped_column(
        Numeric(18, 4),
        nullable=False,
        default=Decimal("0"),
        server_default="0",
        comment="Créditos normales (catálogo) consumidos al activar ventas desde ERP.",
    )

    income_account_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"),
        nullable=True,
    )
    purchase_description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    purchase_cost_usd: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    purchase_expense_account_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"),
        nullable=True,
    )
    preferred_vendor_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("vendors.id", ondelete="SET NULL"),
        nullable=True,
    )

    color: Mapped[str] = mapped_column(String(16), nullable=False, default="#6366f1")
    #: Ruta relativa servida bajo ``/uploads/...`` (ej. ``/uploads/logos/uuid.png``).
    logo_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)

    package_catalog_lines: Mapped[list["ProductPackageCatalog"]] = relationship(
        "ProductPackageCatalog",
        back_populates="product",
        cascade="all, delete-orphan",
        primaryjoin="Product.id == foreign(ProductPackageCatalog.product_id)",
        foreign_keys="ProductPackageCatalog.product_id",
    )


class ProductPackageCatalog(Base):
    """Catálogo de paquetes ofrecidos por un producto «crédito por pantalla» (precio/costo referencial + pantallas)."""

    __tablename__ = "product_package_catalog"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    product_id: Mapped[int] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    package_label: Mapped[str] = mapped_column(String(120), nullable=False)
    reference_cost_usd: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    #: Precio de venta referencial por paquete (USD).
    listing_price_usd: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    screens_per_package: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Cantidad inicial de paquetes en bodega (se expande a pantallas al crear ScreenStock).
    opening_inventory_qty: Mapped[Optional[Decimal]] = mapped_column(Numeric(18, 4), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    product: Mapped["Product"] = relationship("Product", back_populates="package_catalog_lines")
