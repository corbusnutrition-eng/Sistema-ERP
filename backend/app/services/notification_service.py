"""Alertas unificadas para el header del ERP (campanita)."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session, joinedload

from app.currency_utils import normalize_currency_code
from app.models.client_payment import ClientPayment, ClientPaymentStatus
from app.models.sale import Sale, SaleStatus
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.schemas.notification import (
    PendingPaymentNotification,
    PendingPaymentNotificationKind,
    PendingPaymentsNotificationResponse,
)
from app.services.client_payment_service import (
    _sale_invoice_total,
    is_wallet_recharge_client_payment,
    payment_encapsulated_in_open_sale_review,
)
from app.wallet_recharge_helpers import REQ_STATUS_IN_REVIEW
from app.timezone_utils import ensure_aware, now_ecuador


def _client_display_name(client) -> str:
    if client is None:
        return "Cliente"
    return str(client.display_name() if hasattr(client, "display_name") else getattr(client, "name", "") or "Cliente")


def _sort_ts(dt: Optional[datetime]) -> float:
    if dt is None:
        return 0.0
    aware = ensure_aware(dt)
    return aware.timestamp() if aware else 0.0


def list_pending_payment_notifications(db: Session) -> PendingPaymentsNotificationResponse:
    """
    Pagos/comprobantes del portal que requieren acción del administrador:

    - Ventas en ``payment_submitted`` (comprobante enviado, activar en Ventas).
    - Recargas BaaS en ``in_review``.
    - ``ClientPayment`` en ``pending_review`` no encapsulados en venta abierta ni BaaS duplicado.
    """
    items: list[PendingPaymentNotification] = []
    fallback_ts = now_ecuador()

    sales = (
        db.query(Sale)
        .options(joinedload(Sale.client))
        .filter(Sale.status == SaleStatus.payment_submitted)
        .order_by(Sale.created_at.desc(), Sale.id.desc())
        .all()
    )
    for sale in sales:
        client = sale.client
        cur = normalize_currency_code(str(sale.currency or "USD"))
        try:
            total = float(_sale_invoice_total(db, sale))
        except Exception:
            total = float(getattr(sale, "local_amount", None) or getattr(sale, "amount", 0) or 0)
        created = getattr(sale, "created_at", None)
        items.append(
            PendingPaymentNotification(
                id=int(sale.id),
                kind=PendingPaymentNotificationKind.sale,
                label="Pago de Venta",
                client_id=int(sale.client_id) if sale.client_id is not None else None,
                client_name=_client_display_name(client),
                amount=round(total, 2),
                currency=cur,
                created_at=created or fallback_ts,
                path=f"/ventas?open_sale={int(sale.id)}",
            )
        )

    wr_rows = (
        db.query(WalletRechargeRequest)
        .options(joinedload(WalletRechargeRequest.client))
        .filter(WalletRechargeRequest.status == REQ_STATUS_IN_REVIEW)
        .order_by(WalletRechargeRequest.created_at.desc(), WalletRechargeRequest.id.desc())
        .all()
    )
    for req in wr_rows:
        rid = int(req.id)
        client = req.client
        cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
        amt = float(getattr(req, "amount_requested", 0) or 0)
        pad = getattr(req, "portal_declared_payment_amount", None)
        if pad is not None:
            try:
                pad_f = float(pad)
                if pad_f > 1e-9:
                    amt = pad_f
            except (TypeError, ValueError):
                pass
        items.append(
            PendingPaymentNotification(
                id=rid,
                kind=PendingPaymentNotificationKind.wallet_recharge,
                label="Recarga BaaS",
                client_id=int(req.client_id) if req.client_id is not None else None,
                client_name=_client_display_name(client),
                amount=round(amt, 2),
                currency=cur,
                created_at=getattr(req, "created_at", None) or fallback_ts,
                path=f"/equipo/distribuidores?open_recharge={rid}",
            )
        )

    payments = (
        db.query(ClientPayment)
        .options(joinedload(ClientPayment.client))
        .filter(ClientPayment.status == ClientPaymentStatus.pending_review)
        .order_by(ClientPayment.created_at.desc(), ClientPayment.id.desc())
        .all()
    )
    for pay in payments:
        if is_wallet_recharge_client_payment(pay):
            continue
        if payment_encapsulated_in_open_sale_review(db, pay):
            continue
        client = pay.client
        cur = normalize_currency_code(str(pay.currency or "USD"))
        try:
            amt = float(Decimal(str(pay.amount or 0)))
        except Exception:
            amt = float(pay.amount or 0)
        pid = int(pay.id)
        items.append(
            PendingPaymentNotification(
                id=pid,
                kind=PendingPaymentNotificationKind.client_payment,
                label="Abono CxC",
                client_id=int(pay.client_id) if pay.client_id is not None else None,
                client_name=_client_display_name(client),
                amount=round(amt, 2),
                currency=cur,
                created_at=getattr(pay, "created_at", None) or fallback_ts,
                path=f"/ventas?payment_id={pid}",
            )
        )

    items.sort(key=lambda x: _sort_ts(x.created_at), reverse=True)
    return PendingPaymentsNotificationResponse(count=len(items), items=items)
