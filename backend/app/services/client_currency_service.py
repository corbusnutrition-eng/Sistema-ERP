"""Moneda base BaaS del cliente (``clients.custom_fields['currency']`` o columna ``currency``)."""

from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client

_CLIENT_CURRENCY_CF_KEY = "currency"
DEFAULT_CLIENT_CURRENCY = "USD"


def get_client_currency(client: Client) -> str:
    raw_col = getattr(client, "currency", None)
    if raw_col is not None and str(raw_col).strip():
        return normalize_currency_code(str(raw_col), DEFAULT_CLIENT_CURRENCY)
    cf = getattr(client, "custom_fields", None) or {}
    raw = cf.get(_CLIENT_CURRENCY_CF_KEY)
    if raw is not None and str(raw).strip():
        return normalize_currency_code(str(raw), DEFAULT_CLIENT_CURRENCY)
    return DEFAULT_CLIENT_CURRENCY


def set_client_currency(client: Client, currency: str) -> None:
    cur = normalize_currency_code(currency, DEFAULT_CLIENT_CURRENCY)
    if hasattr(client, "currency"):
        try:
            client.currency = cur  # type: ignore[attr-defined]
        except Exception:
            pass
    cf = dict(getattr(client, "custom_fields", None) or {})
    cf[_CLIENT_CURRENCY_CF_KEY] = cur
    client.custom_fields = cf


def count_client_approved_wallet_recharges(
    db: Session,
    client_id: int,
    *,
    exclude_request_id: int | None = None,
) -> int:
    from app.models.wallet_recharge_request import WalletRechargeRequest
    from app.wallet_recharge_helpers import REQ_STATUS_APPROVED, REQ_STATUS_PARTIALLY_PAID

    q = db.query(func.count(WalletRechargeRequest.id)).filter(
        WalletRechargeRequest.client_id == int(client_id),
        WalletRechargeRequest.status.in_((REQ_STATUS_APPROVED, REQ_STATUS_PARTIALLY_PAID)),
    )
    if exclude_request_id is not None:
        q = q.filter(WalletRechargeRequest.id != int(exclude_request_id))
    return int(q.scalar() or 0)


def propagate_client_currency_to_descendants(
    db: Session,
    root_client_id: int,
    currency: str,
) -> None:
    """Hereda la moneda base a todos los sub-clientes (árbol descendiente)."""
    cur = normalize_currency_code(currency, DEFAULT_CLIENT_CURRENCY)
    queue = [int(root_client_id)]
    while queue:
        parent_id = queue.pop(0)
        children = db.query(Client).filter(Client.parent_id == parent_id).all()
        for child in children:
            set_client_currency(child, cur)
            queue.append(int(child.id))
    db.flush()


def lock_client_base_currency_on_recharge_create(
    db: Session,
    client: Client,
    recharge_currency: str,
    *,
    propagate_to_descendants: bool = True,
) -> str:
    """
    Fija la moneda base del cliente al crear/editar una solicitud de recarga
    y la propaga a toda su red de sub-clientes.
    """
    cur = normalize_currency_code(recharge_currency, DEFAULT_CLIENT_CURRENCY)
    set_client_currency(client, cur)
    if propagate_to_descendants:
        propagate_client_currency_to_descendants(db, int(client.id), cur)
    db.flush()
    return cur


def maybe_set_client_base_currency_from_recharge(
    db: Session,
    client: Client,
    recharge_currency: str,
    *,
    recharge_request_id: int | None = None,
) -> None:
    """Compatibilidad: al aprobar recarga, asegura moneda (misma regla que creación)."""
    _ = recharge_request_id
    lock_client_base_currency_on_recharge_create(db, client, recharge_currency)
