#!/usr/bin/env python3
"""
Purga por lotes de ``audit_logs`` con retención diferenciada.

Lo financiero/contable/RBAC se conserva 24 meses (disputas BaaS y requisito
fiscal); el resto (inventario/catálogo/CxP), 6 meses. Purga por lotes de
10.000 con commit por lote — nunca un DELETE monolítico que bloquee la tabla.

Uso (desde ``backend/``):

    PYTHONPATH=. python scripts/purge_audit_logs.py --dry-run
    PYTHONPATH=. python scripts/purge_audit_logs.py

Cron diario 04:00 (hora Ecuador = 09:00 UTC):

    0 9 * * * cd /ruta/backend && PYTHONPATH=. /ruta/venv/bin/python scripts/purge_audit_logs.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from dotenv import load_dotenv

_backend_dir = Path(__file__).resolve().parent.parent
_repo_root = _backend_dir.parent
load_dotenv(_repo_root / ".env")
load_dotenv(_backend_dir / ".env")

from app.audit.context import ACTOR_SYSTEM, audit_actor_scope  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models.audit_log import AuditLog  # noqa: E402
from app.timezone_utils import now_utc  # noqa: E402

DEFAULT_RETENTION_MONTHS = 6
LONG_RETENTION_MONTHS = 24
# Tablas con requisito fiscal / de disputa BaaS: dinero, contabilidad y RBAC.
LONG_RETENTION_TABLES = frozenset(
    {
        "users",
        "clients",
        "sales",
        "client_payments",
        "payment_allocations",
        "client_debt_payments",
        "wallet_transactions",
        "wallet_recharge_requests",
        "transactions",
        "journal_entries",
        "journal_entry_lines",
        "accounts",
        "exchange_rates",
    }
)
BATCH_SIZE = 10_000


def _cutoff(months: int):
    now = now_utc()
    # Aproximación de meses vía días (30.44/mes): suficiente para una política
    # de retención, no para contabilidad — evita depender de dateutil.
    return now - _months_as_timedelta(months)


def _months_as_timedelta(months: int):
    import datetime

    return datetime.timedelta(days=int(months * 30.44))


def _purge_batch(session, table_filter: tuple[str, ...], cutoff) -> int:
    ids = session.scalars(
        AuditLog.__table__.select()
        .with_only_columns(AuditLog.id)
        .where(AuditLog.timestamp < cutoff, AuditLog.entity_table.in_(table_filter))
        .order_by(AuditLog.id)
        .limit(BATCH_SIZE)
    ).all()
    if not ids:
        return 0
    session.execute(AuditLog.__table__.delete().where(AuditLog.id.in_(ids)))
    session.commit()
    return len(ids)


def purge(*, dry_run: bool = False) -> dict[str, int]:
    session = SessionLocal()
    deleted = {"short_retention": 0, "long_retention": 0}
    try:
        short_cutoff = _cutoff(DEFAULT_RETENTION_MONTHS)
        long_cutoff = _cutoff(LONG_RETENTION_MONTHS)

        if dry_run:
            from sqlalchemy import func, select

            short_n = session.scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(AuditLog.timestamp < short_cutoff, ~AuditLog.entity_table.in_(LONG_RETENTION_TABLES))
            )
            long_n = session.scalar(
                select(func.count())
                .select_from(AuditLog)
                .where(AuditLog.timestamp < long_cutoff, AuditLog.entity_table.in_(LONG_RETENTION_TABLES))
            )
            print(f"[dry-run] Elegibles retención corta (<{short_cutoff.date()}): {short_n}")
            print(f"[dry-run] Elegibles retención larga (<{long_cutoff.date()}): {long_n}")
            return {"short_retention": short_n or 0, "long_retention": long_n or 0}

        # Todas las tablas auditadas MENOS las de retención larga.
        from app.audit.scope import AUDITED

        short_tables = tuple(t for t in AUDITED if t not in LONG_RETENTION_TABLES)
        while True:
            n = _purge_batch(session, short_tables, short_cutoff)
            deleted["short_retention"] += n
            if n < BATCH_SIZE:
                break

        long_tables = tuple(LONG_RETENTION_TABLES)
        while True:
            n = _purge_batch(session, long_tables, long_cutoff)
            deleted["long_retention"] += n
            if n < BATCH_SIZE:
                break

        return deleted
    finally:
        session.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Solo cuenta filas elegibles, no borra.")
    args = parser.parse_args()

    with audit_actor_scope(actor_type=ACTOR_SYSTEM, actor_label="purge_audit_logs"):
        result = purge(dry_run=args.dry_run)

    if not args.dry_run:
        total = result["short_retention"] + result["long_retention"]
        print(
            f"Purgadas {result['short_retention']} filas de retención corta "
            f"(> {DEFAULT_RETENTION_MONTHS} meses) y {result['long_retention']} "
            f"de retención larga (> {LONG_RETENTION_MONTHS} meses). Total: {total}."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
