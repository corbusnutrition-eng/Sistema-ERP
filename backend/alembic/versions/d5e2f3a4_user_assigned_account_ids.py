"""users.assigned_account_ids — cuentas asignadas al verificador.

Revision ID: d5e2f3a4
Revises: c4d8e1f2
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "d5e2f3a4"
down_revision = "c4d8e1f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("assigned_account_ids", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "assigned_account_ids")
