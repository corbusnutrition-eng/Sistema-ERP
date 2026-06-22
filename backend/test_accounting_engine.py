#!/usr/bin/env python3
"""
Prueba manual del motor contable (partida doble).

Ejecutar desde backend/:
    PYTHONPATH=. python test_accounting_engine.py

Requiere DATABASE_URL y plan de cuentas con pasarelas vinculadas
(linked_wallet_id o linked_payment_method en cuentas ACTIVOS).
"""

from __future__ import annotations

import sys
import uuid
from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.account import Account, LedgerAccountType
from app.models.journal_entry import JournalEntry, JournalEntryLine
from app.models.payment_method import PaymentMethod
from app.services.accounting_engine import (
    EXPENSE_DETAIL_BY_TYPE,
    record_expense_or_commission,
    record_fx_reconciliation,
    record_operating_income,
)


def _q4(v: Decimal | float) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.0001"))


def _find_expense_tipo_for_currency(db: Session, currency: str) -> str:
    """Elige un tipo_gasto cuya cuenta exista en la moneda indicada."""
    cur = currency.upper()
    for tipo, detail in EXPENSE_DETAIL_BY_TYPE.items():
        row = (
            db.query(Account.id)
            .filter(
                Account.is_active.is_(True),
                Account.account_type == LedgerAccountType.expense.value,
                Account.detail_type == detail,
                Account.currency == cur,
            )
            .first()
        )
        if row is not None:
            return tipo
    raise RuntimeError(
        f"No hay cuentas GASTOS ({list(EXPENSE_DETAIL_BY_TYPE.values())}) en moneda {cur}."
    )


def _find_linked_asset(
    db: Session,
    *,
    currency: Optional[str] = None,
) -> tuple[int, str, Account, PaymentMethod]:
    """Devuelve (pasarela_id, moneda, cuenta ACTIVOS, PaymentMethod)."""
    q = db.query(Account).filter(
        Account.is_active.is_(True),
        Account.account_type == LedgerAccountType.asset.value,
    )
    if currency:
        q = q.filter(Account.currency == currency.upper())

    for acc in q.order_by(Account.id.asc()).all():
        if acc.linked_wallet_id is not None:
            pm = db.get(PaymentMethod, int(acc.linked_wallet_id))
            if pm is not None and pm.is_active:
                return int(pm.id), acc.currency, acc, pm
        lm = (acc.linked_payment_method or "").strip()
        if lm:
            pm = (
                db.query(PaymentMethod)
                .filter(PaymentMethod.name == lm, PaymentMethod.is_active.is_(True))
                .first()
            )
            if pm is not None:
                return int(pm.id), acc.currency, acc, pm

    hint = (
        "No hay cuenta ACTIVOS vinculada a una pasarela. "
        "Asigna linked_wallet_id o linked_payment_method en una cuenta de cobro."
    )
    if currency:
        hint += f" (moneda buscada: {currency})"
    raise RuntimeError(hint)


def _print_entry_lines(db: Session, entry_ids: list[int]) -> None:
    if not entry_ids:
        print("\n(No hay asientos que mostrar.)")
        return

    print("\n" + "=" * 72)
    print("LÍNEAS GENERADAS (journal_entry_lines)")
    print("=" * 72)

    grand_dr = Decimal("0")
    grand_cr = Decimal("0")

    for eid in entry_ids:
        entry = db.get(JournalEntry, eid)
        if entry is None:
            print(f"\n[Asiento id={eid}] — no encontrado")
            continue

        lines = (
            db.query(JournalEntryLine, Account)
            .join(Account, Account.id == JournalEntryLine.account_id)
            .filter(JournalEntryLine.journal_entry_id == eid)
            .order_by(JournalEntryLine.id.asc())
            .all()
        )

        entry_dr = sum(_q4(l.debit) for l, _ in lines)
        entry_cr = sum(_q4(l.credit) for l, _ in lines)
        grand_dr += entry_dr
        grand_cr += entry_cr
        balanced = entry_dr == entry_cr

        print(f"\n--- Asiento #{entry.id} | {entry.reference_type} | ref_id={entry.reference_id}")
        print(f"    Fecha: {entry.date} | {entry.description or ''}")
        print(f"    {'Cuenta':<42} {'Débito':>12} {'Crédito':>12}")
        print(f"    {'-' * 42} {'-' * 12} {'-' * 12}")

        for line, acc in lines:
            name = f"{acc.name} ({acc.detail_type or acc.account_type})"
            print(
                f"    {name[:42]:<42} "
                f"{_q4(line.debit):>12} "
                f"{_q4(line.credit):>12}"
            )

        status = "✓ CUADRA" if balanced else "✗ DESCUADRADO"
        print(f"    Subtotal DR={entry_dr} CR={entry_cr} → {status}")

    print("\n" + "-" * 72)
    global_ok = grand_dr == grand_cr
    print(f"TOTAL GLOBAL  DR={grand_dr}  CR={grand_cr}  →  {'✓ PARTIDA DOBLE OK' if global_ok else '✗ ERROR'}")
    print("=" * 72)


def main() -> int:
    db = SessionLocal()
    created_entry_ids: list[int] = []
    run_tag = uuid.uuid4().hex[:8]

    print("Motor contable — prueba de integración")
    print(f"Run tag: {run_tag}")

    try:
        # Preferir pasarela USD: el plan maestro suele tener TICKETS/GASTOS en USD.
        try:
            pasarela_id, currency, asset_acc, pm = _find_linked_asset(db, currency="USD")
        except RuntimeError:
            pasarela_id, currency, asset_acc, pm = _find_linked_asset(db)

        expense_tipo = _find_expense_tipo_for_currency(db, currency)

        print(f"\nPasarela encontrada: id={pasarela_id} name={pm.name!r}")
        print(f"Cuenta ACTIVOS: id={asset_acc.id} name={asset_acc.name!r} moneda={currency}")
        print(f"tipo_gasto usado: {expense_tipo!r} → {EXPENSE_DETAIL_BY_TYPE[expense_tipo]!r}")

        ref_base = int(uuid.uuid4().int % 9_000_000) + 1_000_000

        # 1) Ingreso operativo (venta de servicios)
        print("\n[1/3] record_operating_income (venta_servicios, 150.00)...")
        e1 = record_operating_income(
            db,
            monto=Decimal("150.00"),
            moneda=currency,
            pasarela_id=pasarela_id,
            tipo_ingreso="venta_servicios",
            reference_id=ref_base,
            entry_date=date.today(),
            description=f"TEST|{run_tag}|operating_income",
        )
        created_entry_ids.append(e1.id)
        print(f"      → JournalEntry id={e1.id}")

        # 2) Gasto / comisión
        print(f"\n[2/3] record_expense_or_commission ({expense_tipo}, 12.50)...")
        e2 = record_expense_or_commission(
            db,
            monto=Decimal("12.50"),
            pasarela_id=pasarela_id,
            tipo_gasto=expense_tipo,
            moneda=currency,
            reference_id=ref_base + 1,
            entry_date=date.today(),
            description=f"TEST|{run_tag}|expense_commission",
        )
        created_entry_ids.append(e2.id)
        print(f"      → JournalEntry id={e2.id}")

        # 3) Pérdida por tipo de cambio (recibido < esperado) — siempre USD
        if currency.upper() != "USD":
            fx_pasarela_id, _, _, fx_pm = _find_linked_asset(db, currency="USD")
            print(f"\nFX en USD con pasarela id={fx_pasarela_id} ({fx_pm.name!r})")
        else:
            fx_pasarela_id = pasarela_id

        print("\n[3/3] record_fx_reconciliation (esperado 100.00, recibido 97.50 USD)...")
        e3 = record_fx_reconciliation(
            db,
            monto_esperado_usd=Decimal("100.00"),
            monto_real_recibido=Decimal("97.50"),
            pasarela_id=fx_pasarela_id,
            reference_id=ref_base + 2,
            entry_date=date.today(),
            description=f"TEST|{run_tag}|fx_loss",
        )
        created_entry_ids.append(e3.id)
        print(f"      → JournalEntry id={e3.id}")

        # Verificar persistencia post-commit (nueva lectura en la misma sesión)
        db.expire_all()
        _print_entry_lines(db, created_entry_ids)

        print(f"\nCommits atómicos OK — {len(created_entry_ids)} asiento(s) persistido(s).")
        print("Para limpiar datos de prueba, elimina journal_entries con descripción TEST|" + run_tag)
        return 0

    except Exception as exc:
        db.rollback()
        print(f"\nERROR: {exc}", file=sys.stderr)
        if created_entry_ids:
            print(f"Asientos creados antes del fallo: {created_entry_ids}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
