#!/usr/bin/env python3
"""
Elimina datos transaccionales de prueba preservando usuarios, clientes
(distribuidores vía tabla users/clients según modelo), maestros y plan de cuentas.

Incluye limpieza completa del módulo BaaS (recargas, billeteras, ledger y CxC vinculada).

Ejecución (desde la raíz del repositorio):
  python limpiar_pruebas.py --yes

Requiere DATABASE_URL válida (ej. variables en .env en la raíz del repo).
"""
from __future__ import annotations

import argparse
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND_DIR = ROOT / "backend"


def _configure_path_and_env() -> None:
    if str(BACKEND_DIR) not in sys.path:
        sys.path.insert(0, str(BACKEND_DIR))
    try:
        from dotenv import load_dotenv

        env_repo = ROOT / ".env"
        if env_repo.is_file():
            load_dotenv(env_repo, override=False)
        backend_env = BACKEND_DIR / ".env"
        if backend_env.is_file():
            load_dotenv(backend_env, override=False)
    except ImportError:
        pass


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Borra datos operativos (ventas, CxC, BaaS/billeteras, gastos CxP, libro contable) "
        "y pone en cero saldos contables, billeteras virtuales y saldos a favor de clientes."
    )
    parser.add_argument("--yes", action="store_true", help="Confirmar escritura destructiva.")
    args = parser.parse_args()
    if not args.yes:
        print("Operación omitida (modo seguridad). Vuelva a lanzar con:  python limpiar_pruebas.py --yes")
        return 1

    _configure_path_and_env()

    from sqlalchemy import delete, func, select, update
    from sqlalchemy.orm import Session, attributes

    from app.database import SessionLocal
    from app.models.account import Account
    from app.models.client import Client
    from app.models.client_debt_payment import ClientDebtPayment
    from app.models.client_payment import ClientPayment, PaymentAllocation
    from app.models.expense import Expense, ExpenseLine
    from app.models.iptv_screen import IPTVScreen
    from app.models.inventory_screen_credit_drawdown import InventoryScreenCreditDrawdown
    from app.models.journal_entry import JournalEntry, JournalEntryLine
    from app.models.sale import Sale
    from app.models.sale_transaction_tag import sale_tag_association
    from app.models.screen_stock import ScreenStock
    from app.models.transaction import Transaction as LedgerTransaction
    from app.models.user import User
    from app.models.vendor import VendorBill, VendorBillLine, VendorPayment, VendorPaymentLine
    from app.models.wallet_recharge_request import WalletRechargeRequest
    from app.models.wallet_transaction import WalletTransaction

    session: Session = SessionLocal()
    try:
        rows_out: dict[str, int] = {}

        def run_delete(label: str, stmt) -> None:
            r = session.execute(stmt)
            cnt = int(r.rowcount or 0) if getattr(r, "rowcount", None) is not None else 0
            rows_out[label] = cnt if cnt >= 0 else 0

        # ── Cobros / Cuotas clientes (incluye pagos BaaS en CxC) ───────────
        run_delete("payment_allocations", delete(PaymentAllocation))
        run_delete("client_payments", delete(ClientPayment))
        run_delete("client_debt_payments", delete(ClientDebtPayment))

        # ── BaaS: historial de billetera y solicitudes de recarga ─────────
        run_delete("wallet_transactions", delete(WalletTransaction))
        run_delete("wallet_recharge_requests", delete(WalletRechargeRequest))

        # ── Libro contable (asientos BaaS «recarga», ventas, cobros, etc.) ─
        run_delete("journal_entry_lines", delete(JournalEntryLine))
        run_delete("journal_entries", delete(JournalEntry))
        run_delete("transactions", delete(LedgerTransaction))

        # ── Cuentas por pagar (CxP proveedores) ─────────────────────────
        run_delete("vendor_payment_lines", delete(VendorPaymentLine))
        run_delete("vendor_payments", delete(VendorPayment))
        run_delete("vendor_bill_lines", delete(VendorBillLine))
        run_delete("vendor_bills", delete(VendorBill))

        # ── Gastos registrados (líneas primero por compatibilidad SQLite) ─
        run_delete("expense_lines", delete(ExpenseLine))
        run_delete("expenses", delete(Expense))

        # ── Inventario IPTV relacionado con ventas ────────────────────────
        run_delete("inventory_screen_credit_drawdown", delete(InventoryScreenCreditDrawdown))

        # Asociaciones venta-etiquetas (cabeceras de etiquetas se conservan).
        session.execute(delete(sale_tag_association))

        # ── Ventas ────────────────────────────────────────────────────────
        run_delete("sales", delete(Sale))

        # ── Inventario físico pantallas / lote ────────────────────────────
        session.execute(
            update(ScreenStock)
            .values(
                status="free",
                sale_id=None,
                client_id=None,
            )
        )

        session.execute(update(IPTVScreen).values(client_id=None))

        # ── Cuentas del plan (saldos a cero) ─────────────────────────────
        session.execute(
            update(Account).values(
                current_balance=Decimal("0"),
                balance=Decimal("0"),
                opening_balance=Decimal("0"),
                opening_balance_date=None,
            )
        )

        # ── Clientes: CxC, billetera BaaS y saldos a favor ────────────────
        session.execute(
            update(Client).values(
                total_credits=0.0,
                credit_balance=0.0,
                wallet_balance=0.0,
                last_recharge=None,
            )
        )
        for client in session.scalars(select(Client)).all():
            cf = dict(client.custom_fields or {})
            if cf.pop("credit_balance_by_currency", None) is not None:
                client.custom_fields = cf
                attributes.flag_modified(client, "custom_fields")

        # ── Usuarios distribuidor: saldo virtual BaaS ───────────────────
        session.execute(update(User).values(wallet_balance=0.0))

        session.commit()

        # ── Verificación post-limpieza (BaaS + operaciones) ─────────────
        checks = {
            "wallet_recharge_requests": session.scalar(select(func.count()).select_from(WalletRechargeRequest)),
            "wallet_transactions": session.scalar(select(func.count()).select_from(WalletTransaction)),
            "client_payments": session.scalar(select(func.count()).select_from(ClientPayment)),
            "journal_entries": session.scalar(select(func.count()).select_from(JournalEntry)),
            "sales": session.scalar(select(func.count()).select_from(Sale)),
        }
        residual_wallets = session.scalar(
            select(func.count()).select_from(Client).where(Client.wallet_balance != 0)
        )
        residual_users = session.scalar(
            select(func.count()).select_from(User).where(User.wallet_balance != 0)
        )

        print("Limpieza de transacciones completada con éxito. Saldos en cero.")
        for k, v in sorted(rows_out.items()):
            if v:
                print(f"  · {k}: filas afectadas ≈ {v}")

        problems: list[str] = []
        for table, n in checks.items():
            if int(n or 0) != 0:
                problems.append(f"{table}={n}")
        if int(residual_wallets or 0) != 0:
            problems.append(f"clients.wallet_balance≠0 ({residual_wallets})")
        if int(residual_users or 0) != 0:
            problems.append(f"users.wallet_balance≠0 ({residual_users})")
        if problems:
            print("ADVERTENCIA: residuos detectados tras la limpieza:", ", ".join(problems), file=sys.stderr)
            return 2

        print("✓ BaaS en cero: sin recargas, sin movimientos de billetera, sin saldos virtuales.")
        return 0
    except Exception as exc:  # noqa: BLE001
        session.rollback()
        print(f"Error durante la limpieza: {exc}", file=sys.stderr)
        raise
    finally:
        session.close()


if __name__ == "__main__":
    sys.exit(main())
