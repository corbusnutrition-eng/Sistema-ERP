"""Añade is_active a exchange_rates.

Revision ID: d2f9a3b1
Revises: c1e8f9a2
Create Date: 2026-07-30
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "d2f9a3b1"
down_revision = "c1e8f9a2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "exchange_rates",
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("exchange_rates", "is_active")
