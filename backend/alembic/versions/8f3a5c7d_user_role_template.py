"""users.role_template — plantilla de rol QBO (cashier, baas_manager, …).

Revision ID: 8f3a5c7d
Revises: 7e2f4b6c
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "8f3a5c7d"
down_revision = "7e2f4b6c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("role_template", sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "role_template")
