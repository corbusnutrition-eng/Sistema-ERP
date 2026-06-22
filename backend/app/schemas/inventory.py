from __future__ import annotations

import datetime
from typing import Literal, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator


# ── Legacy IPTVAccount (Servicio Completo) ────────────────────────────────────

class AccountCreate(BaseModel):
    provider: str = Field(..., min_length=1, max_length=64)
    service_type: Literal["full"] = Field(default="full")
    product_id: Optional[int] = Field(default=None, ge=1)

    credits_spent: Optional[float] = Field(default=None, ge=0)
    cost_per_credit: Optional[float] = Field(default=None, ge=0)
    total_cost: Optional[float] = Field(default=None, ge=0)
    recharge_date: Optional[datetime.date] = None
    expiration_date: Optional[datetime.date] = None
    username: Optional[str] = Field(default=None, max_length=120)
    password: Optional[str] = Field(default=None, max_length=255)

    #: Factura de proveedor automática (misma transacción que la recarga).
    vendor_id: Optional[int] = Field(default=None, ge=1)
    inventory_asset_account_id: Optional[int] = Field(default=None, ge=1)
    vendor_bill_number: Optional[str] = Field(default=None, max_length=80)
    vendor_bill_date: Optional[datetime.date] = None
    vendor_bill_due_date: Optional[datetime.date] = None
    vendor_bill_terms: Optional[str] = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _vendor_bill_consistency(self) -> AccountCreate:
        if self.vendor_id is not None and self.inventory_asset_account_id is None:
            raise ValueError("Indica la cuenta de activos de inventario al elegir proveedor.")
        return self


class ScreenSummary(BaseModel):
    id: int
    screen_number: int
    is_available: bool

    model_config = {"from_attributes": True}


class AccountResponse(BaseModel):
    id: int
    provider_name: str
    service_type: str
    product_id: Optional[int] = None
    #: Datos del producto catálogo (crédito normal / pantalla); null si legado sin FK.
    product_name: Optional[str] = Field(default=None, max_length=200)
    product_color: Optional[str] = Field(default=None, max_length=16)
    username: Optional[str]
    expiration_date: Optional[datetime.date]
    credits_spent: Optional[float]
    cost_per_credit: Optional[float]
    total_cost: Optional[float]
    recharge_date: Optional[datetime.date]
    total_screens: int
    available_screens: int
    screens: list[ScreenSummary]

    model_config = {"from_attributes": True}


# ── New ScreenStock (Bodega por Pantallas) ────────────────────────────────────

class ScreenLineCredentialItem(BaseModel):
    """Credenciales IPTV por unidad de ``quantity`` (un lote = un índice)."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    username: Optional[str] = Field(
        default=None,
        max_length=120,
        validation_alias=AliasChoices("username", "usuario"),
    )
    password: Optional[str] = Field(
        default=None,
        max_length=255,
        validation_alias=AliasChoices("password", "contrasena", "contraseña"),
    )

    @field_validator("username", "password", mode="before")
    @classmethod
    def _strip_cred(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v


class ScreenLineItem(BaseModel):
    """Una línea de compra: un tipo de paquete con su cantidad y costo."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    package: str = Field(..., min_length=1, max_length=120)
    quantity: int = Field(..., ge=1, le=200, description="Número de paquetes comprados")
    cost_per_package: Optional[float] = Field(default=None, ge=0)
    screens_count: int = Field(..., ge=1, le=20, description="Pantallas por paquete (calculado en frontend)")
    #: Legado: misma credencial para cada lote si no se usa ``credentials``.
    iptv_username: Optional[str] = Field(default=None, max_length=120)
    iptv_password: Optional[str] = Field(default=None, max_length=255)
    credentials: Optional[list[ScreenLineCredentialItem]] = Field(
        default=None,
        max_length=200,
        description="Opcional: entrada por cada unidad (índice alinea con orden del bucle quantity).",
    )
    #: Si el paquete se eligió del catálogo UI; si falta o es inválido, se trata como manual y se hace upsert por nombre.
    package_catalog_id: Optional[int] = Field(default=None, ge=1)

    @field_validator("package", mode="before")
    @classmethod
    def _strip_pkg(cls, v: object) -> object:
        if isinstance(v, str):
            return v.strip()
        return v

    @field_validator("iptv_username", "iptv_password", mode="before")
    @classmethod
    def _strip_legacy_iptv(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v

    @model_validator(mode="after")
    def _credentials_not_longer_than_qty(self) -> "ScreenLineItem":
        creds = self.credentials
        if creds is not None and len(creds) > int(self.quantity):
            raise ValueError("credentials no puede tener más elementos que quantity.")
        return self


class ScreenStockBulkCreate(BaseModel):
    """Creación de pantallas en bodega desde múltiples líneas de compra."""
    provider: str = Field(..., min_length=1, max_length=64)
    product_id: Optional[int] = Field(default=None, ge=1)
    expiration_date: Optional[datetime.date] = None
    lines: list[ScreenLineItem] = Field(..., min_length=1, max_length=20)

    @field_validator("provider", mode="before")
    @classmethod
    def _strip_provider(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v


# ── Inventory stats (per-provider dashboard) ─────────────────────────────────

class ProviderStats(BaseModel):
    total_recharged_month: float = 0.0  # credits loaded this calendar month
    total_available: float = 0.0        # total credits loaded − consumed
    total_consumed: float = 0.0         # credits consumed (placeholder for sales link)
    total_cost: float = 0.0             # total USD invested (full-service + screens)
    screens_free: int = 0               # individual screens currently free
    screens_assigned: int = 0           # individual screens currently assigned


class InventoryStatsResponse(BaseModel):
    providers: dict[str, ProviderStats]
    global_total_cost: float = 0.0


class CatalogFullCreditsRow(BaseModel):
    product_id: int
    available_credits: float


class ScreenFifoCredentialsPeek(BaseModel):
    """Vista previa de credenciales de la siguiente unidad FIFO (solo lectura; no reserva)."""

    screen_stock_id: Optional[int] = Field(
        default=None,
        ge=1,
        description="ID de la fila `screen_stock` en cabeza FIFO (informativo).",
    )
    iptv_username: Optional[str] = Field(default=None, max_length=120)
    iptv_password: Optional[str] = Field(default=None, max_length=255)


class ScreenStockNextForSale(BaseModel):
    """Primera unidad FIFO en bodega para ese paquete (GET /inventory/available)."""

    id: int
    iptv_username: Optional[str] = Field(default=None, max_length=120)
    iptv_password: Optional[str] = Field(default=None, max_length=255)


class ScreenAvailabilityRow(BaseModel):
    """Pantallas en bodega libres, agrupadas por paquete y lote (ventas / modal nueva venta)."""
    package: str
    batch_id: str = Field(..., max_length=36, description="UUID del lote de compra (FIFO dentro del lote).")
    count: int
    status: str = "Disponible"
    next_screen: Optional[ScreenStockNextForSale] = Field(
        default=None,
        description="Unidad más antigua (FIFO) disponible para este paquete: credenciales IPTV.",
    )


class InventoryAvailableResponse(BaseModel):
    """Saldo Recarga Total y pantallas disponibles por proveedor (usa JWT usuario autenticado)."""
    provider: str
    total_credits: float
    screens: list[ScreenAvailabilityRow]


class SalesInvNormalCreditOption(BaseModel):
    """Producto crédito normal con saldo disponible (GET /inventory/sales-options)."""

    option_key: str = Field(..., description="Identificador estable para el select (cn:{product_id}).")
    product_id: int = Field(..., ge=1)
    product_name: str
    iptv_provider: str
    available_credits: float = Field(..., ge=0)
    disabled: bool = Field(
        ...,
        description="True si no hay saldo vendible (el front debe bloquear la selección).",
    )
    label: str = Field(..., description="Texto exacto mostrado: Nombre (Stock: X).")
    reference_price: Optional[float] = Field(
        default=None,
        description="Precio de lista del producto (sugerencia de tarifa en UI).",
    )
    reference_currency: Optional[str] = Field(default=None, max_length=10)


class SalesInvScreenPackageOption(BaseModel):
    """Bodega por pantalla agrupada por producto + paquete (solo filas libres sin venta)."""

    option_key: str = Field(..., description="Clave estable (prefijo cp|…).")
    product_id: Optional[int] = Field(default=None, description="NULL en stock legado sin product_id.")
    product_name: str = Field(..., description="Nombre de catálogo o etiqueta legado.")
    package_label: str
    iptv_provider: str
    available_screens: int = Field(..., ge=0)
    disabled: bool = Field(..., description="True si pantallas disponibles <= 0.")
    label: str = Field(..., description="Ej. Producto - Paquete (Stock: 2)")
    reference_cost_usd: Optional[float] = Field(
        default=None,
        description="Costo unitario de referencia del paquete (catálogo o promedio en bodega).",
    )


class SalesInvScreenPickOption(BaseModel):
    """Unidad concreta (edición): pantalla ya vinculada a la venta o fila puntual."""

    option_key: str = Field(..., description="ss:{screen_stock_id}")
    screen_stock_id: int = Field(..., ge=1)
    package_label: str
    iptv_provider: str
    product_id: Optional[int] = Field(default=None)
    label: str
    disabled: bool = False
    reference_cost_usd: Optional[float] = Field(
        default=None,
        description="Costo unitario de la pantalla en bodega (o referencia de catálogo).",
    )


class SalesInventoryOptionsResponse(BaseModel):
    """Opciones de inventario para el modal Nueva venta (dos categorías QB + picks de edición)."""

    normal_credit_options: list[SalesInvNormalCreditOption]
    screen_package_options: list[SalesInvScreenPackageOption]
    screen_pick_options: list[SalesInvScreenPickOption] = Field(
        default_factory=list,
        description="Solo cuando sale_id permite re-elegir la misma pantalla ligada.",
    )


class ScreenStockResponse(BaseModel):
    id: int
    provider: str
    package: str
    status: str
    expiration_date: Optional[datetime.date]
    cost_per_package: Optional[float]
    batch_id: str
    batch_size: int
    sale_id: Optional[int] = None
    product_id: Optional[int] = Field(default=None, ge=1)
    product_name: Optional[str] = Field(default=None, max_length=200)
    product_color: Optional[str] = Field(default=None, max_length=16)
    iptv_username: Optional[str] = Field(default=None, max_length=120)
    iptv_password: Optional[str] = Field(default=None, max_length=255)
    assigned_client_name: Optional[str] = Field(
        default=None,
        description="Cliente de la venta activada (approved) ligada por sale_id.",
    )
    created_at: datetime.datetime

    model_config = {"from_attributes": True}
