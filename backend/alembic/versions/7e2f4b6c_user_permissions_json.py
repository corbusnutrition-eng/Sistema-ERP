"""users.permissions — permisos granulares RBAC (JSON).

Revision ID: 7e2f4b6c
Revises: 6d1e3a5b
Create Date: 2026-06-23
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "7e2f4b6c"
down_revision = "6d1e3a5b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "permissions",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "permissions")
