"""
Prueba de concurrencia: comisiones BaaS y saldo del distribuidor padre.

Valida que múltiples autocompras simultáneas no pierdan comisiones por race
conditions cuando las transacciones ACID y el bloqueo de fila están activos.

SQLite (local):
  - Prueba integridad transaccional (suma exacta de comisiones acreditadas).
  - ``FOR UPDATE`` se omite en SQLite; no simula bloqueo real entre hilos.

PostgreSQL (CI / staging):
  - Ejecutar con ``TEST_DATABASE_URL`` o ``DATABASE_URL`` apuntando a Postgres
    para validar también el row-level locking real.

Comando:
  cd backend && PYTHONPATH=. pytest tests/test_baas_concurrency.py -v
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.client import Client
from app.models.wallet_transaction import WalletTransaction
from app.services.baas_commission_cascade_service import TX_WALLET_DEPOSIT
from app.services.portal_auto_purchase_service import execute_portal_auto_purchase
from app.services.wallet_balance_service import get_client_wallet_balance


def _database_dialect_name(session: Session) -> str:
    bind = session.get_bind()
    return str(getattr(getattr(bind, "dialect", None), "name", "") or "")


def _run_auto_purchase_worker(
    session_factory,
    *,
    child_id: int,
    package_catalog_id: int,
) -> dict[str, object]:
    """Ejecuta una autocompra en su propia sesión SQLAlchemy (thread-safe)."""
    db = session_factory()
    try:
        child = db.get(Client, int(child_id))
        if child is None:
            return {"ok": False, "child_id": child_id, "error": "child_not_found"}

        result = execute_portal_auto_purchase(
            db,
            client=child,
            package_catalog_id=int(package_catalog_id),
            quantity=1,
        )
        return {
            "ok": bool(result.ok),
            "child_id": child_id,
            "flow": result.flow,
            "sale_id": result.sale_id,
        }
    except HTTPException as exc:
        db.rollback()
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        return {"ok": False, "child_id": child_id, "error": detail}
    except Exception as exc:
        db.rollback()
        return {"ok": False, "child_id": child_id, "error": str(exc)}
    finally:
        db.close()


@pytest.mark.concurrency
def test_baas_parent_commission_integrity_under_concurrent_auto_purchases(
    db: Session,
    baas_concurrency_harness: dict[str, object],
) -> None:
    """
    Dispara N autocompras en paralelo y verifica que el saldo del padre
    coincida exactamente con N × comisión unitaria.
    """
    parent_id = int(baas_concurrency_harness["parent_id"])
    child_ids = list(baas_concurrency_harness["child_ids"])
    package_catalog_id = int(baas_concurrency_harness["package_catalog_id"])
    commission_per_purchase = float(baas_concurrency_harness["commission_per_purchase"])
    session_factory = baas_concurrency_harness["session_factory"]
    num_children = len(child_ids)

    max_workers = min(num_children, int(os.getenv("BAAS_CONCURRENCY_WORKERS", "20")))

    results: list[dict[str, object]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(
                _run_auto_purchase_worker,
                session_factory,
                child_id=int(child_id),
                package_catalog_id=package_catalog_id,
            )
            for child_id in child_ids
        ]
        for future in as_completed(futures):
            results.append(future.result())

    successes = [r for r in results if r.get("ok")]
    failures = [r for r in results if not r.get("ok")]

    assert len(results) == num_children, "Todas las tareas concurrentes deben reportar resultado"
    assert len(successes) == num_children, (
        f"Se esperaban {num_children} autocompras exitosas; "
        f"éxitos={len(successes)}, fallos={failures}"
    )

    expected_total = round(commission_per_purchase * len(successes), 2)

    parent = db.get(Client, parent_id)
    assert parent is not None, "Distribuidor padre debe existir tras la ráfaga concurrente"

    parent_wallet = float(get_client_wallet_balance(parent, "USD"))
    assert parent_wallet == pytest.approx(expected_total, abs=0.01), (
        f"Saldo padre={parent_wallet} ≠ comisiones esperadas={expected_total} "
        f"({len(successes)} × {commission_per_purchase})"
    )

    commission_txs = (
        db.query(WalletTransaction)
        .filter(
            WalletTransaction.client_id == parent_id,
            WalletTransaction.transaction_type == TX_WALLET_DEPOSIT,
        )
        .all()
    )
    tx_sum = round(sum(float(tx.amount or 0) for tx in commission_txs), 2)
    assert tx_sum == pytest.approx(expected_total, abs=0.01), (
        f"Suma ledger comisiones={tx_sum} ≠ esperado={expected_total}"
    )
    assert len(commission_txs) == len(successes), (
        f"Debe haber {len(successes)} movimientos wallet_deposit; hay {len(commission_txs)}"
    )

    for tx in commission_txs:
        assert float(tx.amount or 0) == pytest.approx(commission_per_purchase, abs=0.01)


@pytest.mark.concurrency
def test_baas_concurrency_environment_note(db: Session) -> None:
    """
    En PostgreSQL valida también el dialecto con soporte ``FOR UPDATE`` real.

    En SQLite este test es informativo (la integridad ACID se valida en el test principal).
    """
    dialect = _database_dialect_name(db)
    if dialect == "sqlite":
        assert dialect == "sqlite"
        return
    assert dialect == "postgresql"
