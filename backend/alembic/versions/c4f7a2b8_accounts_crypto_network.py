"""accounts.crypto_network for crypto wallet deposit accounts

Revision ID: c4f7a2b8
Revises: b3d6e0f4
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "c4f7a2b8"
down_revision = "b3d6e0f4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "accounts",
        sa.Column("crypto_network", sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("accounts", "crypto_network")
