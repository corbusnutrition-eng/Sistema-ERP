#!/usr/bin/env python3
"""
Asiento de ajuste contable: neutraliza saldo CxC -100 USD (client_payment#5 huérfano).

Corrige un crédito excesivo en Cuentas por Cobrar cuando un cobro de 100 USD
(30-Jul-2026, cliente UNA PANTALLA) quedó sin factura asociada.

Partida doble:
  DR  CxC (CUENTAS POR COBRAR ECUADOR)     +100.00 USD
  CR  Ajustes de Conciliación              +100.00 USD

Uso (desde ``backend/``):

    PYTHONPATH=. python scripts/ajuste_cxc_una_pantalla.py
    PYTHONPATH=. python scripts/ajuste_cxc_una_pantalla.py --dry-run
"""

from __future__ import annotations

import argparse
import sys
import uuid
from datetime import date
from decimal import Decimal
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy.orm import Session

_backend_dir = Path(__file__).resolve().parent.parent
_repo_root = _backend_dir.parent
load_dotenv(_repo_root / ".env")
load_dotenv(_backend_dir / ".env")

from app.database import DATABASE_URL, SessionLocal  # noqa: E402
from app.models.account import Account, LedgerAccountType  # noqa: E402
from app.models.client_payment import ClientPayment  # noqa: E402
from app.models.journal_entry import JournalEntry, JournalReferenceType  # noqa: E402
from app.services.accounting_engine import (  # noqa: E402
    JournalLineDraft,
    _post_journal_atomic,
    _refresh_accounts_balance_cache,
    find_accounts_receivable,
)

ADJUSTMENT_AMOUNT = Decimal("100.00")
ENTRY_DATE = date(2026, 7, 30)
ORPHAN_PAYMENT_ID = 5
CURRENCY = "USD"
CXC_ACCOUNT_NAME = "CUENTAS POR COBRAR ECUADOR"
ADJUSTMENT_ACCOUNT_NAME = "Ajustes de Conciliación"
ENTRY_NOTE = (
    "AJUSTE DE SISTEMA: Neutralización de saldo huérfano "
    f"(client_payment#{ORPHAN_PAYMENT_ID}) del 30-Jul-2026"
)


def _require_postgresql() -> None:
    url = (DATABASE_URL or "").strip()
    if url.startswith("sqlite"):
        print("ERROR: SQLite no soportado. Use PostgreSQL.", file=sys.stderr)
        sys.exit(1)
    if not url.startswith("postgresql"):
        scheme = url.split(":", 1)[0] if url else "(vacío)"
        print(f"ERROR: Esquema de base de datos no soportado: {scheme}", file=sys.stderr)
        sys.exit(1)


def _find_cxc_usd(db: Session) -> Account:
    """Localiza la cuenta CxC USD (prioridad: CUENTAS POR COBRAR ECUADOR)."""
    row = (
        db.query(Account)
        .filter(
            Account.name.ilike(CXC_ACCOUNT_NAME),
            Account.currency == CURRENCY,
            Account.is_active.is_(True),
        )
        .order_by(Account.id.asc())
        .first()
    )
    if row is not None:
        return row

    fallback = find_accounts_receivable(db, CURRENCY)
    if fallback is not None:
        return fallback

    raise RuntimeError(
        f"No se encontró cuenta CxC USD («{CXC_ACCOUNT_NAME}» ni «Cuentas x cobrar (USD)»). "
        "Ejecuta seed_cuentas_regionales.py si el plan está vacío."
    )


def _ensure_adjustment_account(db: Session) -> tuple[Account, bool]:
    """Busca o crea «Ajustes de Conciliación» (gasto, USD)."""
    existing = (
        db.query(Account)
        .filter(
            Account.name.ilike(ADJUSTMENT_ACCOUNT_NAME),
            Account.currency == CURRENCY,
            Account.is_active.is_(True),
        )
        .order_by(Account.id.asc())
        .first()
    )
    if existing is not None:
        return existing, False

    acc = Account(
        code=f"ADJ-{uuid.uuid4().hex[:10]}",
        name=ADJUSTMENT_ACCOUNT_NAME,
        account_number=None,
        account_type=LedgerAccountType.expense.value,
        detail_type="Ajustes de conciliación",
        description="Cuenta puente para ajustes manuales de conciliación CxC.",
        parent_id=None,
        currency=CURRENCY,
        opening_balance=Decimal("0"),
        opening_balance_date=ENTRY_DATE,
        current_balance=Decimal("0"),
        balance=Decimal("0"),
        is_active=True,
    )
    db.add(acc)
    db.flush()
    return acc, True


def _adjustment_already_posted(db: Session) -> JournalEntry | None:
    return (
        db.query(JournalEntry)
        .filter(
            JournalEntry.description == ENTRY_NOTE,
            JournalEntry.reference_type == JournalReferenceType.ajuste_fx.value,
            JournalEntry.reference_id == ORPHAN_PAYMENT_ID,
        )
        .order_by(JournalEntry.id.desc())
        .first()
    )


def run_adjustment(db: Session, *, dry_run: bool = False) -> dict[str, object]:
    payment = db.get(ClientPayment, ORPHAN_PAYMENT_ID)
    payment_label = payment.payment_number if payment is not None else f"id={ORPHAN_PAYMENT_ID}"

    existing = _adjustment_already_posted(db)
    if existing is not None:
        return {
            "status": "skipped",
            "reason": "already_posted",
            "journal_entry_id": int(existing.id),
            "payment_label": payment_label,
        }

    cxc = _find_cxc_usd(db)
    adj_acc, adj_created = _ensure_adjustment_account(db)

    lines = [
        JournalLineDraft(
            account_id=int(cxc.id),
            debit=ADJUSTMENT_AMOUNT,
            credit=Decimal("0"),
            exchange_rate=Decimal("1"),
        ),
        JournalLineDraft(
            account_id=int(adj_acc.id),
            debit=Decimal("0"),
            credit=ADJUSTMENT_AMOUNT,
            exchange_rate=Decimal("1"),
        ),
    ]

    if dry_run:
        db.rollback()
        return {
            "status": "dry_run",
            "payment_label": payment_label,
            "cxc_account_id": int(cxc.id),
            "cxc_account_name": cxc.name,
            "adjustment_account_id": int(adj_acc.id),
            "adjustment_account_created": adj_created,
            "amount": float(ADJUSTMENT_AMOUNT),
            "entry_date": ENTRY_DATE.isoformat(),
            "note": ENTRY_NOTE,
        }

    entry = _post_journal_atomic(
        db,
        entry_date=ENTRY_DATE,
        reference_type=JournalReferenceType.ajuste_fx.value,
        reference_id=ORPHAN_PAYMENT_ID,
        description=ENTRY_NOTE,
        lines=lines,
        fx_weighted=False,
    )

    touched = {int(cxc.id), int(adj_acc.id)}
    _refresh_accounts_balance_cache(db, touched)
    db.commit()

    return {
        "status": "posted",
        "journal_entry_id": int(entry.id),
        "payment_label": payment_label,
        "cxc_account_id": int(cxc.id),
        "cxc_account_name": cxc.name,
        "adjustment_account_id": int(adj_acc.id),
        "adjustment_account_created": adj_created,
        "amount": float(ADJUSTMENT_AMOUNT),
        "entry_date": ENTRY_DATE.isoformat(),
        "note": ENTRY_NOTE,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Asiento de ajuste CxC por cobro huérfano client_payment#5.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Simula el asiento sin persistir cambios.",
    )
    args = parser.parse_args()

    _require_postgresql()
    db_label = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else DATABASE_URL
    print(f"Base de datos: {db_label}")

    db = SessionLocal()
    try:
        result = run_adjustment(db, dry_run=bool(args.dry_run))
    except Exception as exc:
        db.rollback()
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()

    status = str(result.get("status") or "")
    if status == "skipped":
        print(
            f"\n⚠ Asiento ya existente (journal_entry id={result['journal_entry_id']}). "
            "No se duplicó la operación."
        )
        return 0

    if status == "dry_run":
        print("\n[DRY-RUN] Asiento simulado (sin commit):")
        print(f"  • Fecha asiento:     {result['entry_date']}")
        print(f"  • Monto:             {result['amount']:.2f} {CURRENCY}")
        print(f"  • DR CxC:            {result['cxc_account_name']} (id={result['cxc_account_id']})")
        adj_created = "sí" if result.get("adjustment_account_created") else "no"
        print(
            f"  • CR Ajuste:         {ADJUSTMENT_ACCOUNT_NAME} "
            f"(id={result['adjustment_account_id']}, creada={adj_created})"
        )
        print(f"  • Pago referencia:   {result['payment_label']}")
        print(f"  • Nota:              {result['note']}")
        return 0

    print("\n✓ Asiento de ajuste registrado correctamente.")
    print(f"  • journal_entry id:  {result['journal_entry_id']}")
    print(f"  • Fecha asiento:     {result['entry_date']}")
    print(f"  • Monto:             {result['amount']:.2f} {CURRENCY}")
    print(f"  • DR CxC:            {result['cxc_account_name']} (id={result['cxc_account_id']})")
    if result.get("adjustment_account_created"):
        print(f"  • Cuenta creada:     {ADJUSTMENT_ACCOUNT_NAME} (id={result['adjustment_account_id']})")
    else:
        print(f"  • CR Ajuste:         {ADJUSTMENT_ACCOUNT_NAME} (id={result['adjustment_account_id']})")
    print(f"  • Pago referencia:   {result['payment_label']}")
    print(f"  • Nota:              {result['note']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
