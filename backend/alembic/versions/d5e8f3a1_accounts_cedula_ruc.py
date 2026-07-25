"""accounts.cedula_ruc for traditional bank deposit accounts

Revision ID: d5e8f3a1
Revises: c4f7a2b8
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "d5e8f3a1"
down_revision = "c4f7a2b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "accounts",
        sa.Column("cedula_ruc", sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("accounts", "cedula_ruc")
