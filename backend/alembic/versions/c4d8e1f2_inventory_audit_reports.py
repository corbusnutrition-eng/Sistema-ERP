"""inventory_audit_reports — reportes guardados de auditoría IA.

Revision ID: c4d8e1f2
Revises: b3c9d2e5
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "c4d8e1f2"
down_revision = "b3c9d2e5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "inventory_audit_reports",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("service_name", sa.String(length=120), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=False),
        sa.Column("matched_data", sa.JSON(), nullable=False),
        sa.Column("missing_erp_data", sa.JSON(), nullable=False),
        sa.Column("missing_platform_data", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["accounts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_inventory_audit_reports_account_id", "inventory_audit_reports", ["account_id"])
    op.create_index("ix_inventory_audit_reports_service_name", "inventory_audit_reports", ["service_name"])
    op.create_index("ix_inventory_audit_reports_created_at", "inventory_audit_reports", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_inventory_audit_reports_created_at", table_name="inventory_audit_reports")
    op.drop_index("ix_inventory_audit_reports_service_name", table_name="inventory_audit_reports")
    op.drop_index("ix_inventory_audit_reports_account_id", table_name="inventory_audit_reports")
    op.drop_table("inventory_audit_reports")
