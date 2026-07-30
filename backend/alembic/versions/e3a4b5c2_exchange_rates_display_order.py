"""Añade display_order a exchange_rates.

Revision ID: e3a4b5c2
Revises: d2f9a3b1
Create Date: 2026-07-30
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "e3a4b5c2"
down_revision = "d2f9a3b1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "exchange_rates",
        sa.Column("display_order", sa.Integer(), server_default="0", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("exchange_rates", "display_order")
