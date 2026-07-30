"""Añade wallet_credit_usd a wallet_recharge_requests.

Revision ID: g8h9i0j1
Revises: f4a5b6c3
Create Date: 2026-07-30
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "g8h9i0j1"
down_revision = "f4a5b6c3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "wallet_recharge_requests",
        sa.Column("wallet_credit_usd", sa.Float(), nullable=True),
    )
    op.execute(
        """
        UPDATE wallet_recharge_requests
        SET wallet_credit_usd = ROUND(
            COALESCE(amount_requested, 0) + COALESCE(discount, 0),
            2
        )
        WHERE wallet_credit_usd IS NULL
          AND UPPER(TRIM(COALESCE(recharge_currency, 'USD'))) = 'USD'
        """
    )
    op.execute(
        """
        UPDATE wallet_recharge_requests
        SET wallet_credit_usd = ROUND(
            (COALESCE(amount_requested, 0) + COALESCE(discount, 0))
            / NULLIF(COALESCE(recharge_exchange_rate, 1), 0),
            2
        )
        WHERE wallet_credit_usd IS NULL
          AND UPPER(TRIM(COALESCE(recharge_currency, 'USD'))) <> 'USD'
          AND COALESCE(recharge_exchange_rate, 0) > 0
        """
    )


def downgrade() -> None:
    op.drop_column("wallet_recharge_requests", "wallet_credit_usd")
