"""wallet_recharge_requests.is_client_initiated

Revision ID: b1e4f8a2
Revises: a9c3e7f2
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "b1e4f8a2"
down_revision = "a9c3e7f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "wallet_recharge_requests",
        sa.Column(
            "is_client_initiated",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.execute(
        """
        UPDATE wallet_recharge_requests
        SET is_client_initiated = true
        WHERE admin_note ILIKE '%Solicitud creada por el cliente desde el portal.%'
        """
    )


def downgrade() -> None:
    op.drop_column("wallet_recharge_requests", "is_client_initiated")
