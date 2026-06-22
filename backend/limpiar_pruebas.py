#!/usr/bin/env python3
"""
Limpieza de datos transaccionales para pasar a producción.

Conserva catálogos maestros, clientes, usuarios/distribuidores e inventario IPTV
(recargas ``iptv_accounts``, bodega ``screen_stock``, productos).

Elimina ventas, cobros CxC, contabilidad, gastos, facturas de proveedor de prueba,
recargas BaaS (solicitudes + movimientos de billetera), notificaciones y notas de actividad.
Tras el TRUNCATE, pone en cero saldos CxC, billetera BaaS (columna y ``wallet_balances_by_currency``)
y saldo a favor de todos los clientes/usuarios.

Ejecutar desde ``backend/``:

    PYTHONPATH=. python limpiar_pruebas.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import text

# ── Entorno y sesión ERP ──────────────────────────────────────────────────────

_backend_dir = Path(__file__).resolve().parent
_repo_root = _backend_dir.parent
load_dotenv(_repo_root / ".env")
load_dotenv(_backend_dir / ".env")

from app.database import DATABASE_URL, SessionLocal, engine  # noqa: E402


# Tablas transaccionales (TRUNCATE conjunto; PostgreSQL resuelve FKs con CASCADE).
TRANSACTIONAL_TABLES: tuple[str, ...] = (
    # Libro mayor / legacy transactions
    "journal_entry_lines",
    "journal_entries",
    "transactions",
    # Ventas y vínculos
    "payment_allocations",
    "sale_tag_association",
    "inventory_screen_credit_drawdown",
    "sales",
    # Cobros CxC y abonos portal
    "client_payments",
    "client_debt_payments",
    # Gastos operativos
    "expense_lines",
    "expenses",
    # Cuentas por pagar (facturas/pagos a proveedores ligados a recargas de prueba)
    "vendor_payment_lines",
    "vendor_payments",
    "vendor_bill_lines",
    "vendor_bills",
    # BaaS — billeteras virtuales (orden: allocations → movimientos → solicitudes)
    "wallet_transactions",
    "wallet_recharge_requests",
    # Notificaciones y notas de actividad
    "client_notifications",
    "client_notes",
)

# Maestros que NO se truncan ni eliminan.
PRESERVED_TABLES: tuple[str, ...] = (
    "users",
    "clients",
    "client_payment_methods",
    "client_payment_method_accounts",
    "client_product_prices",
    "distributor_custom_prices",
    "accounts",
    "payment_methods",
    "products",
    "catalog_package_types",
    "product_package_catalog",
    "vendors",
    "tag_groups",
    "sale_tags",
    "tags",
    "transaction_classes",
    # Inventario IPTV físico / recargas
    "iptv_accounts",
    "iptv_screens",
    "screen_stock",
)


def _require_postgresql() -> None:
    url = (DATABASE_URL or "").strip()
    if url.startswith("sqlite"):
        print(
            "ERROR: DATABASE_URL apunta a SQLite. Este script solo debe usarse con PostgreSQL.",
            file=sys.stderr,
        )
        sys.exit(1)
    if not url.startswith("postgresql"):
        scheme = url.split(":", 1)[0] if url else "(vacío)"
        print(f"ERROR: Esquema de base de datos no soportado: {scheme}", file=sys.stderr)
        sys.exit(1)


def _print_plan() -> None:
    print("\n=== Se ELIMINARÁN todas las filas (TRUNCATE … RESTART IDENTITY CASCADE) ===")
    for name in TRANSACTIONAL_TABLES:
        print(f"  • {name}")

    print("\n=== Se CONSERVAN (sin TRUNCATE) ===")
    for name in PRESERVED_TABLES:
        print(f"  • {name}")

    print(
        "\n=== Ajustes posteriores (misma transacción) ===\n"
        "  • Pantallas de bodega liberadas (screen_stock → free, sin venta/cliente)\n"
        "  • Pantallas IPTV legacy liberadas (iptv_screens disponibles)\n"
        "  • Contadores de preventas en products (reserved/assigned → 0; se conserva opening/recargas)\n"
        "  • Saldos cacheados del plan de cuentas → saldo de apertura\n"
        "  • BaaS: clients/users.wallet_balance → 0 y custom_fields.wallet_balances_by_currency eliminado\n"
        "  • CxC: clients.credit_balance → 0 y custom_fields.credit_balance_by_currency eliminado\n"
    )


def _count(conn, table: str) -> int:
    row = conn.execute(text(f"SELECT COUNT(*) AS n FROM {table}")).mappings().first()
    return int(row["n"]) if row else 0


def _release_screen_stock(conn) -> int:
    result = conn.execute(
        text(
            """
            UPDATE screen_stock
            SET
                status = 'free',
                sale_id = NULL,
                client_id = NULL
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
            SET
                is_available = TRUE,
                client_id = NULL
            WHERE client_id IS NOT NULL
               OR is_available IS FALSE
            """
        )
    )
    return int(result.rowcount or 0)


def _reset_product_sale_counters(conn) -> int:
    """Solo contadores ligados a ventas borradas; no toca recargas ni opening_qty."""
    result = conn.execute(
        text(
            """
            UPDATE products
            SET
                inventory_credit_reserved_qty = 0,
                inventory_credit_assigned_qty = 0
            """
        )
    )
    return int(result.rowcount or 0)


def _reset_account_cached_balances(conn) -> int:
    result = conn.execute(
        text(
            """
            UPDATE accounts
            SET
                current_balance = COALESCE(opening_balance, 0),
                balance = COALESCE(opening_balance, 0)
            """
        )
    )
    return int(result.rowcount or 0)


def _reset_client_transactional_balances(conn) -> int:
    """No borra clientes; limpia saldos CxC, billetera BaaS y saldo a favor."""
    result = conn.execute(
        text(
            """
            UPDATE clients
            SET
                credit_balance = 0,
                wallet_balance = 0,
                total_credits = 0,
                last_recharge = NULL,
                custom_fields = CASE
                    WHEN custom_fields IS NULL THEN '{}'::jsonb
                    ELSE custom_fields
                        - 'credit_balance_by_currency'
                        - 'wallet_balances_by_currency'
                END
            """
        )
    )
    return int(result.rowcount or 0)


def _reset_user_wallet_balances(conn) -> int:
    result = conn.execute(
        text(
            """
            UPDATE users
            SET wallet_balance = 0
            """
        )
    )
    return int(result.rowcount or 0)


def _verify_baas_zero(conn) -> None:
    """Comprueba ledger BaaS vacío y saldos virtuales en cero (columna + custom_fields)."""
    for table in ("wallet_recharge_requests", "wallet_transactions"):
        n = _count(conn, table)
        if n != 0:
            raise RuntimeError(f"Tras la limpieza, {table} aún tiene {n} fila(s).")

    row = conn.execute(
        text(
            """
            SELECT COUNT(*) AS n
            FROM clients
            WHERE ABS(COALESCE(wallet_balance, 0)) > 0.000001
               OR (
                    custom_fields IS NOT NULL
                    AND custom_fields ? 'wallet_balances_by_currency'
               )
            """
        )
    ).mappings().first()
    residual_clients = int(row["n"]) if row else 0
    if residual_clients > 0:
        raise RuntimeError(
            f"Tras la limpieza, {residual_clients} cliente(s) aún tienen saldo BaaS "
            "(wallet_balance o wallet_balances_by_currency)."
        )

    row_u = conn.execute(
        text(
            """
            SELECT COUNT(*) AS n
            FROM users
            WHERE ABS(COALESCE(wallet_balance, 0)) > 0.000001
            """
        )
    ).mappings().first()
    residual_users = int(row_u["n"]) if row_u else 0
    if residual_users > 0:
        raise RuntimeError(
            f"Tras la limpieza, {residual_users} usuario(s) aún tienen wallet_balance distinto de cero."
        )


def _verify_post_cleanup(conn) -> None:
    for table in (
        "journal_entry_lines",
        "journal_entries",
        "transactions",
        "sales",
        "client_payments",
        "client_debt_payments",
        "client_notifications",
        "client_notes",
        "expenses",
        "vendor_bills",
    ):
        n = _count(conn, table)
        if n != 0:
            raise RuntimeError(f"Tras la limpieza, {table} aún tiene {n} fila(s).")

    _verify_baas_zero(conn)

    row = conn.execute(
        text(
            """
            SELECT
                COALESCE(SUM(inventory_credit_reserved_qty), 0) AS res,
                COALESCE(SUM(inventory_credit_assigned_qty), 0) AS asn
            FROM products
            """
        )
    ).mappings().first()
    if float(row["res"] or 0) > 0 or float(row["asn"] or 0) > 0:
        raise RuntimeError("Contadores reserved/assigned en products no quedaron en cero.")

    clients_n = _count(conn, "clients")
    products_n = _count(conn, "products")
    iptv_n = _count(conn, "iptv_accounts")
    stock_n = _count(conn, "screen_stock")
    print(
        f"✓ Catálogo intacto: {clients_n} cliente(s), {products_n} producto(s), "
        f"{iptv_n} recarga(s) IPTV, {stock_n} unidad(es) en bodega."
    )


def _run_cleanup() -> None:
    tables_sql = ",\n    ".join(TRANSACTIONAL_TABLES)
    truncate_sql = f"TRUNCATE TABLE\n    {tables_sql}\nRESTART IDENTITY CASCADE;"

    db = SessionLocal()
    try:
        print("\nLiberando bodega y pantallas IPTV antes de borrar ventas …")
        stock_rows = _release_screen_stock(db)
        screen_rows = _release_iptv_screens(db)
        print(f"  • {stock_rows} fila(s) en screen_stock liberadas")
        print(f"  • {screen_rows} fila(s) en iptv_screens liberadas")

        print("\nEjecutando TRUNCATE de tablas transaccionales …")
        db.execute(text(truncate_sql))

        prod_rows = _reset_product_sale_counters(db)
        acct_rows = _reset_account_cached_balances(db)
        cli_rows = _reset_client_transactional_balances(db)
        usr_rows = _reset_user_wallet_balances(db)

        _verify_post_cleanup(db)

        db.commit()
        print(f"\n✓ {prod_rows} producto(s): contadores de preventa reiniciados.")
        print(f"✓ {acct_rows} cuenta(s) contables: saldo cache = apertura.")
        print(f"✓ {cli_rows} cliente(s): saldos CxC/billetera BaaS reiniciados (registros conservados).")
        print(f"✓ {usr_rows} usuario(s): saldo BaaS virtual reiniciado.")
        print("✓ BaaS: sin recargas, sin movimientos de billetera, saldos virtuales en cero.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def main() -> int:
    _require_postgresql()
    _print_plan()

    db_label = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else DATABASE_URL
    print(f"\nBase de datos: {db_label}")

    answer = input("\n¿Estás seguro de borrar todas las ventas y contabilidad? (s/n): ").strip().lower()
    if answer not in ("s", "si", "sí", "yes", "y"):
        print("Operación cancelada. No se modificó la base de datos.")
        return 0

    # Verificar conexión antes de mutar.
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))

    try:
        _run_cleanup()
    except Exception as exc:
        print(f"\nERROR al limpiar la base de datos: {exc}", file=sys.stderr)
        return 1

    print(
        "\n✓ Limpieza completada: sin ventas, cobros, contabilidad, BaaS ni notificaciones de prueba.\n"
        "  Catálogo de productos, clientes, usuarios e inventario IPTV (recargas + bodega) conservados."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
