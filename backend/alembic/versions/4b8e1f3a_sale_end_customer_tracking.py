"""sales.end_customer_name / end_customer_phone — seguimiento mini-CRM portal.

Revision ID: 4b8e1f3a
Revises: 3a7f9c2d
Create Date: 2026-06-23
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "4b8e1f3a"
down_revision = "3a7f9c2d"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("sales", sa.Column("end_customer_name", sa.String(length=200), nullable=True))
    op.add_column("sales", sa.Column("end_customer_phone", sa.String(length=30), nullable=True))


def downgrade() -> None:
    op.drop_column("sales", "end_customer_phone")
    op.drop_column("sales", "end_customer_name")
