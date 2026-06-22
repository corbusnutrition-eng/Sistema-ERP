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

# Recarga activada en portal con Códigos de Retiro: billetera entregada, cobro pendiente de webhook.
_RETIRO_INSTANT_CXC_MARKER = "META_RETIRO_INSTANT_CXC=1"


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
    if st in (REQ_STATUS_REJECTED, REQ_STATUS_CANCELED):
        return False
    if wallet_recharge_open_balance(req) <= _WR_BALANCE_EPS:
        return False
    return st in (
        REQ_STATUS_PENDING,
        REQ_STATUS_IN_REVIEW,
        REQ_STATUS_PARTIALLY_PAID,
        REQ_STATUS_APPROVED,
    )


def wallet_recharge_portal_abono_requires_manual_review(req) -> bool:
    """
    True si un comprobante del portal debe encolar revisión admin (``pending_review``),
    no activación instantánea Códigos de Retiro.

    Aplica a abonos secundarios sobre recargas ya activadas (``META_RETIRO_INSTANT_CXC``,
    ``approved`` / ``partially_paid``, o con abonos previos).
    """
    st = str(getattr(req, "status", "") or "")
    if st in (REQ_STATUS_APPROVED, REQ_STATUS_PARTIALLY_PAID, REQ_STATUS_IN_REVIEW):
        return True
    if _RETIRO_INSTANT_CXC_MARKER in str(getattr(req, "admin_note", "") or ""):
        return True
    try:
        if float(getattr(req, "amount_paid", 0) or 0) > _WR_BALANCE_EPS:
            return True
    except (TypeError, ValueError):
        pass
    return False


def wallet_recharge_codigos_retiro_initial_portal_activation(req, db: Optional[Session] = None) -> bool:
    """Primer paso Códigos de Retiro: solicitud ``pending`` sin activación previa."""
    if db is not None and wallet_recharge_virtual_product_already_delivered(db, req):
        return False
    if wallet_recharge_portal_abono_requires_manual_review(req):
        return False
    return str(getattr(req, "status", "") or "") == REQ_STATUS_PENDING


def wallet_recharge_virtual_product_already_delivered(db: Session, req) -> bool:
    """
    Candado de acreditación: True si el saldo virtual ya fue entregado para esta solicitud.

    Tras la primera entrega (100% del ``amount_requested``), abonos parciales posteriores
    solo liquidan CxC y no vuelven a sumar billetera.
    """
    if wallet_recharge_portal_abono_requires_manual_review(req):
        return True
    try:
        product = float(getattr(req, "amount_requested", 0) or 0)
    except (TypeError, ValueError):
        product = 0.0
    if product <= _WR_BALANCE_EPS:
        return False
    from app.services.client_payment_service import _wallet_credited_for_recharge_request

    credited = _wallet_credited_for_recharge_request(db, req)
    return credited >= product - _WR_BALANCE_EPS


def wallet_recharge_portal_may_deliver_virtual_product(db: Session, req) -> bool:
    """True solo en el primer paso portal antes de entregar producto virtual."""
    return not wallet_recharge_virtual_product_already_delivered(db, req)


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


def wallet_recharge_is_retiro_instant_cxc(req) -> bool:
    """True si la recarga ya entregó producto virtual vía activación instantánea Códigos de Retiro."""
    return _RETIRO_INSTANT_CXC_MARKER in str(getattr(req, "admin_note", "") or "")


def stamp_wallet_recharge_retiro_instant_cxc(req) -> None:
    """Marca solicitud con activación instantánea retiro (CxC viva, sin cola admin)."""
    note = str(getattr(req, "admin_note", "") or "").strip()
    if _RETIRO_INSTANT_CXC_MARKER in note:
        return
    req.admin_note = (
        f"{note}\n{_RETIRO_INSTANT_CXC_MARKER}".strip() if note else _RETIRO_INSTANT_CXC_MARKER
    )


def clear_wallet_recharge_retiro_instant_cxc(req) -> None:
    """Quita la marca tras confirmar el cobro vía webhook del socio."""
    note = str(getattr(req, "admin_note", "") or "").strip()
    if _RETIRO_INSTANT_CXC_MARKER not in note:
        return
    lines = [ln for ln in note.splitlines() if ln.strip() != _RETIRO_INSTANT_CXC_MARKER]
    req.admin_note = "\n".join(lines).strip() or None


def wallet_recharge_awaiting_codigos_retiro_webhook(req) -> bool:
    """True si la recarga espera confirmación del socio (no acción manual del admin)."""
    if _RETIRO_INSTANT_CXC_MARKER not in str(getattr(req, "admin_note", "") or ""):
        return False
    return wallet_recharge_open_balance(req) > _WR_BALANCE_EPS


def wallet_recharge_show_in_admin_pending_tab(req) -> bool:
    """True si la solicitud debe aparecer en la pestaña «Pendientes» del panel admin."""
    st = str(getattr(req, "status", "") or "")
    if st == REQ_STATUS_PENDING:
        return True
    if wallet_recharge_open_balance(req) <= _WR_BALANCE_EPS:
        return False
    if st not in (REQ_STATUS_PARTIALLY_PAID, REQ_STATUS_APPROVED):
        return False
    if wallet_recharge_awaiting_codigos_retiro_webhook(req):
        return False
    return True


def wallet_recharge_admin_pending_sql_filter():
    """
    Filtro SQLAlchemy: recargas activadas/parciales con CxC viva que requieren cola admin.

    Excluye activaciones instantáneas Códigos de Retiro (``META_RETIRO_INSTANT_CXC``).
    """
    from sqlalchemy import and_, or_

    from app.models.wallet_recharge_request import WalletRechargeRequest

    return and_(
        WalletRechargeRequest.status.in_((REQ_STATUS_PARTIALLY_PAID, REQ_STATUS_APPROVED)),
        WalletRechargeRequest.balance_pending > _WR_BALANCE_EPS,
        or_(
            WalletRechargeRequest.admin_note.is_(None),
            ~WalletRechargeRequest.admin_note.contains(_RETIRO_INSTANT_CXC_MARKER),
        ),
    )


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
