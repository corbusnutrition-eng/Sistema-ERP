#!/usr/bin/env python3
"""
Limpieza total de datos transaccionales (wipe DB) para entornos de prueba en producción.

Conserva:
  - users (accesos admin/operador)
  - accounts (plan de cuentas; saldos se recalculan tras borrar movimientos)
  - Inventario real: products, iptv_accounts, screen_stock, payment_methods, etc.

Borra además:
  - expenses / expense_lines (gastos)
  - vendors y tablas CxP (facturas y pagos a proveedores)

Ejecutar desde el directorio backend:
    PYTHONPATH=. python wipe_production_db.py

Requiere DATABASE_URL (o el valor por defecto en app.database / .env).
"""

from __future__ import annotations

import os
import sys
from decimal import Decimal
from pathlib import Path
from typing import Type

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.account import Account
from app.models.base import Base
from app.models.client import Client
from app.models.client_debt_payment import ClientDebtPayment
from app.models.client_note import ClientNote
from app.models.client_notification import ClientNotification
from app.models.client_payment import ClientPayment, PaymentAllocation
from app.models.client_payment_method import ClientPaymentMethod
from app.models.client_payment_method_account import ClientPaymentMethodAccount
from app.models.client_product_price import ClientProductPrice
from app.models.expense import Expense, ExpenseLine
from app.models.inventory_screen_credit_drawdown import InventoryScreenCreditDrawdown
from app.models.journal_entry import JournalEntry, JournalEntryLine
from app.models.sale import Sale
from app.models.sale_transaction_tag import sale_tag_association
from app.models.transaction import Transaction
from app.models.vendor import Vendor, VendorBill, VendorBillLine, VendorPayment, VendorPaymentLine
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.models.wallet_transaction import WalletTransaction

CONFIRMATION_WORD = "BOMB"

# (orden, etiqueta legible, modelo ORM o tabla asociación)
WIPE_STEPS: list[tuple[int, str, Type[Base] | object]] = [
    # ── 1. Pagos y recargas ───────────────────────────────────────────────────
    (1, "payment_allocations (PaymentAllocation)", PaymentAllocation),
    (2, "client_payments (ClientPayment)", ClientPayment),
    (3, "client_debt_payments (ClientDebtPayment)", ClientDebtPayment),
    (4, "wallet_transactions (WalletTransaction)", WalletTransaction),
    (5, "wallet_recharge_requests (WalletRechargeRequest)", WalletRechargeRequest),
    # ── 2. Finanzas / contabilidad ────────────────────────────────────────────
    (6, "journal_entry_lines (JournalEntryLine)", JournalEntryLine),
    (7, "journal_entries (JournalEntry)", JournalEntry),
    (8, "transactions (Transaction / libro mayor legacy)", Transaction),
    # ── 3. Gastos y proveedores (CxP) ─────────────────────────────────────────
    (9, "expense_lines (ExpenseLine)", ExpenseLine),
    (10, "expenses (Expense)", Expense),
    (11, "vendor_payment_lines (VendorPaymentLine)", VendorPaymentLine),
    (12, "vendor_payments (VendorPayment)", VendorPayment),
    (13, "vendor_bill_lines (VendorBillLine)", VendorBillLine),
    (14, "vendor_bills (VendorBill)", VendorBill),
    (15, "vendors (Vendor)", Vendor),
    # ── 4. Ventas y suscripciones ─────────────────────────────────────────────
    # SaleInvoiceLineItem: JSON embebido en sales.invoice_lines (sin tabla propia).
    # Subscription: vista calculada desde ventas (sin tabla propia).
    (16, "inventory_screen_credit_drawdown", InventoryScreenCreditDrawdown),
    (17, "sale_tag_association (M2M ventas ↔ etiquetas)", sale_tag_association),
    (18, "sales (Sale; incluye invoice_lines / SaleInvoiceLineItem)", Sale),
    # ── 5. Datos ligados a clientes (previo a borrar clients) ─────────────────
    (19, "client_notes", ClientNote),
    (20, "client_notifications", ClientNotification),
    (21, "client_payment_methods", ClientPaymentMethod),
    (22, "client_payment_method_accounts", ClientPaymentMethodAccount),
    (23, "client_product_prices", ClientProductPrice),
    (24, "clients (Client; incluye sub-clientes BaaS)", Client),
]

PRESERVED_TABLES = (
    "users (User)",
    "accounts (Account / catálogo de cuentas)",
    "products, product_package_catalog, catalog_package_types",
    "iptv_accounts, iptv_screens, screen_stock (inventario real)",
    "payment_methods, transaction_classes, tags, sale_tags, tag_groups",
)


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return

    backend_dir = Path(__file__).resolve().parent
    repo_root = backend_dir.parent
    for env_path in (repo_root / ".env", backend_dir / ".env"):
        if env_path.exists():
            load_dotenv(env_path, override=False)
            break


def _confirm() -> bool:
    print("=" * 72)
    print("WIPE DB — LIMPIEZA TOTAL DE DATOS TRANSACCIONALES")
    print("=" * 72)
    print()
    print("Este script BORRARÁ permanentemente los datos transaccionales listados abajo.")
    print("NO se borrarán:", ", ".join(PRESERVED_TABLES))
    print()
    print("Orden de vaciado:")
    for order, label, _ in WIPE_STEPS:
        print(f"  {order:>2}. {label}")
    print()
    print("Notas:")
    print("  - SaleInvoiceLineItem vive en sales.invoice_lines (JSON); se borra con Sale.")
    print("  - Subscription no tiene tabla; se deriva de ventas aprobadas.")
    print("  - Tras el wipe, los saldos de Account se recalculan (solo saldo de apertura).")
    print("  - screen_stock se conserva; se desvincula de ventas/clientes y vuelve a status 'free'.")
    print()
    answer = input(
        "¿Estás seguro de borrar TODA la data transaccional? Escribe BOMB para confirmar: "
    ).strip()
    return answer == CONFIRMATION_WORD


def _delete_rows(db: Session, target: Type[Base] | object) -> int:
    if target is sale_tag_association:
        result = db.execute(sale_tag_association.delete())
        return result.rowcount or 0

    deleted = db.query(target).delete(synchronize_session=False)  # type: ignore[arg-type]
    return int(deleted or 0)


def _unlink_sale_screen_stock_fks(db: Session) -> None:
    """Rompe FK circular sales ↔ screen_stock; conserva inventario real en bodega."""
    db.execute(text("UPDATE sales SET screen_stock_id = NULL WHERE screen_stock_id IS NOT NULL"))
    db.execute(
        text(
            "UPDATE screen_stock SET sale_id = NULL, client_id = NULL, status = 'free' "
            "WHERE sale_id IS NOT NULL OR client_id IS NOT NULL OR status <> 'free'"
        )
    )


def _unlink_iptv_screens_from_clients(db: Session) -> None:
    db.execute(text("UPDATE iptv_screens SET client_id = NULL WHERE client_id IS NOT NULL"))


def _reset_client_hierarchy(db: Session) -> None:
    db.execute(text("UPDATE clients SET parent_id = NULL WHERE parent_id IS NOT NULL"))


def _recalculate_account_balances(db: Session) -> int:
    """Deja current_balance / balance = saldo de apertura (sin movimientos contables)."""
    accounts = db.query(Account).all()
    for acc in accounts:
        opening = acc.opening_balance if acc.opening_balance is not None else Decimal("0")
        acc.current_balance = opening
        acc.balance = opening
    return len(accounts)


def wipe_transactional_data(db: Session) -> dict[str, int]:
    counts: dict[str, int] = {}

    for order, label, model in WIPE_STEPS:
        if model is Sale:
            _unlink_sale_screen_stock_fks(db)
        if model is Client:
            _unlink_iptv_screens_from_clients(db)
            _reset_client_hierarchy(db)

        deleted = _delete_rows(db, model)
        counts[label] = deleted
        print(f"  [{order:>2}] {label}: {deleted} fila(s) borrada(s)")

    accounts_updated = _recalculate_account_balances(db)
    counts["accounts (recalculo de saldos)"] = accounts_updated
    print(f"  [--] accounts (recalculo de saldos): {accounts_updated} cuenta(s) actualizada(s)")

    return counts


def main() -> int:
    _load_dotenv()

    db_url = (os.getenv("DATABASE_URL") or "").strip()
    if not db_url:
        print("Falta DATABASE_URL en el entorno o en .env", file=sys.stderr)
        return 1

    if not _confirm():
        print("Abortado: confirmación incorrecta. No se modificó la base de datos.")
        return 0

    db = SessionLocal()
    try:
        print()
        print("Iniciando wipe...")
        counts = wipe_transactional_data(db)
        db.commit()
        print()
        print("WIPE completado correctamente.")
        total_deleted = sum(v for k, v in counts.items() if k != "accounts (recalculo de saldos)")
        print(f"Total filas transaccionales eliminadas: {total_deleted}")
    except Exception as exc:
        db.rollback()
        print(f"ERROR: se revirtió la transacción. {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
