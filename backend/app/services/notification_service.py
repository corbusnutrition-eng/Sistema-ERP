"""Alertas unificadas para el header del ERP (campanita)."""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from app.account_constants import is_liquid_deposit_account
from app.account_verifier_access import is_account_verifier
from app.currency_utils import normalize_currency_code
from app.models.account import Account
from app.models.client_payment import ClientPayment, ClientPaymentStatus
from app.models.journal_entry import JournalEntry, JournalEntryLine, JournalReferenceType
from app.models.sale import Sale, SaleStatus
from app.models.system_notification import SystemNotification
from app.models.user import User
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.schemas.notification import (
    PendingPaymentNotification,
    PendingPaymentNotificationKind,
    PendingPaymentsNotificationResponse,
    PendingVerifierPaymentNotification,
    PendingVerifierPaymentsNotificationResponse,
)
from app.services.inventory_alert_service import SYSTEM_NOTIFICATION_KIND_INVENTORY_LOW
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

    inv_rows = (
        db.query(SystemNotification)
        .filter(
            SystemNotification.kind == SYSTEM_NOTIFICATION_KIND_INVENTORY_LOW,
            SystemNotification.is_read.is_(False),
        )
        .order_by(SystemNotification.created_at.desc(), SystemNotification.id.desc())
        .limit(50)
        .all()
    )
    for alert in inv_rows:
        aid = int(alert.id)
        prov = str(alert.provider or "Proveedor")
        pkg = str(alert.package_name or "Paquete")
        remaining = int(alert.remaining_count if alert.remaining_count is not None else 0)
        items.append(
            PendingPaymentNotification(
                id=aid,
                kind=PendingPaymentNotificationKind.inventory_low,
                label=f"Inventario bajo: {pkg}",
                client_id=None,
                client_name=prov,
                amount=float(remaining),
                currency="pantallas",
                created_at=getattr(alert, "created_at", None) or fallback_ts,
                path="/inventario",
            )
        )

    items.sort(key=lambda x: _sort_ts(x.created_at), reverse=True)
    return PendingPaymentsNotificationResponse(count=len(items), items=items)


_RESOLVED_VERIFICATION = frozenset({"confirmed", "not_found", "wrong_account"})


def _line_is_pending_bank_verification(line: JournalEntryLine) -> bool:
    raw = getattr(line, "verification_status", None)
    if raw is None:
        return True
    status = str(raw).strip().lower()
    if not status:
        return True
    if status in _RESOLVED_VERIFICATION:
        return False
    return status == "interbank"


def _payment_id_and_reference(db: Session, entry: JournalEntry, line_id: int) -> tuple[int, str]:
    ref_type = (entry.reference_type or "").strip()
    ref_id = entry.reference_id
    if ref_type == JournalReferenceType.client_payment.value and ref_id is not None:
        cp = db.get(ClientPayment, int(ref_id))
        if cp is not None and str(cp.payment_number or "").strip():
            return int(cp.id), str(cp.payment_number).strip()
        return int(ref_id), f"PAG-{int(ref_id)}"
    if ref_type == JournalReferenceType.recarga.value and ref_id is not None:
        return int(line_id), f"REC-{int(ref_id):05d}"
    if ref_type == JournalReferenceType.venta.value and ref_id is not None:
        return int(line_id), f"FAC-{int(ref_id):04d}"
    if ref_type and ref_id is not None:
        return int(line_id), f"{ref_type}#{ref_id}"
    return int(line_id), f"JE-{int(entry.id):06d}"


def _verifier_bank_account_ids(db: Session, user: User) -> list[int]:
    rows = (
        db.query(Account)
        .filter(
            Account.verifier_id == int(user.id),
            Account.is_active.is_(True),
        )
        .order_by(Account.id.asc())
        .all()
    )
    return [int(acc.id) for acc in rows if is_liquid_deposit_account(acc)]


def list_pending_verifier_payment_notifications(
    db: Session,
    *,
    current_user: dict,
    db_user: Optional[User],
) -> PendingVerifierPaymentsNotificationResponse:
    """
    Depósitos bancarios sin verificar para la campanita del header.

    - Admin: todas las cuentas de depósito con movimientos pendientes.
    - Verificador de Cuentas: solo cuentas asignadas (``accounts.verifier_id``).
    """
    is_admin = str(current_user.get("role") or "") == "admin"
    account_ids: Optional[list[int]] = None

    if is_admin:
        admin_accounts = (
            db.query(Account)
            .filter(Account.is_active.is_(True))
            .order_by(Account.id.asc())
            .all()
        )
        account_ids = [int(acc.id) for acc in admin_accounts if is_liquid_deposit_account(acc)]
    else:
        if db_user is None or not is_account_verifier(db_user):
            return PendingVerifierPaymentsNotificationResponse(count=0, items=[])
        account_ids = _verifier_bank_account_ids(db, db_user)
        if not account_ids:
            return PendingVerifierPaymentsNotificationResponse(count=0, items=[])

    rows = (
        db.query(JournalEntryLine, Account, JournalEntry)
        .join(Account, JournalEntryLine.account_id == Account.id)
        .join(JournalEntry, JournalEntryLine.journal_entry_id == JournalEntry.id)
        .filter(
            Account.id.in_(account_ids),
            JournalEntryLine.debit > 0,
            or_(
                JournalEntryLine.verification_status.is_(None),
                JournalEntryLine.verification_status == "",
                JournalEntryLine.verification_status == "interbank",
            ),
        )
        .order_by(JournalEntry.created_at.desc(), JournalEntryLine.id.desc())
        .limit(200)
        .all()
    )

    fallback_ts = now_ecuador()
    items: list[PendingVerifierPaymentNotification] = []
    for line, account, entry in rows:
        if not _line_is_pending_bank_verification(line):
            continue
        dep = Decimal(str(line.debit or 0)).quantize(Decimal("0.01"))
        if dep <= Decimal("0.005"):
            continue
        payment_id, reference = _payment_id_and_reference(db, entry, int(line.id))
        created = getattr(entry, "created_at", None) or fallback_ts
        items.append(
            PendingVerifierPaymentNotification(
                payment_id=payment_id,
                amount=float(dep),
                reference=reference,
                bank_account_id=int(account.id),
                bank_account_name=str(account.name or "").strip() or f"Cuenta #{account.id}",
                created_at=created,
            )
        )

    items.sort(key=lambda x: _sort_ts(x.created_at), reverse=True)
    return PendingVerifierPaymentsNotificationResponse(count=len(items), items=items)
