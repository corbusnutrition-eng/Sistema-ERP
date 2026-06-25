"""Procesamiento del webhook del socio de recaudo físico (Códigos de Retiro)."""

from __future__ import annotations

import logging
import os
import re
import secrets
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, Optional

from fastapi import HTTPException, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.client_debt_payment import ClientDebtPayment, DebtPaymentStatus
from app.models.client_note import ClientNote
from app.models.client_payment import ClientPayment, ClientPaymentStatus, PaymentAllocation
from app.models.sale import Sale, SaleStatus
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.services.client_payment_service import (
    _deduct_reserved_credit_on_payment_approval,
    apply_payment_allocations,
    parse_notes_meta_sale_id,
    refresh_sale_status_after_payment,
    sync_sale_amount_paid_from_allocations,
    void_client_payment,
)
from app.services.wallet_recharge_client_payment import (
    find_pending_client_payment_for_wallet_recharge,
    parse_notes_meta_wallet_recharge_id,
)
from app.timezone_utils import isoformat_z, now_ecuador
from app.wallet_recharge_helpers import (
    OPEN_PORTAL_STATUSES,
    REQ_STATUS_APPROVED,
    REQ_STATUS_IN_REVIEW,
    REQ_STATUS_PARTIALLY_PAID,
    REQ_STATUS_PENDING,
    REQ_STATUS_REJECTED,
)

logger = logging.getLogger(__name__)

_AMOUNT_EPS = Decimal("0.01")
_WR_EPS = 1e-6
_RETIRO_PM_HINTS = ("retiro", "codigo", "código")

_RETIRO_WEBHOOK_RECEIPT_KEYS = (
    "receipt_url",
    "comprobante_url",
    "url_comprobante",
    "imagen_url",
    "file_url",
    "url",
    "comprobante",
)


def normalize_retiro_webhook_receipt_url(raw: object) -> Optional[str]:
    """Normaliza URL de comprobante del payload del socio (externa o relativa al ERP)."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s or s.lower() in ("null", "none"):
        return None
    return s[:2048]


def extract_receipt_url_from_webhook_payload(payload: dict[str, object]) -> Optional[str]:
    """Lee la URL del comprobante desde cualquier alias conocido del webhook."""
    for key in _RETIRO_WEBHOOK_RECEIPT_KEYS:
        if key not in payload:
            continue
        url = normalize_retiro_webhook_receipt_url(payload.get(key))
        if url:
            return url
    return None
_META_EFECTIVO_RE = re.compile(r"PARTE_EFECTIVO=([\d.]+)", re.IGNORECASE)
_META_RETIRO_WEBHOOK = "META_RETIRO_WEBHOOK=1"

_OPEN_SALE_STATUSES = (
    SaleStatus.pending,
    SaleStatus.payment_submitted,
    SaleStatus.partially_paid,
)

WEBHOOK_WR_STATUSES = (
    REQ_STATUS_PENDING,
    REQ_STATUS_IN_REVIEW,
    REQ_STATUS_PARTIALLY_PAID,
    REQ_STATUS_APPROVED,
)


@dataclass
class MatchedRetiroTransaction:
    client: Client
    amount: Decimal
    client_payment: Optional[ClientPayment] = None
    sale: Optional[Sale] = None
    wallet_recharge: Optional[WalletRechargeRequest] = None


def verify_codigos_retiro_webhook_api_key(raw: Optional[str]) -> None:
    expected = (os.getenv("CODIGOS_RETIRO_WEBHOOK_API_KEY") or "").strip()
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Webhook de códigos de retiro no configurado (CODIGOS_RETIRO_WEBHOOK_API_KEY).",
        )
    got = (raw or "").strip()
    if not got or not secrets.compare_digest(got, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Cabecera X-API-Key inválida.",
        )


def _amount_matches(expected: Decimal, candidate: object) -> bool:
    try:
        got = Decimal(str(candidate)).quantize(Decimal("0.01"))
    except Exception:
        return False
    return abs(got - expected) <= _AMOUNT_EPS


def _sale_matches_retiro_amount(sale: Sale, target: Decimal) -> bool:
    """Compara monto del webhook con total o saldo pendiente de la venta."""
    from app.services.client_payment_service import _sale_invoice_total

    local = sale.local_amount if sale.local_amount is not None else sale.amount
    if _amount_matches(target, local):
        return True
    if _amount_matches(target, sale.amount):
        return True
    try:
        real_total = _sale_invoice_total(sale)
    except Exception:
        real_total = Decimal(str(local or 0))
    if _amount_matches(target, real_total):
        return True
    paid = Decimal(str(sale.amount_paid or 0))
    remaining = real_total - paid
    return remaining > 0 and _amount_matches(target, remaining)


def _payment_compare_amounts(cp: ClientPayment, target: Decimal) -> bool:
    if _amount_matches(target, cp.amount):
        return True
    notes = str(cp.notes or "")
    m = _META_EFECTIVO_RE.search(notes)
    if m and _amount_matches(target, m.group(1)):
        return True
    return False


def _is_codigos_retiro_payment(cp: ClientPayment) -> bool:
    pm = str(cp.payment_method or "").strip().lower()
    if any(h in pm for h in _RETIRO_PM_HINTS):
        return True
    notes = str(cp.notes or "").lower()
    return "codigos_retiro" in notes or "codigo_retiro" in notes or "código de retiro" in notes


def find_client_by_retiro_label(db: Session, label: str) -> Optional[Client]:
    needle = str(label or "").strip().lower()
    if not needle:
        return None
    return (
        db.query(Client)
        .filter(
            or_(
                func.lower(func.trim(Client.name)) == needle,
                func.lower(func.trim(Client.username)) == needle,
                func.lower(func.trim(Client.email)) == needle,
            )
        )
        .first()
    )


def _parse_referencia_externa_sale_id(raw: Optional[str]) -> Optional[int]:
    from app.services.codigos_retiro_instant_service import parse_referencia_externa_sale_id

    return parse_referencia_externa_sale_id(raw)


def _parse_referencia_externa_wallet_recharge_id(raw: Optional[str]) -> Optional[int]:
    from app.services.codigos_retiro_instant_service import parse_referencia_externa_wallet_recharge_id

    return parse_referencia_externa_wallet_recharge_id(raw)


def find_retiro_transaction_by_referencia_externa(
    db: Session,
    *,
    referencia_externa: str,
    amount: Decimal,
) -> Optional[MatchedRetiroTransaction]:
    """Localiza la venta por ID externo (``FAC-*`` o numérico ambiguo)."""
    from app.services.codigos_retiro_instant_service import classify_referencia_externa

    kind, _ = classify_referencia_externa(referencia_externa)
    if kind == "wallet_recharge":
        return None

    sid = _parse_referencia_externa_sale_id(referencia_externa)
    if sid is None:
        return None
    sale = db.get(Sale, int(sid))
    if sale is None:
        return None
    from app.services.codigos_retiro_instant_service import WEBHOOK_SALE_STATUSES

    if sale.status not in WEBHOOK_SALE_STATUSES:
        return None
    client = db.get(Client, int(sale.client_id))
    if client is None:
        return None
    target = amount.quantize(Decimal("0.01"))
    cp: Optional[ClientPayment] = None
    pending_for_sale = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == int(client.id),
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
        .order_by(ClientPayment.created_at.desc(), ClientPayment.id.desc())
        .all()
    )
    for candidate in pending_for_sale:
        linked_sale = _resolve_sale_for_payment(db, candidate)
        if linked_sale is not None and int(linked_sale.id) == int(sale.id):
            cp = candidate
            break
        if parse_notes_meta_sale_id(candidate.notes) == int(sale.id):
            cp = candidate
            break
    return MatchedRetiroTransaction(
        client=client,
        amount=target,
        client_payment=cp,
        sale=sale,
    )


def find_retiro_wallet_recharge_by_referencia_externa(
    db: Session,
    *,
    referencia_externa: str,
    amount: Decimal,
    require_amount_match: bool = True,
) -> Optional[MatchedRetiroTransaction]:
    """Localiza recarga BaaS por referencia externa (``REC-00042``)."""
    wr_id = _parse_referencia_externa_wallet_recharge_id(referencia_externa)
    if wr_id is None:
        return None
    return _build_matched_retiro_wallet_recharge(
        db,
        wr_id=int(wr_id),
        amount=amount,
        require_amount_match=require_amount_match,
    )


def _build_matched_retiro_wallet_recharge(
    db: Session,
    *,
    wr_id: int,
    amount: Decimal,
    require_amount_match: bool = True,
) -> Optional[MatchedRetiroTransaction]:
    """Espejo de ``find_retiro_transaction_by_referencia_externa`` para recargas BaaS."""
    from app.services.codigos_retiro_instant_service import WEBHOOK_WR_STATUSES as WR_STATUSES
    from app.wallet_recharge_helpers import wallet_recharge_awaiting_codigos_retiro_webhook

    req = db.get(WalletRechargeRequest, int(wr_id))
    if req is None:
        return None
    st = str(getattr(req, "status", "") or "")
    if st not in WR_STATUSES:
        return None

    pending = float(getattr(req, "balance_pending", 0) or 0)
    awaiting_webhook = wallet_recharge_awaiting_codigos_retiro_webhook(req)
    if pending <= _WR_EPS and not awaiting_webhook and st not in (REQ_STATUS_PENDING, REQ_STATUS_IN_REVIEW):
        return None

    client = db.get(Client, int(req.client_id))
    if client is None:
        return None

    target = amount.quantize(Decimal("0.01"))
    cp: Optional[ClientPayment] = None
    pending_for_client = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == int(client.id),
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
        .order_by(ClientPayment.created_at.desc(), ClientPayment.id.desc())
        .all()
    )
    for candidate in pending_for_client:
        if parse_notes_meta_wallet_recharge_id(candidate.notes) == int(req.id):
            cp = candidate
            break
    if cp is None:
        cp = find_pending_client_payment_for_wallet_recharge(db, req)

    if require_amount_match:
        amount_ok = any(_amount_matches(target, cand) for cand in _wallet_amount_candidates(req))
        if not amount_ok and cp is not None and _payment_compare_amounts(cp, target):
            amount_ok = True
        if not amount_ok and awaiting_webhook:
            amount_ok = True
        if not amount_ok:
            return None

    return MatchedRetiroTransaction(
        client=client,
        amount=target,
        client_payment=cp,
        wallet_recharge=req,
    )


def resolve_retiro_match_by_referencia_externa(
    db: Session,
    *,
    referencia_externa: str,
    amount: Decimal,
) -> Optional[MatchedRetiroTransaction]:
    """
    Enrutamiento polimórfico: ``REC-*`` → recarga BaaS; ``FAC-*`` / numérico → venta.

    Si la referencia es numérica sin prefijo, intenta recarga y venta (retrocompatibilidad).
    """
    from app.services.codigos_retiro_instant_service import classify_referencia_externa

    ref = str(referencia_externa or "").strip()
    if not ref:
        return None

    kind, entity_id = classify_referencia_externa(ref)

    if kind == "wallet_recharge" and entity_id is not None:
        match = find_retiro_wallet_recharge_by_referencia_externa(
            db,
            referencia_externa=ref,
            amount=amount,
            require_amount_match=False,
        )
        if match is not None:
            return match

    if kind in ("sale", "ambiguous") and entity_id is not None:
        match = find_retiro_transaction_by_referencia_externa(
            db,
            referencia_externa=ref,
            amount=amount,
        )
        if match is not None:
            return match
        if kind == "ambiguous":
            match = _build_matched_retiro_wallet_recharge(
                db,
                wr_id=int(entity_id),
                amount=amount,
                require_amount_match=True,
            )
            if match is not None:
                return match

    if kind == "wallet_recharge":
        return find_retiro_wallet_recharge_by_referencia_externa(
            db,
            referencia_externa=ref,
            amount=amount,
            require_amount_match=False,
        )

    return None


def _resolve_sale_for_payment(db: Session, cp: ClientPayment) -> Optional[Sale]:
    meta_sid = parse_notes_meta_sale_id(cp.notes)
    if meta_sid is not None:
        sale = db.get(Sale, int(meta_sid))
        if sale is not None and int(sale.client_id) == int(cp.client_id):
            return sale
    alloc = (
        db.query(PaymentAllocation)
        .filter(PaymentAllocation.payment_id == int(cp.id))
        .order_by(PaymentAllocation.id.asc())
        .first()
    )
    if alloc is not None and alloc.sale_id is not None:
        sale = db.get(Sale, int(alloc.sale_id))
        if sale is not None and int(sale.client_id) == int(cp.client_id):
            return sale
    return None


def _wallet_amount_candidates(req: WalletRechargeRequest) -> list[Decimal]:
    out: list[Decimal] = []
    for raw in (
        getattr(req, "portal_declared_payment_amount", None),
        getattr(req, "balance_pending", None),
        getattr(req, "amount_requested", None),
    ):
        if raw is None:
            continue
        try:
            out.append(Decimal(str(raw)).quantize(Decimal("0.01")))
        except Exception:
            continue
    return out


def find_pending_retiro_transaction(
    db: Session,
    *,
    client: Client,
    amount: Decimal,
) -> Optional[MatchedRetiroTransaction]:
    """Localiza la transacción pendiente del cliente que coincide con el monto del webhook."""
    target = amount.quantize(Decimal("0.01"))
    cid = int(client.id)

    pending_payments = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == cid,
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
        .order_by(ClientPayment.created_at.desc(), ClientPayment.id.desc())
        .all()
    )
    matching_cp = [cp for cp in pending_payments if _payment_compare_amounts(cp, target)]
    matching_cp.sort(
        key=lambda cp: (
            0 if _is_codigos_retiro_payment(cp) else 1,
            -(cp.created_at.timestamp() if cp.created_at else 0),
            -int(cp.id),
        )
    )

    if matching_cp:
        cp = matching_cp[0]
        wr_id = parse_notes_meta_wallet_recharge_id(cp.notes)
        wr: Optional[WalletRechargeRequest] = None
        if wr_id is not None:
            wr = db.get(WalletRechargeRequest, int(wr_id))
            if wr is not None and int(wr.client_id) != cid:
                wr = None
        sale = None if wr is not None else _resolve_sale_for_payment(db, cp)
        if wr is None and sale is None:
            wr_id2 = parse_notes_meta_wallet_recharge_id(cp.notes)
            if wr_id2 is not None:
                wr = db.get(WalletRechargeRequest, int(wr_id2))
        return MatchedRetiroTransaction(
            client=client,
            amount=target,
            client_payment=cp,
            sale=sale,
            wallet_recharge=wr,
        )

    open_wr = (
        db.query(WalletRechargeRequest)
        .filter(
            WalletRechargeRequest.client_id == cid,
            WalletRechargeRequest.balance_pending > _WR_EPS,
        )
        .order_by(WalletRechargeRequest.created_at.desc(), WalletRechargeRequest.id.desc())
        .all()
    )
    for req in open_wr:
        if any(_amount_matches(target, cand) for cand in _wallet_amount_candidates(req)):
            cp_wr = find_pending_client_payment_for_wallet_recharge(db, req)
            return MatchedRetiroTransaction(
                client=client,
                amount=target,
                client_payment=cp_wr,
                wallet_recharge=req,
            )

    open_sales = (
        db.query(Sale)
        .filter(
            Sale.client_id == cid,
            Sale.status.in_(
                (
                    SaleStatus.pending,
                    SaleStatus.payment_submitted,
                    SaleStatus.partially_paid,
                )
            ),
        )
        .order_by(Sale.created_at.desc(), Sale.id.desc())
        .all()
    )
    for sale in open_sales:
        linked = (
            db.query(ClientPayment)
            .join(PaymentAllocation, PaymentAllocation.payment_id == ClientPayment.id)
            .filter(
                PaymentAllocation.sale_id == int(sale.id),
                ClientPayment.status == ClientPaymentStatus.pending_review,
            )
            .order_by(ClientPayment.created_at.desc())
            .all()
        )
        for cp in linked:
            if _payment_compare_amounts(cp, target):
                return MatchedRetiroTransaction(
                    client=client,
                    amount=target,
                    client_payment=cp,
                    sale=sale,
                )
        meta_matches = [
            cp
            for cp in pending_payments
            if parse_notes_meta_sale_id(cp.notes) == int(sale.id)
            and _payment_compare_amounts(cp, target)
        ]
        if meta_matches:
            return MatchedRetiroTransaction(
                client=client,
                amount=target,
                client_payment=meta_matches[0],
                sale=sale,
            )
        if _sale_matches_retiro_amount(sale, target):
            return MatchedRetiroTransaction(
                client=client,
                amount=target,
                sale=sale,
            )

    return None


def _resolve_currency(ctx: MatchedRetiroTransaction) -> str:
    if ctx.client_payment is not None:
        return normalize_currency_code(str(ctx.client_payment.currency or "USD"))
    if ctx.wallet_recharge is not None:
        return normalize_currency_code(str(getattr(ctx.wallet_recharge, "recharge_currency", None) or "USD"))
    if ctx.sale is not None:
        return normalize_currency_code(str(ctx.sale.currency or "USD"))
    return "USD"


def _stamp_sale_retiro_failed_event(sale: Sale, amount: Decimal, currency: str) -> None:
    events = list(sale.payment_events or [])
    events.append(
        {
            "occurred_at": isoformat_z(now_ecuador()),
            "amount": float(amount),
            "currency": currency,
            "status": "Código de retiro fallido",
            "receipt_url": None,
            "notes": "Código de retiro inválido, sin fondos o intento de fraude (webhook socio recaudo).",
        }
    )
    sale.payment_events = events


def _record_failed_retiro_cxc_debt(
    db: Session,
    ctx: MatchedRetiroTransaction,
    *,
    reason: str,
) -> None:
    """Registra la deuda CxC pendiente tras un retiro fallido (auditoría + saldo abierto)."""
    cur = _resolve_currency(ctx)
    note_text = (
        f"Código de retiro inválido, sin fondos o intento de fraude. "
        f"Monto intentado: {float(ctx.amount):.2f} {cur}. "
        f"{reason.strip()}"
    ).strip()
    db.add(
        ClientNote(
            client_id=int(ctx.client.id),
            user_id=None,
            note=note_text,
            created_at=now_ecuador(),
        )
    )
    db.add(
        ClientDebtPayment(
            client_id=int(ctx.client.id),
            amount=ctx.amount,
            currency=cur,
            receipt_url=None,
            payment_method_id=(
                int(ctx.client_payment.payment_method_id)
                if ctx.client_payment is not None and ctx.client_payment.payment_method_id
                else None
            ),
            deposit_account_id=(
                int(ctx.client_payment.deposit_account_id)
                if ctx.client_payment is not None and ctx.client_payment.deposit_account_id
                else None
            ),
            status=DebtPaymentStatus.rejected,
            notes=note_text[:1000],
            created_at=now_ecuador(),
            approved_at=None,
        )
    )
    if ctx.sale is not None:
        _stamp_sale_retiro_failed_event(ctx.sale, ctx.amount, cur)


def _stamp_retiro_webhook_notes(notes: Optional[str]) -> str:
    from app.services.codigos_retiro_instant_service import stamp_retiro_webhook_notes

    return stamp_retiro_webhook_notes(notes)


def _stamp_sale_retiro_failed_note_only(
    db: Session,
    sale: Sale,
    *,
    amount: Decimal,
    currency: str,
    reason: str,
) -> None:
    """Registra fallo de retiro sin alterar CxC ni pagos (venta ya activada)."""
    from app.models.client_note import ClientNote

    events = list(sale.payment_events or [])
    events.append(
        {
            "occurred_at": isoformat_z(now_ecuador()),
            "amount": float(amount),
            "currency": currency,
            "status": "Código de retiro fallido",
            "receipt_url": None,
            "notes": reason,
        }
    )
    sale.payment_events = events
    db.add(
        ClientNote(
            client_id=int(sale.client_id),
            user_id=None,
            note=reason[:2000],
            created_at=now_ecuador(),
        )
    )


def _stamp_wallet_recharge_retiro_failed_note_only(
    db: Session,
    req: WalletRechargeRequest,
    *,
    amount: Decimal,
    currency: str,
    reason: str,
) -> None:
    """Registra fallo de retiro sin revertir billetera ni CxC (recarga ya activada)."""
    db.add(
        ClientNote(
            client_id=int(req.client_id),
            user_id=None,
            note=reason[:2000],
            created_at=now_ecuador(),
        )
    )
    logger.info(
        "Webhook retiro fallido (recarga BaaS #%s activada): monto=%s %s — CxC sin cambios",
        req.id,
        float(amount),
        currency,
    )


def _approve_client_payment_retiro_light(
    db: Session,
    cp: ClientPayment,
    *,
    sale: Optional[Sale] = None,
) -> None:
    """
    Marca el cobro como aprobado, actualiza saldos CxC y registra el asiento contable
    (DR banco / CR CxC por el monto abonado).
    """
    if cp.status != ClientPaymentStatus.pending_review:
        return

    _deduct_reserved_credit_on_payment_approval(db, cp)

    existing_allocs = (
        db.query(PaymentAllocation).filter(PaymentAllocation.payment_id == int(cp.id)).all()
    )
    if not existing_allocs:
        manual_rows: list[dict] = []
        meta_sid = parse_notes_meta_sale_id(cp.notes)
        if sale is not None:
            manual_rows = [{"sale_id": int(sale.id)}]
        elif meta_sid is not None:
            manual_rows = [{"sale_id": int(meta_sid)}]
        if manual_rows:
            apply_payment_allocations(db, cp, manual_rows, fifo_fallback=True)

    cp.status = ClientPaymentStatus.approved
    cp.approved_at = now_ecuador()
    cp.notes = _stamp_retiro_webhook_notes(cp.notes)
    db.flush()

    touched_sale_ids: set[int] = set()
    if sale is not None:
        touched_sale_ids.add(int(sale.id))
    meta_sid = parse_notes_meta_sale_id(cp.notes)
    if meta_sid is not None:
        touched_sale_ids.add(int(meta_sid))
    for alloc in db.query(PaymentAllocation).filter(PaymentAllocation.payment_id == int(cp.id)).all():
        if alloc.sale_id is not None:
            touched_sale_ids.add(int(alloc.sale_id))

    for sid in touched_sale_ids:
        s = db.get(Sale, int(sid))
        if s is not None:
            sync_sale_amount_paid_from_allocations(db, s)
            refresh_sale_status_after_payment(db, s)

    client = db.get(Client, int(cp.client_id))
    if client is not None:
        linked_sale = sale
        if linked_sale is None and meta_sid is not None:
            linked_sale = db.get(Sale, int(meta_sid))
        from app.services.codigos_retiro_instant_service import (
            ensure_retiro_webhook_deposit_account,
            sync_retiro_webhook_payment_accounting,
        )

        ensure_retiro_webhook_deposit_account(db, cp, client=client, sale=linked_sale)
        db.flush()
        sync_retiro_webhook_payment_accounting(db, cp, strict=True)


def _approve_sale_retiro_light(db: Session, ctx: MatchedRetiroTransaction) -> None:
    """
    Aprueba cobro de venta vía webhook: pasa a Activadas si salda, sin aprovisionar inventario
    ni generar asientos de costo del socio.
    """
    from app.services.client_payment_service import _sale_invoice_total

    sale = ctx.sale
    if sale is None:
        raise ValueError("No hay venta vinculada.")

    cp = ctx.client_payment
    if cp is not None:
        _approve_client_payment_retiro_light(db, cp, sale=sale)
    elif sale.status == SaleStatus.pending:
        real_total = _sale_invoice_total(db, sale)
        now_iso = isoformat_z(now_ecuador())
        events = list(sale.payment_events or [])
        events.append(
            {
                "occurred_at": now_iso,
                "amount": float(ctx.amount),
                "currency": _resolve_currency(ctx),
                "status": "Aprobado",
                "receipt_url": None,
                "notes": "Pago confirmado vía webhook códigos de retiro.",
            }
        )
        sale.payment_events = events
        sale.amount_paid = real_total
        sale.status = SaleStatus.approved
    elif sale.status in (SaleStatus.payment_submitted, SaleStatus.partially_paid):
        refresh_sale_status_after_payment(db, sale)

    db.commit()


def _approve_standalone_payment(db: Session, cp: ClientPayment) -> None:
    _approve_client_payment_retiro_light(db, cp)
    db.commit()


def process_codigos_retiro_webhook(
    db: Session,
    *,
    cliente: str,
    estado: Literal["completado", "fallido", "fallido_revision"],
    monto: Decimal,
    referencia_externa: Optional[str] = None,
    es_prueba: bool = False,
    receipt_url: Optional[str] = None,
) -> dict[str, object]:
    """Ejecuta la lógica de negocio del webhook (sin validar API key)."""
    amount = monto.quantize(Decimal("0.01"))
    receipt_url = normalize_retiro_webhook_receipt_url(receipt_url)
    match: Optional[MatchedRetiroTransaction] = None

    ref = str(referencia_externa or "").strip()
    if ref:
        match = resolve_retiro_match_by_referencia_externa(
            db,
            referencia_externa=ref,
            amount=amount,
        )
        if match is not None:
            if match.wallet_recharge is not None:
                logger.info(
                    "Webhook retiro: recarga BaaS #%s enlazada por referencia_externa=%r (es_prueba=%s)",
                    match.wallet_recharge.id,
                    ref,
                    es_prueba,
                )
            elif match.sale is not None:
                logger.info(
                    "Webhook retiro: venta #%s enlazada por referencia_externa=%r (es_prueba=%s)",
                    match.sale.id,
                    ref,
                    es_prueba,
                )

    if match is None:
        client = find_client_by_retiro_label(db, cliente)
        if client is None:
            logger.warning("Webhook retiro: cliente no encontrado (%r)", cliente)
            return {"ok": False, "message": f"Cliente no encontrado: {cliente!r}"}

        match = find_pending_retiro_transaction(db, client=client, amount=amount)
        if match is None:
            logger.warning(
                "Webhook retiro: transacción pendiente no encontrada cliente=%s monto=%s ref=%r",
                client.id,
                amount,
                ref or None,
            )
            return {
                "ok": False,
                "message": "No se encontró transacción pendiente que coincida con cliente, monto o referencia.",
                "client_id": int(client.id),
            }

    if estado == "completado":
        return _process_completado(db, match, es_prueba=es_prueba, receipt_url=receipt_url)
    return _process_fallido(db, match, es_prueba=es_prueba)


def _wallet_recharge_retiro_failed_preserves_cxc(db: Session, req: WalletRechargeRequest) -> bool:
    """
    True si un retiro fallido no debe alterar CxC ni billetera (igual que ventas activadas).
    """
    from app.services.client_payment_service import _wallet_credited_for_recharge_request
    from app.wallet_recharge_helpers import (
        REQ_STATUS_APPROVED,
        REQ_STATUS_IN_REVIEW,
        REQ_STATUS_PARTIALLY_PAID,
        _RETIRO_INSTANT_CXC_MARKER,
        wallet_recharge_contributes_to_client_debt,
        wallet_recharge_open_balance,
    )

    if wallet_recharge_contributes_to_client_debt(req):
        return True
    if _wallet_credited_for_recharge_request(db, req) > 1e-6:
        return True
    if _RETIRO_INSTANT_CXC_MARKER in str(getattr(req, "admin_note", "") or ""):
        return True
    st = str(getattr(req, "status", "") or "")
    if st in (REQ_STATUS_APPROVED, REQ_STATUS_PARTIALLY_PAID, REQ_STATUS_IN_REVIEW):
        return wallet_recharge_open_balance(req) > 1e-6
    return False


def _process_completado(
    db: Session,
    ctx: MatchedRetiroTransaction,
    *,
    es_prueba: bool = False,
    receipt_url: Optional[str] = None,
) -> dict[str, object]:
    try:
        if not es_prueba:
            logger.info(
                "Webhook retiro PRODUCCIÓN: procesando estado=completado cliente_id=%s monto=%s "
                "sale_id=%s wallet_recharge_id=%s",
                ctx.client.id,
                ctx.amount,
                int(ctx.sale.id) if ctx.sale is not None else None,
                int(ctx.wallet_recharge.id) if ctx.wallet_recharge is not None else None,
            )

        sale = ctx.sale
        req = ctx.wallet_recharge

        if req is not None:
            st = str(getattr(req, "status", "") or "")
            if st in (REQ_STATUS_PENDING, REQ_STATUS_IN_REVIEW):
                try:
                    from app.services.codigos_retiro_instant_service import (
                        format_wallet_recharge_referencia_externa,
                        instant_activation_cxc_wallet_recharge,
                    )

                    instant_activation_cxc_wallet_recharge(
                        db,
                        client_id=int(ctx.client.id),
                        referencia_externa=format_wallet_recharge_referencia_externa(int(req.id)),
                        skip_retiro_method_guard=True,
                    )
                except HTTPException as exc:
                    if exc.status_code != status.HTTP_409_CONFLICT:
                        raise
            db.refresh(req)

        if sale is not None:
            if sale.status in (SaleStatus.pending, SaleStatus.payment_submitted):
                try:
                    from app.services.codigos_retiro_instant_service import instant_activation_cxc

                    instant_activation_cxc(
                        db,
                        client_id=int(ctx.client.id),
                        referencia_externa=str(sale.id),
                        skip_retiro_method_guard=True,
                    )
                except HTTPException as exc:
                    if exc.status_code != status.HTTP_409_CONFLICT:
                        raise
                db.refresh(sale)

        if sale is not None or req is not None:
            from app.services.codigos_retiro_instant_service import register_retiro_webhook_cxc_abono

            payment_id = register_retiro_webhook_cxc_abono(
                db,
                client=ctx.client,
                amount=ctx.amount,
                sale=sale,
                wallet_recharge=req,
                es_prueba=es_prueba,
                existing_payment=ctx.client_payment,
                receipt_url=receipt_url,
            )
            db.commit()
            msg = (
                "Abono CxC registrado por webhook de códigos de retiro (recarga BaaS)."
                if req is not None
                else "Abono CxC registrado por webhook de códigos de retiro."
            )
            out: dict[str, object] = {
                "ok": True,
                "message": msg,
                "payment_id": payment_id,
                "client_id": int(ctx.client.id),
            }
            if sale is not None:
                out["sale_id"] = int(sale.id)
            if req is not None:
                out["wallet_recharge_id"] = int(req.id)
            return out

        cp = ctx.client_payment
        if cp is not None:
            _approve_standalone_payment(db, cp)
            return {
                "ok": True,
                "message": "Pago aprobado.",
                "payment_id": int(cp.id),
                "client_id": int(ctx.client.id),
            }

        return {"ok": False, "message": "Transacción encontrada sin entidad procesable."}
    except Exception as exc:
        db.rollback()
        logger.exception(
            "Webhook retiro completado falló cliente=%s monto=%s",
            ctx.client.id,
            ctx.amount,
        )
        return {"ok": False, "message": str(exc), "client_id": int(ctx.client.id)}


def _process_fallido(
    db: Session,
    ctx: MatchedRetiroTransaction,
    *,
    es_prueba: bool = False,
) -> dict[str, object]:
    reason = (
        "Webhook socio recaudo físico: código de retiro fallido o rechazado en revisión. "
        "La deuda CxC se mantiene para gestión de cobranza."
    )
    if es_prueba:
        reason = f"[PRUEBA] {reason}"
    cp = ctx.client_payment
    sale = ctx.sale
    req = ctx.wallet_recharge
    try:
        if cp is not None and cp.status == ClientPaymentStatus.pending_review:
            void_client_payment(
                db,
                cp,
                reason=f"Código de retiro fallido ({cp.payment_number or cp.id})",
            )

        if sale is not None:
            cur = _resolve_currency(ctx)
            _stamp_sale_retiro_failed_note_only(
                db,
                sale,
                amount=ctx.amount,
                currency=cur,
                reason=reason,
            )
            db.commit()
            return {
                "ok": True,
                "message": "Retiro fallido registrado en la factura; CxC sin cambios.",
                "client_id": int(ctx.client.id),
                "sale_id": int(sale.id),
                "es_prueba": es_prueba,
            }

        if req is not None:
            cur = _resolve_currency(ctx)
            _stamp_wallet_recharge_retiro_failed_note_only(
                db,
                req,
                amount=ctx.amount,
                currency=cur,
                reason=reason,
            )
            if not _wallet_recharge_retiro_failed_preserves_cxc(db, req):
                if str(req.status) in OPEN_PORTAL_STATUSES:
                    req.status = REQ_STATUS_REJECTED
            db.commit()
            return {
                "ok": True,
                "message": "Retiro fallido registrado; billetera y CxC sin cambios.",
                "client_id": int(ctx.client.id),
                "wallet_recharge_id": int(req.id),
                "es_prueba": es_prueba,
            }

        if cp is not None and not es_prueba:
            _record_failed_retiro_cxc_debt(db, ctx, reason=reason)

        db.commit()
        return {
            "ok": True,
            "message": "Retiro fallido registrado.",
            "client_id": int(ctx.client.id),
            "payment_id": int(cp.id) if cp is not None else None,
            "es_prueba": es_prueba,
        }
    except Exception as exc:
        db.rollback()
        logger.exception(
            "Webhook retiro fallido error cliente=%s monto=%s",
            ctx.client.id,
            ctx.amount,
        )
        return {"ok": False, "message": str(exc), "client_id": int(ctx.client.id)}


def run_codigos_retiro_webhook_background(payload: dict[str, object]) -> None:
    """Entry point para ``BackgroundTasks`` con sesión DB propia."""
    from app.database import SessionLocal

    estado_raw = str(payload.get("estado") or "").strip().lower()
    if estado_raw not in ("completado", "fallido", "fallido_revision"):
        logger.error("Webhook códigos retiro: estado inválido %r", estado_raw)
        return

    es_prueba_raw = payload.get("es_prueba")
    if isinstance(es_prueba_raw, bool):
        es_prueba = es_prueba_raw
    else:
        es_prueba = str(es_prueba_raw or "").strip().lower() in ("1", "true", "yes", "si", "sí")

    db = SessionLocal()
    try:
        logger.info(
            "Webhook códigos retiro encolado: estado=%s es_prueba=%s cliente=%r monto=%s ref=%r receipt=%s",
            estado_raw,
            es_prueba,
            payload.get("cliente"),
            payload.get("monto"),
            payload.get("referencia_externa"),
            "yes" if extract_receipt_url_from_webhook_payload(payload) else "no",
        )
        result = process_codigos_retiro_webhook(
            db,
            cliente=str(payload.get("cliente") or ""),
            estado=estado_raw,  # type: ignore[arg-type]
            monto=Decimal(str(payload.get("monto"))),
            referencia_externa=(
                str(payload.get("referencia_externa")).strip()
                if payload.get("referencia_externa") is not None
                else None
            ),
            es_prueba=es_prueba,
            receipt_url=extract_receipt_url_from_webhook_payload(payload),
        )
        logger.info("Webhook códigos retiro procesado: %s", result)
    except Exception:
        db.rollback()
        logger.exception("Error fatal procesando webhook códigos retiro")
    finally:
        db.close()
