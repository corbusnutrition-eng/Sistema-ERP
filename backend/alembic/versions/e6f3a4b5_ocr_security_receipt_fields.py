"""client_payments + wallet_recharge_requests OCR security fields.

Revision ID: e6f3a4b5
Revises: d5e2f3a4
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "e6f3a4b5"
down_revision = "d5e2f3a4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "client_payments",
        sa.Column(
            "is_manually_edited",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "client_payments",
        sa.Column(
            "ai_confidence_score",
            sa.Integer(),
            nullable=True,
            server_default=sa.text("100"),
        ),
    )
    op.add_column(
        "wallet_recharge_requests",
        sa.Column(
            "is_manually_edited",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "wallet_recharge_requests",
        sa.Column(
            "ai_confidence_score",
            sa.Integer(),
            nullable=True,
            server_default=sa.text("100"),
        ),
    )


def downgrade() -> None:
    op.drop_column("wallet_recharge_requests", "ai_confidence_score")
    op.drop_column("wallet_recharge_requests", "is_manually_edited")
    op.drop_column("client_payments", "ai_confidence_score")
    op.drop_column("client_payments", "is_manually_edited")
