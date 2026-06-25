"""Activación inmediata de ventas con Códigos de Retiro (CxC por valor total)."""

from __future__ import annotations

import logging
import re
import unicodedata
from decimal import Decimal
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.client_payment import ClientPayment, ClientPaymentStatus, PaymentAllocation
from app.models.payment_method import PaymentMethod
from app.models.sale import Sale, SaleStatus
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.services.client_payment_service import (
    _sale_invoice_total,
    resolve_client_payment_deposit_account_id,
    sync_sale_amount_paid_from_allocations,
)
from app.timezone_utils import isoformat_z, now_ecuador

logger = logging.getLogger(__name__)

_REF_SALE_RE = re.compile(r"^(?:FAC|REF|MOV)-0*(\d+)$", re.IGNORECASE)
_REF_WR_RE = re.compile(r"^REC-0*(\d+)$", re.IGNORECASE)
_META_RETIRO_WEBHOOK = "META_RETIRO_WEBHOOK=1"

_RETIRO_METHOD_PATTERNS = (
    "codigos de retiro",
    "codigo de retiro",
    "codigos retiro",
    "codigo retiro",
)

_INSTANT_ACTIVATION_STATUSES = (
    SaleStatus.pending,
    SaleStatus.payment_submitted,
)

WEBHOOK_SALE_STATUSES = (
    SaleStatus.pending,
    SaleStatus.payment_submitted,
    SaleStatus.approved,
    SaleStatus.partially_paid,
)


def ensure_retiro_webhook_deposit_account(
    db: Session,
    payment: ClientPayment,
    *,
    client: Client,
    sale: Optional[Sale] = None,
    wallet_recharge: Optional[WalletRechargeRequest] = None,
) -> None:
    """
    Resuelve la cuenta bancaria (DR) del cobro retiro para poder registrar el asiento contable.
    """
    if payment.deposit_account_id is not None:
        return

    resolved = resolve_client_payment_deposit_account_id(db, payment)
    if resolved is not None:
        payment.deposit_account_id = int(resolved)
        return

    from app.account_constants import is_liquid_deposit_account
    from app.models.account import Account
    from app.services.client_payment_method_service import get_client_assigned_account_ids

    cur = normalize_currency_code(str(payment.currency or "USD"))
    pm_id = payment.payment_method_id
    if pm_id is None and sale is not None and sale.payment_method_id is not None:
        pm_id = int(sale.payment_method_id)
    if pm_id is None and wallet_recharge is not None:
        raw_pm = getattr(wallet_recharge, "allowed_payment_methods", None)
        if isinstance(raw_pm, list):
            for x in raw_pm:
                try:
                    pm_id = int(x)
                    break
                except (TypeError, ValueError):
                    continue

    if pm_id is not None:
        assigned = get_client_assigned_account_ids(
            db,
            int(client.id),
            payment_method_id=int(pm_id),
            currency=cur,
        )
        if assigned:
            payment.deposit_account_id = int(assigned[0])
            if payment.payment_method_id is None:
                payment.payment_method_id = int(pm_id)
            return

    for pm in db.query(PaymentMethod).filter(PaymentMethod.is_active.is_(True)).all():
        if not is_codigos_retiro_payment_method_name(pm.name):
            continue
        assigned = get_client_assigned_account_ids(
            db,
            int(client.id),
            payment_method_id=int(pm.id),
            currency=cur,
        )
        if assigned:
            payment.deposit_account_id = int(assigned[0])
            if payment.payment_method_id is None:
                payment.payment_method_id = int(pm.id)
            return

    for acc in db.query(Account).filter(Account.is_active.is_(True)).order_by(Account.id.asc()).all():
        if not is_liquid_deposit_account(acc):
            continue
        if normalize_currency_code(str(acc.currency or "USD")) != cur:
            continue
        payment.deposit_account_id = int(acc.id)
        logger.info(
            "Retiro webhook: cuenta depósito fallback id=%s moneda=%s pago=%s",
            acc.id,
            cur,
            payment.payment_number or payment.id,
        )
        return

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=(
            f"No hay cuenta de depósito activa en {cur} para registrar el cobro "
            "Códigos de Retiro en contabilidad."
        ),
    )


def sync_retiro_webhook_payment_accounting(
    db: Session,
    payment: ClientPayment,
    *,
    strict: bool = True,
) -> None:
    """
    Registra el asiento contable del cobro (DR banco / CR CxC) tras aprobación webhook.

    Asegura devengo DR CxC / CR ingresos de las ventas vinculadas antes del abono.
    """
    if payment.status != ClientPaymentStatus.approved:
        return

    from app.services.client_payment_accounting_sync import sync_client_payment_accounting_ledgers
    from app.services.client_payment_service import parse_notes_meta_sale_id
    from app.services.sale_accounting_sync import sync_sale_accounting_ledgers
    from app.services.wallet_recharge_client_payment import parse_notes_meta_wallet_recharge_id
    from app.services.accounting_engine import ensure_wallet_recharge_accrual_journal

    touched_sale_ids: set[int] = set()
    meta_sid = parse_notes_meta_sale_id(payment.notes)
    if meta_sid is not None:
        touched_sale_ids.add(int(meta_sid))

    for alloc in db.query(PaymentAllocation).filter(PaymentAllocation.payment_id == int(payment.id)).all():
        if alloc.sale_id is not None:
            touched_sale_ids.add(int(alloc.sale_id))
        if alloc.wallet_recharge_id is not None:
            wr = db.get(WalletRechargeRequest, int(alloc.wallet_recharge_id))
            if wr is not None:
                ensure_wallet_recharge_accrual_journal(db, wr, strict=False)

    for sid in sorted(touched_sale_ids):
        sale = db.get(Sale, int(sid))
        if sale is not None:
            sync_sale_accounting_ledgers(db, sale, strict=False, strict_cogs=False)

    wr_id = parse_notes_meta_wallet_recharge_id(payment.notes)
    if wr_id is not None:
        wr = db.get(WalletRechargeRequest, int(wr_id))
        if wr is not None:
            ensure_wallet_recharge_accrual_journal(db, wr, strict=False)

    entry = sync_client_payment_accounting_ledgers(db, payment, strict=strict)
    if entry is None and strict:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                f"No se pudo registrar el asiento contable del pago "
                f"{payment.payment_number or payment.id}."
            ),
        )

    logger.info(
        "Retiro webhook: asiento contable sincronizado pago=%s journal_id=%s monto=%s %s",
        payment.payment_number or payment.id,
        getattr(entry, "id", None),
        payment.amount,
        payment.currency,
    )


def parse_referencia_externa_sale_id(raw: Optional[str]) -> Optional[int]:
    """Interpreta ``referencia_externa`` como PK de venta (``42``, ``FAC-0042``, ``REF-42``)."""
    s = str(raw or "").strip()
    if not s:
        return None
    if _REF_WR_RE.match(s):
        return None
    if s.isdigit():
        n = int(s)
        return n if n > 0 else None
    m = _REF_SALE_RE.match(s)
    if m:
        return int(m.group(1))
    return None


def parse_referencia_externa_wallet_recharge_id(raw: Optional[str]) -> Optional[int]:
    """Interpreta ``referencia_externa`` como PK de recarga BaaS (``REC-00042``)."""
    s = str(raw or "").strip()
    if not s:
        return None
    m = _REF_WR_RE.match(s)
    if m:
        return int(m.group(1))
    return None


def format_wallet_recharge_referencia_externa(wallet_recharge_id: int) -> str:
    """Formato canónico ``REC-00042`` para webhooks del socio (recarga BaaS)."""
    n = int(wallet_recharge_id)
    if n <= 0:
        return ""
    return f"REC-{n:05d}"


def classify_referencia_externa(raw: Optional[str]) -> tuple[str, Optional[int]]:
    """
    Clasifica ``referencia_externa`` del webhook socio.

    Returns:
        (kind, id) donde kind ∈ ``sale`` | ``wallet_recharge`` | ``ambiguous`` | ``unknown``.
    """
    s = str(raw or "").strip()
    if not s:
        return ("unknown", None)
    wr_id = parse_referencia_externa_wallet_recharge_id(s)
    if wr_id is not None:
        return ("wallet_recharge", wr_id)
    sale_id = parse_referencia_externa_sale_id(s)
    if sale_id is not None and (_REF_SALE_RE.match(s) or s.isdigit()):
        if _REF_SALE_RE.match(s):
            return ("sale", sale_id)
        return ("ambiguous", sale_id)
    return ("unknown", None)


def _normalize_payment_method_name(name: Optional[str]) -> str:
    raw = str(name or "").strip().lower()
    if not raw:
        return ""
    decomposed = unicodedata.normalize("NFD", raw)
    return "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn").replace("ó", "o")


def is_codigos_retiro_payment_method_name(name: Optional[str]) -> bool:
    """True si el nombre del método corresponde a Códigos de Retiro."""
    normalized = _normalize_payment_method_name(name)
    if not normalized:
        return False
    return any(pattern in normalized for pattern in _RETIRO_METHOD_PATTERNS)


def is_codigos_retiro_payment_method_id(db: Session, payment_method_id: Optional[int]) -> bool:
    if payment_method_id is None:
        return False
    pm = db.get(PaymentMethod, int(payment_method_id))
    if pm is None or not bool(getattr(pm, "is_active", True)):
        return False
    return is_codigos_retiro_payment_method_name(pm.name)


def assert_codigos_retiro_instant_activation_allowed(
    db: Session,
    sale: Sale,
    payment_method_id: Optional[int],
) -> None:
    """
    Candado de seguridad: la activación inmediata CxC solo procede con Códigos de Retiro.
    """
    pid = payment_method_id if payment_method_id is not None else sale.payment_method_id
    if not is_codigos_retiro_payment_method_id(db, pid):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "La activación inmediata con CxC solo está permitida cuando el método "
                "de pago es Códigos de Retiro."
            ),
        )

    allowed_raw = sale.allowed_payment_methods
    if isinstance(allowed_raw, list) and allowed_raw:
        try:
            allowed_ids = {int(x) for x in allowed_raw}
        except (TypeError, ValueError):
            allowed_ids = set()
        if allowed_ids and int(pid) not in allowed_ids:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="El método de pago no está habilitado para este pedido.",
            )


def stamp_retiro_webhook_notes(notes: Optional[str]) -> str:
    base = str(notes or "").strip()
    if _META_RETIRO_WEBHOOK in base:
        return base
    return f"{base}\n{_META_RETIRO_WEBHOOK}".strip() if base else _META_RETIRO_WEBHOOK


def resolve_sale_from_referencia_externa(
    db: Session,
    referencia_externa: str,
    *,
    client_id: Optional[int] = None,
    allowed_statuses: Optional[tuple[SaleStatus, ...]] = None,
) -> Sale:
    sid = parse_referencia_externa_sale_id(referencia_externa)
    if sid is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="referencia_externa inválida (use ID numérico o FAC-0001).",
        )
    sale = db.get(Sale, int(sid))
    if sale is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Venta #{sid} no encontrada.",
        )
    if client_id is not None and int(sale.client_id) != int(client_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="La venta no pertenece a este cliente.",
        )
    allowed = allowed_statuses or WEBHOOK_SALE_STATUSES
    if sale.status not in allowed:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"La venta #{sid} no admite esta operación (estado={sale.status.value}).",
        )
    return sale


def instant_activation_cxc(
    db: Session,
    *,
    client_id: int,
    referencia_externa: str,
    payment_method_id: Optional[int] = None,
    skip_retiro_method_guard: bool = False,
) -> Sale:
    """
    Regla 2: activa la venta y deja CxC al 100% del total de la factura.

    No registra ningún pago; el saldo pendiente es el total hasta que el webhook confirme.
    """
    from app.api.v1.sales import _activate_sale_record
    from app.services.client_payment_service import (
        _approved_alloc_sum_for_sale,
        _sale_cxc_open_balance,
        try_sweep_client_credit_on_new_cxc,
    )

    sale = resolve_sale_from_referencia_externa(
        db,
        referencia_externa,
        client_id=int(client_id),
        allowed_statuses=_INSTANT_ACTIVATION_STATUSES,
    )
    if not skip_retiro_method_guard:
        assert_codigos_retiro_instant_activation_allowed(db, sale, payment_method_id)

    sid = int(sale.id)

    if sale.status in (SaleStatus.approved, SaleStatus.partially_paid):
        real_total = _sale_invoice_total(db, sale)
        open_bal = _sale_cxc_open_balance(db, sale, payment=None)
        if open_bal >= real_total - Decimal("0.01"):
            return sale
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="La venta ya está activada.",
        )

    _activate_sale_record(db, sid)

    sale = db.get(Sale, sid)
    if sale is None:
        raise HTTPException(status_code=500, detail="Venta inconsistente tras activación.")

    approved_before_webhook = _approved_alloc_sum_for_sale(db, sid)
    if approved_before_webhook > Decimal("0.01"):
        logger.warning(
            "Códigos retiro instant CxC: venta #%s tenía cobros aprobados previos (%s); "
            "se mantiene coherencia CxC vía allocations.",
            sid,
            approved_before_webhook,
        )
        sync_sale_amount_paid_from_allocations(db, sale)
    else:
        sale.amount_paid = Decimal("0")

    real_total = _sale_invoice_total(db, sale)
    open_after = _sale_cxc_open_balance(db, sale, payment=None)

    events = list(sale.payment_events or [])
    events.append(
        {
            "occurred_at": isoformat_z(now_ecuador()),
            "amount": float(real_total),
            "currency": str(sale.currency or "USD"),
            "status": "Activada (Códigos de Retiro — CxC total)",
            "receipt_url": None,
            "notes": (
                "Activación inmediata con crédito: CxC por el 100% del valor de la factura. "
                f"Saldo pendiente: {float(open_after):.2f} {str(sale.currency or 'USD')}. "
                "Sin pago registrado hasta confirmación del socio."
            ),
        }
    )
    sale.payment_events = events

    if open_after > Decimal("0.01"):
        sale.status = SaleStatus.approved
    elif sale.status not in (SaleStatus.approved, SaleStatus.partially_paid):
        sale.status = SaleStatus.approved

    from app.models.client import Client

    client = db.get(Client, int(client_id))
    if client is not None:
        try_sweep_client_credit_on_new_cxc(
            db,
            client,
            currency=str(sale.currency or "USD"),
            strict_accounting=False,
        )

    db.commit()
    db.refresh(sale)

    logger.info(
        "Códigos retiro instant-activation-cxc: venta #%s cliente=%s total=%s cxc=%s amount_paid=%s",
        sid,
        client_id,
        real_total,
        open_after,
        sale.amount_paid,
    )
    return sale


def instant_activate_sale_for_codigos_retiro(
    db: Session,
    *,
    client_id: int,
    referencia_externa: str,
) -> Sale:
    """Alias retrocompatible → ``instant_activation_cxc``."""
    return instant_activation_cxc(db, client_id=client_id, referencia_externa=referencia_externa)


def build_instant_activation_cxc_response(db: Session, sale: Sale) -> dict[str, object]:
    from app.services.client_payment_service import _sale_cxc_open_balance, _sale_invoice_total

    total = _sale_invoice_total(db, sale)
    open_bal = _sale_cxc_open_balance(db, sale, payment=None)
    cur = str(sale.currency or "USD").strip().upper()[:10] or "USD"
    st = sale.status.value if hasattr(sale.status, "value") else str(sale.status)
    return {
        "ok": True,
        "message": "Pedido activado. CxC generada por el 100% del valor de la factura (sin pagos registrados).",
        "sale_id": int(sale.id),
        "sale_status": st,
        "invoice_total": float(total),
        "cxc_open_balance": float(open_bal),
        "amount_paid": float(Decimal(str(sale.amount_paid or 0))),
        "currency": cur,
    }


def register_retiro_webhook_cxc_abono(
    db: Session,
    *,
    client: Client,
    amount: Decimal,
    sale: Optional[Sale] = None,
    wallet_recharge: Optional[WalletRechargeRequest] = None,
    es_prueba: bool = False,
    existing_payment: Optional[ClientPayment] = None,
) -> int:
    """
    Registra abono CxC confirmado por webhook del socio (estado=completado).

    Motor único: ``ClientPayment`` + ``PaymentAllocation`` + ``finalize_client_payment_approval``.
    Soporta ventas y recargas BaaS polimórficamente.

    Si ya existe un cobro ``pending_review`` del portal para la misma venta/recarga,
    lo reutiliza (un solo registro) en lugar de crear otro.
    """
    from app.services.client_payment_service import (
        finalize_client_payment_approval,
        next_payment_number,
        parse_notes_meta_sale_id,
    )
    from app.services.wallet_recharge_client_payment import (
        build_wallet_recharge_payment_notes,
        find_pending_client_payment_for_wallet_recharge,
    )

    if (sale is None) == (wallet_recharge is None):
        raise ValueError("Indique exactamente sale o wallet_recharge.")

    pay_amount = amount.quantize(Decimal("0.01"))
    if pay_amount <= Decimal("0"):
        raise ValueError("Monto del webhook inválido.")

    cp = existing_payment
    if cp is None and wallet_recharge is not None:
        cp = find_pending_client_payment_for_wallet_recharge(db, wallet_recharge)
    if cp is None and sale is not None:
        pending_for_client = (
            db.query(ClientPayment)
            .filter(
                ClientPayment.client_id == int(client.id),
                ClientPayment.status == ClientPaymentStatus.pending_review,
            )
            .order_by(ClientPayment.created_at.desc(), ClientPayment.id.desc())
            .all()
        )
        sid = int(sale.id)
        for candidate in pending_for_client:
            if parse_notes_meta_sale_id(candidate.notes) == sid:
                cp = candidate
                break

    if cp is not None and cp.status == ClientPaymentStatus.approved:
        return int(cp.id)
    if cp is not None and cp.status != ClientPaymentStatus.pending_review:
        raise ValueError(
            f"El cobro {cp.payment_number} no puede procesarse por webhook (estado={cp.status})."
        )

    now = now_ecuador()
    manual_rows: list[dict] = []

    if sale is not None:
        cur = str(sale.currency or "USD").strip().upper()[:10] or "USD"
        exchange_rate = float(getattr(sale, "exchange_rate", None) or 1.0)
        pm_id = getattr(sale, "payment_method_id", None)
        dep_id = getattr(sale, "deposit_account_id", None)
        receipt_url = None
        webhook_notes = stamp_retiro_webhook_notes(
            f"META_SALE_ID={int(sale.id)}\ncodigos_retiro_webhook=1\nwebhook_abono=1"
        )
        manual_rows = [{"sale_id": int(sale.id)}]
    else:
        assert wallet_recharge is not None
        req = wallet_recharge
        cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
        exchange_rate = float(getattr(req, "recharge_exchange_rate", None) or 1.0)
        pm_id = None
        raw_pm = getattr(req, "allowed_payment_methods", None)
        if isinstance(raw_pm, list):
            for x in raw_pm:
                try:
                    pm_id = int(x)
                    break
                except (TypeError, ValueError):
                    continue
        dep_id = getattr(req, "portal_submitted_deposit_account_id", None)
        try:
            dep_id = int(dep_id) if dep_id is not None else None
        except (TypeError, ValueError):
            dep_id = None
        receipt_url = str(getattr(req, "receipt_url", "") or "").strip() or None
        base_notes = build_wallet_recharge_payment_notes(int(req.id), float(pay_amount), cur)
        webhook_notes = stamp_retiro_webhook_notes(
            f"{base_notes}\ncodigos_retiro_webhook=1\nwebhook_abono=1"
        )
        manual_rows = [{"wallet_recharge_id": int(req.id)}]

    if es_prueba:
        webhook_notes = f"[PRUEBA] {webhook_notes}"

    if cp is not None:
        cp.amount = pay_amount
        cp.currency = cur
        cp.exchange_rate = exchange_rate
        if pm_id is not None:
            cp.payment_method_id = pm_id
        if dep_id is not None:
            cp.deposit_account_id = dep_id
        if receipt_url:
            cp.receipt_file_url = receipt_url
        cp.payment_method = "Códigos de Retiro"
        prior = str(cp.notes or "").strip()
        cp.notes = webhook_notes if not prior else f"{prior}\n{webhook_notes}"
    else:
        cp = ClientPayment(
            payment_number=next_payment_number(db),
            client_id=int(client.id),
            amount=pay_amount,
            currency=cur,
            exchange_rate=exchange_rate,
            payment_method="Códigos de Retiro",
            payment_method_id=pm_id,
            deposit_account_id=dep_id,
            receipt_file_url=receipt_url,
            status=ClientPaymentStatus.pending_review,
            notes=webhook_notes,
            created_at=now,
        )
        db.add(cp)
    db.flush()

    ensure_retiro_webhook_deposit_account(
        db,
        cp,
        client=client,
        sale=sale,
        wallet_recharge=wallet_recharge,
    )
    db.flush()

    if sale is not None:
        from app.services.sale_accounting_sync import sync_sale_accounting_ledgers

        sync_sale_accounting_ledgers(db, sale, strict=False, strict_cogs=False)
    else:
        from app.services.accounting_engine import ensure_wallet_recharge_accrual_journal

        ensure_wallet_recharge_accrual_journal(db, wallet_recharge, strict=False)

    finalize_client_payment_approval(
        db,
        cp,
        manual_rows=manual_rows,
        fifo_fallback=True,
        strict_accounting=True,
    )

    sync_retiro_webhook_payment_accounting(db, cp, strict=True)

    db.flush()
    return int(cp.id)


def register_retiro_webhook_abono(
    db: Session,
    *,
    sale: Sale,
    client: Client,
    amount: Decimal,
    es_prueba: bool = False,
) -> int:
    """Registra abono CxC confirmado por webhook del socio (estado=completado)."""
    return register_retiro_webhook_cxc_abono(
        db,
        client=client,
        amount=amount,
        sale=sale,
        es_prueba=es_prueba,
    )


def register_retiro_webhook_wallet_recharge_abono(
    db: Session,
    *,
    req: WalletRechargeRequest,
    client: Client,
    amount: Decimal,
    es_prueba: bool = False,
) -> int:
    """
    Registra abono CxC confirmado por webhook del socio (recarga BaaS activada instant-retiro).

    Delega en ``register_retiro_webhook_cxc_abono`` (motor único ``PaymentAllocation``).
    """
    return register_retiro_webhook_cxc_abono(
        db,
        client=client,
        amount=amount,
        wallet_recharge=req,
        es_prueba=es_prueba,
    )
