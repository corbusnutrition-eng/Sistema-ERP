"""sales.dismissed_tracked_screen_stock_ids — ocultar filas caducadas en mini-CRM portal.

Revision ID: 5c9d2e4f
Revises: 4b8e1f3a
Create Date: 2026-06-23
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "5c9d2e4f"
down_revision = "4b8e1f3a"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sales",
        sa.Column("dismissed_tracked_screen_stock_ids", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("sales", "dismissed_tracked_screen_stock_ids")
