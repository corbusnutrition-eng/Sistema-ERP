"""payment_allocations: wallet_recharge_id polimórfico (CxC BaaS + ventas).

Revision ID: 2b4c8e1f
Revises: 1de06517a7db
Create Date: 2026-06-22
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "2b4c8e1f"
down_revision = "1de06517a7db"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "payment_allocations",
        sa.Column("wallet_recharge_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        op.f("ix_payment_allocations_wallet_recharge_id"),
        "payment_allocations",
        ["wallet_recharge_id"],
        unique=False,
    )
    op.create_foreign_key(
        "fk_payment_allocations_wallet_recharge_id",
        "payment_allocations",
        "wallet_recharge_requests",
        ["wallet_recharge_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.alter_column("payment_allocations", "sale_id", existing_type=sa.Integer(), nullable=True)


def downgrade() -> None:
    op.alter_column("payment_allocations", "sale_id", existing_type=sa.Integer(), nullable=False)
    op.drop_constraint("fk_payment_allocations_wallet_recharge_id", "payment_allocations", type_="foreignkey")
    op.drop_index(op.f("ix_payment_allocations_wallet_recharge_id"), table_name="payment_allocations")
    op.drop_column("payment_allocations", "wallet_recharge_id")
