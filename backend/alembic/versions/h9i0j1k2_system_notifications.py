"""Tabla system_notifications para alertas internas del ERP.

Revision ID: h9i0j1k2
Revises: g8h9i0j1
Create Date: 2026-07-30
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "h9i0j1k2"
down_revision = "g8h9i0j1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "system_notifications",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("provider", sa.String(length=80), nullable=True),
        sa.Column("package_name", sa.String(length=120), nullable=True),
        sa.Column("remaining_count", sa.Integer(), nullable=True),
        sa.Column("is_read", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_system_notifications_kind", "system_notifications", ["kind"], unique=False)
    op.create_index("ix_system_notifications_created_at", "system_notifications", ["created_at"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_system_notifications_created_at", table_name="system_notifications")
    op.drop_index("ix_system_notifications_kind", table_name="system_notifications")
    op.drop_table("system_notifications")
