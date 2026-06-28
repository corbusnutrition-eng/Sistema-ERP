from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, JSON, String, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class WalletRechargeRequest(Base):
    """Solicitud de recarga de saldo virtual con comprobante (fuera del inventario)."""

    __tablename__ = "wallet_recharge_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    amount_requested: Mapped[float] = mapped_column(Float, nullable=False)
    receipt_url: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        server_default=text("'pending'"),
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    #: IDs de métodos de pago (catálogo) habilitados para esta solicitud / enlace público.
    allowed_payment_methods: Mapped[Optional[list[Any]]] = mapped_column(JSON, nullable=True)
    #: Si no es null y no está vacío, solo estas cuentas de depósito se muestran en el portal.
    allowed_deposit_account_ids: Mapped[Optional[list[Any]]] = mapped_column(JSON, nullable=True)
    #: Identificador público único para `/portal/recharge/{link_hash}` (enlaces legados).
    link_hash: Mapped[Optional[str]] = mapped_column(String(40), nullable=True, unique=True, index=True)
    #: Moneda en la que se cobra el importe de esta solicitud (portal + admin).
    recharge_currency: Mapped[str] = mapped_column(
        String(10),
        nullable=False,
        server_default=text("'USD'"),
    )
    #: Tasa informativa: unidades de ``recharge_currency`` por 1 USD (misma convención que ventas).
    recharge_exchange_rate: Mapped[float] = mapped_column(Float, nullable=False, server_default=text("1"))
    #: Comprobante opcional que el admin adjunta al crear la solicitud (referencia para el cliente).
    admin_precheck_receipt_url: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)
    #: Cuenta de depósito que el cliente declara en el portal al enviar comprobante.
    portal_submitted_deposit_account_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    #: Importe que el cliente declara haber pagado (validado con IA en frontend).
    portal_declared_payment_amount: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    #: Importe reconocido acumulado contra la solicitud (no supera ``amount_requested``).
    amount_paid: Mapped[float] = mapped_column(Float, nullable=False, server_default=text("0"))
    #: Saldo pendiente de esta recarga (normalmente ``amount_requested - amount_paid``).
    balance_pending: Mapped[float] = mapped_column(Float, nullable=False)
    #: Excedente acumulado enviado a ``Client.credit_balance`` (CxC saldo a favor).
    surplus_credited: Mapped[float] = mapped_column(Float, nullable=False, server_default=text("0"))
    #: Nota interna editable desde administración de recargas.
    admin_note: Mapped[Optional[str]] = mapped_column(String(2048), nullable=True)

    #: Líneas de detalle opcionales (multilinea, JSON).
    recharge_detail_lines: Mapped[Optional[list[Any]]] = mapped_column(JSON, nullable=True)

    #: Importe declarado por el admin/distribuidor en USD al crear/editar la solicitud.
    declared_deposit_usd: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    #: El cliente corrigió manualmente el monto detectado por IA en el portal.
    is_manually_edited: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    #: Confianza 0–100 de la lectura IA del último comprobante portal.
    ai_confidence_score: Mapped[Optional[int]] = mapped_column(Integer, nullable=True, server_default=text("100"))

    client: Mapped["Client"] = relationship(back_populates="wallet_recharge_requests")
