"""Añade reglas de tolerancia a exchange_rates.

Revision ID: f4a5b6c3
Revises: e3a4b5c2
Create Date: 2026-07-30
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "f4a5b6c3"
down_revision = "e3a4b5c2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "exchange_rates",
        sa.Column("tolerance_type", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "exchange_rates",
        sa.Column("tolerance_value", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("exchange_rates", "tolerance_value")
    op.drop_column("exchange_rates", "tolerance_type")
