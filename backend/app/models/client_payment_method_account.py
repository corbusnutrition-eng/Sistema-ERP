from __future__ import annotations

from sqlalchemy import ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class ClientPaymentMethodAccount(Base):
    """Cuentas de depósito (hijas) habilitadas por cliente y método de pago padre."""

    __tablename__ = "client_payment_method_accounts"
    __table_args__ = (
        UniqueConstraint(
            "client_id",
            "payment_method_id",
            "account_id",
            name="uq_client_payment_method_account",
        ),
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
    account_id: Mapped[int] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    client: Mapped["Client"] = relationship("Client", back_populates="assigned_payment_method_account_links")
    payment_method: Mapped["PaymentMethod"] = relationship("PaymentMethod")
    account: Mapped["Account"] = relationship("Account")
