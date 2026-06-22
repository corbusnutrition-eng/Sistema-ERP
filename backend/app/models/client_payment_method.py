from __future__ import annotations

from sqlalchemy import ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class ClientPaymentMethod(Base):
    """Métodos de pago habilitados para un cliente en su portal (CRM → portal público)."""

    __tablename__ = "client_payment_methods"
    __table_args__ = (
        UniqueConstraint("client_id", "payment_method_id", name="uq_client_payment_method"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    payment_method_id: Mapped[int] = mapped_column(
        ForeignKey("payment_methods.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    client: Mapped["Client"] = relationship("Client", back_populates="assigned_payment_method_links")
    payment_method: Mapped["PaymentMethod"] = relationship("PaymentMethod")
