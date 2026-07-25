"""wallet_recharge_requests.assigned_package_prices JSON snapshot

Revision ID: f7b2c4d5
Revises: e6a1b2c3
Create Date: 2026-07-25

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "f7b2c4d5"
down_revision = "e6a1b2c3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "wallet_recharge_requests",
        sa.Column("assigned_package_prices", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("wallet_recharge_requests", "assigned_package_prices")
