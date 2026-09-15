"""Bitácora de auditoría: before/after de cada cambio en entidades clave.

Ver ``app.audit`` para el mecanismo de captura (event listeners de Session) y
``app.audit.scope`` para qué tablas se auditan.
"""

from __future__ import annotations

import datetime
from typing import Any, Optional

from sqlalchemy import JSON, BigInteger, DateTime, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base

# PostgreSQL en prod / SQLite en tests: variantes explícitas.
_JSONB = JSONB().with_variant(JSON(), "sqlite")
_ARRAY_TEXT = ARRAY(Text()).with_variant(JSON(), "sqlite")
# SQLite solo autoincrementa INTEGER PRIMARY KEY (no BIGINT).
_BIG_PK = BigInteger().with_variant(Integer(), "sqlite")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(_BIG_PK, primary_key=True, autoincrement=True)
    timestamp: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), index=True
    )
    #: staff | portal_client | webhook | system | script | anonymous.
    #: VARCHAR libre (no ENUM de BD): un actor nuevo no debe requerir migración.
    actor_type: Mapped[str] = mapped_column(String(20), nullable=False, server_default="system")
    #: Referencia polimórfica (users.id o clients.id según actor_type). Sin FK
    #: a propósito: la bitácora debe sobrevivir a que se borre el actor, y no
    #: se puede tener FK a dos tablas distintas. NULL para el caso límite del
    #: admin mock histórico (ya eliminado) o actores sin id numérico.
    actor_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    #: Email/nombre del actor EN EL MOMENTO del hecho (denormalizado): si el
    #: usuario se renombra o se borra, la bitácora sigue siendo legible.
    actor_label: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    ip: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(300), nullable=True)
    #: Agrupa todas las filas de una misma petición HTTP (una autocompra del
    #: portal genera 8-14 filas). Columna más valiosa para reconstruir un evento.
    request_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    #: insert | update | delete | bulk_update | bulk_delete
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    entity_table: Mapped[str] = mapped_column(String(63), nullable=False)
    #: String, no Integer: hay PKs compuestas (payment_allocations, client_payment_methods).
    entity_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    #: Solo las columnas que cambiaron en `update`; snapshot completo en `delete`; NULL en `insert`.
    before: Mapped[Optional[dict[str, Any]]] = mapped_column(_JSONB, nullable=True)
    #: Solo las columnas que cambiaron en `update`; snapshot completo en `insert`; NULL en `delete`.
    after: Mapped[Optional[dict[str, Any]]] = mapped_column(_JSONB, nullable=True)
    changed_fields: Mapped[Optional[list[str]]] = mapped_column(_ARRAY_TEXT, nullable=True)
    #: ⚠️ NO renombrar a `metadata`: ese nombre está reservado por DeclarativeBase.
    meta: Mapped[Optional[dict[str, Any]]] = mapped_column(_JSONB, nullable=True)

    __table_args__ = (
        Index("ix_audit_logs_entity", "entity_table", "entity_id", "timestamp"),
        Index("ix_audit_logs_actor", "actor_type", "actor_id", "timestamp"),
        Index("ix_audit_logs_request_id", "request_id"),
        Index("ix_audit_logs_table_ts", "entity_table", "timestamp"),
    )
