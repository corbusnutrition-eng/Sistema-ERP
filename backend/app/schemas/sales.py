from __future__ import annotations

import datetime
import uuid
from decimal import Decimal
from uuid import UUID
from typing import Any, Literal, Optional

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    computed_field,
    field_validator,
    model_validator,
)

from app.currency_utils import normalize_currency_code


def _dedupe_int_ids(ids: list[int]) -> list[int]:
    return sorted({int(x) for x in ids})


def _coerce_locale_decimal(v: object) -> object:
    if v is None:
        return None
    if isinstance(v, Decimal):
        return v
    if isinstance(v, (int, float)):
        return Decimal(str(v))
    if isinstance(v, str):
        s = v.strip().replace(",", ".")
        if not s:
            return None
        return Decimal(s)
    return v


def _coerce_locale_float(v: object) -> object:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().replace(",", ".")
        if not s:
            return None
        return float(s)
    return v


class SaleInvoiceLineItem(BaseModel):
    """Una línea del detalle de factura (UI tipo QuickBooks)."""

    model_config = ConfigDict(extra="ignore")

    description: Optional[str] = Field(default=None, max_length=2000)
    qty: Optional[float] = Field(default=None, ge=0, validation_alias=AliasChoices("qty", "quantity"))
    rate: Optional[float] = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices("rate", "price", "unit_price"),
    )
    #: Subtotal línea si el cliente/API envía importe cerrado (opcional).
    amount: Optional[float] = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices("amount", "subtotal", "line_total"),
    )

    @field_validator("qty", "rate", "amount", mode="before")
    @classmethod
    def _locale_float_line(cls, v: object) -> object:
        return _coerce_locale_float(v)

    transaction_class_id: Optional[int] = Field(
        default=None,
        ge=1,
        validation_alias=AliasChoices("transaction_class_id", "clase_id"),
        description="Clase contable opcional por línea.",
    )
    iptv_username: Optional[str] = Field(
        default=None,
        max_length=120,
        validation_alias=AliasChoices("iptv_username", "iptv_usuario"),
    )
    iptv_password: Optional[str] = Field(
        default=None,
        max_length=255,
        validation_alias=AliasChoices("iptv_password", "iptv_contrasena"),
    )
    #: Origen ERP de la línea (facturas mixtas: credenciales bodega solo en ``screen_stock``).
    line_inventory_kind: Optional[Literal["full_credits", "screen_stock"]] = None
    #: Clave ERP original (cn:/fc:/cp|…/ss:) para rehidratar el modal sin ambigüedad.
    inventory_option_key: Optional[str] = Field(default=None, max_length=512)

    @field_validator("description", "iptv_username", "iptv_password", mode="before")
    @classmethod
    def _strip_opt(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v

    @field_validator("inventory_option_key", mode="before")
    @classmethod
    def _strip_inv_opt_key(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v


class SaleOperationLine(BaseModel):
    """Línea operativa enviada desde la UI (factura multilínea); define inventario + importe."""

    model_config = ConfigDict(extra="ignore")

    inventory_option_key: str = Field(
        ...,
        min_length=1,
        max_length=512,
        description="Clave de opción de inventario: cn:{id}, fc:{proveedor}, cp|..., ss:{screen_stock_id}.",
    )
    qty: float = Field(..., gt=0)
    rate: float = Field(..., ge=0)
    description: Optional[str] = Field(default=None, max_length=2000)
    product_id: Optional[int] = Field(default=None, ge=1)
    clase_id: Optional[int] = Field(
        default=None,
        ge=1,
        validation_alias=AliasChoices("clase_id", "transaction_class_id"),
    )
    iptv_username: Optional[str] = Field(
        default=None,
        max_length=120,
        validation_alias=AliasChoices("iptv_username", "iptv_usuario"),
    )
    iptv_password: Optional[str] = Field(
        default=None,
        max_length=255,
        validation_alias=AliasChoices("iptv_password", "iptv_contrasena"),
    )

    @field_validator("inventory_option_key", mode="before")
    @classmethod
    def _strip_key(cls, v: object) -> object:
        if v is None:
            return v
        return str(v).strip()

    @field_validator(
        "description",
        "iptv_username",
        "iptv_password",
        mode="before",
    )
    @classmethod
    def _strip_line_strings(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v


class SaleCreate(BaseModel):
    """Venta multimoneda enlazada a inventario:

    - ``full_credits``: deducción del pool Recarga Total al **Activar** (ledger enlazado a ``sale_id``).
    - ``screen_stock``: reserva FIFO N pantallas ``screen_stock`` (proveedor + paquete).
    """

    model_config = ConfigDict(extra="ignore")

    client_id: Optional[int] = Field(default=None, ge=1, description="ID en tabla ``clients`` (CRM).")
    user_id: Optional[int] = Field(
        default=None,
        ge=1,
        description="ID en tabla ``users`` con rol portal (cliente). Se enlaza o crea CRM automáticamente.",
    )
    catalog_render_email: Optional[EmailStr] = Field(
        default=None,
        description="Correo del catálogo VIP (lista Render). Localmente se enlaza / crea fila CRM por email.",
    )
    inventory_channel: Literal["full_credits", "screen_stock", "mixed"]
    provider: str = Field(..., min_length=1, max_length=64)
    credits_quantity: Optional[float] = Field(
        default=None,
        description="Obligatorio cuando inventory_channel es full_credits.",
    )
    package: Optional[str] = Field(
        default=None,
        max_length=120,
        description="Obligatorio cuando inventory_channel es screen_stock (paquete de bodega).",
    )
    screen_stock_id: Optional[int] = Field(
        default=None,
        ge=1,
        description="Si se indica, se asigna esa fila screen_stock libre (mismo proveedor y paquete).",
    )
    selected_screen_id: Optional[int] = Field(
        default=None,
        ge=1,
        description="Ídem screen_stock_id (modal QuickBooks): pantalla exacta en bodega; no usar FIFO.",
    )
    screen_stock_batch_id: Optional[str] = Field(
        default=None,
        max_length=36,
        description="Opcional: acota el FIFO de bodega a un lote (UUID). Solo sin screen_stock_id.",
    )
    inventory_screen_units: int = Field(
        default=1,
        ge=1,
        le=200,
        description="Solo screen_stock: número de pantallas en bodega (FIFO por fecha). Con pantalla manual debe ser 1.",
    )

    currency: str = Field(default="USD", min_length=3, max_length=10)
    exchange_rate: float = Field(default=1.0, gt=0)
    local_amount: Decimal = Field(..., gt=0, decimal_places=4)
    amount_paid: Optional[Decimal] = Field(
        default=None,
        decimal_places=4,
        description="Importe cobrado en la moneda de la venta. Omitido = pago total (= local_amount).",
    )

    @field_validator("exchange_rate", mode="before")
    @classmethod
    def _locale_float_create(cls, v: object) -> object:
        return _coerce_locale_float(v)

    @field_validator("local_amount", "amount_paid", mode="before")
    @classmethod
    def _locale_decimal_create(cls, v: object) -> object:
        return _coerce_locale_decimal(v)

    product_id: Optional[int] = None
    #: Producto catálogo del paquete ``cp|`` (bodega). En ventas ``mixed`` no coincide con ``product_id`` de créditos (cn:).
    screen_fifo_product_id: Optional[int] = Field(
        default=None,
        ge=1,
        description="Producto de catálogo para FIFO ``cp|`` (pantallas en bodega). Lo rellena el agregador de líneas.",
    )
    #: En ``mixed``: proveedor tal como figura en bodega (FIFO de ``cp|``); ``provider`` refiere a créditos (cn:/fc:).
    screen_stock_inventory_provider: Optional[str] = Field(
        default=None,
        max_length=64,
    )
    class_id: Optional[int] = Field(
        default=None,
        ge=1,
        description="Clase en cabecera (legado); con invoice_lines suele deducirse de la primera línea con clase.",
    )
    invoice_lines: Optional[list[SaleInvoiceLineItem]] = Field(
        default=None,
        description=(
            "Detalle por línea (clase, credenciales IPTV opcionales por ítem). "
            "Con líneas ERP, usar ``line_inventory_kind`` por fila (full_credits | screen_stock)."
        ),
    )
    #: Si se envía, el backend consolida inventario (mismo tipo por venta) y rellena cabecera ERP.
    lines: Optional[list[SaleOperationLine]] = Field(
        default=None,
        max_length=100,
        description="Líneas con clave de inventario; se agregan cantidades si el tipo es homogéneo.",
    )
    payment_method_id: Optional[int] = Field(default=None, ge=1)
    deposit_account_id: Optional[int] = Field(default=None, ge=1)
    #: Nombres de métodos de pago admitidos para abonos al portal (según catálogo).
    allowed_payment_methods: Optional[list[str]] = Field(default=None)
    #: Cuentas de depósito (IDs) habilitadas para pagos al portal para esta venta.
    allowed_deposit_accounts: Optional[list[int]] = Field(default=None)
    notes: Optional[str] = Field(default=None, max_length=4000)
    tag_ids: list[int] = Field(default_factory=list, description="Etiquetas de venta (tabla sale_tags).")

    amount_usd: float = Field(default=0.0)

    @model_validator(mode="after")
    def _client_xor_portal_user(self) -> "SaleCreate":
        has_c = self.client_id is not None and int(self.client_id) >= 1
        has_u = self.user_id is not None and int(self.user_id) >= 1
        em_raw = getattr(self, "catalog_render_email", None)
        has_e = em_raw is not None and bool(str(em_raw).strip())
        if sum(bool(x) for x in (has_c, has_u, has_e)) != 1:
            raise ValueError("Debe enviar exactamente uno: client_id, user_id o catalog_render_email.")
        return self

    @model_validator(mode="after")
    def _invoice_lines_max(self) -> "SaleCreate":
        if self.invoice_lines is not None and len(self.invoice_lines) > 100:
            raise ValueError("Máximo 100 líneas de factura.")
        if self.lines is not None and len(self.lines) > 100:
            raise ValueError("Máximo 100 líneas operativas.")
        return self

    @field_validator("currency", mode="before")
    @classmethod
    def _norm_currency_sale_create(cls, v: object) -> str:
        return normalize_currency_code(v) if v not in (None, "") else "USD"

    @field_validator("notes", mode="before")
    @classmethod
    def _strip_notes(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v

    @field_validator("screen_stock_inventory_provider", mode="before")
    @classmethod
    def _scr_inv_prov_trim(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v

    @field_validator("provider")
    @classmethod
    def _normalize_provider(cls, v: str) -> str:
        t = (v or "").strip()
        if not t:
            raise ValueError("Proveedor IPTV obligatorio.")
        return t

    @field_validator("package")
    @classmethod
    def _normalize_package(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        s = v.strip()
        return s if s else None

    @field_validator("allowed_payment_methods", mode="before")
    @classmethod
    def _allowed_pm_strip_create(cls, v: object) -> object:
        if v is None:
            return None
        if not isinstance(v, list):
            raise ValueError("allowed_payment_methods debe ser lista.")
        return [str(x).strip() for x in v[:40] if str(x).strip()]

    @field_validator("allowed_deposit_accounts", mode="before")
    @classmethod
    def _allowed_dep_create(cls, v: object) -> object:
        if v is None:
            return None
        if not isinstance(v, list):
            raise ValueError("allowed_deposit_accounts debe ser lista.")
        return _dedupe_int_ids([int(x) for x in v])

    @field_validator("screen_stock_batch_id", mode="before")
    @classmethod
    def _strip_batch_id_create(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v

    @model_validator(mode="after")
    def _route_and_amount(self) -> "SaleCreate":
        ch = self.inventory_channel

        if ch == "mixed":
            if self.credits_quantity is None:
                raise ValueError("Ventas mixtas: indica cantidad de créditos (líneas cn:/fc:).")
            if float(self.credits_quantity) <= 0:
                raise ValueError("La cantidad de créditos (mixta) debe ser mayor a 0.")
            if not self.package or not str(self.package).strip():
                raise ValueError("Ventas mixtas: indica paquete de pantalla (bodega).")
            if self.inventory_screen_units < 1 or self.inventory_screen_units > 200:
                raise ValueError("Ventas mixtas: unidades de pantalla entre 1 y 200.")
            if (
                self.screen_stock_id is not None
                and self.selected_screen_id is not None
            ):
                raise ValueError("Usa solo uno: screen_stock_id o selected_screen_id.")
            if self.screen_stock_id is not None and self.screen_stock_batch_id:
                raise ValueError("No combines pantalla explícita (screen_stock_id) con lote FIFO (batch).")
            if self.selected_screen_id is not None and self.screen_stock_batch_id:
                raise ValueError("No combines pantalla explícita (selected_screen_id) con lote FIFO (batch).")
            explicit = (
                self.screen_stock_id
                if self.screen_stock_id is not None
                else self.selected_screen_id
            )
            if explicit is not None and self.inventory_screen_units != 1:
                raise ValueError(
                    "Si eliges pantalla manual en venta mixta, solo puede haber 1 unidad de pantalla.",
                )
            sp = str(self.screen_stock_inventory_provider or "").strip()
            if not sp:
                raise ValueError("Ventas mixtas: indica proveedor de bodega (pantalla / FIFO).")
            self.screen_stock_inventory_provider = sp

        if ch == "full_credits":
            if self.credits_quantity is None:
                raise ValueError("Indica cantidad de créditos a vender.")
            if float(self.credits_quantity) <= 0:
                raise ValueError("La cantidad de créditos debe ser mayor a 0.")
            if self.package is not None and self.package.strip():
                raise ValueError("Las ventas por créditos no incluyen paquete de pantalla.")
            self.package = None
            if self.screen_stock_id is not None:
                raise ValueError("screen_stock_id solo aplica a ventas por pantalla (bodega).")
            if self.selected_screen_id is not None:
                raise ValueError("selected_screen_id solo aplica a ventas por pantalla (bodega).")
            if self.screen_stock_batch_id:
                raise ValueError("screen_stock_batch_id solo aplica a ventas por pantalla (bodega).")
            self.inventory_screen_units = 1

        if ch == "screen_stock":
            if not self.package or not self.package.strip():
                raise ValueError("Selecciona un paquete de pantalla (bodega).")
            self.credits_quantity = None
            if (
                self.screen_stock_id is not None
                and self.selected_screen_id is not None
            ):
                raise ValueError("Usa solo uno: screen_stock_id o selected_screen_id.")
            if self.screen_stock_id is not None and self.screen_stock_batch_id:
                raise ValueError("No combines pantalla explícita (screen_stock_id) con lote FIFO (screen_stock_batch_id).")
            if self.selected_screen_id is not None and self.screen_stock_batch_id:
                raise ValueError("No combines pantalla explícita (selected_screen_id) con lote FIFO (screen_stock_batch_id).")
            explicit = (
                self.screen_stock_id
                if self.screen_stock_id is not None
                else self.selected_screen_id
            )
            if explicit is not None and self.inventory_screen_units != 1:
                raise ValueError("Si eliges una pantalla manualmente solo puede haber 1 unidad.")

        if ch != "mixed":
            self.screen_stock_inventory_provider = None

        self.amount_usd = round(float(self.local_amount) / float(self.exchange_rate), 4)
        if self.amount_paid is not None and self.amount_paid > self.local_amount:
            raise ValueError("El importe pagado no puede superar el monto de cobro.")
        return self

    @field_validator("tag_ids", mode="before")
    @classmethod
    def _sale_tag_ids_create(cls, v: object) -> object:
        if v is None:
            return []
        if isinstance(v, list):
            return _dedupe_int_ids([int(x) for x in v])
        return v


class WebhookSimulatePayload(BaseModel):
    payment_link_id: uuid.UUID
    amount: Decimal = Field(default=Decimal("10.00"), gt=0)
    currency: str = Field(default="USD", min_length=3, max_length=10)

    @field_validator("currency", mode="before")
    @classmethod
    def _norm_currency_webhook(cls, v: object) -> str:
        return normalize_currency_code(v) if v not in (None, "") else "USD"


class WebhookSimulateResponse(BaseModel):
    success: bool
    message: str
    sale_id: Optional[int] = None
    provider: Optional[str] = None


class ScreenCredential(BaseModel):
    screen_id: int
    screen_number: int
    account_username: str
    account_password: str
    provider: str


class ScreenStockSaleCredential(BaseModel):
    """Credenciales reales por fila FIFO de bodega (detalle multimoneda pantalla por pantalla)."""

    screen_stock_id: int
    iptv_username: Optional[str] = None
    iptv_password: Optional[str] = None


class PublicSaleReport(BaseModel):
    """Payload que envía el cliente desde la página pública para reportar un pago manual."""
    amount: Decimal = Field(default=Decimal("10.00"), gt=0)
    currency: str = Field(default="USD", min_length=3, max_length=10)
    receipt_url: Optional[str] = None

    @field_validator("currency", mode="before")
    @classmethod
    def _norm_currency_public_report(cls, v: object) -> str:
        return normalize_currency_code(v) if v not in (None, "") else "USD"


class SaleUpdate(BaseModel):
    """Actualización de venta pendiente desde el panel (campos opcionales)."""

    client_id: Optional[int] = Field(default=None, ge=1)
    inventory_channel: Optional[Literal["full_credits", "screen_stock", "mixed"]] = None
    provider: Optional[str] = Field(default=None, max_length=64)
    package: Optional[str] = Field(default=None, max_length=120)
    credits_quantity: Optional[float] = None
    screen_stock_id: Optional[int] = Field(default=None, ge=1)
    selected_screen_id: Optional[int] = Field(
        default=None,
        ge=1,
        description="Pantalla exacta en bodega (misma semántica que screen_stock_id en PATCH).",
    )
    screen_stock_batch_id: Optional[str] = Field(
        default=None,
        max_length=36,
        description="Acota la reserva FIFO a un lote de bodega al cambiar paquete/proveedor sin pantalla explícita.",
    )
    inventory_screen_units: Optional[int] = Field(default=None, ge=1, le=200)
    status: Optional[Literal["pending", "cancelled", "annulled"]] = Field(
        default=None,
        description="Pendiente: cancelar sin activar (cancelled); activada: anular con annulled o cancelled (mapeado a annulled).",
    )
    product_id: Optional[int] = None
    class_id: Optional[int] = None
    payment_method_id: Optional[int] = None
    deposit_account_id: Optional[int] = None
    allowed_payment_methods: Optional[list[str]] = None
    allowed_deposit_accounts: Optional[list[int]] = None
    currency: Optional[str] = Field(default=None, min_length=3, max_length=10)
    exchange_rate: Optional[float] = Field(default=None, gt=0)
    local_amount: Optional[Decimal] = Field(default=None, gt=0, decimal_places=4)
    amount_paid: Optional[Decimal] = Field(
        default=None,
        decimal_places=4,
        description="Importe cobrado en moneda de venta. Omitido en PATCH no altera el valor guardado.",
    )
    notes: Optional[str] = Field(default=None, max_length=4000)
    receipt_clear: Optional[bool] = Field(
        default=None,
        description="Si es True, elimina el comprobante adjunto existente (PATCH JSON o multipart).",
    )
    tag_ids: Optional[list[int]] = Field(
        default=None,
        description="Si se envía, reemplaza las etiquetas de la venta (lista vacía = quitar todas).",
    )
    invoice_lines: Optional[list[SaleInvoiceLineItem]] = Field(
        default=None,
        description="Detalle por línea (clase y credenciales opcionales por ítem). Reemplaza el JSON guardado.",
    )
    created_at: Optional[datetime.datetime] = Field(
        default=None,
        description="Ajuste de fecha del movimiento para libro mayor (ventas ya activadas).",
    )

    @field_validator("notes", mode="before")
    @classmethod
    def _strip_notes_patch(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v

    @field_validator("tag_ids", mode="before")
    @classmethod
    def _sale_tag_ids_patch(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, list):
            return _dedupe_int_ids([int(x) for x in v])
        return v

    @field_validator("allowed_payment_methods", mode="before")
    @classmethod
    def _allowed_pm_patch(cls, v: object) -> object:
        if v is None:
            return None
        if not isinstance(v, list):
            raise ValueError("allowed_payment_methods debe ser lista.")
        return [str(x).strip() for x in v[:40] if str(x).strip()]

    @field_validator("allowed_deposit_accounts", mode="before")
    @classmethod
    def _allowed_deps_patch(cls, v: object) -> object:
        if v is None:
            return None
        if not isinstance(v, list):
            raise ValueError("allowed_deposit_accounts debe ser lista.")
        return _dedupe_int_ids([int(x) for x in v])

    @model_validator(mode="after")
    def _invoice_lines_max_patch(self) -> "SaleUpdate":
        if self.invoice_lines is not None and len(self.invoice_lines) > 100:
            raise ValueError("Máximo 100 líneas de factura.")
        return self

    @field_validator("provider", "package", "screen_stock_batch_id", mode="before")
    @classmethod
    def _strip_opt_str(cls, v: object) -> object:
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v

    @field_validator("currency", mode="before")
    @classmethod
    def _norm_currency_sale_patch(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return None
            return normalize_currency_code(s)
        return v

    @field_validator("class_id", "payment_method_id", "deposit_account_id", "product_id", mode="before")
    @classmethod
    def _fk_positive_or_none(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip().lower()
            if not s or s in ("null", "none", "undefined"):
                return None
            try:
                v = int(float(s.replace(",", ".")))
            except (TypeError, ValueError):
                return None
        elif isinstance(v, float) and v.is_integer():
            v = int(v)
        if isinstance(v, int) and v < 1:
            return None
        return v

    @field_validator("credits_quantity", mode="before")
    @classmethod
    def _optional_float_patch(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip().lower()
            if not s or s in ("null", "none"):
                return None
        return _coerce_locale_float(v)

    @field_validator("exchange_rate", mode="before")
    @classmethod
    def _locale_float_patch(cls, v: object) -> object:
        coerced = _coerce_locale_float(v)
        if coerced is None:
            return None
        try:
            fv = float(coerced)
        except (TypeError, ValueError):
            return None
        return fv if fv > 0 else None

    @field_validator("local_amount", "amount_paid", mode="before")
    @classmethod
    def _locale_decimal_patch(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip().lower()
            if not s or s in ("null", "none"):
                return None
        return _coerce_locale_decimal(v)


class SaleStatusPut(BaseModel):
    """PUT ``/sales/{id}/status``: activar preventa, rechazar con motivo o anular venta activada."""

    model_config = ConfigDict(extra="ignore")

    status: Literal["approved", "rejected", "annulled"]
    rejection_reason: Optional[str] = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _reason_required_if_rejected(self) -> "SaleStatusPut":
        if self.status == "rejected":
            if self.rejection_reason is None or not str(self.rejection_reason).strip():
                raise ValueError("El motivo del rechazo es obligatorio.")
        return self

    @field_validator("rejection_reason", mode="before")
    @classmethod
    def _strip_reason(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v


SalePendingPatch = SaleUpdate


class SaleWebCreditsSyncResponse(BaseModel):
    """Resultado de traer comprobantes de ventas IPTV/créditos desde el portal Flask (catálogo VIP)."""

    updated_ids: list[int] = Field(default_factory=list, description="IDs de ventas actualizadas.")
    skipped_ids: list[int] = Field(default_factory=list, description="IDs omitidos (estado incompatible o datos incompletos).")
    not_found_ids: list[int] = Field(default_factory=list, description="IDs de venta ERP que no existen localmente.")
    errors: list[str] = Field(default_factory=list)


class SaleExtendTimerBody(BaseModel):
    """Extender manualmente la caducidad de la reserva temporal (solo ``pending``)."""

    extra_minutes: int = Field(..., ge=1, le=525600, description="Minutos a sumar al temporizador (máx. 1 año).")


class LinkedPaymentOut(BaseModel):
    """Pago de cliente aplicado a esta factura (vía ``payment_allocations``)."""

    payment_id: int
    date: Optional[datetime.datetime] = None
    amount_applied: float
    payment_number: str


class PendingReviewPaymentOut(BaseModel):
    """Pago vinculado a esta factura que aún está en revisión (pendiente de aprobar)."""

    payment_id: int
    payment_number: str
    amount: float
    currency: str
    payment_method: Optional[str] = None
    receipt_file_url: Optional[str] = None
    created_at: Optional[datetime.datetime] = None
    amount_applied_to_sale: Optional[float] = Field(
        default=None,
        description="Monto de este pago reservado a esta factura (filas ``payment_allocations`` en revisión).",
    )


class SaleResponse(BaseModel):
    id: int
    payment_token: Optional[UUID] = Field(
        default=None,
        description="Token público único por venta; enlace cliente: `/checkout/{payment_token}`.",
    )
    client_id: int
    client_name: str
    client_email: str = Field(..., description="Email del cliente (búsqueda en listados).")
    client_portal_token: Optional[str] = Field(
        default=None,
        description="Portal de autogestión `/portal/{client_portal_token}` (misma que el cliente de la venta).",
    )
    product_id: Optional[int] = None
    product_name: Optional[str] = None
    # amount = siempre USD (contabilidad)
    amount: Decimal
    currency: str
    exchange_rate: float
    local_amount: Optional[Decimal] = None
    amount_paid: Decimal = Field(..., description="Importe cobrado en moneda de venta (< local_amount ⇒ saldo pendiente).")
    balance_due: Decimal = Field(..., description="Saldo pendiente (cuentas por cobrar) en moneda de venta.")
    staff_review_action: str = Field(
        default="activate",
        description=(
            "Acción sugerida en panel: ``activate`` (aprovisionar inventario + cobro) o "
            "``approve_payment`` (solo aprobar comprobante CxC; inventario ya entregado)."
        ),
    )
    status: str
    rejection_reason: Optional[str] = Field(
        default=None,
        max_length=2000,
        description="Motivo registrado al rechazar una preventa (estado rejected).",
    )
    rejection_image_url: Optional[str] = Field(
        default=None,
        max_length=512,
        description="Ruta de evidencia (imagen) al rechazar desde el panel.",
    )
    receipt_url: Optional[str] = Field(
        default=None,
        description="Ruta del comprobante de pago guardado en servidor (p. ej. `/uploads/…`).",
    )
    created_at: datetime.datetime
    expires_at: Optional[datetime.datetime] = Field(
        default=None,
        description="Caducidad de la reserva (solo ``pending`` con TTL).",
    )
    credential: Optional[ScreenCredential]
    class_id: Optional[int] = None
    payment_method_id: Optional[int] = None
    payment_method: Optional[str] = Field(
        default=None,
        description="Nombre legible del método de pago (si existe).",
    )
    deposit_account_id: Optional[int] = None
    allowed_payment_methods: list[str] = Field(
        default_factory=list,
        description="Métodos de pago que el cliente puede usar en el portal para esta venta.",
    )
    allowed_deposit_accounts: list[int] = Field(
        default_factory=list,
        description="IDs de cuentas de depósito habilitadas para el cliente (portal).",
    )

    @field_validator("allowed_payment_methods", mode="before")
    @classmethod
    def _coerce_allowed_payment_methods(cls, v: Any) -> list[str]:
        if v is None:
            return []
        if isinstance(v, (list, tuple, set)):
            return [str(x).strip() for x in v if x is not None and str(x).strip()]
        return []

    @field_validator("allowed_deposit_accounts", mode="before")
    @classmethod
    def _coerce_allowed_deposit_accounts(cls, v: Any) -> list[int]:
        if v is None:
            return []
        if not isinstance(v, (list, tuple, set)):
            return []
        out: list[int] = []
        for x in v:
            if x is None or isinstance(x, bool):
                continue
            try:
                out.append(int(x))
            except (TypeError, ValueError):
                continue
        return out

    inventory_channel: Optional[str] = None
    inventory_provider: Optional[str] = None
    inventory_package: Optional[str] = None
    credits_quantity: Optional[float] = None
    screen_stock_id: Optional[int] = None
    inventory_screen_units: int = Field(default=1, ge=1)
    notes: Optional[str] = Field(
        default=None,
        description="Memo / comentario de la venta (visible en listados e historial).",
    )
    tag_ids: list[int] = Field(default_factory=list)
    tags: list[str] = Field(
        default_factory=list,
        description="Nombres de etiquetas de venta (ordenados).",
    )
    iptv_username: Optional[str] = Field(
        default=None,
        description="Usuario IPTV: cuenta de pantalla si hay pantalla ligada; si no, usuario del cliente.",
    )
    iptv_password: Optional[str] = Field(
        default=None,
        description="Contraseña asociada a la salida IPTV (pantalla física desde bodega o credenciales de factura).",
    )
    screen_stock_delivery: Optional[list[ScreenStockSaleCredential]] = Field(
        default=None,
        description="En ventas ERP de bodega: credenciales de cada pantalla entregada (orden FIFO).",
    )
    invoice_lines: Optional[list[SaleInvoiceLineItem]] = Field(
        default=None,
        description="Detalle multimoneda tipo QuickBooks (clases / credenciales por línea).",
    )
    fifo_cp_inventory_key: Optional[str] = Field(
        default=None,
        description=(
            "Solo uso UI: primer ``cp|…`` coherente con filas FIFO de bodega de la venta "
            "(fallback si ``invoice_lines`` no trae ``inventory_option_key``)."
        ),
    )
    linked_payments: list[LinkedPaymentOut] = Field(
        default_factory=list,
        description="Pagos CxC aprobados aplicados a esta factura (estilo QuickBooks).",
    )
    pending_review_payments: list[PendingReviewPaymentOut] = Field(
        default_factory=list,
        description="Pagos en estado pending_review vinculados a esta factura (comprobantes por aprobar).",
    )

    model_config = {"from_attributes": True}

    @computed_field  # type: ignore[prop-decorator]
    @property
    def payment_receipt(self) -> Optional[str]:
        """Alias de ``receipt_url`` para clientes que esperan ``payment_receipt``."""
        return self.receipt_url


class PendingBankPaymentBrief(BaseModel):
    """Comprobante portal aún en revisión, vinculado a una venta específica."""

    payment_id: int
    payment_number: Optional[str] = None
    amount: float
    currency: str
    deposit_account_id: Optional[int] = Field(
        default=None,
        description="Cuenta bancaria declarada por el cliente para este comprobante.",
    )
    receipt_url: Optional[str] = Field(
        default=None, description="Ruta relativa del comprobante (p. ej. /uploads/…)."
    )


class SaleApprovalBody(BaseModel):
    """Opciones al activar/aprobar una venta con comprobante en revisión."""

    override_account_id: Optional[int] = Field(
        default=None,
        ge=1,
        description="Cuenta bancaria real donde ingresó el dinero (reemplaza la declarada por el cliente).",
    )


class SalePortalPaymentConsolidated(BaseModel):
    """Resumen financiero para revisar/activar venta con pagos mixtos portal."""

    sale_id: int
    currency: str
    staff_review_action: str = Field(
        default="activate",
        description="``activate`` = primera activación con inventario; ``approve_payment`` = solo cobro CxC.",
    )
    invoice_total: float
    balance_due: float
    amount_paid_registered: float
    auto_credit_applied: float
    default_deposit_account_id: Optional[int] = Field(
        default=None,
        description="Cuenta sugerida para acreditar el ingreso (venta o comprobante pendiente).",
    )
    pending_bank_review: Optional[PendingBankPaymentBrief] = None
