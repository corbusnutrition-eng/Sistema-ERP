"""telegram_chat_id en users y verifier_id en accounts.

Revision ID: i0j1k2l3
Revises: h9i0j1k2
Create Date: 2026-08-11
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "i0j1k2l3"
down_revision = "h9i0j1k2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("telegram_chat_id", sa.String(length=64), nullable=True))
    op.add_column("accounts", sa.Column("verifier_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_accounts_verifier_id_users",
        "accounts",
        "users",
        ["verifier_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_accounts_verifier_id", "accounts", ["verifier_id"], unique=False)

    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            """
            SELECT id, assigned_account_ids
            FROM users
            WHERE role_template = 'account_verifier'
              AND assigned_account_ids IS NOT NULL
            """
        )
    ).fetchall()

    for user_id, raw_ids in rows:
        if not raw_ids:
            continue
        if isinstance(raw_ids, str):
            try:
                account_ids = json.loads(raw_ids)
            except json.JSONDecodeError:
                continue
        else:
            account_ids = raw_ids
        if not isinstance(account_ids, list):
            continue
        for raw_aid in account_ids:
            try:
                aid = int(raw_aid)
            except (TypeError, ValueError):
                continue
            if aid <= 0:
                continue
            conn.execute(
                sa.text("UPDATE accounts SET verifier_id = :uid WHERE id = :aid"),
                {"uid": int(user_id), "aid": aid},
            )


def downgrade() -> None:
    op.drop_index("ix_accounts_verifier_id", table_name="accounts")
    op.drop_constraint("fk_accounts_verifier_id_users", "accounts", type_="foreignkey")
    op.drop_column("accounts", "verifier_id")
    op.drop_column("users", "telegram_chat_id")
