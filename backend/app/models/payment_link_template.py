from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import ForeignKey, JSON, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class PaymentLinkTemplate(Base):
    """Plantilla de links de pago por método, módulo y (opcional) producto."""

    __tablename__ = "payment_link_templates"
    __table_args__ = (
        UniqueConstraint(
            "payment_method_id",
            "module_type",
            "product_id",
            name="uq_payment_link_tpl_pm_module_product",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    payment_method_id: Mapped[int] = mapped_column(
        ForeignKey("payment_methods.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    module_type: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    product_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("products.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    links: Mapped[Optional[list[Any]]] = mapped_column(JSON, nullable=True)

    payment_method = relationship("PaymentMethod", lazy="joined")
    product = relationship("Product", lazy="joined")
