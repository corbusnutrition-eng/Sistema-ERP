"""journal_entry_lines.verified_at — timestamp de confirmación bancaria.

Revision ID: b3c9d2e5
Revises: a2f8e1c4
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "b3c9d2e5"
down_revision = "a2f8e1c4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "journal_entry_lines",
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("journal_entry_lines", "verified_at")
