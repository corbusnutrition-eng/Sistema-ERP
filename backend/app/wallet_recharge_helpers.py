"""Estados canónicos de WalletRechargeRequest y helpers de filtrado/visualización."""

from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from app.models.payment_method import PaymentMethod

REQ_STATUS_PENDING = "pending"
REQ_STATUS_IN_REVIEW = "in_review"
REQ_STATUS_PARTIALLY_PAID = "partially_paid"
REQ_STATUS_APPROVED = "approved"
REQ_STATUS_REJECTED = "rejected"
REQ_STATUS_CANCELED = "canceled"

CANONICAL_STATUSES = frozenset(
    {
        REQ_STATUS_PENDING,
        REQ_STATUS_IN_REVIEW,
        REQ_STATUS_PARTIALLY_PAID,
        REQ_STATUS_APPROVED,
        REQ_STATUS_REJECTED,
        REQ_STATUS_CANCELED,
    }
)

OPEN_PORTAL_STATUSES = (REQ_STATUS_PENDING, REQ_STATUS_IN_REVIEW, REQ_STATUS_PARTIALLY_PAID)

_WR_BALANCE_EPS = 1e-6


def wallet_recharge_billing_currency(req) -> str:
    """Moneda de la solicitud de recarga (normalizada ISO)."""
    from app.currency_utils import normalize_currency_code

    return normalize_currency_code(getattr(req, "recharge_currency", None), "USD")


class InvalidWalletRechargeStatusFilter(ValueError):
    """Valor de ``status`` en query params no reconocido."""


def normalize_wallet_recharge_list_status(raw: Optional[str]) -> str:
    """
    Traduce filtros legacy o alias (ventas portal) al estado interno inglés.

    ``None`` se interpreta como el tab por defecto del panel («en revisión»).
    Raises ``InvalidWalletRechargeStatusFilter`` si el valor no es válido ni alias conocido.
    """
    if raw is None:
        return REQ_STATUS_IN_REVIEW
    s = str(raw).strip().lower()
    if s == "" or s == "all":
        return "all"
    aliases = {
        "pendiente": REQ_STATUS_IN_REVIEW,
        "pending_payment": REQ_STATUS_PENDING,
        "payment_submitted": REQ_STATUS_IN_REVIEW,
        "aprobado": REQ_STATUS_APPROVED,
        "rechazado": REQ_STATUS_REJECTED,
        "cancelled": REQ_STATUS_CANCELED,
        "activado": REQ_STATUS_APPROVED,
        # Legacy: «parcial» ya no es pestaña propia; se agrupa en «activado».
        "parcial": REQ_STATUS_APPROVED,
        "partially_paid": REQ_STATUS_APPROVED,
        "partial": REQ_STATUS_APPROVED,
    }
    out = aliases.get(s, s)
    if out == "all":
        return "all"
    if out not in CANONICAL_STATUSES:
        raise InvalidWalletRechargeStatusFilter(str(raw))
    return out


def payment_methods_display(db: Session, raw_ids: Optional[list]) -> Optional[str]:
    if not raw_ids:
        return None
    ids: list[int] = []
    for x in raw_ids:
        try:
            ids.append(int(x))
        except (TypeError, ValueError):
            continue
    ids = sorted({i for i in ids if i > 0})
    if not ids:
        return None
    rows = (
        db.query(PaymentMethod)
        .filter(PaymentMethod.id.in_(ids))
        .order_by(PaymentMethod.id.asc())
        .all()
    )
    if not rows:
        return None
    by_id = {int(r.id): (r.name or "").strip() for r in rows}
    labels = []
    for i in ids:
        name = by_id.get(i)
        if name:
            labels.append(name)
    return ", ".join(labels) if labels else None


def wallet_recharge_open_balance(req) -> float:
    try:
        return float(getattr(req, "balance_pending", 0) or 0)
    except (TypeError, ValueError):
        return 0.0


def wallet_recharge_accepts_client_receipt(req) -> bool:
    """Cliente puede adjuntar comprobante (inicial o abono adicional contra CxC)."""
    st = str(getattr(req, "status", "") or "")
    if st == REQ_STATUS_PENDING:
        return True
    if st in (REQ_STATUS_PARTIALLY_PAID, REQ_STATUS_APPROVED):
        return wallet_recharge_open_balance(req) > _WR_BALANCE_EPS
    return False


def wallet_recharge_portal_historical_debt(req) -> bool:
    """Deuda real en portal «Saldo pendiente»: activada con CxC; excluye pedidos abiertos en «Nuevos pedidos»."""
    if wallet_recharge_open_balance(req) <= _WR_BALANCE_EPS:
        return False
    st = str(getattr(req, "status", "") or "")
    if st in (REQ_STATUS_PENDING, REQ_STATUS_IN_REVIEW):
        return False
    if st == REQ_STATUS_PARTIALLY_PAID:
        return False
    if st == REQ_STATUS_APPROVED:
        try:
            paid = float(getattr(req, "amount_paid", 0) or 0)
        except (TypeError, ValueError):
            paid = 0.0
        if paid > _WR_BALANCE_EPS:
            return False
    return st == REQ_STATUS_APPROVED


def wallet_recharge_contributes_to_client_debt(req) -> bool:
    """Saldo CxC vivo de una recarga (ERP / CxC; incluye solicitudes aún no activadas)."""
    if wallet_recharge_open_balance(req) <= _WR_BALANCE_EPS:
        return False
    st = str(getattr(req, "status", "") or "")
    return st in (
        REQ_STATUS_PENDING,
        REQ_STATUS_IN_REVIEW,
        REQ_STATUS_PARTIALLY_PAID,
        REQ_STATUS_APPROVED,
    )


def wallet_recharge_editable_by_admin(req) -> bool:
    st = str(getattr(req, "status", "") or "")
    if st in (REQ_STATUS_PENDING, REQ_STATUS_IN_REVIEW, REQ_STATUS_PARTIALLY_PAID):
        return True
    if st == REQ_STATUS_APPROVED:
        return wallet_recharge_open_balance(req) > _WR_BALANCE_EPS
    return False
