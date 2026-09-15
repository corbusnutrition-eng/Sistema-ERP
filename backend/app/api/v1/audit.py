"""Consulta de la bitácora de auditoría (solo lectura, inmutable).

No existe endpoint de escritura ni de borrado: la purga es un script con
credenciales de servidor (``scripts/purge_audit_logs.py``), nunca una ruta HTTP.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import Text, cast, func, select
from sqlalchemy.orm import Session

from app.api.v1.dependencies import require_permission
from app.audit.scope import AUDITED
from app.database import get_db
from app.models.audit_log import AuditLog
from app.permissions import AUDIT_LOGS_VIEW
from app.schemas.audit import AuditLogDetail, AuditLogPage, AuditLogRow, AuditTableInfo
from app.timezone_utils import ecuador_day_range_utc

router = APIRouter(prefix="/audit", tags=["audit"])

DbDep = Annotated[Session, Depends(get_db)]
AuditViewDep = Annotated[dict, Depends(require_permission(AUDIT_LOGS_VIEW))]

MAX_PAGE_SIZE = 200
_VALID_ACTIONS = ("insert", "update", "delete", "bulk_update", "bulk_delete")


@router.get("", response_model=AuditLogPage, summary="Listado filtrable de la bitácora")
@router.get("/", response_model=AuditLogPage, include_in_schema=False)
def list_audit_logs(
    db: DbDep,
    _: AuditViewDep,
    entity_table: Optional[str] = Query(None, description="Tabla auditada (ej. 'sales')"),
    entity_id: Optional[str] = Query(None, max_length=64),
    action: Optional[str] = Query(None, pattern="^(insert|update|delete|bulk_update|bulk_delete)$"),
    actor_type: Optional[str] = Query(None, max_length=20),
    actor_id: Optional[int] = Query(None, ge=1),
    actor_q: Optional[str] = Query(None, max_length=120, description="Búsqueda parcial en actor_label"),
    request_id: Optional[str] = Query(None, max_length=64),
    changed_field: Optional[str] = Query(None, max_length=63),
    ip: Optional[str] = Query(None, max_length=45),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    cursor: Optional[int] = Query(None, ge=1, description="Keyset: devuelve filas con id < cursor"),
    limit: int = Query(50, ge=1, le=MAX_PAGE_SIZE),
    with_total: bool = Query(False, description="Calcula el total (COUNT caro; off por defecto)"),
) -> AuditLogPage:
    """
    Paginación **keyset** por ``id`` descendente: estable y O(1) aunque haya
    millones de filas (a diferencia de ``OFFSET``, que degrada linealmente).
    ``cursor`` = ``next_cursor`` de la página anterior.
    """
    if entity_table and entity_table not in AUDITED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tabla no auditada.")

    stmt = select(AuditLog)
    if entity_table:
        stmt = stmt.where(AuditLog.entity_table == entity_table)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == str(entity_id))
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if actor_type:
        stmt = stmt.where(AuditLog.actor_type == actor_type)
    if actor_id is not None:
        stmt = stmt.where(AuditLog.actor_id == actor_id)
    if actor_q:
        stmt = stmt.where(AuditLog.actor_label.ilike(f"%{actor_q.strip()}%"))
    if request_id:
        stmt = stmt.where(AuditLog.request_id == request_id)
    if ip:
        stmt = stmt.where(AuditLog.ip == ip)
    if changed_field:
        if db.get_bind().dialect.name == "postgresql":
            stmt = stmt.where(AuditLog.changed_fields.contains([changed_field]))
        else:
            # SQLite (tests/dev): changed_fields se guarda como JSON plano.
            stmt = stmt.where(cast(AuditLog.changed_fields, Text).like(f'%"{changed_field}"%'))
    if date_from or date_to:
        start, end = ecuador_day_range_utc(date_from or date(1970, 1, 1), date_to or date.today())
        stmt = stmt.where(AuditLog.timestamp >= start, AuditLog.timestamp < end)

    total: Optional[int] = None
    if with_total:
        total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0

    if cursor is not None:
        stmt = stmt.where(AuditLog.id < cursor)

    rows = list(db.scalars(stmt.order_by(AuditLog.id.desc()).limit(limit + 1)))
    has_more = len(rows) > limit
    rows = rows[:limit]

    return AuditLogPage(
        items=[AuditLogRow.model_validate(r) for r in rows],
        next_cursor=(int(rows[-1].id) if rows and has_more else None),
        has_more=has_more,
        total=total,
    )


@router.get(
    "/entity/{entity_table}/{entity_id}",
    response_model=list[AuditLogRow],
    summary="Línea de tiempo completa de una entidad",
)
def entity_timeline(
    entity_table: str, entity_id: str, db: DbDep, _: AuditViewDep, limit: int = Query(200, ge=1, le=500)
) -> list[AuditLogRow]:
    """Usa el índice ``(entity_table, entity_id, timestamp)``."""
    if entity_table not in AUDITED:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Tabla no auditada.")
    rows = db.scalars(
        select(AuditLog)
        .where(AuditLog.entity_table == entity_table, AuditLog.entity_id == str(entity_id))
        .order_by(AuditLog.id.desc())
        .limit(limit)
    )
    return [AuditLogRow.model_validate(r) for r in rows]


@router.get(
    "/request/{request_id}",
    response_model=list[AuditLogDetail],
    summary="Todos los cambios de una misma petición",
)
def request_trace(request_id: str, db: DbDep, _: AuditViewDep) -> list[AuditLogDetail]:
    """Reconstruye una operación completa: una autocompra del portal son ~8-14 filas."""
    rows = db.scalars(select(AuditLog).where(AuditLog.request_id == request_id).order_by(AuditLog.id.asc()))
    return [AuditLogDetail.model_validate(r) for r in rows]


@router.get("/meta/tables", response_model=list[AuditTableInfo], summary="Tablas auditables (para los filtros)")
def audit_tables(_: AuditViewDep) -> list[AuditTableInfo]:
    return [AuditTableInfo(table=spec.table, label=spec.label) for spec in AUDITED.values()]


@router.get("/{audit_id}", response_model=AuditLogDetail, summary="Detalle con before/after completos")
def audit_detail(audit_id: int, db: DbDep, _: AuditViewDep) -> AuditLogDetail:
    row = db.get(AuditLog, audit_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Registro de auditoría no encontrado.")
    return AuditLogDetail.model_validate(row)
