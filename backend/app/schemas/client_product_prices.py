from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


FLUJO_PROVIDER_NAME = "Flujo"


class ClientProductPriceItem(BaseModel):
    product_id: int = Field(..., ge=1)
    package_catalog_id: int = Field(..., ge=1)
    custom_price: float = Field(..., gt=0, description="Precio en USD (contabilidad / piso legacy).")
    local_price: Optional[float] = Field(
        default=None,
        gt=0,
        description="Precio de venta en moneda del cliente (portal BaaS).",
    )
    price_currency: Optional[str] = Field(
        default=None,
        max_length=10,
        description="Moneda de ``local_price`` (ej. BOB).",
    )


class FlujoPackageForPricing(BaseModel):
    package_catalog_id: int
    product_id: int
    product_name: str
    package_label: str
    display_name: str = Field(description="Etiqueta visible, ej. «Flujo 1 mes».")
    reference_cost_usd: float = Field(description="Costo base del paquete en inventario (USD).")
    free_stock: int = Field(description="Pantallas libres en bodega para este paquete Flujo.")


# Alias retrocompatible con el endpoint admin existente.
ScreenCatalogProductForPricing = FlujoPackageForPricing


class PortalAssignedPackagePrice(BaseModel):
    package_catalog_id: int
    product_id: int
    precio_venta_local: float
    currency: str = "USD"
    reference_cost_usd: Optional[float] = Field(
        default=None,
        description="Costo base catálogo (USD); sólo referencia.",
    )


class PortalAutoPurchaseProduct(BaseModel):
    package_catalog_id: int
    product_id: int
    name: str
    package_label: str
    custom_price: Optional[float] = Field(
        default=None,
        description="Precio en USD; null si el cliente no tiene precio asignado.",
    )
    precio_venta_local: Optional[float] = Field(
        default=None,
        description="Precio de venta asignado al cliente en su moneda base; null si no hay asignación.",
    )
    reference_cost_usd: Optional[float] = Field(
        default=None,
        description="Costo base del catálogo (USD); no usar como precio de venta.",
    )
    free_stock: int
    currency: str = "USD"


class AdminClientAssignedPackagePrice(BaseModel):
    """Precio ya asignado a un cliente (sin datos de catálogo)."""

    package_id: int = Field(..., description="``package_catalog_id`` del paquete.")
    package_catalog_id: int = Field(..., description="Alias de ``package_id``.")
    product_id: int
    sale_price_local: float
    currency: str = "USD"


class AdminClientPackagePriceRow(BaseModel):
    """Fila de matriz admin: catálogo global + precio local del cliente (si existe)."""

    package_catalog_id: int
    product_id: int
    display_name: str
    product_name: str = ""
    package_label: str = ""
    reference_cost_usd: float = 0
    free_stock: int = 0
    sale_price_local: Optional[float] = Field(
        default=None,
        description="Precio de venta en moneda del cliente; null si aún no está asignado.",
    )


class AdminClientPackagePriceUpsertItem(BaseModel):
    package_id: int = Field(..., ge=1, description="``package_catalog_id`` del paquete Flujo.")
    sale_price_local: float = Field(..., gt=0, description="Precio de venta en moneda del cliente.")


class AdminClientPackagePricesUpsertBody(BaseModel):
    prices: list[AdminClientPackagePriceUpsertItem] = Field(default_factory=list)


class AdminClientPackagePricesUpsertResponse(BaseModel):
    ok: bool = True
    updated: int = 0
    message: str = ""


class PortalAutoPurchaseRequest(BaseModel):
    package_catalog_id: int = Field(..., ge=1)
    quantity: int = Field(default=1, ge=1, le=200)
    end_customer_name: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Nombre del cliente final (seguimiento mini-CRM).",
    )
    end_customer_phone: Optional[str] = Field(
        default=None,
        max_length=30,
        description="Teléfono del cliente final (seguimiento mini-CRM).",
    )
    precio_venta: Optional[float] = Field(
        default=None,
        ge=0,
        description="Precio cobrado al cliente final en moneda de la billetera.",
    )


class PortalAutoPurchaseCredential(BaseModel):
    screen_stock_id: int
    iptv_username: Optional[str] = None
    iptv_password: Optional[str] = None
    username: Optional[str] = Field(
        default=None,
        description="Alias de iptv_username para el portal del cliente.",
    )
    password: Optional[str] = Field(
        default=None,
        description="Alias de iptv_password para el portal del cliente.",
    )


class PortalAutoPurchaseResponse(BaseModel):
    ok: bool = True
    flow: str = Field(description="'fulfilled' si hay stock; 'pending_assignment' si queda en revisión.")
    message: str
    sale_id: int
    wallet_balance_remaining: float
    quantity_requested: int = 1
    quantity_fulfilled: int = 0
    credentials: list[PortalAutoPurchaseCredential] = Field(default_factory=list)
    credentials_missing: bool = Field(
        default=False,
        description="True si la compra se completó pero alguna pantalla no tiene usuario/contraseña en bodega.",
    )
