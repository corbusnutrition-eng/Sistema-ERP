"""sales.discount + wallet_recharge_requests.discount

Revision ID: a8c3d4e5
Revises: f7b2c4d5
Create Date: 2026-07-26

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "a8c3d4e5"
down_revision = "f7b2c4d5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "sales",
        sa.Column("discount", sa.Numeric(18, 4), nullable=False, server_default="0"),
    )
    op.add_column(
        "wallet_recharge_requests",
        sa.Column("discount", sa.Float(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("wallet_recharge_requests", "discount")
    op.drop_column("sales", "discount")
