"""Tabla audit_logs: bitacora before/after de entidades clave.

Revision ID: k2l3m4n5
Revises: j1k2l3m4
Create Date: 2026-09-15
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "k2l3m4n5"
down_revision = "j1k2l3m4"
branch_labels = None
depends_on = None

_JSONB = postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite")
_ARRAY_TEXT = postgresql.ARRAY(sa.Text()).with_variant(sa.JSON(), "sqlite")
_BIG_PK = sa.BigInteger().with_variant(sa.Integer(), "sqlite")


def upgrade() -> None:
    op.create_table(
        "audit_logs",
        sa.Column("id", _BIG_PK, autoincrement=True, nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("actor_type", sa.String(length=20), server_default="system", nullable=False),
        sa.Column("actor_id", sa.Integer(), nullable=True),
        sa.Column("actor_label", sa.String(length=200), nullable=True),
        sa.Column("ip", sa.String(length=45), nullable=True),
        sa.Column("user_agent", sa.String(length=300), nullable=True),
        sa.Column("request_id", sa.String(length=64), nullable=True),
        sa.Column("action", sa.String(length=16), nullable=False),
        sa.Column("entity_table", sa.String(length=63), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=True),
        sa.Column("before", _JSONB, nullable=True),
        sa.Column("after", _JSONB, nullable=True),
        sa.Column("changed_fields", _ARRAY_TEXT, nullable=True),
        sa.Column("meta", _JSONB, nullable=True),
        sa.PrimaryKeyConstraint("id"),
        # Sin FK a users/clients: actor_id es polimorfico y la bitacora debe
        # ser inmutable e independiente del ciclo de vida del actor.
    )
    op.create_index("ix_audit_logs_timestamp", "audit_logs", ["timestamp"])
    op.create_index("ix_audit_logs_entity", "audit_logs", ["entity_table", "entity_id", "timestamp"])
    op.create_index("ix_audit_logs_actor", "audit_logs", ["actor_type", "actor_id", "timestamp"])
    op.create_index("ix_audit_logs_request_id", "audit_logs", ["request_id"])
    op.create_index("ix_audit_logs_table_ts", "audit_logs", ["entity_table", "timestamp"])

    if op.get_bind().dialect.name == "postgresql":
        op.create_index(
            "ix_audit_logs_changed_fields",
            "audit_logs",
            ["changed_fields"],
            postgresql_using="gin",
        )
        # Defensa en profundidad: la bitacora es append-only tambien a nivel BD.
        # Solo el rol dueño (el que ejecuta migraciones y el script de purga)
        # puede borrar/actualizar filas.
        op.execute("REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC")


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.drop_index("ix_audit_logs_changed_fields", table_name="audit_logs")
    op.drop_index("ix_audit_logs_table_ts", table_name="audit_logs")
    op.drop_index("ix_audit_logs_request_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_actor", table_name="audit_logs")
    op.drop_index("ix_audit_logs_entity", table_name="audit_logs")
    op.drop_index("ix_audit_logs_timestamp", table_name="audit_logs")
    op.drop_table("audit_logs")
