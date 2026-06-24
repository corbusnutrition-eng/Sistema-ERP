from __future__ import annotations

import datetime
import enum
import uuid as uuid_pkg
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Optional

from sqlalchemy import JSON, DateTime, Enum, Float, ForeignKey, Integer, Numeric, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.sale_transaction_tag import SaleTransactionTag, sale_tag_association
from app.models.screen_stock import ScreenStock

if TYPE_CHECKING:
    from app.models.account import Account
    from app.models.payment_method import PaymentMethod
    from app.models.transaction_class import TransactionClass


class SaleStatus(str, enum.Enum):
    approved = "approved"
    pending = "pending"
    #: Cliente envió comprobante vía portal; pendiente de aprobación por staff.
    payment_submitted = "payment_submitted"
    #: Venta activada con pago parcial; el cliente aún tiene saldo pendiente.
    partially_paid = "partially_paid"
    #: Preventa caducada por tiempo de reserva (inventario liberado).
    expired = "expired"
    cancelled = "cancelled"
    rejected = "rejected"
    annulled = "annulled"


class Sale(Base):
    __tablename__ = "sales"

    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[int] = mapped_column(ForeignKey("clients.id"), nullable=False, index=True)
    product_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("products.id"),
        nullable=True,
        index=True,
    )
    iptv_screen_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("iptv_screens.id"),
        index=True,
    )
    screen_stock_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("screen_stock.id"),
        nullable=True,
        index=True,
    )
    # amount = valor contable SIEMPRE en USD (para contabilidad unificada)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    # Moneda local usada en la transacción (ISO 4217)
    currency: Mapped[str] = mapped_column(String(10), nullable=False, default="USD")
    # Unidades de moneda local equivalentes a 1 USD (ej. 4000 para COP)
    exchange_rate: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    # Monto en la moneda local cobrada al cliente
    local_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(18, 4), nullable=True)
    #: Cobrado efectivamente en la misma moneda que ``local_amount`` (pagos parciales → saldo por cobrar).
    amount_paid: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    status: Mapped[SaleStatus] = mapped_column(
        Enum(SaleStatus, name="sale_status_enum"),
        nullable=False,
        default=SaleStatus.pending,
    )
    rejection_reason: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    #: Evidencia (foto) al rechazar preventa desde el panel.
    rejection_image_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    receipt_url: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    #: Token único del pedido para el portal público de pago (``GET /checkout/{token}``).
    payment_token: Mapped[uuid_pkg.UUID] = mapped_column(
        UUID(as_uuid=True),
        unique=True,
        nullable=False,
        index=True,
    )
    notes: Mapped[Optional[str]] = mapped_column(String(4000), nullable=True)
    #: Cliente final registrado por el distribuidor en autocompra portal (mini-CRM «Mis compras»).
    end_customer_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    end_customer_phone: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    #: Precio cobrado al cliente final en la moneda de la venta (mini-CRM «Mis compras»).
    end_customer_sale_price: Mapped[Optional[Decimal]] = mapped_column(Numeric(18, 4), nullable=True)
    #: Unidades ocultas del mini-CRM «Mis compras» (``screen_stock.id``; ``0`` = fila sin pantalla asignada).
    dismissed_tracked_screen_stock_ids: Mapped[Optional[list[Any]]] = mapped_column(JSON, nullable=True)
    #: full_credits | screen_stock cuando la venta se creó desde ERP (activación aplaza inventario).
    inventory_channel: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    #: Paquete de bodega (screen_stock).
    inventory_package: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    #: Créditos vendidos cuando la venta es por recarga total (cuentas full).
    credits_quantity: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    #: Proveedor IPTV asociado a la venta por créditos (denormalizado).
    inventory_provider: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    #: Unidades de pantalla vendidas (canal ``screen_stock``; FIFO en bodega).
    inventory_screen_units: Mapped[int] = mapped_column(
        Integer,
        default=1,
        server_default="1",
        nullable=False,
    )
    class_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("transaction_classes.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    #: Detalle multimoneda tipo QuickBooks (clases y credenciales opcionales por línea).
    invoice_lines: Mapped[Optional[list[Any]]] = mapped_column(JSON, nullable=True)
    payment_method_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("payment_methods.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    deposit_account_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    #: Nombres de métodos de pago habilitados para el cliente en el portal (validados contra catálogo).
    allowed_payment_methods: Mapped[Optional[list[Any]]] = mapped_column(JSON, nullable=True)
    #: IDs de cuentas de depósito permitidas para abonos desde el portal.
    allowed_deposit_accounts: Mapped[Optional[list[Any]]] = mapped_column(JSON, nullable=True)
    #: Historial de abonos recibidos desde el portal: lista de {occurred_at, amount, currency, status, receipt_url}.
    payment_events: Mapped[Optional[list[Any]]] = mapped_column(JSON, nullable=True)
    #: Caducidad de la reserva temporal para ``pending`` (UTC).
    expires_at: Mapped[Optional[datetime.datetime]] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    client: Mapped["Client"] = relationship(back_populates="sales")
    product: Mapped[Optional["Product"]] = relationship()
    screen: Mapped[Optional["IPTVScreen"]] = relationship(back_populates="sales")
    #: Pantalla ligada por ``screen_stock_id`` (no por ``ScreenStock.sale_id``; pueden coexistir varias filas por venta).
    screen_stock_row: Mapped[Optional[ScreenStock]] = relationship(
        foreign_keys=[screen_stock_id],
        post_update=True,
    )
    transaction_class: Mapped[Optional["TransactionClass"]] = relationship()
    payment_method: Mapped[Optional["PaymentMethod"]] = relationship()
    deposit_account: Mapped[Optional["Account"]] = relationship()
    tags: Mapped[list["SaleTransactionTag"]] = relationship(
        "SaleTransactionTag",
        secondary=sale_tag_association,
        lazy="selectin",
    )
