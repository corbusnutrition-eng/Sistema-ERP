#!/usr/bin/env python3
"""
Siembra del Plan de Cuentas maestro según la taxonomía en ``app.account_structure``.

Ejecutar desde el directorio backend:
    PYTHONPATH=. python seed_accounts.py

Requiere DATABASE_URL (o el valor por defecto en app.database).
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

from sqlalchemy.orm import Session

from app.account_structure import ACCOUNT_STRUCTURE
from app.currency_utils import normalize_currency_code
from app.database import SessionLocal
from app.models.account import Account

OPENING = Decimal("0.0000")
AS_OF = date(2026, 5, 13)


def _ledger_for_group(categoria: str, tipo: str) -> str:
    for g in ACCOUNT_STRUCTURE.get(categoria, []):
        if g["tipo"] == tipo:
            return g["account_type"]
    raise ValueError(f"Grupo no encontrado: {categoria} / {tipo}")


# Cuentas sembradas: una por cada detalle de los 6 grupos estrictos.
SEED_ROWS: list[dict[str, str]] = [
    # ACTIVOS — Activos Corrientes
    {"name": "Inventario", "cat": "ACTIVOS", "tipo": "Activos Corrientes", "detail": "Inventario", "currency": "USD"},
    {"name": "Fondos sin depositar", "cat": "ACTIVOS", "tipo": "Activos Corrientes", "detail": "Fondos sin depositar", "currency": "USD"},
    {"name": "Anticipo empleados", "cat": "ACTIVOS", "tipo": "Activos Corrientes", "detail": "Anticipo empleados", "currency": "USD"},
    # RESPONSABILIDAD — Cuentas por pagar
    {"name": "Cuentas por pagar", "cat": "RESPONSABILIDAD", "tipo": "Cuentas por pagar", "detail": "Cuentas por pagar", "currency": "USD"},
    {"name": "Anticipos de clientes", "cat": "RESPONSABILIDAD", "tipo": "Cuentas por pagar", "detail": "Anticipos de clientes", "currency": "USD"},
    {"name": "Saldos a favor", "cat": "RESPONSABILIDAD", "tipo": "Cuentas por pagar", "detail": "Saldos a favor", "currency": "USD"},
    # INGRESOS
    {"name": "Venta de productos y Servicios", "cat": "INGRESOS", "tipo": "Ingresos", "detail": "Venta de productos y Servicios", "currency": "USD"},
    {"name": "Ingresos recarga de saldo", "cat": "INGRESOS", "tipo": "Ingresos", "detail": "Ingresos recarga de saldo", "currency": "USD"},
    {"name": "Otros ingresos principales", "cat": "INGRESOS", "tipo": "Ingresos", "detail": "Otros ingresos principales", "currency": "USD"},
    # GASTO — Gastos
    {"name": "Deudas incobrables", "cat": "GASTO", "tipo": "Gastos", "detail": "Deudas incobrables", "currency": "USD"},
    {"name": "Gastos administrativos", "cat": "GASTO", "tipo": "Gastos", "detail": "Gastos administrativos", "currency": "USD"},
    {"name": "Gasto nómina", "cat": "GASTO", "tipo": "Gastos", "detail": "Gasto nómina", "currency": "USD"},
    {"name": "Tasas y comisiones", "cat": "GASTO", "tipo": "Gastos", "detail": "Tasas y comisiones", "currency": "USD"},
    {"name": "Publicidad y Promoción", "cat": "GASTO", "tipo": "Gastos", "detail": "Publicidad y Promoción", "currency": "USD"},
    {"name": "Reparación y mantenimiento", "cat": "GASTO", "tipo": "Gastos", "detail": "Reparación y mantenimiento", "currency": "USD"},
    {"name": "Suministros y materiales", "cat": "GASTO", "tipo": "Gastos", "detail": "Suministros y materiales", "currency": "USD"},
    {"name": "Comida y ocio", "cat": "GASTO", "tipo": "Gastos", "detail": "Comida y ocio", "currency": "USD"},
    {"name": "Servicios varios", "cat": "GASTO", "tipo": "Gastos", "detail": "Servicios varios", "currency": "USD"},
    # GASTO — Costos de venta
    {"name": "Descuentos", "cat": "GASTO", "tipo": "Costos de venta", "detail": "Descuentos", "currency": "USD"},
    {"name": "Otros costos de venta", "cat": "GASTO", "tipo": "Costos de venta", "detail": "Otros", "currency": "USD"},
    # GASTO — Otros gastos
    {"name": "Pérdida de cambio", "cat": "GASTO", "tipo": "Otros gastos", "detail": "Pérdida de cambio", "currency": "USD"},
    {"name": "Otros gastos", "cat": "GASTO", "tipo": "Otros gastos", "detail": "Otros gastos", "currency": "USD"},
    {"name": "Liquidaciones", "cat": "GASTO", "tipo": "Otros gastos", "detail": "Liquidaciones", "currency": "USD"},
]


def seed_accounts(db: Session) -> tuple[int, int]:
    inserted = 0
    skipped = 0

    for row in SEED_ROWS:
        name = str(row["name"]).strip()
        detail = str(row["detail"]).strip()[:64]
        currency = normalize_currency_code(row["currency"])
        ledger = _ledger_for_group(row["cat"], row["tipo"])

        dup = (
            db.query(Account.id)
            .filter(Account.name == name, Account.currency == currency, Account.parent_id.is_(None))
            .first()
        )
        if dup:
            skipped += 1
            print(f"[omitir] Ya existe (nombre+moneda): {name!r} ({currency})")
            continue

        acc = Account(
            code=f"COA-{uuid.uuid4().hex[:12]}",
            name=name,
            account_number=None,
            account_type=ledger,
            detail_type=detail or None,
            description=None,
            parent_id=None,
            currency=currency,
            opening_balance=OPENING,
            opening_balance_date=AS_OF,
            current_balance=OPENING,
            balance=OPENING,
            is_active=True,
        )
        db.add(acc)
        inserted += 1

    db.commit()
    return inserted, skipped


def main() -> None:
    db = SessionLocal()
    try:
        ins, sk = seed_accounts(db)
        print(f"Listo: {ins} cuenta(s) insertadas, {sk} omitida(s) por duplicado.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
