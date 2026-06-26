"""journal_entry_lines.verification_status — verificación bancaria inline en libro mayor.

Revision ID: a2f8e1c4
Revises: 9b4c6d8e
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "a2f8e1c4"
down_revision = "9b4c6d8e"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "journal_entry_lines",
        sa.Column("verification_status", sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("journal_entry_lines", "verification_status")
