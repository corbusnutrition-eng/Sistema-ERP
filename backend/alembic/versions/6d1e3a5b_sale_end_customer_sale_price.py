"""sales.end_customer_sale_price — precio cobrado al cliente final (mini-CRM).

Revision ID: 6d1e3a5b
Revises: 5c9d2e4f
Create Date: 2026-06-23
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "6d1e3a5b"
down_revision = "5c9d2e4f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sales",
        sa.Column("end_customer_sale_price", sa.Numeric(precision=18, scale=4), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sales", "end_customer_sale_price")
