#!/usr/bin/env python3
"""
Limpieza total de datos operativos para preparar producción.

Vacía inventario, clientes, ventas, billetera BaaS, notificaciones y movimientos contables.
Conserva el plan de cuentas (``accounts``), ``users`` (Master Admin / ERP) y
``alembic_version`` (historial de migraciones). Los saldos de ``accounts`` se
reinician a 0 tras borrar asientos y transacciones.

Uso (desde ``backend/``):

    PYTHONPATH=. python scripts/wipe_test_data.py

Sin confirmación interactiva (Render / CI):

    PYTHONPATH=. python scripts/wipe_test_data.py --yes

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

from app.database import DATABASE_URL, engine  # noqa: E402

# Tablas operativas solicitadas + dependientes directas para TRUNCATE limpio.
OPERATIONAL_TABLES: tuple[str, ...] = (
    # Ventas y pagos
    "payment_allocations",
    "client_debt_payments",
    "sale_tag_association",
    "inventory_screen_credit_drawdown",
    "sales",
    "client_payments",
    # Billetera BaaS
    "wallet_transactions",
    "wallet_recharge_requests",
    # Contabilidad
    "journal_entry_lines",
    "journal_entries",
    "transactions",
    # Notificaciones
    "client_notifications",
    # Clientes y red
    "client_product_prices",
    "client_payment_method_accounts",
    "client_payment_methods",
    "client_notes",
    "clients",
    # Inventario y catálogo
    "screen_stock",
    "iptv_screens",
    "iptv_accounts",
    "product_package_catalog",
    "products",
    "distributor_custom_prices",
    "payment_link_templates",
    "inventory_audit_reports",
    # CxP / gastos (referencian accounts; se vacían para evitar facturas huérfanas)
    "vendor_payment_lines",
    "vendor_payments",
    "vendor_bill_lines",
    "vendor_bills",
    "expense_lines",
    "expenses",
    "vendors",
)

PRESERVED_TABLES: tuple[str, ...] = (
    "users",
    "accounts",
    "alembic_version",
    "payment_methods",
    "transaction_classes",
    "tags",
    "tag_groups",
    "sale_tags",
    "catalog_package_types",
    "exchange_rates",
    "system_notifications",
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
    for name in OPERATIONAL_TABLES:
        print(f"  • {name}")

    print("\n=== Tablas que NO se tocan ===")
    for name in PRESERVED_TABLES:
        print(f"  • {name}")

    print(
        "\n=== Ajustes posteriores ===\n"
        "  • accounts.current_balance y accounts.balance → 0 (plan de cuentas conservado)\n"
        "  • users.wallet_balance → 0 (cuentas ERP conservadas)\n"
        "  • users.parent_id → NULL (árbol distribuidor limpio)\n"
    )


def _reset_account_balances_zero(conn) -> int:
    result = conn.execute(
        text(
            """
            UPDATE accounts
            SET current_balance = 0,
                balance = 0
            """
        )
    )
    return int(result.rowcount or 0)


def _reset_users_after_wipe(conn) -> int:
    result = conn.execute(
        text(
            """
            UPDATE users
            SET wallet_balance = 0,
                parent_id = NULL
            """
        )
    )
    return int(result.rowcount or 0)


def _verify_post_cleanup(conn) -> None:
    for table in OPERATIONAL_TABLES:
        n = _count(conn, table)
        if n != 0:
            raise RuntimeError(f"Tras el wipe, {table} aún tiene {n} fila(s).")

    users_n = _count(conn, "users")
    if users_n == 0:
        raise RuntimeError(
            "La tabla users quedó vacía. Aborta: no ejecutes este script si no hay admin."
        )

    alembic_n = _count(conn, "alembic_version")
    if alembic_n == 0:
        raise RuntimeError("alembic_version quedó vacía; el historial de migraciones se perdió.")

    accounts_n = _count(conn, "accounts")
    if accounts_n == 0:
        raise RuntimeError("La tabla accounts quedó vacía; el plan de cuentas se perdió.")

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


def _run_wipe() -> dict[str, int]:
    tables_sql = ",\n    ".join(OPERATIONAL_TABLES)
    truncate_sql = f"TRUNCATE TABLE\n    {tables_sql}\nRESTART IDENTITY CASCADE;"

    stats: dict[str, int] = {}
    with engine.begin() as conn:
        print("\n[1/4] TRUNCATE de tablas operativas …")
        conn.execute(text(truncate_sql))
        for table in OPERATIONAL_TABLES:
            print(f"      ✓ {table}")

        print("\n[2/4] Reiniciando saldos del plan de cuentas …")
        stats["accounts_reset"] = _reset_account_balances_zero(conn)
        print(f"      → {stats['accounts_reset']} cuenta(s) contable(s) → saldo 0.00")

        print("\n[3/4] Reiniciando saldos de usuarios ERP …")
        stats["users_reset"] = _reset_users_after_wipe(conn)
        print(f"      → {stats['users_reset']} usuario(s) actualizado(s)")

        print("\n[4/4] Verificación …")
        _verify_post_cleanup(conn)

    return stats


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Wipe total de datos operativos (preparación producción).",
    )
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Ejecutar sin confirmación interactiva.",
    )
    args = parser.parse_args()

    _require_postgresql()
    _print_plan()

    db_label = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else DATABASE_URL
    print(f"\nBase de datos: {db_label}")

    if not args.yes:
        answer = input(
            "\n⚠️  ¿Vaciar TODOS los datos operativos? Esta acción es IRREVERSIBLE.\n"
            "Escriba SI para continuar: "
        ).strip().lower()
        if answer not in ("si", "sí", "s", "yes", "y"):
            print("Operación cancelada. No se modificó la base de datos.")
            return 0

    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))

    try:
        stats = _run_wipe()
    except Exception as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        return 1

    users_kept = 0
    accounts_kept = 0
    with engine.connect() as conn:
        users_kept = _count(conn, "users")
        accounts_kept = _count(conn, "accounts")

    print(
        f"\n✓ Limpieza completada.\n"
        f"  • {users_kept} usuario(s) ERP conservado(s) (incl. Master Admin).\n"
        f"  • {accounts_kept} cuenta(s) del plan contable conservada(s) (saldos en 0).\n"
        f"  • Esquema y alembic_version intactos.\n"
        f"  • {stats.get('users_reset', 0)} usuario(s) con billetera reiniciada.\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
