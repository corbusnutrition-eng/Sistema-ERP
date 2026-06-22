from __future__ import annotations

import enum
from typing import Optional

from sqlalchemy import Boolean, Enum, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class UserRole(str, enum.Enum):
    admin = "admin"
    worker = "worker"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, name="user_role_enum"),
        nullable=False,
        default=UserRole.worker,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # Multinivel / BaaS — jerarquía de distribuidores y saldo virtual
    parent_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    wallet_balance: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    referral_code: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, unique=True, index=True)

    #: Jerarquía multinivel — lado «uno»: `remote_side` debe ser la PK (`users.id`), no la FK.
    parent: Mapped[Optional["User"]] = relationship(
        "User",
        remote_side="User.id",
        foreign_keys=[parent_id],
        back_populates="children",
    )
    children: Mapped[list["User"]] = relationship(
        "User",
        foreign_keys=[parent_id],
        back_populates="parent",
    )
    wallet_transactions: Mapped[list["WalletTransaction"]] = relationship(
        "WalletTransaction",
        back_populates="user",
        cascade="all, delete-orphan",
    )
