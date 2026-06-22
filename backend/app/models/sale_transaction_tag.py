"""Etiquetas agrupadas para ventas (QuickBooks-style). Distintas del catálogo CRM `tags` (UUID)."""

from __future__ import annotations

from sqlalchemy import Column, ForeignKey, Integer, String, Table
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

sale_tag_association = Table(
    "sale_tag_association",
    Base.metadata,
    Column("sale_id", ForeignKey("sales.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", ForeignKey("sale_tags.id", ondelete="CASCADE"), primary_key=True),
)


class TagGroup(Base):
    __tablename__ = "tag_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    color: Mapped[str] = mapped_column(String(32), nullable=False, server_default="#2563EB")

    tags: Mapped[list["SaleTransactionTag"]] = relationship(
        back_populates="group",
        cascade="all, delete-orphan",
    )


class SaleTransactionTag(Base):
    """Etiqueta de venta (tabla física `sale_tags`; nombre de clase evita colisión con CRM Tag)."""

    __tablename__ = "sale_tags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    group_id: Mapped[int] = mapped_column(ForeignKey("tag_groups.id", ondelete="CASCADE"), nullable=False, index=True)

    group: Mapped["TagGroup"] = relationship(back_populates="tags")
