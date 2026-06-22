from __future__ import annotations

import datetime
from decimal import Decimal
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

from app.schemas.checkout_public import CheckoutLinePublic
from app.schemas.client_product_prices import PortalAssignedPackagePrice


class PortalClientBrief(BaseModel):
    name: str
    email: str
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


class SalePaymentEvent(BaseModel):
    occurred_at: str
    amount: float
    currency: str
    status: str
    receipt_url: Optional[str] = None


class PortalSalePaymentBrief(BaseModel):
    """Intento de pago vinculado a una venta (portal público)."""

    id: int
    payment_number: Optional[str] = None
    amount: Decimal
    currency: str
    status: str = Field(description="pending_review, approved, rejected, etc.")
    created_at: Optional[str] = None


class PortalOutstandingSale(BaseModel):
    sale_id: int
    status: str
    #: Fecha de creación de la venta (ordenar «factura más reciente» en portal).
    invoice_created_at: Optional[datetime.datetime] = None
    #: UTC: tiempo restante de reserva para pedidos ``pending`` con TTL.
    expires_at: Optional[datetime.datetime] = None
    currency: str
    local_amount: Optional[Decimal] = None
    amount_paid: Decimal = Decimal("0")
    balance_due: Decimal = Decimal("0")
    payment_token: Optional[UUID] = None
    lines: list[CheckoutLinePublic] = Field(default_factory=list)
    allowed_payment_methods: list[PortalPaymentMethodPick] = Field(default_factory=list)
    allowed_deposit_accounts: list[PortalDepositPick] = Field(default_factory=list)
    payment_events: list[SalePaymentEvent] = Field(default_factory=list)
    client_payments: list[PortalSalePaymentBrief] = Field(
        default_factory=list,
        description="Pagos del cliente ligados a esta venta, más recientes primero.",
    )


class PortalLedgerEntry(BaseModel):
    """Movimiento en el estado de cuenta del portal (historial público simplificado)."""

    type: Literal["invoice", "payment"] = Field(description="'invoice': venta/factura; 'payment': abono aplicado.")
    date: Optional[str] = Field(default=None, description="ISO 8601 (UTC cuando exista zona).")
    description: str
    reference: str = Field(description="Referencia corta tipo FAC-xxxx o PAG-…")
    amount: Decimal = Field(description="Valor absoluto en la moneda indicada.")
    currency: str = "USD"
    status: str = Field(description="Etiqueta de estado visible para el cliente.")
    #: Solo ``invoice``: id de la venta. ``payment``: típicamente ``None``.
    sale_id: Optional[int] = Field(default=None, description="ID interno de venta cuando aplica.")
    #: Solo ``payment``: ventas a las que se aplicó el abono (allocations aprobadas).
    linked_sale_ids: list[int] = Field(default_factory=list)


class DebtPaymentItem(BaseModel):
    id: int
    client_id: int
    client_name: str
    payment_number: Optional[str] = None
    amount: Decimal
    currency: str
    receipt_url: Optional[str] = None
    status: str
    created_at: Optional[str] = None
    notes: Optional[str] = None


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
    total_debt_by_currency: list[dict[str, object]]
    total_debt: Decimal = Decimal("0")
    pending_sales: list[PortalOutstandingSale] = Field(default_factory=list)
    outstanding_sales: list[PortalOutstandingSale]
    new_order_sales: list[PortalOutstandingSale] = Field(
        default_factory=list,
        description="Ventas con saldo pendiente > 0 (pending, partially_paid, approved/activado, etc.).",
    )
    historical_debt_sales: list[PortalOutstandingSale] = Field(
        default_factory=list,
        description="Facturas aprobadas/parciales con saldo CxC pendiente.",
    )
    outstanding_balance: Decimal = Field(
        default=Decimal("0"),
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
