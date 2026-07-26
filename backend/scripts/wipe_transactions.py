#!/usr/bin/env python3
"""
Wipe de datos transaccionales para entornos de prueba.

Elimina ventas, recargas BaaS, cobros CxC, asientos contables y movimientos de
billetera virtual. Conserva catálogos maestros: usuarios, clientes/distribuidores,
productos, plan de cuentas (filas), métodos de pago e inventario IPTV/bodega.

Los links de pago por transacción (``sales.payment_token``, ``wallet_recharge_requests``)
se borran con sus tablas. El token permanente del portal del cliente
(``clients.payment_token``) se conserva.

Uso (desde ``backend/``):

    PYTHONPATH=. python scripts/wipe_transactions.py

En Render / CI (sin prompt interactivo):

    PYTHONPATH=. python scripts/wipe_transactions.py --yes

Requiere PostgreSQL (``DATABASE_URL`` en ``.env`` o entorno).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import text

_backend_dir = Path(__file__).resolve().parent.parent
_repo_root = _backend_dir.parent
load_dotenv(_repo_root / ".env")
load_dotenv(_backend_dir / ".env")

from app.database import DATABASE_URL, SessionLocal, engine  # noqa: E402

# Tablas transaccionales (PostgreSQL resuelve FKs con TRUNCATE … CASCADE).
TRANSACTIONAL_TABLES: tuple[str, ...] = (
    "journal_entry_lines",
    "journal_entries",
    "transactions",
    "payment_allocations",
    "sale_tag_association",
    "inventory_screen_credit_drawdown",
    "sales",
    "client_payments",
    "client_debt_payments",
    "wallet_transactions",
    "wallet_recharge_requests",
)

PRESERVED_LABELS: tuple[str, ...] = (
    "users (admin / operadores / distribuidores ERP)",
    "clients (CRM + token permanente del portal)",
    "accounts (plan de cuentas — filas conservadas, saldos reiniciados)",
    "payment_methods, products, transaction_classes, tags",
    "client_payment_methods / client_payment_method_accounts (prefs CRM)",
    "iptv_accounts, iptv_screens, screen_stock (inventario físico)",
    "vendors, expenses (no incluidos en este wipe)",
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


def _count(conn, table: str) -> int:
    row = conn.execute(text(f"SELECT COUNT(*) AS n FROM {table}")).mappings().first()
    return int(row["n"]) if row else 0


def _print_plan() -> None:
    print("\n=== Tablas que se vaciarán (TRUNCATE … RESTART IDENTITY CASCADE) ===")
    for name in TRANSACTIONAL_TABLES:
        print(f"  • {name}")

    print("\n=== Se conservan (sin borrar filas maestras) ===")
    for label in PRESERVED_LABELS:
        print(f"  • {label}")

    print(
        "\n=== Ajustes posteriores ===\n"
        "  • screen_stock / iptv_screens liberados de reservas de prueba\n"
        "  • products: contadores reserved/assigned → 0\n"
        "  • accounts.current_balance y accounts.balance → 0.00\n"
        "  • clients: wallet_balance, credit_balance, total_credits → 0\n"
        "  • users.wallet_balance → 0\n"
        "  • custom_fields: wallet_balances_by_currency / credit_balance_by_currency eliminados\n"
    )


def _release_screen_stock(conn) -> int:
    result = conn.execute(
        text(
            """
            UPDATE screen_stock
            SET status = 'free', sale_id = NULL, client_id = NULL
            WHERE status IN ('reserved', 'assigned', 'held')
               OR sale_id IS NOT NULL
               OR client_id IS NOT NULL
            """
        )
    )
    return int(result.rowcount or 0)


def _release_iptv_screens(conn) -> int:
    result = conn.execute(
        text(
            """
            UPDATE iptv_screens
            SET is_available = TRUE, client_id = NULL
            WHERE client_id IS NOT NULL OR is_available IS FALSE
            """
        )
    )
    return int(result.rowcount or 0)


def _reset_product_sale_counters(conn) -> int:
    result = conn.execute(
        text(
            """
            UPDATE products
            SET inventory_credit_reserved_qty = 0, inventory_credit_assigned_qty = 0
            """
        )
    )
    return int(result.rowcount or 0)


def _reset_account_balances_zero(conn) -> int:
    result = conn.execute(
        text(
            """
            UPDATE accounts
            SET current_balance = 0, balance = 0
            """
        )
    )
    return int(result.rowcount or 0)


def _reset_client_balances(conn) -> int:
    result = conn.execute(
        text(
            """
            UPDATE clients
            SET
                wallet_balance = 0,
                credit_balance = 0,
                total_credits = 0,
                last_recharge = NULL,
                custom_fields = CASE
                    WHEN custom_fields IS NULL THEN '{}'::jsonb
                    ELSE custom_fields
                        - 'wallet_balances_by_currency'
                        - 'credit_balance_by_currency'
                END
            """
        )
    )
    return int(result.rowcount or 0)


def _reset_user_wallet_balances(conn) -> int:
    result = conn.execute(text("UPDATE users SET wallet_balance = 0"))
    return int(result.rowcount or 0)


def _verify_post_cleanup(conn) -> None:
    for table in TRANSACTIONAL_TABLES:
        n = _count(conn, table)
        if n != 0:
            raise RuntimeError(f"Tras el wipe, {table} aún tiene {n} fila(s).")

    residual = conn.execute(
        text(
            """
            SELECT COUNT(*) AS n FROM accounts
            WHERE ABS(COALESCE(current_balance, 0)) > 0.000001
               OR ABS(COALESCE(balance, 0)) > 0.000001
            """
        )
    ).mappings().first()
    if int(residual["n"] or 0) > 0:
        raise RuntimeError("Quedaron cuentas con saldo distinto de cero.")

    for label, sql in (
        ("clients.wallet_balance", "SELECT COUNT(*) AS n FROM clients WHERE ABS(COALESCE(wallet_balance,0))>1e-6"),
        ("clients.credit_balance", "SELECT COUNT(*) AS n FROM clients WHERE ABS(COALESCE(credit_balance,0))>1e-6"),
        ("users.wallet_balance", "SELECT COUNT(*) AS n FROM users WHERE ABS(COALESCE(wallet_balance,0))>1e-6"),
    ):
        row = conn.execute(text(sql)).mappings().first()
        if int(row["n"] or 0) > 0:
            raise RuntimeError(f"Quedaron registros con {label} distinto de cero.")


def _run_wipe() -> dict[str, int]:
    tables_sql = ",\n    ".join(TRANSACTIONAL_TABLES)
    truncate_sql = f"TRUNCATE TABLE\n    {tables_sql}\nRESTART IDENTITY CASCADE;"

    db = SessionLocal()
    stats: dict[str, int] = {}
    try:
        print("\n[1/4] Liberando reservas de inventario ligadas a ventas de prueba …")
        stats["screen_stock_liberadas"] = _release_screen_stock(db)
        stats["iptv_screens_liberadas"] = _release_iptv_screens(db)
        print(f"      → {stats['screen_stock_liberadas']} fila(s) en screen_stock")
        print(f"      → {stats['iptv_screens_liberadas']} fila(s) en iptv_screens")

        print("\n[2/4] TRUNCATE de tablas transaccionales …")
        db.execute(text(truncate_sql))
        for table in TRANSACTIONAL_TABLES:
            print(f"      ✓ {table}")

        print("\n[3/4] Reiniciando saldos y contadores …")
        stats["products_reset"] = _reset_product_sale_counters(db)
        stats["accounts_reset"] = _reset_account_balances_zero(db)
        stats["clients_reset"] = _reset_client_balances(db)
        stats["users_reset"] = _reset_user_wallet_balances(db)
        print(f"      → {stats['products_reset']} producto(s): contadores de preventa")
        print(f"      → {stats['accounts_reset']} cuenta(s) contables → saldo 0.00")
        print(f"      → {stats['clients_reset']} cliente(s): billetera + saldo a favor")
        print(f"      → {stats['users_reset']} usuario(s): billetera BaaS")

        print("\n[4/4] Verificación …")
        _verify_post_cleanup(db)

        db.commit()
        return stats
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Wipe transaccional para entorno de pruebas.")
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Ejecutar sin confirmación interactiva (Render / CI).",
    )
    args = parser.parse_args()

    _require_postgresql()
    _print_plan()

    db_label = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else DATABASE_URL
    print(f"\nBase de datos: {db_label}")

    if not args.yes:
        answer = input(
            "\n¿Borrar TODAS las transacciones de prueba y reiniciar saldos? (escriba SI): "
        ).strip().lower()
        if answer not in ("si", "sí", "s", "yes", "y"):
            print("Operación cancelada. No se modificó la base de datos.")
            return 0

    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))

    try:
        _run_wipe()
    except Exception as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        return 1

    print(
        "\n✓ Wipe completado.\n"
        "  Ventas, recargas, cobros, asientos contables y movimientos BaaS eliminados.\n"
        "  Saldos de cuentas y billeteras reiniciados a 0.00.\n"
        "  Catálogos maestros e inventario conservados."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
