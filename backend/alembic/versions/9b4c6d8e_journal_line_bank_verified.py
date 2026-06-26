"""journal_entry_lines.is_bank_verified — conciliación bancaria en dos pasos.

Revision ID: 9b4c6d8e
Revises: 8f3a5c7d
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "9b4c6d8e"
down_revision = "8f3a5c7d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "journal_entry_lines",
        sa.Column(
            "is_bank_verified",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    # Movimientos históricos: no exigir verificación retroactiva.
    op.execute("UPDATE journal_entry_lines SET is_bank_verified = TRUE")


def downgrade() -> None:
    op.drop_column("journal_entry_lines", "is_bank_verified")
