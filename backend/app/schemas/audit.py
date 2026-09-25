from __future__ import annotations

import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict


class AuditLogRow(BaseModel):
    """Fila de listado: SIN before/after (evita arrastrar JSONB pesado en cada página)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    timestamp: datetime.datetime
    actor_type: str
    actor_id: Optional[int] = None
    actor_label: Optional[str] = None
    ip: Optional[str] = None
    request_id: Optional[str] = None
    action: str
    entity_table: str
    entity_id: Optional[str] = None
    changed_fields: Optional[list[str]] = None


class AuditLogDetail(AuditLogRow):
    """Detalle: incluye before/after completos."""

    user_agent: Optional[str] = None
    before: Optional[dict[str, Any]] = None
    after: Optional[dict[str, Any]] = None
    meta: Optional[dict[str, Any]] = None


class AuditLogPage(BaseModel):
    items: list[AuditLogRow]
    next_cursor: Optional[int] = None
    has_more: bool = False
    total: Optional[int] = None


class AuditTableInfo(BaseModel):
    table: str
    label: str
