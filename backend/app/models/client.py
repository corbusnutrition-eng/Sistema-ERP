from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import DateTime, Float, ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

CLIENT_STATUSES = ("Activo", "Inactivo")


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[int] = mapped_column(primary_key=True)
    #: Distribuidor padre (reseller). ``None`` = cliente raíz del ERP.
    parent_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("clients.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    name: Mapped[Optional[str]] = mapped_column(String(150), nullable=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    phone: Mapped[Optional[str]] = mapped_column(String(30))
    #: WhatsApp/teléfono de soporte BaaS para la red de sub-clientes (portal, cascada por parent_id).
    contact_phone: Mapped[Optional[str]] = mapped_column(String(30), nullable=True)
    username: Mapped[str] = mapped_column(String(120), nullable=False, comment="Usuario IPTV")
    #: Hash contraseña portal (sincronizado con web Render); opcional para clientes sólo ERP.
    password_hash: Mapped[Optional[str]] = mapped_column(
        String(512),
        nullable=True,
        comment="Hash de contraseña compartido con catalogo-vip / portal web",
    )
    country: Mapped[Optional[str]] = mapped_column(String(100), nullable=True, comment="País del cliente")
    lead_source: Mapped[Optional[str]] = mapped_column(
        String(120), nullable=True, comment="Origen web del lead (ej. 'landing_iptv', 'contacto')"
    )
    status: Mapped[str] = mapped_column(
        String(30),
        nullable=False,
        default="Activo",
        server_default="Activo",
    )
    total_credits: Mapped[float] = mapped_column(Float, nullable=False, default=0.0, server_default="0")
    #: Saldo a favor CxC (pagos por encima del saldo pendiente; se cruza contra futuras compras).
    credit_balance: Mapped[float] = mapped_column(Float, nullable=False, default=0.0, server_default="0")
    #: Saldo virtual BaaS (recargas aprobadas por comprobante / enlaces públicos).
    wallet_balance: Mapped[float] = mapped_column(Float, nullable=False, default=0.0, server_default="0")
    #: Moneda base BaaS del distribuidor (primera recarga aprobada; heredada por sub-clientes).
    currency: Mapped[str] = mapped_column(
        String(10),
        nullable=False,
        default="USD",
        server_default="USD",
    )
    last_recharge: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    payment_token: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        nullable=False,
        unique=True,
        default=uuid.uuid4,
    )
    custom_fields: Mapped[dict[str, Any]] = mapped_column(
        JSONB,
        nullable=False,
        default=dict,
    )
    note: Mapped[Optional[str]] = mapped_column(
        Text, nullable=True, comment="Nota interna de seguimiento del cliente"
    )
    tags: Mapped[Optional[list[str]]] = mapped_column(
        JSONB, nullable=True, default=None, comment="Etiquetas del cliente (ej. VIP, moroso, recurrente)"
    )

    #: Memoria revendedor: último par IPTV usado en venta ERP de «crédito normal» (factura).
    last_iptv_username: Mapped[Optional[str]] = mapped_column(
        String(120), nullable=True, comment="Último usuario IPTV en venta de crédito normal"
    )
    last_iptv_password: Mapped[Optional[str]] = mapped_column(
        String(255), nullable=True, comment="Última contraseña IPTV en venta de crédito normal"
    )

    @property
    def last_normal_credit_username(self) -> Optional[str]:
        """Alias explícito (API/UI) sobre ``last_iptv_username``."""
        return self.last_iptv_username

    @property
    def last_normal_credit_password(self) -> Optional[str]:
        return self.last_iptv_password

    parent: Mapped[Optional["Client"]] = relationship(
        "Client",
        remote_side="Client.id",
        foreign_keys=[parent_id],
        back_populates="children",
    )
    children: Mapped[list["Client"]] = relationship(
        "Client",
        foreign_keys=[parent_id],
        back_populates="parent",
    )
    screens: Mapped[list["IPTVScreen"]] = relationship(back_populates="client")
    sales: Mapped[list["Sale"]] = relationship(back_populates="client")
    notes: Mapped[list["ClientNote"]] = relationship(
        back_populates="client", cascade="all, delete-orphan", order_by="ClientNote.created_at.desc()"
    )
    debt_payments: Mapped[list["ClientDebtPayment"]] = relationship(  # type: ignore[name-defined]
        "ClientDebtPayment", back_populates="client", cascade="all, delete-orphan", order_by="ClientDebtPayment.created_at.desc()"
    )
    client_payments: Mapped[list["ClientPayment"]] = relationship(  # type: ignore[name-defined]
        "ClientPayment", back_populates="client", cascade="all, delete-orphan", order_by="ClientPayment.created_at.desc()"
    )
    wallet_recharge_requests: Mapped[list["WalletRechargeRequest"]] = relationship(
        "WalletRechargeRequest",
        back_populates="client",
        cascade="all, delete-orphan",
    )
    wallet_transactions: Mapped[list["WalletTransaction"]] = relationship(
        "WalletTransaction",
        back_populates="client",
        cascade="all, delete-orphan",
    )
    inbox_notifications: Mapped[list["ClientNotification"]] = relationship(
        "ClientNotification",
        back_populates="client",
        cascade="all, delete-orphan",
        order_by="ClientNotification.created_at.desc()",
    )
    assigned_payment_method_links: Mapped[list["ClientPaymentMethod"]] = relationship(
        "ClientPaymentMethod",
        back_populates="client",
        cascade="all, delete-orphan",
    )
    assigned_payment_method_account_links: Mapped[list["ClientPaymentMethodAccount"]] = relationship(
        "ClientPaymentMethodAccount",
        back_populates="client",
        cascade="all, delete-orphan",
    )

    @property
    def portal_token(self) -> uuid.UUID:
        """Mismo UUID que ``payment_token``: enlace permanente ``/portal/{token}``."""
        return self.payment_token

    def display_name(self) -> str:
        """Nombre para UI y reportes: nombre → usuario IPTV → email."""
        n = (self.name or "").strip()
        if n:
            return n
        u = (self.username or "").strip()
        if u:
            return u
        return (self.email or "").strip() or "—"
