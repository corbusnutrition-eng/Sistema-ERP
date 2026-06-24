"""clients.contact_phone — soporte BaaS en cascada por parent_id.

Revision ID: 3a7f9c2d
Revises: 2b4c8e1f
Create Date: 2026-06-23
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "3a7f9c2d"
down_revision = "2b4c8e1f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("contact_phone", sa.String(length=30), nullable=True))
    op.execute(
        """
        UPDATE clients
        SET contact_phone = phone
        WHERE contact_phone IS NULL
          AND phone IS NOT NULL
          AND TRIM(phone) <> ''
        """
    )


def downgrade() -> None:
    op.drop_column("clients", "contact_phone")
