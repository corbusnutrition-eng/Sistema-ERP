"""Reportes guardados de auditoría de inventario (cuadre IA vs ERP)."""

from __future__ import annotations

import datetime
from typing import Any, Optional

from sqlalchemy import Date, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.models.base import Base
from app.timezone_utils import now_ecuador


class InventoryAuditReport(Base):
    __tablename__ = "inventory_audit_reports"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    account_id: Mapped[int] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    service_name: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    start_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    end_date: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    matched_data: Mapped[list[Any]] = mapped_column(JSON, nullable=False, default=list)
    missing_erp_data: Mapped[list[Any]] = mapped_column(JSON, nullable=False, default=list)
    missing_platform_data: Mapped[list[Any]] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=now_ecuador,
        index=True,
    )

    account: Mapped[Optional["Account"]] = relationship("Account", lazy="joined")
