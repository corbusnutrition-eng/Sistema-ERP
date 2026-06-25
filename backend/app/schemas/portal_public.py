from __future__ import annotations

import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

from app.schemas.client_product_prices import PortalAssignedPackagePrice


class PortalCheckoutLinePublic(BaseModel):
    """Línea de factura para el portal: siempre JSON-safe (sin ``null`` en montos)."""

    description: str = Field(default="Pedido", max_length=2000)
    qty: float = Field(default=1.0, ge=0)
    rate: float = Field(default=0.0, ge=0)
    amount: float = Field(default=0.0, ge=0)


class PortalClientBrief(BaseModel):
    name: str
    email: str
    phone: Optional[str] = Field(
        default=None,
        description="Teléfono CRM del cliente (datos de contacto generales).",
    )
    contact_phone: Optional[str] = Field(
        default=None,
        description="WhatsApp de soporte BaaS para sub-clientes directos (E.164, ej. +593999999999).",
    )
    parent_id: Optional[int] = Field(
        default=None,
        description="Distribuidor padre; null = cliente directo (1ª línea) con CxC frente al admin.",
    )
    #: Saldo a favor CxC (pagos por encima de facturas pendientes).
    credit_balance: float = Field(default=0.0)
    credit_balance_currency: str = Field(default="USD", max_length=10)
    credit_balances_by_currency: list[dict[str, object]] = Field(default_factory=list)
    available_credit: float = Field(
        default=0.0,
        description="Saldo a favor aplicable a facturas (misma moneda principal que credit_balance).",
    )
    #: Saldo virtual BaaS (CRM ``clients.wallet_balance``).
    wallet_balance: float = Field(default=0.0, description="Saldo principal en billetera BaaS.")
    wallet_balance_currency: str = Field(default="USD", max_length=10)
    wallet_balances_by_currency: list[dict[str, object]] = Field(default_factory=list)
    currency: str = Field(
        default="USD",
        max_length=10,
        description="Moneda base BaaS (primera recarga aprobada; heredada por sub-clientes).",
    )


class PortalPaymentMethodPick(BaseModel):
    id: int
    name: str


class PortalAssignedPaymentMethod(BaseModel):
    """Método padre con cuentas hijas habilitadas para el cliente (CRM → portal)."""

    id: int
    name: str
    deposit_accounts: list["PortalDepositPick"] = Field(default_factory=list)


class PortalDepositPick(BaseModel):
    id: int
    bank_name: str = Field(description="Nombre / etiqueta visible de la cuenta")
    account_number: Optional[str] = None
    currency: str
    #: Notas / titular desde descripción de cuenta (si existe en ERP).
    holder_note: Optional[str] = Field(default=None, description="Texto breve de referencia (titular, detalle).")
    payment_method_id: Optional[int] = Field(
        default=None,
        description="Método de pago padre al que pertenece la cuenta (filtrado en cascada portal).",
    )


class SalePaymentEvent(BaseModel):
    occurred_at: str = ""
    amount: float = Field(default=0.0, ge=0)
    currency: str = "USD"
    status: str = "En revisión"
    receipt_url: Optional[str] = None


class PortalSalePaymentBrief(BaseModel):
    """Intento de pago vinculado a una venta (portal público)."""

    id: int
    payment_number: Optional[str] = None
    amount: float = Field(default=0.0, description="Monto aplicado a esta venta (allocation) o del cobro.")
    currency: str = "USD"
    status: str = Field(default="pending_review", description="pending_review, approved, rejected, etc.")
    created_at: Optional[str] = None


class PortalOutstandingSale(BaseModel):
    sale_id: int
    status: str
    #: Fecha de creación de la venta (ordenar «factura más reciente» en portal).
    invoice_created_at: Optional[datetime.datetime] = None
    #: UTC: tiempo restante de reserva para pedidos ``pending`` con TTL.
    expires_at: Optional[datetime.datetime] = None
    currency: str = "USD"
    invoice_total: float = Field(
        default=0.0,
        description="Total facturado en moneda de la venta (motor CxC unificado).",
    )
    local_amount: Optional[float] = Field(
        default=None,
        description="Total en moneda local; alias de ``invoice_total`` para compatibilidad portal.",
    )
    amount_paid: float = Field(
        default=0.0,
        description="Cobros aprobados + allocations en revisión (FIFO).",
    )
    balance_due: float = Field(
        default=0.0,
        description="Saldo CxC pendiente en moneda de la venta.",
    )
    payment_token: Optional[UUID] = None
    lines: list[PortalCheckoutLinePublic] = Field(default_factory=list)
    allowed_payment_methods: list[PortalPaymentMethodPick] = Field(default_factory=list)
    allowed_deposit_accounts: list[PortalDepositPick] = Field(default_factory=list)
    payment_methods_tree: list[PortalAssignedPaymentMethod] = Field(
        default_factory=list,
        description="Métodos con cuentas anidadas por padre (filtrado en cascada en checkout).",
    )
    payment_events: list[SalePaymentEvent] = Field(default_factory=list)
    client_payments: list[PortalSalePaymentBrief] = Field(
        default_factory=list,
        description="Pagos del cliente ligados a esta venta, más recientes primero.",
    )

    @field_validator("status", mode="before")
    @classmethod
    def _normalize_status(cls, v: object) -> str:
        s = str(v or "pending").strip().lower().replace("-", "_")
        allowed = frozenset(
            {"pending", "payment_submitted", "partially_paid", "approved", "expired", "cancelled"}
        )
        return s if s in allowed else "pending"

    @model_validator(mode="before")
    @classmethod
    def _coalesce_null_lists(cls, data: object) -> object:
        if not isinstance(data, dict):
            return data
        out = dict(data)
        for key in ("lines", "payment_events", "client_payments", "allowed_payment_methods", "allowed_deposit_accounts"):
            if out.get(key) is None:
                out[key] = []
        return out


class PortalLedgerEntry(BaseModel):
    """Movimiento en el estado de cuenta del portal (historial público simplificado)."""

    type: Literal["invoice", "payment"] = Field(description="'invoice': venta/factura; 'payment': abono aplicado.")
    date: Optional[str] = Field(default=None, description="ISO 8601 (UTC cuando exista zona).")
    description: str
    reference: str = Field(description="Referencia corta tipo FAC-xxxx o PAG-…")
    amount: float = Field(default=0.0, description="Valor absoluto en la moneda indicada.")
    currency: str = "USD"
    status: str = Field(default="", description="Etiqueta de estado visible para el cliente.")
    #: Solo ``invoice``: id de la venta. ``payment``: típicamente ``None``.
    sale_id: Optional[int] = Field(default=None, description="ID interno de venta cuando aplica.")
    #: Solo ``payment``: ventas a las que se aplicó el abono (allocations aprobadas).
    linked_sale_ids: list[int] = Field(default_factory=list)


class DebtPaymentItem(BaseModel):
    id: int
    client_id: int
    client_name: str
    payment_number: Optional[str] = None
    amount: float = Field(default=0.0)
    currency: str = "USD"
    receipt_url: Optional[str] = None
    status: str = "pending_review"
    created_at: Optional[str] = None
    notes: Optional[str] = None


class PortalTrackedPurchaseItem(BaseModel):
    """Compra BaaS con seguimiento de cliente final (mini-CRM «Mis compras»)."""

    sale_id: int = Field(..., ge=1)
    screen_stock_id: Optional[int] = Field(
        default=None,
        description="Unidad de bodega asignada; null si la venta aún no tiene pantalla.",
    )
    end_customer_name: str
    end_customer_phone: Optional[str] = None
    precio_venta: Optional[float] = Field(
        default=None,
        ge=0,
        description="Precio cobrado al cliente final en moneda de la venta.",
    )
    currency: Optional[str] = Field(
        default=None,
        description="Moneda del precio cobrado (ISO 4217, ej. USD).",
    )
    package_name: str
    purchase_date: str = Field(description="ISO 8601 (UTC/Z) de creación de la venta.")
    inventory_created_at: Optional[str] = Field(
        default=None,
        description="ISO 8601 (UTC/Z) de creación del ítem en bodega (base del cálculo de vencimiento).",
    )
    inventory_package_raw: Optional[str] = Field(
        default=None,
        description="Etiqueta cruda del paquete en bodega (ej. «1 mes»).",
    )
    expiration_date: Optional[str] = Field(
        default=None,
        description="Fecha de vencimiento efectiva ISO (YYYY-MM-DD) calculada desde inventario.",
    )
    days_remaining: Optional[int] = Field(
        default=None,
        description="Días restantes hasta vencimiento efectivo (negativo si ya expiró).",
    )
    days_until_expiration: Optional[int] = Field(
        default=None,
        description="Alias de days_remaining (compatibilidad).",
    )
    expired: bool = False


class PortalActiveScreen(BaseModel):
    """Pantalla de bodega asignada a una venta activada del cliente (portal público)."""

    screen_stock_id: int = Field(..., ge=1)
    sale_id: int = Field(..., ge=1)
    package_name: str = Field(..., description="Etiqueta legible del paquete (ej. Flujo 1 mes).")
    username: Optional[str] = Field(default=None, description="Usuario IPTV de la pantalla.")
    password: Optional[str] = Field(default=None, description="Contraseña IPTV de la pantalla.")
    assigned_at: str = Field(
        ...,
        description="ISO 8601 (UTC/Z) de activación/asignación de la venta en bodega.",
    )
    expiration_date: Optional[str] = Field(
        default=None,
        description="Fecha de vencimiento ISO (YYYY-MM-DD) si está registrada en bodega.",
    )


class PortalWalletRechargeItem(BaseModel):
    """Recarga BaaS abierta para el cliente autenticado por ``payment_token``."""

    id: int
    amount_requested: float
    receipt_url: Optional[str] = None
    status: str
    created_at: datetime.datetime
    recharge_currency: str = Field(default="USD", description="Moneda de cobro configurada por administración.")
    recharge_exchange_rate: float = Field(
        default=1.0,
        description="Referencia tipo ventas: unidades de moneda de cobro por 1 USD.",
    )
    admin_precheck_receipt_url: Optional[str] = Field(
        default=None,
        description="Comprobante de referencia que el administrador puede adjuntar al crear la solicitud.",
    )
    allowed_payment_methods: list[PortalPaymentMethodPick] = Field(
        default_factory=list,
        description="Catálogo habilitado para esta solicitud (ids para el formulario de comprobante).",
    )
    allowed_deposit_accounts: list[PortalDepositPick] = Field(
        default_factory=list,
        description="Cuentas de depósito habilitadas para esta recarga (ERP).",
    )
    payment_methods_tree: list[PortalAssignedPaymentMethod] = Field(
        default_factory=list,
        description="Métodos con cuentas anidadas por padre (filtrado en cascada en checkout).",
    )
    payment_methods_display: Optional[str] = Field(
        default=None,
        description="Métodos de pago permitidos para esta solicitud.",
    )
    amount_paid: float = Field(default=0.0, description="Importe reconocido acumulado hacia esta recarga.")
    balance_pending: float = Field(default=0.0, description="Saldo pendiente antes de cerrar la recarga.")
    surplus_credited: float = Field(
        default=0.0,
        description="Excedente acumulado enviado a saldo a favor CxC por esta solicitud.",
    )


class PortalSubClientBrief(BaseModel):
    """Sub-cliente directo de un distribuidor (portal público)."""

    id: int
    name: str
    username: str
    email: str
    phone: Optional[str] = None
    wallet_balance: float = Field(default=0.0)
    currency: str = Field(default="USD", max_length=10, description="Moneda base BaaS heredada del padre.")
    portal_token: UUID
    status: str = "Activo"


class PortalSubClientUpdate(BaseModel):
    """Actualización de datos de contacto por el distribuidor padre."""

    name: Optional[str] = Field(default=None, max_length=150)
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(default=None, max_length=30)


class PortalSubClientDeleteResponse(BaseModel):
    ok: bool = True
    id: int
    message: str = "Sub-cliente eliminado de tu red."


class PortalTrackedPurchaseDeleteResponse(BaseModel):
    ok: bool = True
    sale_id: int = Field(..., ge=1)
    screen_stock_id: Optional[int] = Field(
        default=None,
        description="Unidad ocultada; null si la fila era sin pantalla asignada.",
    )
    message: str = "Cliente caducado eliminado de Mis compras."


class PortalTrackedPurchaseUpdate(BaseModel):
    end_customer_name: str = Field(..., min_length=1, max_length=200)
    end_customer_phone: Optional[str] = Field(default=None, max_length=30)
    precio_venta: Optional[float] = Field(
        default=None,
        ge=0,
        description="Precio cobrado al cliente final en moneda de la venta.",
    )


class PortalTrackedPurchaseUpdateResponse(BaseModel):
    ok: bool = True
    sale_id: int = Field(..., ge=1)
    screen_stock_id: Optional[int] = None
    end_customer_name: str
    end_customer_phone: Optional[str] = None
    precio_venta: Optional[float] = None
    currency: Optional[str] = None
    message: str = "Datos del cliente actualizados."


class PortalSubClientPriceItem(BaseModel):
    package_catalog_id: int = Field(..., ge=1)
    product_id: int = Field(..., ge=1)
    custom_price: float = Field(..., gt=0)


class PortalSubClientCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=120)
    email: EmailStr
    name: Optional[str] = Field(default=None, max_length=150)
    phone: Optional[str] = Field(default=None, max_length=30)
    prices: list[PortalSubClientPriceItem] = Field(
        ...,
        min_length=1,
        description="Precio de venta obligatorio por cada paquete Flujo autorizado del distribuidor.",
    )
    initial_transfer_amount: float = Field(
        ...,
        gt=0,
        description="Recarga BaaS inicial descontada del patrocinador y acreditada al sub-cliente.",
    )


class PortalSubClientTransferRequest(BaseModel):
    child_client_id: int = Field(..., ge=1)
    amount: float = Field(..., gt=0)


class PortalSubClientTransferResponse(BaseModel):
    parent_wallet_balance: float
    child_wallet_balance: float
    amount: float
    message: str = "Transferencia BaaS completada."


class PortalSubClientSetPricesRequest(BaseModel):
    items: list[PortalSubClientPriceItem] = Field(default_factory=list)


class PortalAssignPricesRequest(BaseModel):
    """Asignar precios de venta a un sub-cliente directo."""

    child_client_id: int = Field(..., ge=1)
    items: list[PortalSubClientPriceItem] = Field(default_factory=list)


class PortalSubClientPricingRow(BaseModel):
    package_catalog_id: int
    product_id: int
    display_name: str
    package_label: str
    reference_cost_usd: float
    parent_floor_price_usd: float
    parent_floor_price_local: float = Field(
        description="Costo de adquisición del distribuidor en su moneda base (precio asignado).",
    )
    floor_currency: str = Field(default="USD", max_length=10)
    child_custom_price: Optional[float] = None
    free_stock: int = 0


class PortalDashboardGanancias(BaseModel):
    diario: float = Field(default=0.0, description="Utilidad acumulada hoy (Ecuador).")
    semanal: float = Field(default=0.0, description="Utilidad acumulada en la semana calendario actual.")
    mensual: float = Field(default=0.0, description="Utilidad acumulada en el mes calendario actual.")
    currency: str = Field(default="USD", max_length=10)


class PortalDashboardMetrics(BaseModel):
    ganancias_totales: PortalDashboardGanancias
    pantallas_activas: int = Field(default=0, ge=0)
    vencimientos_semana: int = Field(
        default=0,
        ge=0,
        description="Clientes finales con vencimiento en 0–7 días (Mis compras).",
    )
    saldo_baas: float = Field(default=0.0, ge=0)
    saldo_baas_currency: str = Field(default="USD", max_length=10)


class PortalHomeResponse(BaseModel):
    """GET /portal/{portal_token} — cliente autogestión."""

    client: PortalClientBrief
    credit_balance_total: float = Field(description="Valor numérico de referencia CRM (total_credits).")
    #: Saldo a favor CxC (pagos aplicados por encima de facturas pendientes); misma convención que ``local_amount`` / portal.
    credit_balance: float = Field(default=0.0)
    credit_balance_currency: str = Field(default="USD", max_length=10)
    credit_balances_by_currency: list[dict[str, object]] = Field(default_factory=list)
    available_credit_by_currency: list[dict[str, object]] = Field(
        default_factory=list,
        description="Crédito CxC aplicable a futuras facturas, por moneda.",
    )
    available_credit: float = Field(
        default=0.0,
        description="Saldo a favor total en la moneda principal (anticipos de clientes / sobrepagos).",
    )
    total_debt_by_currency: list[dict[str, object]] = Field(default_factory=list)
    total_debt: float = Field(default=0.0)
    pending_sales: list[PortalOutstandingSale] = Field(default_factory=list)
    outstanding_sales: list[PortalOutstandingSale] = Field(default_factory=list)
    new_order_sales: list[PortalOutstandingSale] = Field(
        default_factory=list,
        description="Ventas con saldo pendiente > 0 (pending, partially_paid, approved/activado, etc.).",
    )
    historical_debt_sales: list[PortalOutstandingSale] = Field(
        default_factory=list,
        description="Facturas aprobadas/parciales con saldo CxC pendiente.",
    )
    outstanding_balance: float = Field(
        default=0.0,
        description="Suma de saldos en facturas históricas (no incluye pedidos pending).",
    )
    historical_debt_by_currency: list[dict[str, object]] = Field(default_factory=list)
    pending_debt_payments: list[DebtPaymentItem] = Field(
        default_factory=list,
        description="Abonos de deuda del portal del cliente en revisión.",
    )
    recent_client_payments: list[DebtPaymentItem] = Field(
        default_factory=list,
        description="Últimos pagos/abonos del cliente con estado actualizado (incluye rechazados).",
    )
    ledger: list[PortalLedgerEntry] = Field(
        default_factory=list,
        description="Historial de facturas con saldo y abonos aplicados, más recientes primero.",
    )
    active_screens: list[PortalActiveScreen] = Field(
        default_factory=list,
        description="Pantallas IPTV ya activadas (ventas approved con bodega asignada).",
    )
    assigned_package_prices: list[PortalAssignedPackagePrice] = Field(
        default_factory=list,
        description="Precios Flujo personalizados del cliente (venta local por paquete).",
    )
    precios_asignados: dict[str, float] = Field(
        default_factory=dict,
        description="Mapa package_catalog_id (str) → precio de venta en moneda del cliente.",
    )
    assigned_payment_methods: list[PortalAssignedPaymentMethod] = Field(
        default_factory=list,
        description="Métodos padre con cuentas hijas habilitadas por administración (CRM).",
    )
    assigned_deposit_accounts: list[PortalDepositPick] = Field(
        default_factory=list,
        description="Cuentas de depósito vinculadas a los métodos asignados (moneda del cliente).",
    )
    allowed_payment_account_ids: list[int] = Field(
        default_factory=list,
        description="IDs de cuentas habilitadas por CRM; vacío = portal usa configuración global por venta.",
    )
    outstanding_wallet_recharges: list[PortalWalletRechargeItem] = Field(
        default_factory=list,
        description="Todas las solicitudes BaaS abiertas del cliente (portal checkout).",
    )
    parent_contact_phone: Optional[str] = Field(
        default=None,
        description="WhatsApp del parent_id inmediato (solo si el padre directo configuró contact_phone).",
    )
    dashboard_metrics: Optional[PortalDashboardMetrics] = Field(
        default=None,
        description="Mini-dashboard de rendimiento del distribuidor (portal autogestión).",
    )


class PortalContactUpdate(BaseModel):
    phone: str = Field(..., min_length=8, max_length=30, description="Número E.164, ej. +593999999999.")


class PortalContactResponse(BaseModel):
    contact_phone: str
    phone: str = Field(description="Alias de contact_phone (compatibilidad frontend).")
    message: str = "Contacto actualizado."


class PortalPaymentSubmitResponse(BaseModel):
    message: str
    status: str
    receipt_url: Optional[str] = Field(
        default=None,
        description="Ruta pública del comprobante guardado (`/uploads/…`).",
    )
    payment_id: Optional[int] = Field(
        default=None,
        description="ID del ClientPayment cuando payment_intent=abono.",
    )
    payment_number: Optional[str] = None


class PortalInstantActivationResponse(BaseModel):
    ok: bool = True
    message: str
    sale_id: int
    sale_status: str
    invoice_total: float
    cxc_open_balance: float
    amount_paid: float = 0.0
    currency: str = "USD"


class PortalWalletRechargeInstantActivationResponse(BaseModel):
    ok: bool = True
    message: str
    wallet_recharge_id: int
    recharge_status: str
    amount_requested: float
    cxc_open_balance: float
    amount_paid: float = 0.0
    currency: str = "USD"


class PortalCxcBalanceResponse(BaseModel):
    """GET /portal/{token}/cxc-balance — deuda CxC abierta del cliente."""

    total: float = Field(default=0.0, description="Saldo CxC en la moneda principal del cliente.")
    currency: str = Field(default="USD", max_length=10)
    by_currency: list[dict[str, object]] = Field(
        default_factory=list,
        description="Desglose de deuda CxC por moneda.",
    )


class DebtPaymentSubmitResponse(BaseModel):
    message: str
    debt_payment_id: int
    payment_number: Optional[str] = None
    status: str


class ReceiptAnalysisResponse(BaseModel):
    """Resultado del análisis IA del comprobante bancario."""

    is_readable: bool = Field(description="True si la imagen es un comprobante legible.")
    extracted_amount: Optional[float] = Field(default=None, description="Monto detectado en el comprobante.")
    extracted_currency: Optional[str] = Field(default=None, description="Moneda detectada (ISO 4217).")
    amount_matches: Optional[bool] = Field(
        default=None,
        description="True si el monto coincide con el esperado. None si no se puede comparar.",
    )
    expected_amount: Optional[float] = Field(default=None)
    expected_currency: Optional[str] = Field(default=None)
