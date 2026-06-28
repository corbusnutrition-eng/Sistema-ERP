"""Dashboard de red BaaS del portal (árbol + métricas agregadas)."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime

from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.wallet_transaction import WalletTransaction
from app.services.baas_commission_cascade_service import (
    TX_NETWORK_PROFIT,
    TX_WALLET_DEPOSIT,
    _convert_amount_to_currency,
)
from app.services.client_currency_service import get_client_currency
from app.services.client_reseller_service import build_distributor_tree_node
from app.timezone_utils import ECUADOR_TZ, ensure_aware, now_ecuador


def _wallet_tx_currency(description: str | None) -> str:
    desc_raw = (description or "").strip()
    if " · " in desc_raw:
        tail = desc_raw.rsplit(" · ", 1)[-1].strip()
        if len(tail) >= 3:
            return normalize_currency_code(tail, "USD")
    return "USD"


def _is_network_commission_tx(tx: WalletTransaction) -> bool:
    tx_type = str(tx.transaction_type or "")
    if tx_type == TX_NETWORK_PROFIT:
        return True
    if tx_type == TX_WALLET_DEPOSIT:
        desc = (tx.description or "").strip()
        return desc.startswith("Comisión por red")
    return False


def _monthly_network_commissions(db: Session, client_id: int, target_currency: str) -> float:
    now = now_ecuador()
    month_start = datetime(now.year, now.month, 1, tzinfo=ECUADOR_TZ)
    total = 0.0
    commission_txs = (
        db.query(WalletTransaction)
        .filter(
            WalletTransaction.client_id == int(client_id),
            WalletTransaction.transaction_type.in_((TX_WALLET_DEPOSIT, TX_NETWORK_PROFIT)),
        )
        .all()
    )
    for tx in commission_txs:
        if not _is_network_commission_tx(tx):
            continue
        try:
            amt = float(tx.amount or 0)
        except (TypeError, ValueError):
            continue
        if amt <= 1e-9:
            continue
        created = getattr(tx, "created_at", None)
        if created is None or ensure_aware(created) < month_start:
            continue
        tx_cur = _wallet_tx_currency(tx.description)
        total += _convert_amount_to_currency(db, amt, tx_cur, target_currency)
    return round(max(0.0, total), 2)


def _aggregate_tree_metrics(tree: dict[str, object]) -> tuple[int, int, float, dict[int, int]]:
    """Retorna (descendants_count, active_descendants, total_balance_all_nodes, level_counts)."""
    level_counts: dict[int, int] = defaultdict(int)
    network_count = 0
    active_count = 0
    total_balance = 0.0

    def walk(node: dict[str, object], *, is_root: bool) -> None:
        nonlocal network_count, active_count, total_balance
        nivel = int(node.get("nivel") or 1)
        level_counts[nivel] += 1
        try:
            total_balance += float(node.get("wallet_balance") or 0)
        except (TypeError, ValueError):
            pass
        if not is_root:
            network_count += 1
            status = str(node.get("status") or "Activo").strip().lower()
            if status != "inactivo":
                active_count += 1
        for child in node.get("children") or []:
            if isinstance(child, dict):
                walk(child, is_root=False)

    walk(tree, is_root=True)
    return network_count, active_count, round(total_balance, 2), dict(level_counts)


def build_portal_network_dashboard(db: Session, root: Client) -> dict[str, object]:
    """Árbol recursivo + KPIs globales + conteo por nivel para el portal del distribuidor."""
    tree = build_distributor_tree_node(db, root)
    root_cur = normalize_currency_code(get_client_currency(root), "USD")
    network_count, active_count, total_balance, level_counts = _aggregate_tree_metrics(tree)
    total_commissions = _monthly_network_commissions(db, int(root.id), root_cur)

    return {
        "tree": tree,
        "metrics": {
            "total_network_count": int(network_count),
            "active_clients_count": int(active_count),
            "total_network_balance": float(total_balance),
            "total_commissions": float(total_commissions),
            "currency": root_cur,
        },
        "level_counts": [
            {"level": int(level), "count": int(count)}
            for level, count in sorted(level_counts.items())
        ],
    }
