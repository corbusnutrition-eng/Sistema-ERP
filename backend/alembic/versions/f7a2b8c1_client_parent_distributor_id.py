"""clients.parent_distributor_id — jerarquía BaaS vs usuarios ERP.

Revision ID: f7a2b8c1
Revises: e6f3a4b5
Create Date: 2026-07-11
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "f7a2b8c1"
down_revision = "e6f3a4b5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("parent_distributor_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_clients_parent_distributor_id_users",
        "clients",
        "users",
        ["parent_distributor_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        op.f("ix_clients_parent_distributor_id"),
        "clients",
        ["parent_distributor_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_clients_parent_distributor_id"), table_name="clients")
    op.drop_constraint("fk_clients_parent_distributor_id_users", "clients", type_="foreignkey")
    op.drop_column("clients", "parent_distributor_id")
