"""ClientPayment para solicitudes BaaS (mismo patrón que abonos CxC en ventas)."""

from __future__ import annotations

import re
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.client_payment import ClientPayment, ClientPaymentStatus
from app.models.payment_method import PaymentMethod
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.services.client_payment_service import next_payment_number
from app.timezone_utils import now_ecuador

_META_WR_RE = re.compile(r"META_WALLET_RECHARGE_ID=(\d+)", re.IGNORECASE)


def parse_notes_meta_wallet_recharge_id(notes: Optional[str]) -> Optional[int]:
    m = _META_WR_RE.search(str(notes or ""))
    if not m:
        return None
    try:
        return int(m.group(1))
    except (TypeError, ValueError):
        return None


def build_wallet_recharge_payment_notes(
    req_id: int,
    amount: float,
    currency: str,
    *,
    credit_amount: float = 0.0,
) -> str:
    cur = normalize_currency_code(currency, "USD")
    lines = [
        "portal_wallet_recharge",
        f"META_WALLET_RECHARGE_ID={int(req_id)}",
    ]
    cash = max(0.0, float(amount) - float(credit_amount or 0))
    if credit_amount and float(credit_amount) > 1e-9:
        lines.append(f"PARTE_SALDO_FAVOR={float(credit_amount):.2f} {cur}")
    if cash > 1e-9:
        lines.append(f"PARTE_EFECTIVO={cash:.2f} {cur}")
    elif not (credit_amount and float(credit_amount) > 1e-9):
        lines.append(f"PARTE_EFECTIVO={float(amount):.2f} {cur}")
    return "\n".join(lines)


def _first_allowed_payment_method_id(req: WalletRechargeRequest) -> Optional[int]:
    raw = req.allowed_payment_methods if isinstance(req.allowed_payment_methods, list) else []
    for x in raw:
        try:
            return int(x)
        except (TypeError, ValueError):
            continue
    return None


def find_pending_client_payment_for_wallet_recharge(
    db: Session,
    req: WalletRechargeRequest,
) -> Optional[ClientPayment]:
    rid = int(req.id)
    cid = int(req.client_id)
    pending = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == cid,
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
        .order_by(ClientPayment.created_at.desc())
        .all()
    )
    receipt = str(getattr(req, "receipt_url", None) or "").strip()
    for cp in pending:
        if parse_notes_meta_wallet_recharge_id(cp.notes) == rid:
            return cp
        if receipt and str(cp.receipt_file_url or "").strip() == receipt:
            return cp
    return None


def ensure_pending_client_payment_for_wallet_recharge(
    db: Session,
    req: WalletRechargeRequest,
    *,
    client: Optional[Client] = None,
    payment_method_id: Optional[int] = None,
    deposit_account_id: Optional[int] = None,
    declared_amount: Optional[float] = None,
    credit_amount: Optional[float] = None,
) -> Optional[ClientPayment]:
    """
    Crea o actualiza un ``ClientPayment`` en revisión vinculado a la solicitud BaaS.
    """
    receipt = str(getattr(req, "receipt_url", None) or "").strip()
    try:
        cash_f = float(declared_amount) if declared_amount is not None else float(
            getattr(req, "portal_declared_payment_amount", None) or 0
        )
    except (TypeError, ValueError):
        cash_f = 0.0
    try:
        credit_f = float(credit_amount or 0)
    except (TypeError, ValueError):
        credit_f = 0.0
    if cash_f <= 0 and credit_f <= 0:
        try:
            cash_f = float(getattr(req, "balance_pending", None) or req.amount_requested or 0)
        except (TypeError, ValueError):
            cash_f = 0.0
    total_f = cash_f + max(0.0, credit_f)
    if total_f <= 0:
        return None
    if not receipt and credit_f <= 0:
        return None

    cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
    xr = float(getattr(req, "recharge_exchange_rate", None) or 1.0)

    pm_id = payment_method_id if payment_method_id is not None else _first_allowed_payment_method_id(req)
    pm_name: Optional[str] = None
    if pm_id is not None:
        pm = db.get(PaymentMethod, int(pm_id))
        if pm is not None:
            pm_name = (pm.name or "").strip() or None

    dep_id = deposit_account_id
    if dep_id is None:
        raw_dep = getattr(req, "portal_submitted_deposit_account_id", None)
        if raw_dep is not None:
            try:
                dep_id = int(raw_dep)
            except (TypeError, ValueError):
                dep_id = None

    existing = find_pending_client_payment_for_wallet_recharge(db, req)
    notes = build_wallet_recharge_payment_notes(
        int(req.id),
        total_f,
        cur,
        credit_amount=credit_f,
    )
    pm_label = pm_name or ("Saldo a Favor" if credit_f > 1e-9 and cash_f <= 1e-9 else None)

    if client is None:
        client = db.get(Client, int(req.client_id))

    def _reserve_credit_on_payment(payment: ClientPayment) -> bool:
        if credit_f <= 1e-9 or client is None:
            return True
        from app.services.client_payment_service import (
            _FP_EPS,
            reserve_client_credit_for_pending_payment,
        )

        taken = reserve_client_credit_for_pending_payment(
            db,
            client,
            payment,
            Decimal(str(credit_f)).quantize(Decimal("0.01")),
        )
        return taken > _FP_EPS

    if existing is not None:
        if client is not None:
            from app.services.client_payment_service import (
                _FP_EPS,
                add_client_credit_balance,
                credit_reserved_restore_from_notes,
                credit_was_reserved_at_submit,
            )

            if credit_was_reserved_at_submit(existing.notes):
                old = credit_reserved_restore_from_notes(existing.notes)
                if old > _FP_EPS:
                    add_client_credit_balance(db, client, cur, old)

        existing.amount = Decimal(str(total_f))
        existing.currency = cur
        existing.exchange_rate = xr
        if receipt:
            existing.receipt_file_url = receipt
        if pm_id is not None:
            existing.payment_method_id = int(pm_id)
        if pm_label:
            existing.payment_method = pm_label
        if dep_id is not None:
            existing.deposit_account_id = int(dep_id)
        existing.notes = notes
        db.flush()
        if not _reserve_credit_on_payment(existing):
            return None
        db.flush()
        return existing

    if client is None:
        return None

    cp = ClientPayment(
        payment_number=next_payment_number(db),
        client_id=int(client.id),
        amount=Decimal(str(total_f)),
        currency=cur,
        exchange_rate=xr,
        receipt_file_url=receipt or None,
        payment_method_id=int(pm_id) if pm_id is not None else None,
        payment_method=pm_label,
        deposit_account_id=int(dep_id) if dep_id is not None else None,
        status=ClientPaymentStatus.pending_review,
        notes=notes,
        created_at=now_ecuador(),
    )
    db.add(cp)
    db.flush()
    if not _reserve_credit_on_payment(cp):
        db.delete(cp)
        db.flush()
        return None
    return cp


def ensure_pending_wallet_recharge_credit_payment(
    db: Session,
    req: WalletRechargeRequest,
    *,
    client: Optional[Client] = None,
    credit_amount: float,
) -> Optional[ClientPayment]:
    """Crea o actualiza cobro en revisión por cruce de saldo a favor (sin comprobante)."""
    try:
        credit_f = float(credit_amount)
    except (TypeError, ValueError):
        return None
    if credit_f <= 1e-9:
        return None
    return ensure_pending_client_payment_for_wallet_recharge(
        db,
        req,
        client=client,
        declared_amount=0.0,
        credit_amount=credit_f,
    )


def _resolve_wallet_recharge_receipt_url(req: WalletRechargeRequest) -> Optional[str]:
    for raw in (
        getattr(req, "receipt_url", None),
        getattr(req, "admin_precheck_receipt_url", None),
    ):
        s = str(raw or "").strip()
        if s:
            return s
    return None


def _create_approved_wallet_recharge_client_payment(
    db: Session,
    req: WalletRechargeRequest,
    *,
    client: Optional[Client] = None,
    amount: float,
    receipt_url: Optional[str] = None,
) -> Optional[ClientPayment]:
    """Crea un cobro BaaS ya aprobado (respaldo si no hay fila ``pending_review``)."""
    try:
        amt_f = float(amount)
    except (TypeError, ValueError):
        return None
    if amt_f <= 0:
        return None

    if client is None:
        client = db.get(Client, int(req.client_id))
    if client is None:
        return None

    cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
    xr = float(getattr(req, "recharge_exchange_rate", None) or 1.0)
    pm_id = _first_allowed_payment_method_id(req)
    pm_name: Optional[str] = None
    if pm_id is not None:
        pm = db.get(PaymentMethod, int(pm_id))
        if pm is not None:
            pm_name = (pm.name or "").strip() or None

    dep_id = None
    raw_dep = getattr(req, "portal_submitted_deposit_account_id", None)
    if raw_dep is not None:
        try:
            dep_id = int(raw_dep)
        except (TypeError, ValueError):
            dep_id = None

    now_ts = now_ecuador()
    cp = ClientPayment(
        payment_number=next_payment_number(db),
        client_id=int(client.id),
        amount=Decimal(str(amt_f)).quantize(Decimal("0.0001")),
        currency=cur,
        exchange_rate=xr,
        receipt_file_url=(str(receipt_url).strip() if receipt_url else None),
        payment_method_id=int(pm_id) if pm_id is not None else None,
        payment_method=pm_name,
        deposit_account_id=dep_id,
        status=ClientPaymentStatus.approved,
        approved_at=now_ts,
        notes=build_wallet_recharge_payment_notes(int(req.id), amt_f, cur),
        created_at=now_ts,
    )
    db.add(cp)
    db.flush()
    return cp


def resolve_wallet_recharge_payment_for_admin_approval(
    db: Session,
    req: WalletRechargeRequest,
    *,
    client: Optional[Client] = None,
) -> Optional[ClientPayment]:
    """
    Localiza o crea el ``ClientPayment`` vinculado **antes** de limpiar el comprobante de la solicitud.
    """
    cp = find_pending_client_payment_for_wallet_recharge(db, req)
    if cp is not None:
        return cp
    return ensure_pending_client_payment_for_wallet_recharge(db, req, client=client)


def approve_wallet_recharge_client_payment_ledger(
    db: Session,
    payment: ClientPayment,
    req: WalletRechargeRequest,
    *,
    received_amount: float,
    applied_to_recharge: float,
    surplus: float,
    strict_accounting: bool = True,
) -> None:
    """Aprueba el cobro BaaS vía el mismo motor CxC que ventas (sin ``commit``)."""
    from app.services.accounting_engine import ensure_wallet_recharge_accrual_journal
    from app.services.client_payment_accounting_sync import sync_client_payment_accounting_ledgers
    from app.services.client_payment_service import _stamp_wallet_recharge_cxc_applied_notes

    recv = Decimal(str(received_amount)).quantize(Decimal("0.0001"))
    if recv > Decimal("0"):
        payment.amount = recv

    if payment.status != ClientPaymentStatus.approved:
        payment.status = ClientPaymentStatus.approved
        payment.approved_at = now_ecuador()

    cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
    payment.notes = _stamp_wallet_recharge_cxc_applied_notes(
        payment.notes,
        applied_to_cxc=float(applied_to_recharge),
        received_amount=float(received_amount),
        currency=cur,
    )
    db.flush()
    ensure_wallet_recharge_accrual_journal(db, req, strict=strict_accounting)
    sync_client_payment_accounting_ledgers(db, payment, strict=strict_accounting)


def finalize_wallet_recharge_client_payment_on_approval(
    db: Session,
    req: WalletRechargeRequest,
    *,
    client: Optional[Client] = None,
    received_amount: float,
    applied_to_cxc: float,
    surplus: float = 0.0,
    strict_accounting: bool = True,
) -> Optional[ClientPayment]:
    """
    Al aprobar una recarga BaaS: garantiza ``ClientPayment`` en estado ``approved`` y asiento contable.

    Debe invocarse **antes** de borrar ``receipt_url`` en abonos parciales.
    """
    recv = float(received_amount)
    if recv <= 1e-6:
        return None

    cp = resolve_wallet_recharge_payment_for_admin_approval(db, req, client=client)
    if cp is None:
        cp = _create_approved_wallet_recharge_client_payment(
            db,
            req,
            client=client,
            amount=recv,
            receipt_url=_resolve_wallet_recharge_receipt_url(req),
        )
    if cp is None:
        return None

    approve_wallet_recharge_client_payment_ledger(
        db,
        cp,
        req,
        received_amount=recv,
        applied_to_recharge=applied_to_cxc,
        surplus=surplus,
        strict_accounting=strict_accounting,
    )
    return cp
