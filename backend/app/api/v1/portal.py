"""Portal público de autogestión del cliente (token permanente por cliente ``Client.payment_token``)."""

from __future__ import annotations

import base64
import json
import logging
import re
import os
import uuid as uuid_pkg
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload
from app.timezone_utils import UTC, ensure_aware, isoformat_z, now_ecuador

logger = logging.getLogger(__name__)

from app.account_constants import is_liquid_deposit_account
from app.api.v1.checkout import (
    _checkout_lines_public,
    _infer_local_amount_for_checkout,
)
from app.api.v1.sales import (
    _persist_receipt_upload,
    _resolve_deposit_account_id,
    expire_pending_sales_if_needed,
)
from app.api.v1.distributors import (
    _apply_deposit_account_filter,
    _is_grouping_parent,
    _linked_matches_pm,
    _matched_accounts_for_payment_methods,
)
from app.services.sale_accounting_sync import commit_db_or_rollback, sync_sale_accounting_ledgers
from app.currency_utils import normalize_currency_code
from app.database import get_db
from app.models.account import Account
from app.models.client import Client
from app.models.client_debt_payment import ClientDebtPayment, DebtPaymentStatus
from app.models.client_payment import ClientPayment, ClientPaymentStatus, PaymentAllocation
from app.models.payment_method import PaymentMethod
from app.models.journal_entry import JournalEntry, JournalReferenceType
from app.models.product import Product
from app.models.sale import Sale, SaleStatus
from app.models.screen_stock import ScreenStock
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.models.wallet_transaction import WalletTransaction
from app.schemas.client_notifications import PortalNotificationMarkReadResponse, PortalNotificationRead
from app.schemas.client_product_prices import (
    PortalAutoPurchaseProduct,
    PortalAutoPurchaseRequest,
    PortalAutoPurchaseResponse,
)
from app.schemas.portal_public import (
    DebtPaymentItem,
    DebtPaymentSubmitResponse,
    PortalActiveScreen,
    PortalClientBrief,
    PortalCxcBalanceResponse,
    PortalDepositPick,
    PortalHomeResponse,
    PortalInstantActivationResponse,
    PortalLedgerEntry,
    PortalOutstandingSale,
    PortalPaymentMethodPick,
    PortalPaymentSubmitResponse,
    PortalSalePaymentBrief,
    PortalAssignPricesRequest,
    PortalSubClientBrief,
    PortalSubClientCreate,
    PortalSubClientDeleteResponse,
    PortalSubClientPricingRow,
    PortalSubClientSetPricesRequest,
    PortalSubClientTransferRequest,
    PortalSubClientTransferResponse,
    PortalSubClientUpdate,
    PortalWalletRechargeItem,
    ReceiptAnalysisResponse,
    SalePaymentEvent,
)
from app.services.client_notification_service import (
    list_client_notifications,
    mark_client_notification_read,
)
from app.services.client_product_price_service import _package_display_name
from app.services import render_sync
from app.services.client_product_price_service import list_portal_auto_purchase_products
from app.services.portal_auto_purchase_service import execute_portal_auto_purchase
from app.services.client_reseller_service import (
    TX_BAAS_TRANSFER_IN,
    TX_BAAS_TRANSFER_OUT,
    create_subclient_with_prices,
    get_direct_subclient,
    list_parent_selling_packages,
    list_subclient_pricing_matrix,
    list_subclients_for_parent,
    soft_delete_subclient_for_parent,
    transfer_baas_balance_parent_to_child,
    update_subclient_for_parent,
    upsert_subclient_product_prices,
)
from app.schemas.client_product_prices import ClientProductPriceItem
from app.services.client_payment_service import (
    compute_client_credit_summary,
    get_client_credit_balance,
    next_payment_number,
    subtract_client_credit_balance,
)
from app.schemas.distributors import WalletRechargeRequestRead
from app.wallet_recharge_helpers import (
    OPEN_PORTAL_STATUSES,
    REQ_STATUS_APPROVED,
    REQ_STATUS_IN_REVIEW,
    REQ_STATUS_PARTIALLY_PAID,
    REQ_STATUS_PENDING,
    payment_methods_display,
    wallet_recharge_accepts_client_receipt,
)

router = APIRouter(prefix="/portal", tags=["public-client-portal"])


# ── OpenAI receipt analyzer ───────────────────────────────────────────────────

_RECEIPT_SYSTEM_PROMPT = (
    "Eres un asistente contable experto. Analiza el comprobante bancario proporcionado. "
    "Extrae el monto total transferido y la moneda (ej. BOB, USD, EUR). "
    "Tu respuesta debe ser ÚNICAMENTE un JSON válido con esta estructura exacta: "
    '{"extracted_amount": 150.0, "extracted_currency": "BOB", "is_readable": true}. '
    "Si no puedes leer el comprobante o la imagen no es un comprobante bancario, "
    'devuelve {"extracted_amount": null, "extracted_currency": null, "is_readable": false}.'
)

_FALLBACK_RESULT = {"extracted_amount": None, "extracted_currency": None, "is_readable": False}


async def _analyze_receipt_with_openai(image_bytes: bytes, media_type: str) -> dict:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    print(f"DEBUG IA: API Key cargada: {bool(api_key)} | longitud: {len(api_key)}")
    if not api_key:
        print("ERROR IA: OPENAI_API_KEY vacía o no definida en el entorno.")
        return _FALLBACK_RESULT

    try:
        from openai import AsyncOpenAI
    except ImportError as exc:
        print(f"ERROR IA: Librería openai no instalada → {exc}")
        return _FALLBACK_RESULT

    b64 = base64.b64encode(image_bytes).decode()
    print(f"DEBUG IA: Imagen recibida | tipo={media_type} | tamaño base64={len(b64)} bytes")
    data_url = f"data:{media_type};base64,{b64}"

    try:
        client = AsyncOpenAI(api_key=api_key)
        print("DEBUG IA: Enviando solicitud a gpt-4o-mini…")
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=256,
            messages=[
                {"role": "system", "content": _RECEIPT_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_url, "detail": "low"}},
                        {"type": "text", "text": "Analiza este comprobante y devuelve el JSON."},
                    ],
                },
            ],
        )
        print(f"DEBUG IA: Respuesta recibida | finish_reason={resp.choices[0].finish_reason}")
    except Exception as exc:
        print(f"ERROR CRÍTICO OPENAI: {exc}")
        logger.error("OpenAI receipt analysis error: %s", exc, exc_info=True)
        return _FALLBACK_RESULT

    raw = (resp.choices[0].message.content or "").strip()
    print(f"DEBUG IA: Contenido crudo de OpenAI → {raw!r}")

    if "```" in raw:
        parts = raw.split("```")
        raw = parts[1].lstrip("json").strip() if len(parts) > 1 else raw

    try:
        result = json.loads(raw)
        print(f"DEBUG IA: JSON parseado → {result}")
        return result
    except json.JSONDecodeError as exc:
        print(f"ERROR IA: OpenAI devolvió texto no-JSON → {raw!r} | error={exc}")
        return _FALLBACK_RESULT


DbDep = Annotated[Session, Depends(get_db)]

_FP_EPS = Decimal("0.00005")


def _portal_form_int_optional(raw: Optional[object]) -> Optional[int]:
    if raw is None:
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw if raw >= 1 else None
    s = str(raw).strip()
    if not s:
        return None
    try:
        iv = int(s)
        return iv if iv >= 1 else None
    except ValueError:
        return None


def _portal_form_bool(raw: Optional[object]) -> bool:
    if raw is None:
        return False
    if isinstance(raw, bool):
        return raw
    s = str(raw).strip().lower()
    return s in ("1", "true", "yes", "si", "sí", "on")


def _portal_wants_credit_balance(*flags: Optional[object]) -> bool:
    """True si el cliente pidió cruzar saldo a favor (cualquier alias de formulario)."""
    return any(_portal_form_bool(f) for f in flags)


_PORTAL_REVIEW_SUCCESS_MSG = (
    "Tu pago/abono ha sido enviado y está en revisión por un operador."
)


def _pending_review_alloc_sum(db: Session, sale_id: int) -> Decimal:
    agg = (
        db.query(func.coalesce(func.sum(PaymentAllocation.amount_applied), 0))
        .join(ClientPayment, PaymentAllocation.payment_id == ClientPayment.id)
        .filter(
            PaymentAllocation.sale_id == int(sale_id),
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
        .scalar()
    )
    try:
        return Decimal(str(agg or 0)).quantize(Decimal("0.0001"))
    except Exception:
        return Decimal("0")


def _portal_effective_amount_paid(db: Session, sale: Sale) -> Decimal:
    from app.services.client_payment_service import (
        _approved_alloc_sum_for_sale,
        _pending_review_alloc_sum_for_sale,
    )

    approved = _approved_alloc_sum_for_sale(db, int(sale.id))
    pending = _pending_review_alloc_sum_for_sale(db, int(sale.id))
    return (approved + pending).quantize(Decimal("0.0001"))


def _parse_meta_credit_reserved(notes: Optional[str]) -> Decimal:
    if not notes:
        return Decimal("0")
    m = re.search(r"META_CRE_RESV=([\d.]+)", str(notes))
    if not m:
        return Decimal("0")
    try:
        return Decimal(str(m.group(1))).quantize(Decimal("0.01"))
    except Exception:
        return Decimal("0")


def _real_total_from_raw_lines(sale: Sale) -> Decimal:
    """Suma directa del JSON ``invoice_lines`` con todos los alias de campo posibles."""
    raw = getattr(sale, "invoice_lines", None)
    if not isinstance(raw, list) or not raw:
        return Decimal("0")
    acc = Decimal("0")
    for chunk in raw[:200]:
        if not isinstance(chunk, dict):
            continue
        q_val = chunk.get("qty") if chunk.get("qty") is not None else chunk.get("quantity")
        p_val = (
            chunk.get("rate")
            if chunk.get("rate") is not None
            else chunk.get("price")
            if chunk.get("price") is not None
            else chunk.get("unit_price")
        )
        if q_val is not None and p_val is not None:
            try:
                dq, dp = Decimal(str(q_val)), Decimal(str(p_val))
                if dq > Decimal("0"):
                    acc += dq * dp
                    continue
            except Exception:
                pass
        for ak in ("amount", "subtotal", "line_total", "total"):
            v = chunk.get(ak)
            if v is None:
                continue
            try:
                dv = Decimal(str(v))
                if dv > Decimal("0"):
                    acc += dv
            except Exception:
                pass
            break
    return acc.quantize(Decimal("0.0001"))


def _compute_portal_balance(db: Session, sale: Sale) -> tuple[Decimal, Decimal]:
    """Retorna ``(real_total, balance)``."""
    from app.services.client_payment_service import _sale_cxc_open_balance, _sale_invoice_total

    real_total = _sale_invoice_total(db, sale)
    balance = _sale_cxc_open_balance(db, sale, payment=None)
    return real_total, balance


def _sale_balance_due_portal(db: Session, sale: Sale) -> Decimal:
    _, balance = _compute_portal_balance(db, sale)
    return balance if balance > _FP_EPS else Decimal("0")


def _portal_client_payment_ids_for_sale(db: Session, sale_id: int, client_id: int) -> list[int]:
    """Ids de pagos CxC vinculados a una venta (allocations + META_SALE_ID), cualquier estado."""
    from app.services.client_payment_service import parse_notes_meta_sale_id

    sid = int(sale_id)
    cid = int(client_id)
    ids: set[int] = set()

    for (pid,) in (
        db.query(PaymentAllocation.payment_id)
        .filter(PaymentAllocation.sale_id == sid)
        .distinct()
        .all()
    ):
        ids.add(int(pid))

    for cp in db.query(ClientPayment).filter(ClientPayment.client_id == cid).all():
        if parse_notes_meta_sale_id(cp.notes) == sid:
            ids.add(int(cp.id))

    return sorted(ids)


def _portal_client_payments_for_sale(
    db: Session,
    sale_id: int,
    client_id: int,
) -> list[PortalSalePaymentBrief]:
    """Pagos del cliente ligados a la venta, más recientes primero."""
    pids = _portal_client_payment_ids_for_sale(db, sale_id, client_id)
    if not pids:
        return []
    rows = (
        db.query(ClientPayment)
        .filter(ClientPayment.id.in_(pids))
        .order_by(ClientPayment.created_at.desc(), ClientPayment.id.desc())
        .all()
    )
    out: list[PortalSalePaymentBrief] = []
    for r in rows:
        st = r.status.value if hasattr(r.status, "value") else str(r.status or "")
        out.append(
            PortalSalePaymentBrief(
                id=int(r.id),
                payment_number=r.payment_number,
                amount=Decimal(str(r.amount or 0)).quantize(Decimal("0.01")),
                currency=str(r.currency or "USD"),
                status=st,
                created_at=r.created_at.isoformat() if r.created_at else None,
            )
        )
    return out


def _debt_payment_item_from_client_payment(cp: ClientPayment) -> DebtPaymentItem:
    st = cp.status.value if hasattr(cp.status, "value") else str(cp.status or "")
    return DebtPaymentItem(
        id=int(cp.id),
        client_id=int(cp.client_id),
        client_name="",
        payment_number=cp.payment_number,
        amount=Decimal(str(cp.amount or 0)).quantize(Decimal("0.01")),
        currency=str(cp.currency or "USD"),
        receipt_url=cp.receipt_file_url,
        status=st,
        created_at=cp.created_at.isoformat() if cp.created_at else None,
        notes=cp.notes,
    )


def _get_recent_client_payments_for_portal(
    db: Session,
    client_id: int,
    *,
    limit: int = 40,
) -> list[DebtPaymentItem]:
    """Últimos pagos/abonos del cliente con estado actual (incluye rechazados)."""
    rows = (
        db.query(ClientPayment)
        .filter(ClientPayment.client_id == int(client_id))
        .order_by(ClientPayment.created_at.desc(), ClientPayment.id.desc())
        .limit(max(1, min(int(limit), 100)))
        .all()
    )
    return [_debt_payment_item_from_client_payment(r) for r in rows]


def _build_payment_events(sale: Sale) -> list[SalePaymentEvent]:
    raw = getattr(sale, "payment_events", None)
    if not isinstance(raw, list):
        return []
    events: list[SalePaymentEvent] = []
    for ev in raw:
        if not isinstance(ev, dict):
            continue
        try:
            events.append(
                SalePaymentEvent(
                    occurred_at=str(ev.get("occurred_at", "")),
                    amount=float(ev.get("amount", 0)),
                    currency=str(ev.get("currency", "USD")),
                    status=str(ev.get("status", "En revisión")),
                    receipt_url=ev.get("receipt_url"),
                )
            )
        except Exception:
            pass
    return events


def _portal_resolve_payment_picks_for_client(
    db: Session,
    client: Client,
    *,
    currency: str,
    sale: Optional[Sale] = None,
    recharge_raw_pm: Optional[list] = None,
) -> tuple[list[PortalPaymentMethodPick], list[PortalDepositPick]]:
    """Métodos/cuentas del portal: prioriza asignación CRM; si no hay, lógica por venta/recarga."""
    from app.services.client_payment_method_service import (
        build_client_assigned_deposit_picks,
        get_client_assigned_payment_method_ids,
        get_client_assigned_payment_methods_with_accounts,
    )

    cur = normalize_currency_code(currency, "USD")
    assigned_ids = get_client_assigned_payment_method_ids(db, int(client.id))
    if assigned_ids:
        nested = get_client_assigned_payment_methods_with_accounts(
            db,
            int(client.id),
            currency=cur,
        )
        methods = [
            PortalPaymentMethodPick(id=int(m.id), name=m.name)
            for m in nested
            if m.deposit_accounts
        ]
        deps: list[PortalDepositPick] = []
        seen_dep: set[int] = set()
        for method in nested:
            for dep in method.deposit_accounts:
                if int(dep.id) in seen_dep:
                    continue
                seen_dep.add(int(dep.id))
                deps.append(dep)
        return methods, deps

    if recharge_raw_pm is not None:
        pm_picks = _portal_wallet_recharge_method_picks(db, recharge_raw_pm)
        if pm_picks:
            return pm_picks, []

    if sale is not None:
        raw_pm = list(sale.allowed_payment_methods or []) if isinstance(sale.allowed_payment_methods, list) else []
        labels = [str(x).strip() for x in raw_pm if str(x).strip()]
        if not labels:
            labels = _portal_default_method_labels(db)
        methods = _portal_build_method_picks(db, labels)

        raw_ids = sale.allowed_deposit_accounts or []
        dep_ids: list[int] = []
        if isinstance(raw_ids, list):
            for x in raw_ids:
                try:
                    dep_ids.append(int(x))
                except (TypeError, ValueError):
                    continue
        if not dep_ids:
            dep_ids = _portal_default_deposit_ids(db)
        deps = _portal_build_deposit_picks(db, dep_ids)
        return methods, deps

    return [], []


def _build_portal_outstanding_row(db: Session, client: Client, s: Sale) -> tuple[PortalOutstandingSale, Decimal]:
    cur = normalize_currency_code(str(s.currency or "USD"))
    lines = _checkout_lines_public(db, s, product=s.product, stock_row=s.screen_stock_row)
    la_inf = _infer_local_amount_for_checkout(s, lines)
    ap_d = _portal_effective_amount_paid(db, s)

    if la_inf is None:
        balance_due_out = Decimal("0")
    else:
        bd = (la_inf - ap_d).quantize(Decimal("0.0001"))
        balance_due_out = bd if bd > Decimal("0") else Decimal("0")

    methods, deps = _portal_resolve_payment_picks_for_client(db, client, currency=cur, sale=s)

    la_display = la_inf if la_inf is not None else s.local_amount
    if la_display is not None:
        try:
            la_display = Decimal(str(la_display)).quantize(Decimal("0.0001"))
        except Exception:
            la_display = None

    row = PortalOutstandingSale(
        sale_id=s.id,
        status=s.status.value,
        invoice_created_at=s.created_at if isinstance(getattr(s, "created_at", None), datetime) else None,
        expires_at=s.expires_at if s.status == SaleStatus.pending else None,
        currency=cur,
        local_amount=la_display,
        amount_paid=ap_d,
        balance_due=balance_due_out,
        payment_token=getattr(s, "payment_token", None),
        lines=lines,
        allowed_payment_methods=methods,
        allowed_deposit_accounts=deps,
        payment_events=_build_payment_events(s),
        client_payments=_portal_client_payments_for_sale(db, int(s.id), int(client.id)),
    )
    return row, balance_due_out


def _short_public_account_note(text: object | None, max_len: int = 220) -> Optional[str]:
    if text is None:
        return None
    s = str(text).strip()
    if not s:
        return None
    return s[:max_len]


def _portal_build_deposit_picks(db: Session, account_ids: list[int]) -> list[PortalDepositPick]:
    out: list[PortalDepositPick] = []
    seen: set[int] = set()
    for aid in account_ids:
        if aid in seen:
            continue
        seen.add(aid)
        a = db.get(Account, aid)
        if a is None or not a.is_active or not is_liquid_deposit_account(a):
            continue
        cur = normalize_currency_code(str(a.currency or "USD"))
        holder = _short_public_account_note(getattr(a, "description", None))
        out.append(
            PortalDepositPick(
                id=a.id,
                bank_name=(a.name or "").strip() or f"Cuenta {a.id}",
                account_number=(str(a.account_number).strip() if a.account_number else None),
                currency=cur,
                holder_note=holder,
            )
        )
    return out


def _portal_wallet_recharge_deposit_pick_ids_ordered(db: Session, req: WalletRechargeRequest) -> list[int]:
    """IDs de cuentas de depósito (hojas) habilitadas para la solicitud, orden estables."""
    raw_pm = req.allowed_payment_methods if isinstance(req.allowed_payment_methods, list) else []
    pm_ids: list[int] = []
    for x in raw_pm:
        try:
            pm_ids.append(int(x))
        except (TypeError, ValueError):
            continue
    pm_ids = sorted({i for i in pm_ids if i > 0})
    if not pm_ids:
        return []
    pm_rows = (
        db.query(PaymentMethod)
        .filter(PaymentMethod.id.in_(pm_ids), PaymentMethod.is_active.is_(True))
        .order_by(PaymentMethod.id.asc())
        .all()
    )
    if not pm_rows:
        return []
    matched, by_id = _matched_accounts_for_payment_methods(db, pm_rows)
    raw_sel = req.allowed_deposit_account_ids if isinstance(req.allowed_deposit_account_ids, list) else None
    sel_ids: Optional[list[int]] = None
    if raw_sel:
        tmp: list[int] = []
        for x in raw_sel:
            try:
                tmp.append(int(x))
            except (TypeError, ValueError):
                continue
        sel_ids = tmp if tmp else None
    restricted = _apply_deposit_account_filter(matched, by_id, sel_ids)
    seen: set[int] = set()
    ordered: list[int] = []
    for pm in pm_rows:
        ml = (pm.name or "").strip().lower()
        if not ml:
            continue
        for acc in restricted:
            if _is_grouping_parent(acc.id, restricted):
                continue
            if not _linked_matches_pm(acc, ml, by_id):
                continue
            if acc.id not in seen:
                seen.add(acc.id)
                ordered.append(int(acc.id))
    return ordered


def _validate_wallet_recharge_deposit_account(
    db: Session,
    req: WalletRechargeRequest,
    deposit_account_id: Optional[int],
) -> None:
    allowed_ids = _portal_wallet_recharge_deposit_pick_ids_ordered(db, req)
    if not allowed_ids:
        if deposit_account_id is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Esta solicitud no tiene cuentas de depósito configuradas; contacta al administrador.",
            )
        return
    if deposit_account_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Indica la cuenta donde realizaste el depósito.",
        )
    if int(deposit_account_id) not in set(allowed_ids):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cuenta seleccionada no está habilitada para esta solicitud.",
        )


def _portal_build_method_picks(db: Session, labels: list[str]) -> list[PortalPaymentMethodPick]:
    out: list[PortalPaymentMethodPick] = []
    seen: set[int] = set()
    for lab in labels[:40]:
        s = str(lab).strip()
        if not s:
            continue
        pm = (
            db.query(PaymentMethod)
            .filter(
                PaymentMethod.is_active.is_(True),
                func.lower(func.trim(PaymentMethod.name)) == s.lower(),
            )
            .first()
        )
        if pm is None or int(pm.id) in seen:
            continue
        seen.add(int(pm.id))
        out.append(PortalPaymentMethodPick(id=int(pm.id), name=(pm.name or "").strip()))
    return out


def _portal_default_method_labels(db: Session) -> list[str]:
    rows = (
        db.query(PaymentMethod).filter(PaymentMethod.is_active.is_(True)).order_by(PaymentMethod.name.asc()).all()
    )
    return [(r.name or "").strip() for r in rows if (r.name or "").strip()]


def _portal_default_deposit_ids(db: Session) -> list[int]:
    rows = db.query(Account).filter(Account.is_active.is_(True)).order_by(Account.name.asc()).all()
    return [int(a.id) for a in rows if is_liquid_deposit_account(a)]


_PORTAL_LEDGER_LIMIT = 150


def _portal_ledger_ts(dt_val: Optional[datetime]) -> datetime:
    if dt_val is None:
        return datetime.fromtimestamp(0, tz=UTC)
    return ensure_aware(dt_val)


def _portal_client_ledger(db: Session, client_id: int) -> list[PortalLedgerEntry]:
    """Facturas aprobadas / parciales y abonos (ClientPayment aprobados), más recientes primero."""
    merged: list[tuple[datetime, PortalLedgerEntry]] = []

    ledger_sales = (
        db.query(Sale)
        .options(joinedload(Sale.product))
        .filter(
            Sale.client_id == int(client_id),
            Sale.status.in_((SaleStatus.approved, SaleStatus.partially_paid)),
        )
        .order_by(Sale.created_at.desc())
        .limit(200)
        .all()
    )
    for s in ledger_sales:
        real_total, _ = _compute_portal_balance(db, s)
        if real_total <= _FP_EPS:
            continue
        cur = normalize_currency_code(str(s.currency or "USD"))
        parts = []
        if s.product is not None and getattr(s.product, "name", None):
            pn = str(s.product.name).strip()
            if pn:
                parts.append(pn)
        if s.notes and str(s.notes).strip():
            parts.append(str(s.notes).strip()[:200])
        description = " · ".join(parts) if parts else "Factura / pedido activado"
        if len(description) > 260:
            description = description[:257] + "…"
        label = "Pago parcial" if s.status == SaleStatus.partially_paid else "Facturado"
        ts = getattr(s, "created_at", None)
        iso = ts.isoformat() if isinstance(ts, datetime) else None
        merged.append(
            (
                _portal_ledger_ts(ts if isinstance(ts, datetime) else None),
                PortalLedgerEntry(
                    type="invoice",
                    date=iso,
                    description=description,
                    reference=f"FAC-{int(s.id):04d}",
                    amount=real_total.quantize(Decimal("0.01")),
                    currency=cur,
                    status=label,
                    sale_id=int(s.id),
                    linked_sale_ids=[],
                ),
            )
        )

    ledger_payments = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == int(client_id),
            ClientPayment.status == ClientPaymentStatus.approved,
        )
        .order_by(ClientPayment.created_at.desc())
        .limit(200)
        .all()
    )
    for p in ledger_payments:
        try:
            amt = Decimal(str(p.amount or "0")).quantize(Decimal("0.01"))
        except Exception:
            continue
        if amt <= Decimal("0"):
            continue
        cur = normalize_currency_code(str(p.currency or "USD"))
        ref = ((p.payment_number or "").strip() or f"PAG-{int(p.id)}")[:40]
        bits = [(p.payment_method or "").strip(), (p.notes or "").strip()]
        description = " — ".join(x for x in bits if x) or "Abono a tu cuenta"
        if len(description) > 260:
            description = description[:257] + "…"
        ts = getattr(p, "approved_at", None) or getattr(p, "created_at", None)
        iso = ts.isoformat() if isinstance(ts, datetime) else None
        alloc_rows = (
            db.query(PaymentAllocation)
            .filter(PaymentAllocation.payment_id == int(p.id))
            .all()
        )
        linked_ids = sorted({int(a.sale_id) for a in alloc_rows if a.sale_id is not None})
        merged.append(
            (
                _portal_ledger_ts(ts if isinstance(ts, datetime) else None),
                PortalLedgerEntry(
                    type="payment",
                    date=iso,
                    description=description,
                    reference=ref,
                    amount=amt,
                    currency=cur,
                    status="Abono aplicado",
                    sale_id=None,
                    linked_sale_ids=linked_ids,
                ),
            )
        )

    wallet_txs = (
        db.query(WalletTransaction)
        .filter(
            WalletTransaction.client_id == int(client_id),
            WalletTransaction.transaction_type.in_((TX_BAAS_TRANSFER_OUT, TX_BAAS_TRANSFER_IN)),
        )
        .order_by(WalletTransaction.created_at.desc())
        .limit(100)
        .all()
    )
    for wtx in wallet_txs:
        try:
            amt = Decimal(str(abs(float(wtx.amount or 0)))).quantize(Decimal("0.01"))
        except Exception:
            continue
        if amt <= Decimal("0"):
            continue
        ts = getattr(wtx, "created_at", None)
        iso = ts.isoformat() if isinstance(ts, datetime) else None
        tx_type = str(wtx.transaction_type or "")
        if tx_type == TX_BAAS_TRANSFER_OUT:
            description = (wtx.description or "").strip() or "Transferencia a sub-cliente"
            status_label = "Transferencia BaaS"
            ref = f"TXF-{int(wtx.id):05d}"
        else:
            description = (wtx.description or "").strip() or "Recarga de distribuidor"
            status_label = "Recarga BaaS"
            ref = f"TXR-{int(wtx.id):05d}"
        merged.append(
            (
                _portal_ledger_ts(ts if isinstance(ts, datetime) else None),
                PortalLedgerEntry(
                    type="payment",
                    date=iso,
                    description=description[:260],
                    reference=ref,
                    amount=amt,
                    currency="USD",
                    status=status_label,
                    sale_id=None,
                    linked_sale_ids=[],
                ),
            )
        )

    merged.sort(key=lambda row: row[0], reverse=True)
    return [entry for _, entry in merged[:_PORTAL_LEDGER_LIMIT]]


def _portal_wallet_recharge_method_picks(db: Session, raw_ids: Optional[list]) -> list[PortalPaymentMethodPick]:
    """IDs JSON de la solicitud → picks activos del catálogo."""
    if not raw_ids or not isinstance(raw_ids, list):
        return []
    ids: list[int] = []
    for x in raw_ids:
        try:
            ids.append(int(x))
        except (TypeError, ValueError):
            continue
    ids = sorted({i for i in ids if i > 0})
    if not ids:
        return []
    rows = (
        db.query(PaymentMethod)
        .filter(PaymentMethod.id.in_(ids), PaymentMethod.is_active.is_(True))
        .order_by(PaymentMethod.id.asc())
        .all()
    )
    return [
        PortalPaymentMethodPick(id=int(r.id), name=(r.name or "").strip() or f"Método #{r.id}") for r in rows
    ]


def _validate_wallet_recharge_declared_payment_method(
    db: Session,
    req: WalletRechargeRequest,
    payment_method_id: Optional[int],
) -> None:
    raw = req.allowed_payment_methods if isinstance(req.allowed_payment_methods, list) else []
    allowed: list[int] = []
    for x in raw:
        try:
            allowed.append(int(x))
        except (TypeError, ValueError):
            continue
    allowed_unique = sorted({i for i in allowed if i > 0})
    if not allowed_unique:
        return
    if payment_method_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Indica el método de pago que utilizaste para esta recarga.",
        )
    pid = int(payment_method_id)
    if pid not in allowed_unique:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El método de pago seleccionado no está habilitado para esta solicitud.",
        )
    pm_row = db.get(PaymentMethod, pid)
    if pm_row is None or not bool(pm_row.is_active):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Método de pago inválido o inactivo.",
        )


# ── Wallet recharge (BaaS) ────────────────────────────────────────────────────


@router.get("/{portal_token}/recharges", response_model=list[PortalWalletRechargeItem])
def portal_list_wallet_recharges(portal_token: uuid_pkg.UUID, db: DbDep) -> list[PortalWalletRechargeItem]:
    """Solicitudes de recarga abiertas para el cliente (incluye pagos parciales en curso)."""
    client = _portal_client_from_token(db, portal_token)

    from sqlalchemy import and_, or_

    rows = (
        db.query(WalletRechargeRequest)
        .filter(
            WalletRechargeRequest.client_id == client.id,
            or_(
                WalletRechargeRequest.status.in_(OPEN_PORTAL_STATUSES),
                and_(
                    WalletRechargeRequest.status == REQ_STATUS_APPROVED,
                    WalletRechargeRequest.balance_pending > 1e-6,
                ),
            ),
        )
        .order_by(WalletRechargeRequest.created_at.desc())
        .all()
    )
    out: list[PortalWalletRechargeItem] = []
    from app.services.client_payment_method_service import (
        get_client_assigned_payment_method_ids,
        get_client_assigned_payment_methods_with_accounts,
    )

    client_has_assigned_pm = bool(get_client_assigned_payment_method_ids(db, int(client.id)))
    for r in rows:
        recharge_cur = normalize_currency_code(getattr(r, "recharge_currency", None), "USD")
        if client_has_assigned_pm:
            nested = get_client_assigned_payment_methods_with_accounts(
                db,
                int(client.id),
                currency=recharge_cur,
            )
            pm_picks = [
                PortalPaymentMethodPick(id=int(m.id), name=m.name)
                for m in nested
                if m.deposit_accounts
            ]
            pm_disp = ", ".join(p.name for p in pm_picks) if pm_picks else ""
            dep_picks: list[PortalDepositPick] = []
            seen_dep: set[int] = set()
            for method in nested:
                for dep in method.deposit_accounts:
                    if int(dep.id) in seen_dep:
                        continue
                    seen_dep.add(int(dep.id))
                    dep_picks.append(dep)
        else:
            raw_pm = r.allowed_payment_methods if isinstance(r.allowed_payment_methods, list) else None
            pm_picks = _portal_wallet_recharge_method_picks(db, raw_pm)
            pm_disp = payment_methods_display(db, raw_pm)
            dep_ids = _portal_wallet_recharge_deposit_pick_ids_ordered(db, r)
            dep_picks = _portal_build_deposit_picks(db, dep_ids)
        ts = r.created_at
        pre_raw = getattr(r, "admin_precheck_receipt_url", None)
        pre_out = str(pre_raw).strip() if pre_raw else None
        out.append(
            PortalWalletRechargeItem(
                id=r.id,
                amount_requested=float(r.amount_requested),
                amount_paid=float(getattr(r, "amount_paid", 0) or 0),
                balance_pending=float(getattr(r, "balance_pending", 0) or 0),
                surplus_credited=float(getattr(r, "surplus_credited", 0) or 0),
                receipt_url=r.receipt_url or None,
                status=r.status,
                created_at=ts if isinstance(ts, datetime) else now_ecuador(),
                recharge_currency=normalize_currency_code(getattr(r, "recharge_currency", None), "USD"),
                recharge_exchange_rate=float(getattr(r, "recharge_exchange_rate", None) or 1.0),
                admin_precheck_receipt_url=pre_out,
                allowed_payment_methods=pm_picks,
                allowed_deposit_accounts=dep_picks,
                payment_methods_display=pm_disp,
            )
        )
    return out


def _is_portal_client_blocked(client: Client) -> bool:
    return str(client.status or "Activo").strip().lower() == "inactivo"


def _ensure_portal_client_not_blocked(client: Client) -> None:
    if _is_portal_client_blocked(client):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="ACCOUNT_BLOCKED")


def _portal_client_from_token(db: Session, portal_token: uuid_pkg.UUID) -> Client:
    client = db.query(Client).filter(Client.payment_token == portal_token).first()
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Portal no encontrado.")
    _ensure_portal_client_not_blocked(client)
    return client


def _portal_subclient_brief(row: Client) -> PortalSubClientBrief:
    from app.services.client_currency_service import get_client_currency
    from app.services.wallet_balance_service import get_client_wallet_balance

    cur = get_client_currency(row)
    bal = float(get_client_wallet_balance(row, cur))
    return PortalSubClientBrief(
        id=int(row.id),
        name=row.display_name(),
        username=str(row.username or ""),
        email=str(row.email or ""),
        phone=(str(row.phone).strip() if row.phone else None),
        wallet_balance=bal,
        currency=cur,
        portal_token=row.payment_token,
        status=str(row.status or "Activo"),
    )


@router.get("/{portal_token}/sub-clients", response_model=list[PortalSubClientBrief])
def portal_list_sub_clients(portal_token: uuid_pkg.UUID, db: DbDep) -> list[PortalSubClientBrief]:
    """Lista sub-clientes directos del distribuidor autenticado por token."""
    parent = _portal_client_from_token(db, portal_token)
    rows = list_subclients_for_parent(db, int(parent.id), active_only=True)
    return [_portal_subclient_brief(r) for r in rows]


@router.get("/{portal_token}/selling-packages", response_model=list[PortalSubClientPricingRow])
def portal_parent_selling_packages(
    portal_token: uuid_pkg.UUID,
    db: DbDep,
) -> list[PortalSubClientPricingRow]:
    """Paquetes Flujo que el distribuidor puede revender (costo = su tarifa de adquisición)."""
    parent = _portal_client_from_token(db, portal_token)
    rows = list_parent_selling_packages(db, int(parent.id))
    return [PortalSubClientPricingRow.model_validate(r) for r in rows]


@router.post("/{portal_token}/sub-clients", response_model=PortalSubClientBrief, status_code=status.HTTP_201_CREATED)
def portal_create_sub_client(
    portal_token: uuid_pkg.UUID,
    payload: PortalSubClientCreate,
    db: DbDep,
) -> PortalSubClientBrief:
    """Crea un sub-cliente con precios y recarga BaaS inicial (transacción atómica)."""
    parent = _portal_client_from_token(db, portal_token)
    price_items = [
        ClientProductPriceItem(
            product_id=int(p.product_id),
            package_catalog_id=int(p.package_catalog_id),
            custom_price=float(p.custom_price),
        )
        for p in payload.prices
    ]
    child = create_subclient_with_prices(
        db,
        parent,
        username=payload.username,
        email=str(payload.email),
        name=payload.name,
        phone=payload.phone,
        prices=price_items,
        initial_transfer_amount=float(payload.initial_transfer_amount),
    )
    return _portal_subclient_brief(child)


@router.delete(
    "/{portal_token}/sub-clients/{child_client_id}",
    response_model=PortalSubClientDeleteResponse,
)
def portal_delete_sub_client(
    portal_token: uuid_pkg.UUID,
    child_client_id: int,
    db: DbDep,
) -> PortalSubClientDeleteResponse:
    """Elimina un sub-cliente de la red del distribuidor (soft delete; requiere saldo BaaS $0)."""
    parent = _portal_client_from_token(db, portal_token)
    child = soft_delete_subclient_for_parent(db, parent, int(child_client_id))
    return PortalSubClientDeleteResponse(id=int(child.id))


@router.delete(
    "/{portal_token}/subclients/{child_client_id}",
    response_model=PortalSubClientDeleteResponse,
    include_in_schema=False,
)
def portal_delete_sub_client_alias(
    portal_token: uuid_pkg.UUID,
    child_client_id: int,
    db: DbDep,
) -> PortalSubClientDeleteResponse:
    """Alias retrocompatible sin guion en la ruta."""
    return portal_delete_sub_client(portal_token, child_client_id, db)


@router.get("/{portal_token}/notifications", response_model=list[PortalNotificationRead])
def portal_list_notifications(
    portal_token: uuid_pkg.UUID,
    db: DbDep,
) -> list[PortalNotificationRead]:
    """Bandeja de notificaciones del cliente (más recientes primero)."""
    client = _portal_client_from_token(db, portal_token)
    rows = list_client_notifications(db, int(client.id))
    return [PortalNotificationRead.model_validate(r) for r in rows]


@router.put(
    "/{portal_token}/notifications/{notification_id}/read",
    response_model=PortalNotificationMarkReadResponse,
)
def portal_mark_notification_read(
    portal_token: uuid_pkg.UUID,
    notification_id: int,
    db: DbDep,
) -> PortalNotificationMarkReadResponse:
    """Marca una notificación como leída."""
    client = _portal_client_from_token(db, portal_token)
    row = mark_client_notification_read(
        db,
        client_id=int(client.id),
        notification_id=int(notification_id),
    )
    return PortalNotificationMarkReadResponse(id=int(row.id))


@router.put("/{portal_token}/sub-clients/{child_client_id}", response_model=PortalSubClientBrief)
def portal_update_sub_client(
    portal_token: uuid_pkg.UUID,
    child_client_id: int,
    payload: PortalSubClientUpdate,
    db: DbDep,
) -> PortalSubClientBrief:
    """Actualiza datos de contacto de un sub-cliente directo (solo el patrocinador padre)."""
    parent = _portal_client_from_token(db, portal_token)
    if payload.name is None and payload.email is None and payload.phone is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Indica al menos un campo para actualizar.",
        )
    child = update_subclient_for_parent(
        db,
        parent,
        int(child_client_id),
        name=payload.name,
        email=str(payload.email) if payload.email is not None else None,
        phone=payload.phone,
    )
    return _portal_subclient_brief(child)


def _portal_transfer_baas_impl(
    db: Session,
    parent: Client,
    child_client_id: int,
    amount: float,
) -> PortalSubClientTransferResponse:
    child = get_direct_subclient(db, parent, int(child_client_id))
    transfer_baas_balance_parent_to_child(db, parent, child, float(amount))
    db.refresh(parent)
    db.refresh(child)
    return PortalSubClientTransferResponse(
        parent_wallet_balance=float(parent.wallet_balance or 0),
        child_wallet_balance=float(child.wallet_balance or 0),
        amount=float(amount),
    )


@router.post("/{portal_token}/transfer", response_model=PortalSubClientTransferResponse)
def portal_transfer_baas(
    portal_token: uuid_pkg.UUID,
    payload: PortalSubClientTransferRequest,
    db: DbDep,
) -> PortalSubClientTransferResponse:
    """
    Transfiere saldo BaaS del distribuidor a un sub-cliente directo.
    Valida contra ``wallet_balance`` (billetera BaaS disponible del padre).
    """
    parent = _portal_client_from_token(db, portal_token)
    return _portal_transfer_baas_impl(db, parent, int(payload.child_client_id), float(payload.amount))


@router.post("/{portal_token}/sub-clients/transfer", response_model=PortalSubClientTransferResponse)
def portal_transfer_baas_to_subclient(
    portal_token: uuid_pkg.UUID,
    payload: PortalSubClientTransferRequest,
    db: DbDep,
) -> PortalSubClientTransferResponse:
    """Alias retrocompatible de ``POST …/transfer``."""
    parent = _portal_client_from_token(db, portal_token)
    return _portal_transfer_baas_impl(db, parent, int(payload.child_client_id), float(payload.amount))


@router.get(
    "/{portal_token}/sub-clients/{child_client_id}/pricing",
    response_model=list[PortalSubClientPricingRow],
)
def portal_subclient_pricing_matrix(
    portal_token: uuid_pkg.UUID,
    child_client_id: int,
    db: DbDep,
) -> list[PortalSubClientPricingRow]:
    """Matriz de precios Flujo con piso del distribuidor para un sub-cliente."""
    parent = _portal_client_from_token(db, portal_token)
    get_direct_subclient(db, parent, int(child_client_id))
    rows = list_subclient_pricing_matrix(db, parent_id=int(parent.id), child_id=int(child_client_id))
    return [PortalSubClientPricingRow.model_validate(r) for r in rows]


def _portal_assign_prices_impl(
    db: Session,
    parent: Client,
    child_client_id: int,
    items: list[ClientProductPriceItem],
) -> dict[str, object]:
    child = get_direct_subclient(db, parent, int(child_client_id))
    touched = upsert_subclient_product_prices(db, parent=parent, child=child, items=items)
    return {"ok": True, "updated": int(touched)}


@router.get("/{portal_token}/assign-prices", response_model=list[PortalSubClientPricingRow])
def portal_assign_prices_catalog(
    portal_token: uuid_pkg.UUID,
    child_client_id: int,
    db: DbDep,
) -> list[PortalSubClientPricingRow]:
    """Paquetes Flujo autorizados para el padre (con su costo) y precios actuales del hijo."""
    parent = _portal_client_from_token(db, portal_token)
    get_direct_subclient(db, parent, int(child_client_id))
    rows = list_subclient_pricing_matrix(db, parent_id=int(parent.id), child_id=int(child_client_id))
    return [PortalSubClientPricingRow.model_validate(r) for r in rows]


@router.post("/{portal_token}/assign-prices")
def portal_assign_prices(
    portal_token: uuid_pkg.UUID,
    payload: PortalAssignPricesRequest,
    db: DbDep,
) -> dict[str, object]:
    """Guarda precios de venta para un sub-cliente (piso = tarifa del padre)."""
    parent = _portal_client_from_token(db, portal_token)
    items = [
        ClientProductPriceItem(
            product_id=int(i.product_id),
            package_catalog_id=int(i.package_catalog_id),
            custom_price=float(i.custom_price),
        )
        for i in (payload.items or [])
    ]
    return _portal_assign_prices_impl(db, parent, int(payload.child_client_id), items)


@router.put("/{portal_token}/sub-clients/{child_client_id}/prices")
def portal_set_subclient_prices(
    portal_token: uuid_pkg.UUID,
    child_client_id: int,
    payload: PortalSubClientSetPricesRequest,
    db: DbDep,
) -> dict[str, object]:
    """Alias retrocompatible de ``POST …/assign-prices``."""
    parent = _portal_client_from_token(db, portal_token)
    items = [
        ClientProductPriceItem(
            product_id=int(i.product_id),
            package_catalog_id=int(i.package_catalog_id),
            custom_price=float(i.custom_price),
        )
        for i in (payload.items or [])
    ]
    return _portal_assign_prices_impl(db, parent, int(child_client_id), items)


@router.get("/{portal_token}/auto-purchase/catalog", response_model=list[PortalAutoPurchaseProduct])
def portal_auto_purchase_catalog(portal_token: uuid_pkg.UUID, db: DbDep) -> list[PortalAutoPurchaseProduct]:
    """Productos con precio personalizado asignado al cliente y stock libre en bodega."""
    client = _portal_client_from_token(db, portal_token)
    return list_portal_auto_purchase_products(db, int(client.id))


@router.post("/{portal_token}/auto-purchase", response_model=PortalAutoPurchaseResponse)
def portal_auto_purchase(
    portal_token: uuid_pkg.UUID,
    payload: PortalAutoPurchaseRequest,
    db: DbDep,
) -> PortalAutoPurchaseResponse:
    """Autocompra de pantalla con saldo BaaS: despacho inmediato o solicitud en revisión."""
    client = _portal_client_from_token(db, portal_token)
    try:
        return execute_portal_auto_purchase(
            db,
            client=client,
            package_catalog_id=int(payload.package_catalog_id),
            quantity=int(payload.quantity),
        )
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception(
            "auto-purchase portal client_id=%s package_catalog_id=%s qty=%s",
            client.id,
            payload.package_catalog_id,
            payload.quantity,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"No se pudo completar la compra: {exc}",
        ) from exc


async def apply_portal_wallet_recharge_client_receipt_upload(
    db: Session,
    client: Client,
    *,
    req: WalletRechargeRequest,
    receipt_file: Optional[UploadFile] = None,
    receipt_url_form: Optional[str] = None,
    payment_method_id: Optional[int],
    deposit_account_id: Optional[int],
    paid_amount_str: Optional[str],
    declared_amount_alt: Optional[str],
    background_tasks: BackgroundTasks,
    url_request_id_for_id_erp: int,
    id_erp_optional: Optional[str] = None,
    credit_amount: Optional[float] = None,
) -> WalletRechargeRequest:
    """
    Persiste el comprobante del cliente contra una solicitud BaaS (``pending`` / ``partially_paid``).

    También sirve cuando el mismo flujo se invoca desde ``POST …/payments`` (abono unificado).
    """
    if int(req.client_id) != int(client.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Esta solicitud no pertenece a tu cuenta.")

    if id_erp_optional is not None and str(id_erp_optional).strip() != "":
        try:
            id_erp_n = int(str(id_erp_optional).strip())
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El campo id_erp debe ser un número válido.",
            ) from None
        if id_erp_n != int(url_request_id_for_id_erp):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El id_erp no coincide con el identificador de la solicitud de recarga.",
            )

    if not wallet_recharge_accepts_client_receipt(req):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No hay saldo pendiente en esta solicitud o no admite nuevos comprobantes.",
        )

    _validate_wallet_recharge_declared_payment_method(db, req, payment_method_id)
    _validate_wallet_recharge_deposit_account(db, req, deposit_account_id)

    from app.services.client_payment_method_service import (
        validate_client_portal_deposit_account_id,
        validate_client_portal_payment_method_id,
    )
    from app.services.client_currency_service import get_client_currency

    wr_cur = normalize_currency_code(getattr(req, "recharge_currency", None), get_client_currency(client))
    validate_client_portal_payment_method_id(db, client, payment_method_id)
    validate_client_portal_deposit_account_id(
        db,
        client,
        deposit_account_id,
        currency=wr_cur,
        payment_method_id=payment_method_id,
    )

    pm_id = int(payment_method_id) if payment_method_id is not None else None
    from app.services.codigos_retiro_instant_service import is_codigos_retiro_payment_method_id

    paid_raw = ((declared_amount_alt or paid_amount_str) or "").strip().replace(",", ".")
    if is_codigos_retiro_payment_method_id(db, pm_id):
        if not paid_raw:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Indica el importe que pagaste según tu comprobante.",
            )
        try:
            paid_f = float(paid_raw)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El importe declarado no es válido.",
            ) from None
        if not (paid_f > 0):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El importe declarado debe ser mayor a cero.",
            )

        was_partial = float(getattr(req, "amount_paid", 0) or 0) > 1e-6
        receipt_url = await _resolve_portal_payment_receipt_url(receipt_file, receipt_url_form)
        req.receipt_url = receipt_url
        req.portal_declared_payment_amount = paid_f
        req.portal_submitted_deposit_account_id = int(deposit_account_id) if deposit_account_id is not None else None

        product_total = float(getattr(req, "amount_requested", 0) or 0)

        from app.services.accounting_engine import ensure_wallet_recharge_accrual_journal
        from app.services.client_currency_service import maybe_set_client_base_currency_from_recharge
        from app.services.client_payment_service import _wallet_credited_for_recharge_request
        from app.services.wallet_balance_service import add_client_wallet_balance

        credited_so_far = _wallet_credited_for_recharge_request(db, req)
        wallet_to_add = max(0.0, round(product_total - credited_so_far, 2))
        if wallet_to_add > 1e-6:
            maybe_set_client_base_currency_from_recharge(
                db,
                client,
                wr_cur,
                recharge_request_id=int(req.id),
            )
            add_client_wallet_balance(db, client, wr_cur, wallet_to_add)

        # Regla 2 (paralelo a instant_activation_cxc en ventas): entrega el producto,
        # devenga CxC al 100% y deja amount_paid=0 hasta confirmación del webhook del socio.
        # balance_pending refleja la deuda exigible; el tab «Pendientes» excluye estas filas
        # vía META_RETIRO_INSTANT_CXC (sin ClientPayment en revisión para el admin).
        from app.wallet_recharge_helpers import stamp_wallet_recharge_retiro_instant_cxc

        req.amount_paid = 0.0
        req.balance_pending = round(product_total, 2)
        req.status = REQ_STATUS_APPROVED
        stamp_wallet_recharge_retiro_instant_cxc(req)
        ensure_wallet_recharge_accrual_journal(db, req, strict=True)

        db.commit()
        db.refresh(req)

        email = str(client.email or "").strip()
        abs_receipt = str(receipt_url or "").strip()
        if email and abs_receipt:
            background_tasks.add_task(
                render_sync.notify_wallet_recharge_client_receipt,
                int(req.id),
                email,
                paid_f,
                abs_receipt,
                from_partial_payment=was_partial,
            )
        return req

    # Resto de flujos: igual que antes, estado in_review, monto declarado, etc.
    if not paid_raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Indica el importe que pagaste según tu comprobante.",
        )
    try:
        paid_f = float(paid_raw)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El importe declarado no es válido.",
        ) from None
    if not (paid_f > 0):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El importe declarado debe ser mayor a cero.",
        )

    was_partial = float(getattr(req, "amount_paid", 0) or 0) > 1e-6

    receipt_url = await _resolve_portal_payment_receipt_url(receipt_file, receipt_url_form)
    req.receipt_url = receipt_url
    req.portal_declared_payment_amount = paid_f
    req.portal_submitted_deposit_account_id = int(deposit_account_id) if deposit_account_id is not None else None
    st_now = str(getattr(req, "status", "") or "")
    if st_now in (REQ_STATUS_APPROVED, REQ_STATUS_PARTIALLY_PAID):
        if float(getattr(req, "amount_paid", 0) or 0) > 1e-6:
            req.status = REQ_STATUS_PARTIALLY_PAID
    else:
        req.status = REQ_STATUS_IN_REVIEW

    from app.services.wallet_recharge_client_payment import ensure_pending_client_payment_for_wallet_recharge

    ensure_pending_client_payment_for_wallet_recharge(
        db,
        req,
        client=client,
        payment_method_id=pm_id,
        deposit_account_id=int(deposit_account_id) if deposit_account_id is not None else None,
        declared_amount=paid_f,
        credit_amount=credit_amount,
        always_create_new=True,
    )
    db.commit()
    db.refresh(req)

    email = str(client.email or "").strip()
    abs_receipt = str(receipt_url or "").strip()
    if email and abs_receipt:
        background_tasks.add_task(
            render_sync.notify_wallet_recharge_client_receipt,
            int(req.id),
            email,
            paid_f,
            abs_receipt,
            from_partial_payment=was_partial,
        )

    return req


@router.post("/{portal_token}/recharges/{request_id}/pay", response_model=WalletRechargeRequestRead)
async def portal_pay_wallet_recharge(
    portal_token: uuid_pkg.UUID,
    request_id: int,
    db: DbDep,
    background_tasks: BackgroundTasks,
    file: Annotated[Optional[UploadFile], File()] = None,
    payment_method_id: Annotated[Optional[int], Form()] = None,
    deposit_account_id: Annotated[Optional[int], Form()] = None,
    paid_amount: Annotated[Optional[str], Form()] = None,
    monto_declarado: Annotated[Optional[str], Form()] = None,
    id_erp: Annotated[Optional[str], Form()] = None,
    pay_with_credit: Annotated[Optional[str], Form()] = None,
    use_credit_balance: Annotated[Optional[str], Form()] = None,
    apply_credit_balance: Annotated[Optional[str], Form()] = None,
) -> WalletRechargeRequest:
    """El cliente adjunta comprobante (BaaS); la solicitud pasa a ``in_review``.

    Aplica cuando el estado es ``pending`` o ``partially_paid`` (abono contra saldo pendiente).
    FormData: ``paid_amount`` y/o alias ``monto_declarado`` (mismo valor).

    Opcional ``id_erp`` (portal Web / Flask): mismo identificador que ``request_id`` en la URL; si llega debe coincidir.
    """
    client = _portal_client_from_token(db, portal_token)

    req = db.get(WalletRechargeRequest, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Solicitud no encontrada.")

    if _portal_wants_credit_balance(pay_with_credit, use_credit_balance, apply_credit_balance):
        from app.services.client_payment_service import submit_client_credit_to_wallet_recharge_for_review

        if int(req.client_id) != int(client.id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Esta solicitud no pertenece a tu cuenta.")
        _applied, cp = submit_client_credit_to_wallet_recharge_for_review(db, client, req)
        if _applied <= 1e-6 or cp is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No hay saldo a favor disponible en la moneda de esta recarga.",
            )
        try:
            commit_db_or_rollback(db)
        except HTTPException:
            db.rollback()
            raise
        db.refresh(req)
        db.refresh(client)
        return req

    if file is None or not getattr(file, "filename", None):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Adjunta la imagen o PDF del comprobante, o indica use_credit_balance=1.",
        )

    credit_on_receipt = 0.0
    if _portal_wants_credit_balance(apply_credit_balance, use_credit_balance):
        from app.services.client_payment_service import get_client_credit_balance

        wr_cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
        pending_wr = float(getattr(req, "balance_pending", 0) or 0)
        cb_wr = float(get_client_credit_balance(client, wr_cur, db=db))
        credit_on_receipt = min(cb_wr, pending_wr)

    return await apply_portal_wallet_recharge_client_receipt_upload(
        db,
        client,
        req=req,
        receipt_file=file,
        payment_method_id=payment_method_id,
        deposit_account_id=deposit_account_id,
        paid_amount_str=paid_amount,
        declared_amount_alt=monto_declarado,
        background_tasks=background_tasks,
        url_request_id_for_id_erp=int(request_id),
        id_erp_optional=id_erp,
        credit_amount=credit_on_receipt if credit_on_receipt > 1e-9 else None,
    )


def _portal_package_label_for_screen(db: Session, row: ScreenStock, sale: Sale) -> str:
    pkg = (row.package or sale.inventory_package or "").strip()
    if pkg:
        return _package_display_name(pkg)
    pid = row.product_id or sale.product_id
    if pid:
        pr = db.get(Product, int(pid))
        pname = (pr.name or "").strip() if pr else ""
        if pname:
            return pname
    prov = (row.provider or sale.inventory_provider or "").strip()
    return prov or "Pantalla IPTV"


def _portal_screen_assigned_at(db: Session, sale: Sale) -> datetime:
    """
    Mejor aproximación a la fecha de activación: asiento COGS (approved) → devengo → creación.
    """
    sid = int(sale.id)
    for ref in (JournalReferenceType.venta_cogs.value, JournalReferenceType.venta.value):
        ts = (
            db.query(func.max(JournalEntry.created_at))
            .filter(
                JournalEntry.reference_type == ref,
                JournalEntry.reference_id == sid,
            )
            .scalar()
        )
        if ts is not None:
            return ensure_aware(ts)
    return ensure_aware(sale.created_at)


def _portal_active_screens_for_client(db: Session, client_id: int) -> list[PortalActiveScreen]:
    """
    Pantallas en bodega ya asignadas a ventas ``approved`` del cliente (historial público).
    Orden: más reciente primero (``assigned_at`` DESC).
    """
    rows = (
        db.query(ScreenStock, Sale)
        .join(Sale, ScreenStock.sale_id == Sale.id)
        .filter(
            Sale.client_id == int(client_id),
            Sale.status == SaleStatus.approved,
            ScreenStock.status == "assigned",
            ScreenStock.sale_id.isnot(None),
        )
        .all()
    )
    assigned_cache: dict[int, datetime] = {}
    staged: list[tuple[datetime, int, PortalActiveScreen]] = []
    for stk, sale in rows:
        sid_sale = int(sale.id)
        if sid_sale not in assigned_cache:
            assigned_cache[sid_sale] = _portal_screen_assigned_at(db, sale)
        assigned_dt = assigned_cache[sid_sale]
        exp = stk.expiration_date
        exp_s = exp.isoformat() if exp is not None else None
        staged.append(
            (
                assigned_dt,
                int(stk.id),
                PortalActiveScreen(
                    screen_stock_id=int(stk.id),
                    sale_id=sid_sale,
                    package_name=_portal_package_label_for_screen(db, stk, sale),
                    username=(stk.iptv_username or "").strip() or None,
                    password=(stk.iptv_password or "").strip() or None,
                    assigned_at=isoformat_z(assigned_dt),
                    expiration_date=exp_s,
                ),
            )
        )
    staged.sort(key=lambda t: (t[0], t[1]), reverse=True)
    return [item[2] for item in staged]


# ── GET home ──────────────────────────────────────────────────────────────────

def _compute_portal_cxc_balance(db: Session, client: Client) -> PortalCxcBalanceResponse:
    """Saldo CxC total del cliente (facturas + recargas BaaS con deuda abierta)."""
    from app.services.client_currency_service import get_client_currency
    from app.services.client_payment_service import list_client_ar_open_obligations

    obligations = list_client_ar_open_obligations(db, int(client.id))
    agg: dict[str, Decimal] = {}
    for ob in obligations:
        cur = normalize_currency_code(str(ob.get("currency") or "USD"))
        bal = Decimal(str(ob.get("open_balance") or 0))
        if bal > _FP_EPS:
            agg[cur] = agg.get(cur, Decimal("0")) + bal

    client_cur = get_client_currency(client)
    by_currency = [
        {"currency": k, "amount": float(v.quantize(Decimal("0.01")))}
        for k, v in sorted(agg.items())
    ]
    primary_total = float(agg.get(client_cur, Decimal("0")).quantize(Decimal("0.01")))
    return PortalCxcBalanceResponse(
        total=primary_total,
        currency=client_cur,
        by_currency=by_currency,
    )


@router.get("/{portal_token}/cxc-balance", response_model=PortalCxcBalanceResponse, summary="Saldo CxC total del cliente")
def portal_cxc_balance(portal_token: uuid_pkg.UUID, db: DbDep) -> PortalCxcBalanceResponse:
    client = _portal_client_from_token(db, portal_token)
    return _compute_portal_cxc_balance(db, client)


@router.get("/{portal_token}", response_model=PortalHomeResponse)
def portal_home(portal_token: uuid_pkg.UUID, db: DbDep) -> PortalHomeResponse:
    client = _portal_client_from_token(db, portal_token)

    expire_pending_sales_if_needed(db)

    # Incluye ventas activadas (``approved``) con CxC abierto tras rechazo de pago, etc.
    _OPEN_STATUSES = (
        SaleStatus.pending,
        SaleStatus.payment_submitted,
        SaleStatus.partially_paid,
        SaleStatus.approved,
    )

    sales_all = (
        db.query(Sale)
        .options(
            joinedload(Sale.product),
            joinedload(Sale.screen_stock_row),
        )
        .filter(Sale.client_id == client.id)
        .filter(Sale.status.in_(_OPEN_STATUSES))
        .order_by(Sale.created_at.desc())
        .all()
    )

    agg: dict[str, Decimal] = {}
    hist_agg: dict[str, Decimal] = {}
    pending_sales: list[PortalOutstandingSale] = []
    out_sales: list[PortalOutstandingSale] = []
    new_order_sales: list[PortalOutstandingSale] = []
    historical_debt_sales: list[PortalOutstandingSale] = []
    _HISTORICAL_STATUSES = (
        SaleStatus.partially_paid,
        SaleStatus.approved,
        SaleStatus.payment_submitted,
    )

    from app.services.wallet_balance_service import compute_client_wallet_summary
    from app.services.client_currency_service import get_client_currency
    from app.services.client_product_price_service import list_client_assigned_package_prices
    from app.services.client_payment_method_service import (
        build_client_assigned_deposit_picks,
        get_client_assigned_payment_methods_with_accounts,
    )
    from app.schemas.client_product_prices import PortalAssignedPackagePrice

    client_currency = get_client_currency(client)
    assigned_pm_models = get_client_assigned_payment_methods_with_accounts(
        db,
        int(client.id),
        currency=client_currency,
    )
    assigned_dep_models = build_client_assigned_deposit_picks(
        db,
        int(client.id),
        currency=client_currency,
    )

    for s in sales_all:
        row, bal = _build_portal_outstanding_row(db, client, s)
        pending_sales.append(row)
        if bal > _FP_EPS:
            cur = normalize_currency_code(str(s.currency or "USD"))
            agg[cur] = agg.get(cur, Decimal("0")) + bal
            out_sales.append(row)
            # Cualquier venta con saldo pendiente puede cobrarse desde «Nuevos pedidos para pago».
            new_order_sales.append(row)
        if s.status in (SaleStatus.approved, SaleStatus.payment_submitted) and bal > _FP_EPS:
            historical_debt_sales.append(row)
            hcur = normalize_currency_code(str(s.currency or "USD"))
            hist_agg[hcur] = hist_agg.get(hcur, Decimal("0")) + bal

    # ``total_debt_*`` / ``outstanding_balance``: solo deuda histórica (excluye ventas ``pending`` del acordeón «Nuevos pedidos»).
    debt_rows: list[dict[str, object]] = [
        {"currency": k, "amount": float(v.quantize(Decimal("0.0001")))} for k, v in sorted(hist_agg.items())
    ]
    hist_rows: list[dict[str, object]] = debt_rows
    primary_debt = Decimal(str(debt_rows[0]["amount"])) if debt_rows else Decimal("0")
    outstanding_balance = sum(hist_agg.values(), Decimal("0"))

    pending_debt_payments = _get_pending_debt_payments_for_client(db, client.id)
    recent_client_payments = _get_recent_client_payments_for_portal(db, int(client.id))

    ledger_rows = _portal_client_ledger(db, client.id)
    active_screens = _portal_active_screens_for_client(db, int(client.id))

    credit_summary = compute_client_credit_summary(db, int(client.id), sync=True)
    credit_rows = list(credit_summary.get("credit_balances_by_currency") or [])
    primary_credit = float(credit_summary.get("credit_balance") or 0)
    primary_credit_cur = str(credit_summary.get("credit_balance_currency") or "USD")

    from app.services.wallet_balance_service import compute_client_wallet_summary
    from app.services.client_product_price_service import list_client_assigned_package_prices
    from app.schemas.client_product_prices import PortalAssignedPackagePrice

    wallet_summary = compute_client_wallet_summary(client)
    wallet_rows = list(wallet_summary.get("wallet_balances_by_currency") or [])
    assigned_rows = list_client_assigned_package_prices(db, int(client.id))
    assigned_models = [PortalAssignedPackagePrice.model_validate(r) for r in assigned_rows]
    precios_asignados = {
        str(r["package_catalog_id"]): float(r["precio_venta_local"]) for r in assigned_rows
    }

    db.commit()

    return PortalHomeResponse(
        client=PortalClientBrief(
            name=client.display_name(),
            email=str(client.email or ""),
            parent_id=int(client.parent_id) if client.parent_id is not None else None,
            credit_balance=primary_credit,
            credit_balance_currency=primary_credit_cur,
            credit_balances_by_currency=credit_rows,
            available_credit=primary_credit,
            wallet_balance=float(wallet_summary.get("wallet_balance") or 0),
            wallet_balance_currency=str(wallet_summary.get("wallet_balance_currency") or client_currency),
            wallet_balances_by_currency=wallet_rows,
            currency=client_currency,
        ),
        credit_balance_total=float(client.total_credits or 0),
        credit_balance=primary_credit,
        credit_balance_currency=primary_credit_cur,
        credit_balances_by_currency=credit_rows,
        available_credit_by_currency=credit_rows,
        available_credit=primary_credit,
        total_debt_by_currency=debt_rows,
        total_debt=primary_debt,
        pending_sales=pending_sales,
        outstanding_sales=out_sales,
        new_order_sales=new_order_sales,
        historical_debt_sales=historical_debt_sales,
        outstanding_balance=outstanding_balance,
        historical_debt_by_currency=hist_rows,
        pending_debt_payments=pending_debt_payments,
        recent_client_payments=recent_client_payments,
        ledger=ledger_rows,
        active_screens=active_screens,
        assigned_package_prices=assigned_models,
        precios_asignados=precios_asignados,
        assigned_payment_methods=assigned_pm_models,
        assigned_deposit_accounts=assigned_dep_models,
    )


def _get_pending_debt_payments_for_client(db: Session, client_id: int) -> list[DebtPaymentItem]:
    """
    Devuelve SOLO los pagos «abono puro» del cliente que están pendientes de revisión:
    - Estado estrictamente ``pending_review`` (excluye rejected, approved, etc.).
    - Sin ``PaymentAllocation`` vinculada a ninguna venta (los pagos ligados a una venta
      se muestran en la fila de esa venta, no aquí, para evitar duplicados).
    """
    # Subconsulta: IDs de pagos que ya tienen allocation a alguna venta.
    linked_payment_ids_sq = (
        db.query(PaymentAllocation.payment_id)
        .distinct()
        .subquery()
    )

    rows = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == client_id,
            ClientPayment.status == ClientPaymentStatus.pending_review,
            ClientPayment.id.notin_(
                db.query(linked_payment_ids_sq.c.payment_id)
            ),
        )
        .order_by(ClientPayment.created_at.desc())
        .all()
    )
    result: list[DebtPaymentItem] = []
    for r in rows:
        result.append(
            DebtPaymentItem(
                id=r.id,
                client_id=r.client_id,
                client_name="",
                payment_number=r.payment_number,
                amount=r.amount,
                currency=str(r.currency or "USD"),
                receipt_url=r.receipt_file_url,
                status=r.status.value,
                created_at=r.created_at.isoformat() if r.created_at else None,
                notes=r.notes,
            )
        )
    return result


async def _resolve_portal_payment_receipt_url(
    receipt_file: Optional[UploadFile],
    receipt_url_form: Optional[str],
) -> str:
    """Comprobante subido al ERP o URL externa (p. ej. widget Códigos de Retiro)."""
    ext = (receipt_url_form or "").strip()
    if ext:
        if len(ext) > 2048:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="URL de comprobante demasiado larga.",
            )
        return ext
    if receipt_file is None or not getattr(receipt_file, "filename", None):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Adjunta la imagen o PDF del comprobante.",
        )
    stored = await _persist_receipt_upload(receipt_file)
    if not stored:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No se pudo guardar el comprobante.",
        )
    return str(stored).strip()


async def _portal_create_abono_payment(
    db: Session,
    client: Client,
    *,
    payment_method_id: int,
    deposit_account_id: int,
    receipt_file: Optional[UploadFile],
    receipt_url_form: Optional[str] = None,
    paid_amount: float,
    currency: str = "USD",
    notes: Optional[str] = None,
) -> ClientPayment:
    """Crea ClientPayment (abono CxC). El endpoint puede luego vincular allocation a una factura."""
    if float(paid_amount) <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El monto del abono debe ser mayor a 0.",
        )

    pm = db.get(PaymentMethod, int(payment_method_id))
    if pm is None or not bool(pm.is_active):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Método de pago inválido o inactivo.")

    cur_norm = normalize_currency_code((currency or "USD").strip().upper())
    from app.services.client_payment_method_service import (
        validate_client_portal_deposit_account_id,
        validate_client_portal_payment_method_id,
    )

    validate_client_portal_payment_method_id(db, client, int(payment_method_id))
    validate_client_portal_deposit_account_id(
        db,
        client,
        int(deposit_account_id),
        currency=cur_norm,
        payment_method_id=int(payment_method_id),
    )

    dep_acc_id = _resolve_deposit_account_id(db, int(deposit_account_id))

    receipt_url = await _resolve_portal_payment_receipt_url(receipt_file, receipt_url_form)

    from app.services.client_payment_service import next_payment_number

    raw_notes_in = "" if notes is None else str(notes).strip()
    if raw_notes_in == "":
        notes_fixed: Optional[str] = None
    else:
        from app.services.client_payment_service import (
            dedupe_notes_portal_general_abono_chunks,
            sanitize_portal_deposit_optional_user_notes,
        )

        nl = raw_notes_in.lower()
        if "portal_general_abono" in nl:
            notes_fixed = dedupe_notes_portal_general_abono_chunks(
                sanitize_portal_deposit_optional_user_notes(raw_notes_in) or raw_notes_in
            ) or raw_notes_in
            notes_fixed = notes_fixed.strip() or None
        else:
            notes_fixed = raw_notes_in

    payment = ClientPayment(
        payment_number=next_payment_number(db),
        client_id=client.id,
        amount=Decimal(str(paid_amount)),
        currency=cur_norm,
        receipt_file_url=(receipt_url or "").strip() or None,
        payment_method_id=int(pm.id),
        payment_method=(pm.name or "").strip() or None,
        deposit_account_id=int(dep_acc_id),
        status=ClientPaymentStatus.pending_review,
        notes=notes_fixed,
        created_at=now_ecuador(),
    )
    db.add(payment)
    db.flush()
    return payment


# ── POST payments (new order or abono) ─────────────────────────────────────────

@router.post("/{portal_token}/payments", response_model=PortalPaymentSubmitResponse)
async def portal_submit_payment(
    portal_token: uuid_pkg.UUID,
    db: DbDep,
    background_tasks: BackgroundTasks,
    payment_intent: Annotated[str, Form(...)],
    payment_method_id: Annotated[Optional[str], Form()] = None,
    deposit_account_id: Annotated[Optional[str], Form()] = None,
    receipt_file: Annotated[Optional[UploadFile], File()] = None,
    sale_id: Annotated[Optional[int], Form()] = None,
    paid_amount: Annotated[Optional[float], Form()] = None,
    currency: Annotated[Optional[str], Form()] = None,
    notes: Annotated[Optional[str], Form()] = None,
    portal_debt_kind: Annotated[Optional[str], Form()] = None,
    portal_sale_id: Annotated[Optional[str], Form()] = None,
    portal_wallet_recharge_id: Annotated[Optional[str], Form()] = None,
    id_erp: Annotated[Optional[str], Form()] = None,
    pay_with_credit: Annotated[Optional[str], Form()] = None,
    use_credit_balance: Annotated[Optional[str], Form()] = None,
    apply_credit_balance: Annotated[Optional[str], Form()] = None,
    receipt_url: Annotated[Optional[str], Form()] = None,
    codigos_retiro: Annotated[Optional[str], Form()] = None,
) -> PortalPaymentSubmitResponse:
    client = _portal_client_from_token(db, portal_token)

    expire_pending_sales_if_needed(db)

    intent = (payment_intent or "").strip().lower()
    if intent not in ("new_order", "abono"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="payment_intent debe ser 'new_order' o 'abono'.",
        )

    if intent == "abono":
        kind_ab = (portal_debt_kind or "").strip().lower()
        tgt_wr_ab = _portal_form_int_optional(portal_wallet_recharge_id)
        tgt_sale_ab = _portal_form_int_optional(portal_sale_id)

        if tgt_wr_ab is not None and kind_ab != "wallet_recharge":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Para enviar el id de solicitud de recarga debes usar portal_debt_kind=wallet_recharge.",
            )
        if tgt_sale_ab is not None and kind_ab != "sale":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Para enviar portal_sale_id debes usar portal_debt_kind=sale.",
            )
        if kind_ab not in ("", "sale", "wallet_recharge"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="portal_debt_kind debe ser 'sale', 'wallet_recharge' u omitirse (abono general).",
            )
        if kind_ab == "sale" and tgt_sale_ab is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Indica portal_sale_id para enlazar este abono a una factura concreta.",
            )

        if _portal_wants_credit_balance(pay_with_credit, use_credit_balance, apply_credit_balance):
            from app.services.client_payment_service import (
                submit_client_credit_to_sale_for_review,
                submit_client_credit_to_wallet_recharge_for_review,
            )

            if kind_ab == "wallet_recharge":
                if tgt_wr_ab is None:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Indica portal_wallet_recharge_id para pagar con saldo a favor.",
                    )
                req_wr = db.get(WalletRechargeRequest, int(tgt_wr_ab))
                if req_wr is None or int(req_wr.client_id) != int(client.id):
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Solicitud de recarga no encontrada.")
                applied_wr, cp_wr = submit_client_credit_to_wallet_recharge_for_review(db, client, req_wr)
                if applied_wr <= 1e-6 or cp_wr is None:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="No hay saldo a favor disponible en la moneda de esta recarga.",
                    )
                commit_db_or_rollback(db)
                db.refresh(req_wr)
                return PortalPaymentSubmitResponse(
                    message=_PORTAL_REVIEW_SUCCESS_MSG,
                    status=str(REQ_STATUS_IN_REVIEW),
                    receipt_url=None,
                    payment_id=int(cp_wr.id),
                    payment_number=cp_wr.payment_number,
                )

            if kind_ab != "sale" or tgt_sale_ab is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Indica portal_debt_kind=sale y portal_sale_id, o wallet_recharge con su id.",
                )
            sale_cr = db.get(Sale, int(tgt_sale_ab))
            if sale_cr is None or int(sale_cr.client_id) != int(client.id):
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Venta no encontrada.")
            if sale_cr.status == SaleStatus.expired:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Esta factura ha caducado. Contacta al administrador.",
                )
            if sale_cr.status in (SaleStatus.cancelled, SaleStatus.rejected, SaleStatus.annulled):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="No se puede abonar una factura cancelada o rechazada.",
                )
            applied_sale, credit_pay = submit_client_credit_to_sale_for_review(db, client, sale_cr)
            if applied_sale <= _FP_EPS:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="No hay saldo a favor disponible en la moneda de esta factura.",
                )
            commit_db_or_rollback(db)
            db.refresh(sale_cr)
            if credit_pay is not None:
                db.refresh(credit_pay)
            return PortalPaymentSubmitResponse(
                message=_PORTAL_REVIEW_SUCCESS_MSG,
                status=sale_cr.status.value,
                receipt_url=None,
                payment_id=int(credit_pay.id) if credit_pay is not None else None,
                payment_number=credit_pay.payment_number if credit_pay is not None else None,
            )

        pm_id_ab = _portal_form_int_optional(payment_method_id)
        dep_raw_ab = _portal_form_int_optional(deposit_account_id)
        if pm_id_ab is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Selecciona un método de pago.",
            )
        if dep_raw_ab is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Selecciona la cuenta donde depositaste.",
            )
        from app.services.client_payment_method_service import (
            validate_client_portal_deposit_account_id,
            validate_client_portal_payment_method_id,
        )

        abono_cur = normalize_currency_code((currency or "USD").strip().upper())
        validate_client_portal_payment_method_id(db, client, pm_id_ab)
        validate_client_portal_deposit_account_id(
            db,
            client,
            dep_raw_ab,
            currency=abono_cur,
            payment_method_id=pm_id_ab,
        )
        amt = float(paid_amount or 0)
        if amt <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El monto del abono debe ser mayor a 0.",
            )

        if kind_ab == "wallet_recharge":
            if tgt_wr_ab is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Indica portal_wallet_recharge_id para pagar una recarga.",
                )
            req_wr = db.get(WalletRechargeRequest, int(tgt_wr_ab))
            if req_wr is None or int(req_wr.client_id) != int(client.id):
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Solicitud de recarga no encontrada.")

            req_done = await apply_portal_wallet_recharge_client_receipt_upload(
                db,
                client,
                req=req_wr,
                receipt_file=receipt_file,
                receipt_url_form=receipt_url,
                payment_method_id=int(pm_id_ab),
                deposit_account_id=int(dep_raw_ab),
                paid_amount_str=str(amt),
                declared_amount_alt=None,
                background_tasks=background_tasks,
                url_request_id_for_id_erp=int(tgt_wr_ab),
                id_erp_optional=id_erp,
            )
            receipt_out = str(req_done.receipt_url or "").strip() or None
            return PortalPaymentSubmitResponse(
                message="Recibimos tu comprobante para la recarga solicitada. Un operador lo validará pronto.",
                status=str(REQ_STATUS_IN_REVIEW),
                receipt_url=receipt_out,
                payment_id=None,
                payment_number=None,
            )

        payment = await _portal_create_abono_payment(
            db,
            client,
            payment_method_id=int(pm_id_ab),
            deposit_account_id=int(dep_raw_ab),
            receipt_file=receipt_file,
            receipt_url_form=receipt_url,
            paid_amount=amt,
            currency=(currency or "USD").strip(),
            notes=notes,
        )
        if tgt_sale_ab is not None:
            from app.services.client_payment_service import (
                append_client_payment_notes_unique,
                dedupe_notes_portal_general_abono_chunks,
            )

            sale_ab = db.get(Sale, int(tgt_sale_ab))
            if sale_ab is None or int(sale_ab.client_id) != int(client.id):
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Venta no encontrada.")
            if sale_ab.status == SaleStatus.expired:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Esta factura ha caducado. Contacta al administrador.",
                )
            if sale_ab.status in (SaleStatus.cancelled, SaleStatus.rejected, SaleStatus.annulled):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="No se puede abonar una factura cancelada o rechazada.",
                )

            amt_dec_ab = Decimal(str(amt)).quantize(Decimal("0.01"))
            _, bal_ab = _compute_portal_balance(db, sale_ab)
            if bal_ab <= _FP_EPS:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Esta factura no tiene saldo pendiente.",
                )
            from app.services.client_payment_service import cap_allocation_for_sale

            alloc_ab = cap_allocation_for_sale(db, payment, sale_ab, amt_dec_ab).quantize(
                Decimal("0.0001")
            )

            cur_ab = normalize_currency_code(str(payment.currency or "USD").strip().upper())
            canonical_patch = dedupe_notes_portal_general_abono_chunks(
                "\n".join(
                    [
                        "portal_general_abono",
                        f"META_SALE_ID={int(sale_ab.id)}",
                        f"ORIGIN_SALE_REF={int(sale_ab.id)}",
                        f"PARTE_EFECTIVO={float(amt_dec_ab):.2f} {cur_ab}",
                    ]
                )
            )
            payment.notes = append_client_payment_notes_unique(payment.notes, canonical_patch).strip() or canonical_patch

            if alloc_ab > _FP_EPS:
                db.add(
                    PaymentAllocation(
                        payment_id=int(payment.id),
                        sale_id=int(sale_ab.id),
                        amount_applied=alloc_ab,
                    )
                )

            rc_ab = str(payment.receipt_file_url or "").strip()
            if rc_ab:
                sale_ab.receipt_url = rc_ab

            ts_ab = now_ecuador()
            iso_ab = ts_ab.isoformat()
            pm_ab = (payment.payment_method or "").strip() or "Transferencia"
            ev_ab = list(sale_ab.payment_events or [])
            ev_ab.append(
                {
                    "occurred_at": iso_ab,
                    "amount": float(amt_dec_ab),
                    "currency": cur_ab,
                    "status": "Depósito — En revisión",
                    "receipt_url": rc_ab or None,
                    "credit_portion": 0.0,
                    "deposit_portion": float(amt_dec_ab),
                    "pending_payment_number": payment.payment_number,
                    "pending_payment_id": int(payment.id),
                    "composite_method": pm_ab,
                }
            )
            sale_ab.payment_events = ev_ab

            if sale_ab.status in (
                SaleStatus.pending,
                SaleStatus.partially_paid,
                SaleStatus.payment_submitted,
                SaleStatus.approved,
            ):
                sale_ab.status = SaleStatus.payment_submitted
                sale_ab.expires_at = None

            sync_sale_accounting_ledgers(db, sale_ab, strict=False)

        commit_db_or_rollback(db)
        db.refresh(payment)
        return PortalPaymentSubmitResponse(
            message="Recibimos tu abono. Un operador lo aplicará a tu saldo pendiente.",
            status=payment.status.value,
            receipt_url=payment.receipt_file_url,
            payment_id=payment.id,
            payment_number=payment.payment_number,
        )

    if sale_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="sale_id es obligatorio para pagar una orden nueva.",
        )

    sale = (
        db.query(Sale)
        .options(joinedload(Sale.product), joinedload(Sale.screen_stock_row))
        .filter(Sale.id == int(sale_id))
        .first()
    )
    if sale is None or int(sale.client_id) != int(client.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Venta no encontrada.")

    if sale.status == SaleStatus.expired:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Esta orden ha caducado. Contacta al administrador para reactivarla.",
        )

    if sale.status in (SaleStatus.cancelled, SaleStatus.rejected, SaleStatus.annulled):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No se puede enviar comprobante para una factura cancelada o rechazada.",
        )

    real_total, balance = _compute_portal_balance(db, sale)

    if balance <= _FP_EPS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Este pedido no tiene saldo pendiente.",
        )

    if sale.status == SaleStatus.pending and real_total > _FP_EPS:
        try:
            ap_current = Decimal(str(sale.amount_paid)) if sale.amount_paid is not None else Decimal("0")
            if ap_current >= real_total - _FP_EPS:
                sale.amount_paid = Decimal("0")
        except Exception:
            pass

    cur_norm = normalize_currency_code((currency or str(sale.currency or "USD")).strip().upper())

    cb_client = get_client_credit_balance(client, cur_norm, db=db)

    deposit_part = Decimal("0")
    if paid_amount is not None:
        try:
            raw_s = str(paid_amount).strip().replace(",", ".")
            if raw_s != "":
                dp = Decimal(raw_s)
                if dp > Decimal("0"):
                    deposit_part = dp.quantize(Decimal("0.01"))
        except Exception:
            deposit_part = Decimal("0")

    credit_only_flag = _portal_wants_credit_balance(
        pay_with_credit, use_credit_balance
    ) and deposit_part <= _FP_EPS and (
        receipt_file is None or not getattr(receipt_file, "filename", None)
    )
    apply_credit_flag = _portal_wants_credit_balance(
        apply_credit_balance, use_credit_balance, pay_with_credit
    )

    credit_apply = Decimal("0")
    if credit_only_flag or apply_credit_flag:
        credit_apply = min(cb_client, balance).quantize(Decimal("0.01"))
        if credit_apply <= _FP_EPS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No hay saldo a favor disponible en la moneda de este pedido.",
            )

    if credit_only_flag:
        from app.services.client_payment_service import submit_client_credit_to_sale_for_review

        applied, credit_pay = submit_client_credit_to_sale_for_review(
            db,
            client,
            sale,
            credit_amount=float(credit_apply),
        )
        if applied <= _FP_EPS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No se pudo registrar el cruce de saldo a favor.",
            )
        try:
            sync_sale_accounting_ledgers(db, sale, strict=False)
            commit_db_or_rollback(db)
        except HTTPException:
            db.rollback()
            raise
        db.refresh(sale)
        if credit_pay is not None:
            db.refresh(credit_pay)
        return PortalPaymentSubmitResponse(
            status=sale.status.value,
            message=_PORTAL_REVIEW_SUCCESS_MSG,
            receipt_url=None,
            payment_id=int(credit_pay.id) if credit_pay is not None else None,
            payment_number=credit_pay.payment_number if credit_pay is not None else None,
        )

    pm: Optional[PaymentMethod] = None
    pm_id_sel = _portal_form_int_optional(payment_method_id)
    dep_sel = _portal_form_int_optional(deposit_account_id)
    deposit_acc_resolved: Optional[int] = None

    if pm_id_sel is None or dep_sel is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Para pagar con transferencia selecciona método y cuenta receptoras.",
        )
    pm = db.get(PaymentMethod, int(pm_id_sel))
    if pm is None or not bool(pm.is_active):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Método de pago inválido o inactivo.")

    from app.services.client_payment_method_service import (
        get_client_assigned_payment_method_ids,
        validate_client_portal_deposit_account_id,
        validate_client_portal_payment_method_id,
    )

    validate_client_portal_payment_method_id(db, client, pm_id_sel)
    validate_client_portal_deposit_account_id(
        db,
        client,
        dep_sel,
        currency=cur_norm,
        payment_method_id=pm_id_sel,
    )

    deposit_acc_resolved = int(_resolve_deposit_account_id(db, int(dep_sel)))

    assigned_pm = get_client_assigned_payment_method_ids(db, int(client.id))
    if not assigned_pm:
        raw_ids = sale.allowed_deposit_accounts or []
        ids_allowed: list[int] = []
        if isinstance(raw_ids, list):
            for x in raw_ids:
                try:
                    ids_allowed.append(int(x))
                except (TypeError, ValueError):
                    continue
        if ids_allowed and int(deposit_acc_resolved) not in ids_allowed:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Esta cuenta de depósito no está habilitada para esta venta.",
            )

        raw_labels = (
            list(sale.allowed_payment_methods or []) if isinstance(sale.allowed_payment_methods, list) else []
        )
        labels_allowed = [str(x).strip() for x in raw_labels if str(x).strip()]
        if labels_allowed:
            pname = (pm.name or "").strip().lower()
            if not any(pname == str(x).strip().lower() for x in labels_allowed):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Este método de pago no está habilitado para esta venta.",
                )

    stored_receipt_url = await _resolve_portal_payment_receipt_url(receipt_file, receipt_url)

    if deposit_part <= Decimal("0"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Indica el importe del depósito (debe ser mayor a 0).",
        )

    total_pay = (credit_apply + deposit_part).quantize(Decimal("0.01"))
    if total_pay <= _FP_EPS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Importe de pago inválido.")

    now_ts = now_ecuador()
    now_iso = now_ts.isoformat()
    events: list[dict] = list(sale.payment_events or [])
    pm_name = (pm.name or "").strip() if pm is not None else "Transferencia"
    from app.services.client_payment_service import (
        dedupe_notes_portal_general_abono_chunks,
        sanitize_portal_deposit_optional_user_notes,
    )

    user_clean = sanitize_portal_deposit_optional_user_notes((notes or "").strip())
    owed_after_credit = (balance - credit_apply).quantize(Decimal("0.01"))
    if owed_after_credit < Decimal("0"):
        owed_after_credit = Decimal("0")
    alloc_invoice = min(deposit_part, owed_after_credit).quantize(Decimal("0.0001"))
    canonical_body = (
        "portal_general_abono\n"
        f"META_SALE_ID={int(sale.id)}\n"
        f"ORIGIN_SALE_REF={int(sale.id)}\n"
        f"IS_INITIAL_SALE_PAYMENT=1\n"
        f"PARTE_EFECTIVO={float(deposit_part):.2f} {cur_norm}"
    )
    if credit_apply > _FP_EPS:
        canonical_body += f"\nPARTE_SALDO_FAVOR={float(credit_apply):.2f} {cur_norm}"
    if user_clean:
        assembled_notes = canonical_body.strip() + "\n" + user_clean
    else:
        assembled_notes = canonical_body.strip()
    deposit_notes_final = dedupe_notes_portal_general_abono_chunks(assembled_notes.strip())
    deposit_pay = ClientPayment(
        payment_number=next_payment_number(db),
        client_id=int(client.id),
        amount=total_pay,
        currency=cur_norm,
        receipt_file_url=(stored_receipt_url or "").strip() or None,
        payment_method_id=pm.id if pm is not None else None,
        payment_method=pm_name[:120],
        deposit_account_id=int(deposit_acc_resolved) if deposit_acc_resolved is not None else None,
        status=ClientPaymentStatus.pending_review,
        notes=deposit_notes_final,
        created_at=now_ts,
    )
    db.add(deposit_pay)
    db.flush()
    if alloc_invoice > _FP_EPS:
        db.add(
            PaymentAllocation(
                payment_id=int(deposit_pay.id),
                sale_id=int(sale.id),
                amount_applied=alloc_invoice,
            )
        )
    credit_alloc = None
    if credit_apply > _FP_EPS:
        credit_alloc = PaymentAllocation(
            payment_id=int(deposit_pay.id),
            sale_id=int(sale.id),
            amount_applied=credit_apply,
        )
        db.add(credit_alloc)
    db.flush()

    if credit_apply > _FP_EPS:
        from app.services.client_payment_service import reserve_client_credit_for_pending_payment

        taken = reserve_client_credit_for_pending_payment(db, client, deposit_pay, credit_apply)
        if taken <= _FP_EPS:
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No hay saldo a favor suficiente para completar este pago.",
            )
        if taken != credit_apply:
            credit_apply = taken
            if credit_alloc is not None:
                credit_alloc.amount_applied = credit_apply
            deposit_pay.amount = (credit_apply + deposit_part).quantize(Decimal("0.01"))
            db.flush()

    total_pay = (credit_apply + deposit_part).quantize(Decimal("0.01"))
    status_label = "Pago mixto — En revisión" if credit_apply > _FP_EPS else "Depósito — En revisión"
    events.append({
        "occurred_at": now_iso,
        "amount": float(total_pay),
        "currency": cur_norm,
        "status": status_label,
        "receipt_url": stored_receipt_url.strip() if stored_receipt_url else None,
        "credit_portion": float(credit_apply),
        "deposit_portion": float(deposit_part),
        "pending_payment_number": deposit_pay.payment_number,
        "pending_payment_id": int(deposit_pay.id),
        "composite_method": pm_name if credit_apply <= _FP_EPS else f"{pm_name} + Saldo a Favor",
    })
    sale.payment_events = events
    if pm is not None and deposit_acc_resolved is not None:
        sale.payment_method_id = int(pm.id)
        sale.deposit_account_id = int(deposit_acc_resolved)
        sale.receipt_url = (stored_receipt_url or "").strip() or None
    if sale.status in (
        SaleStatus.pending,
        SaleStatus.partially_paid,
        SaleStatus.payment_submitted,
        SaleStatus.approved,
    ):
        sale.status = SaleStatus.payment_submitted
        sale.expires_at = None

    try:
        sync_sale_accounting_ledgers(db, sale, strict=False)
        commit_db_or_rollback(db)
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("Error contable al registrar pago portal venta id=%s", sale.id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al registrar el pago y el asiento contable.",
        ) from exc
    db.refresh(sale)
    db.refresh(client)
    db.refresh(deposit_pay)

    return PortalPaymentSubmitResponse(
        status=sale.status.value,
        message=_PORTAL_REVIEW_SUCCESS_MSG,
        receipt_url=stored_receipt_url.strip() if stored_receipt_url else None,
        payment_id=int(deposit_pay.id),
        payment_number=deposit_pay.payment_number,
    )


# ── POST debt-payment (generic / CxC abono) ───────────────────────────────────

@router.post("/{portal_token}/debt-payment", response_model=DebtPaymentSubmitResponse)
async def portal_submit_debt_payment(
    portal_token: uuid_pkg.UUID,
    db: DbDep,
    payment_method_id: Annotated[int, Form(...)],
    deposit_account_id: Annotated[int, Form(...)],
    paid_amount: Annotated[float, Form(...)],
    currency: Annotated[str, Form(...)] = "USD",
    notes: Annotated[Optional[str], Form()] = None,
    receipt_file: Annotated[Optional[UploadFile], File()] = None,
) -> DebtPaymentSubmitResponse:
    """
    Compatibilidad: crea ``ClientPayment`` (CxC) sin modificar facturas.
    Preferir ``POST /api/v1/payments/portal-abono`` desde el portal nuevo.
    """
    client = _portal_client_from_token(db, portal_token)

    if float(paid_amount) <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El monto del abono debe ser mayor a 0.")

    pm = db.get(PaymentMethod, int(payment_method_id))
    if pm is None or not bool(pm.is_active):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Método de pago inválido o inactivo.")

    dep_acc_id = _resolve_deposit_account_id(db, int(deposit_account_id))

    if receipt_file is None or not getattr(receipt_file, "filename", None):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Adjunta la imagen o PDF del comprobante.")

    payment = await _portal_create_abono_payment(
        db,
        client,
        payment_method_id=int(payment_method_id),
        deposit_account_id=int(dep_acc_id),
        receipt_file=receipt_file,
        paid_amount=float(paid_amount),
        currency=currency.strip() if currency else "USD",
        notes=notes,
    )
    db.commit()
    db.refresh(payment)

    return DebtPaymentSubmitResponse(
        message="Recibimos tu abono. Un operador lo aplicará a tu saldo pendiente.",
        debt_payment_id=payment.id,
        payment_number=payment.payment_number,
        status=payment.status.value,
    )


# ── Admin: list pending debt payments ────────────────────────────────────────

@router.get("/admin/debt-payments", response_model=list[DebtPaymentItem])
def admin_list_debt_payments(db: DbDep) -> list[DebtPaymentItem]:
    """Lista todos los abonos de deuda genérica pendientes de revisión."""
    rows = (
        db.query(ClientDebtPayment)
        .options(joinedload(ClientDebtPayment.client))
        .filter(ClientDebtPayment.status == DebtPaymentStatus.pending_review)
        .order_by(ClientDebtPayment.created_at.desc())
        .all()
    )
    result: list[DebtPaymentItem] = []
    for r in rows:
        client_name = r.client.display_name() if r.client else f"Cliente #{r.client_id}"
        result.append(
            DebtPaymentItem(
                id=r.id,
                client_id=r.client_id,
                client_name=client_name,
                amount=r.amount,
                currency=str(r.currency or "USD"),
                receipt_url=r.receipt_url,
                status=r.status.value,
                created_at=r.created_at.isoformat() if r.created_at else None,
                notes=r.notes,
            )
        )
    return result


# ── Admin: approve debt payment ───────────────────────────────────────────────

@router.post("/admin/debt-payments/{payment_id}/approve")
def admin_approve_debt_payment(payment_id: int, db: DbDep) -> dict:
    """
    Aprueba un abono de deuda.
    Aplica el monto al saldo de las facturas más antiguas del cliente (FIFO).
    Registra el pago en el historial de las facturas afectadas.
    """
    dp = db.get(ClientDebtPayment, payment_id)
    if dp is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Abono no encontrado.")
    if dp.status != DebtPaymentStatus.pending_review:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Este abono ya fue procesado (estado: {dp.status.value}).",
        )

    # Obtener ventas con saldo pendiente del cliente, ordenadas por fecha (más antiguas primero)
    _OPEN_STATUSES = (SaleStatus.partially_paid, SaleStatus.pending, SaleStatus.payment_submitted)
    sales_with_balance = (
        db.query(Sale)
        .options(joinedload(Sale.product), joinedload(Sale.screen_stock_row))
        .filter(Sale.client_id == dp.client_id, Sale.status.in_(_OPEN_STATUSES))
        .order_by(Sale.created_at.asc())
        .all()
    )

    remaining = Decimal(str(dp.amount))
    now_iso = isoformat_z(now_ecuador())

    for sale in sales_with_balance:
        if remaining <= _FP_EPS:
            break

        _, balance = _compute_portal_balance(db, sale)
        if balance <= _FP_EPS:
            continue

        apply = min(remaining, balance)
        remaining -= apply

        old_paid = Decimal(str(sale.amount_paid)) if sale.amount_paid is not None else Decimal("0")
        sale.amount_paid = old_paid + apply

        events: list[dict] = list(sale.payment_events or [])
        events.append(
            {
                "occurred_at": now_iso,
                "amount": float(apply),
                "currency": str(dp.currency or "USD"),
                "status": "Aprobado",
                "receipt_url": dp.receipt_url,
            }
        )
        sale.payment_events = events

        # Recalcular estado de la venta
        _, new_balance = _compute_portal_balance(db, sale)
        if new_balance <= _FP_EPS:
            sale.status = SaleStatus.approved
        elif sale.status in (SaleStatus.pending, SaleStatus.payment_submitted):
            sale.status = SaleStatus.partially_paid

        sync_sale_accounting_ledgers(db, sale, strict=False)

    dp.status = DebtPaymentStatus.approved
    dp.approved_at = now_ecuador()

    try:
        commit_db_or_rollback(db)
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("Error al aprobar abono CxC id=%s", payment_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error al aplicar el abono y registrar asientos contables.",
        ) from exc

    return {
        "message": "Abono aprobado y aplicado al saldo del cliente.",
        "remaining_after_apply": float(remaining),
    }


# ── Admin: reject debt payment ────────────────────────────────────────────────

@router.post("/admin/debt-payments/{payment_id}/reject")
def admin_reject_debt_payment(payment_id: int, db: DbDep) -> dict:
    dp = db.get(ClientDebtPayment, payment_id)
    if dp is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Abono no encontrado.")
    if dp.status != DebtPaymentStatus.pending_review:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Este abono ya fue procesado (estado: {dp.status.value}).",
        )
    dp.status = DebtPaymentStatus.rejected
    db.commit()
    return {"message": "Abono rechazado."}


@router.post(
    "/{portal_token}/sales/{referencia_externa}/instant-activation-cxc",
    response_model=PortalInstantActivationResponse,
    summary="Activación inmediata con CxC total (Códigos de Retiro)",
)
def portal_instant_activation_cxc(
    portal_token: uuid_pkg.UUID,
    referencia_externa: str,
    db: DbDep,
    payment_method_id: Annotated[
        Optional[int],
        Query(description="ID del método de pago seleccionado (debe ser Códigos de Retiro)"),
    ] = None,
) -> PortalInstantActivationResponse:
    """
    Regla 2: activa la venta pendiente y genera CxC por el 100% del total.
    No registra pagos; el webhook del socio aplicará abonos después.
    """
    from app.services.codigos_retiro_instant_service import (
        build_instant_activation_cxc_response,
        instant_activation_cxc,
    )

    client = _portal_client_from_token(db, portal_token)
    sale = instant_activation_cxc(
        db,
        client_id=int(client.id),
        referencia_externa=referencia_externa,
        payment_method_id=payment_method_id,
    )
    return PortalInstantActivationResponse.model_validate(
        build_instant_activation_cxc_response(db, sale)
    )


@router.patch(
    "/{portal_token}/sales/{referencia_externa}/instant-activation",
    response_model=PortalInstantActivationResponse,
    summary="[Legacy] Alias de instant-activation-cxc",
    include_in_schema=False,
)
def portal_codigos_retiro_instant_activation(
    portal_token: uuid_pkg.UUID,
    referencia_externa: str,
    db: DbDep,
) -> PortalInstantActivationResponse:
    return portal_instant_activation_cxc(portal_token, referencia_externa, db)


# ── POST analyze-receipt ──────────────────────────────────────────────────────

@router.post("/analyze-receipt", response_model=ReceiptAnalysisResponse, summary="Analiza un comprobante con IA")
async def analyze_receipt(
    receipt_image: Annotated[UploadFile, File(...)],
    expected_amount: Annotated[Optional[float], Form()] = None,
    expected_currency: Annotated[Optional[str], Form()] = None,
) -> ReceiptAnalysisResponse:
    allowed_types = {"image/jpeg", "image/png", "image/gif", "image/webp"}
    ct = (receipt_image.content_type or "").lower()
    if ct not in allowed_types:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Solo se aceptan imágenes (JPEG, PNG, GIF, WEBP) para el análisis.",
        )

    image_bytes = await receipt_image.read()
    if len(image_bytes) > 10 * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="La imagen no puede superar los 10 MB.",
        )

    result = await _analyze_receipt_with_openai(image_bytes, ct)

    extracted_amount: Optional[float] = None
    try:
        raw_amt = result.get("extracted_amount")
        if raw_amt is not None:
            extracted_amount = float(raw_amt)
    except (TypeError, ValueError):
        extracted_amount = None

    extracted_currency: Optional[str] = None
    raw_cur = result.get("extracted_currency")
    if raw_cur and isinstance(raw_cur, str):
        extracted_currency = raw_cur.strip().upper()[:10] or None

    is_readable: bool = bool(result.get("is_readable", False))
    if extracted_amount is None or extracted_amount <= 0:
        is_readable = False

    amount_matches: Optional[bool] = None
    if is_readable and expected_amount is not None and extracted_amount is not None:
        amount_matches = abs(extracted_amount - expected_amount) <= max(expected_amount * 0.01, 0.05)

    return ReceiptAnalysisResponse(
        is_readable=is_readable,
        extracted_amount=extracted_amount,
        extracted_currency=extracted_currency,
        amount_matches=amount_matches,
        expected_amount=expected_amount,
        expected_currency=(expected_currency or "").strip().upper()[:10] or None,
    )
