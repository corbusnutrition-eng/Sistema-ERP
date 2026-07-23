"""payment_link_templates table

Revision ID: b3d6e0f4
Revises: b2c5d9e3
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "b3d6e0f4"
down_revision = "b2c5d9e3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "payment_link_templates",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("payment_method_id", sa.Integer(), nullable=False),
        sa.Column("module_type", sa.String(length=16), nullable=False),
        sa.Column("product_id", sa.Integer(), nullable=True),
        sa.Column("links", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["payment_method_id"], ["payment_methods.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["product_id"], ["products.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "payment_method_id",
            "module_type",
            "product_id",
            name="uq_payment_link_tpl_pm_module_product",
        ),
    )
    op.create_index(
        "ix_payment_link_templates_payment_method_id",
        "payment_link_templates",
        ["payment_method_id"],
    )
    op.create_index(
        "ix_payment_link_templates_module_type",
        "payment_link_templates",
        ["module_type"],
    )
    op.create_index(
        "ix_payment_link_templates_product_id",
        "payment_link_templates",
        ["product_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_payment_link_templates_product_id", table_name="payment_link_templates")
    op.drop_index("ix_payment_link_templates_module_type", table_name="payment_link_templates")
    op.drop_index("ix_payment_link_templates_payment_method_id", table_name="payment_link_templates")
    op.drop_table("payment_link_templates")
