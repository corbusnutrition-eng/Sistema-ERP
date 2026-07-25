"""wallet_recharge_requests.payment_method_id for portal checkout sync

Revision ID: e6a1b2c3
Revises: d5e8f3a1
Create Date: 2026-07-25

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "e6a1b2c3"
down_revision = "d5e8f3a1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "wallet_recharge_requests",
        sa.Column("payment_method_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_wallet_recharge_requests_payment_method_id",
        "wallet_recharge_requests",
        ["payment_method_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_wallet_recharge_requests_payment_method_id", table_name="wallet_recharge_requests")
    op.drop_column("wallet_recharge_requests", "payment_method_id")
