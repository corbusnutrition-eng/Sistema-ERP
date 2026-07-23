"""sales + wallet_recharge_requests hotmart_links JSON

Revision ID: b2c5d9e3
Revises: b1e4f8a2
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "b2c5d9e3"
down_revision = "b1e4f8a2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sales",
        sa.Column("hotmart_links", sa.JSON(), nullable=True),
    )
    op.add_column(
        "wallet_recharge_requests",
        sa.Column("hotmart_links", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("wallet_recharge_requests", "hotmart_links")
    op.drop_column("sales", "hotmart_links")
