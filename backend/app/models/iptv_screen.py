from __future__ import annotations

from typing import Optional

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class IPTVScreen(Base):
    __tablename__ = "iptv_screens"
    __table_args__ = (
        CheckConstraint("screen_number >= 1 AND screen_number <= 3", name="ck_screen_number_range"),
        UniqueConstraint("iptv_account_id", "screen_number", name="uq_account_screen_number"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    iptv_account_id: Mapped[int] = mapped_column(
        ForeignKey("iptv_accounts.id"),
        nullable=False,
        index=True,
    )
    screen_number: Mapped[int] = mapped_column(nullable=False)
    is_available: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    client_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("clients.id"),
        nullable=True,
        index=True,
    )

    iptv_account: Mapped["IPTVAccount"] = relationship(back_populates="screens")
    client: Mapped[Optional["Client"]] = relationship(back_populates="screens")
    sales: Mapped[list["Sale"]] = relationship(back_populates="screen")
