"""Índices compuestos CxC: sales(client_id, status) y payment_allocations(sale_id, payment_id).

Revision ID: a9c3e7f2
Revises: f7a2b8c1  (f7a2b8c1_client_parent_distributor_id.py — última migración válida previa)
Create Date: 2026-07-13
"""
from __future__ import annotations

from alembic import op


revision = "a9c3e7f2"
down_revision = "f7a2b8c1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_sales_client_id_status",
        "sales",
        ["client_id", "status"],
        unique=False,
    )
    op.create_index(
        "ix_payment_allocations_sale_id_payment_id",
        "payment_allocations",
        ["sale_id", "payment_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_payment_allocations_sale_id_payment_id", table_name="payment_allocations")
    op.drop_index("ix_sales_client_id_status", table_name="sales")
