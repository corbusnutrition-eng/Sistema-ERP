"""Tabla exchange_rates para tasas Binance P2P.

Revision ID: c1e8f9a2
Revises: a8c3d4e5
Create Date: 2026-07-30
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "c1e8f9a2"
down_revision = "a8c3d4e5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "exchange_rates",
        sa.Column("currency_code", sa.String(length=10), nullable=False),
        sa.Column("binance_rate", sa.Float(), nullable=True),
        sa.Column("manual_rate", sa.Float(), nullable=True),
        sa.Column("use_manual_override", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("currency_code"),
    )


def downgrade() -> None:
    op.drop_table("exchange_rates")
