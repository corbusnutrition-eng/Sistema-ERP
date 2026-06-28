from __future__ import annotations

import logging
import os
import re
import secrets
import uuid as uuid_module
from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Optional

import requests
from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile, status, Body
from sqlalchemy import and_, func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.account_constants import is_liquid_deposit_account
from app.currency_utils import normalize_currency_code
from app.api.v1.dependencies import require_permission
from app.permissions import (
    BAAS_DISTRIBUTORS_EDIT,
    BAAS_DISTRIBUTORS_VIEW,
    BAAS_RECHARGE_REQUESTS_APPROVE,
    BAAS_RECHARGE_REQUESTS_CREATE,
    BAAS_RECHARGE_REQUESTS_EDIT,
    BAAS_RECHARGE_REQUESTS_VIEW,
    BAAS_TREE_VIEW,
)
from app.api.v1.sales import _persist_receipt_upload
from app.database import get_db
from app.models.account import Account
from app.models.client import Client
from app.models.client_payment import ClientPayment
from app.models.distributor_custom_price import DistributorCustomPrice
from app.models.payment_method import PaymentMethod
from app.models.product import Product
from app.models.user import User
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.models.wallet_transaction import WalletTransaction
from app.schemas.client_product_prices import FlujoPackageForPricing
from app.schemas.distributors import (
    ApproveWalletRechargePayload,
    ApproveWalletRechargeResponse,
    AssignParentRequest,
    CatalogClientsPickerResponse,
    ClientWalletBrief,
    CustomPriceRead,
    DistributorUserRead,
    DistributorTreeNode,
    DistributorWalletClientRead,
    GenerateRechargeLinkPayload,
    GenerateRechargeLinkResponse,
    RechargeRequest,
    RechargeResponse,
    SetPriceRequest,
    SetPriceResponse,
    TransferRequest,
    TransferResponse,
    WalletBridgeSyncResponse,
    WalletRechargeLinkedPaymentAdmin,
    WalletRechargePublicAccount,
    WalletRechargePublicDetail,
    WalletRechargePublicMethodGroup,
    WalletRechargeRequestAdminNoteUpdate,
    WalletRechargeRequestAdminRow,
    WalletRechargeRequestCreate,
    WalletRechargeRequestPendingUpdate,
    WalletRechargeRequestRead,
    WalletRechargeRequestsMetrics,
    WalletTransactionRead,
)
from app.wallet_recharge_helpers import (
    InvalidWalletRechargeStatusFilter,
    REQ_STATUS_APPROVED,
    REQ_STATUS_CANCELED,
    REQ_STATUS_IN_REVIEW,
    REQ_STATUS_PARTIALLY_PAID,
    REQ_STATUS_PENDING,
    REQ_STATUS_REJECTED,
    normalize_wallet_recharge_list_status,
    payment_methods_display,
    wallet_recharge_admin_pending_sql_filter,
)
from app.services import render_sync
from app.services.catalog_client_picker_rows import local_clients_catalog_picker_rows
from app.services.client_payment_service import (
    finalize_wallet_recharge_payment_approval,
    get_client_credit_balance,
)
from app.services.client_reseller_service import (
    build_distributor_tree_node,
    get_client_by_payment_token,
)
from app.services.client_product_price_service import (
    list_screen_catalog_products_for_pricing,
    upsert_client_product_prices,
)

router = APIRouter(prefix="/distributors", tags=["distributors"])

DbDep = Annotated[Session, Depends(get_db)]

BaasDistributorsViewDep = Annotated[dict, Depends(require_permission(BAAS_DISTRIBUTORS_VIEW))]
BaasDistributorsEditDep = Annotated[dict, Depends(require_permission(BAAS_DISTRIBUTORS_EDIT))]
BaasRechargeViewDep = Annotated[dict, Depends(require_permission(BAAS_RECHARGE_REQUESTS_VIEW))]
BaasRechargeCreateDep = Annotated[dict, Depends(require_permission(BAAS_RECHARGE_REQUESTS_CREATE))]
BaasRechargeEditDep = Annotated[dict, Depends(require_permission(BAAS_RECHARGE_REQUESTS_EDIT))]
BaasRechargeApproveDep = Annotated[dict, Depends(require_permission(BAAS_RECHARGE_REQUESTS_APPROVE))]
BaasTreeViewDep = Annotated[dict, Depends(require_permission(BAAS_TREE_VIEW))]

logger = logging.getLogger(__name__)


def _trim_wallet_creation_note(note: Optional[str]) -> Optional[str]:
    """Normaliza nota de creación sin asumir unicidad de tipos (robustez frente a payloads raros)."""
    if note is None:
        return None
    s = " ".join(str(note).split()).strip()
    return s[:2048] if s else None


TX_RECHARGE = "recharge"
TX_TRANSFER_OUT = "transfer_out"
TX_TRANSFER_IN = "transfer_in"

_RE_WR_SOLICITUD_REF = re.compile(r"Recarga abono\s*\(\s*solicitud\s*#\s*(\d+)\s*\)", re.IGNORECASE)
_RE_WR_APLICADO = re.compile(r"aplicado(?:\s*CxC)?\s*([\d.]+)", re.IGNORECASE)


def _linked_wallet_payments_admin(db: Session, req: WalletRechargeRequest) -> list[WalletRechargeLinkedPaymentAdmin]:
    """Abonos y comprobantes vinculados (mismo motor CxC que ventas)."""
    from app.services.client_payment_service import linked_payments_financial_for_wallet_recharge

    cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
    approved, pending = linked_payments_financial_for_wallet_recharge(db, req)
    out: list[WalletRechargeLinkedPaymentAdmin] = []
    for row in approved:
        receipt = row.get("receipt_file_url")
        applied = float(row.get("amount_applied") or 0)
        out.append(
            WalletRechargeLinkedPaymentAdmin(
                kind="credit_applied",
                occurred_at=row.get("date"),
                amount=round(applied, 2),
                amount_applied=round(applied, 2),
                currency=cur,
                status_label="Aprobado",
                receipt_url=receipt,
                receipt_file_url=receipt,
                payment_id=int(row["payment_id"]) if row.get("payment_id") is not None else None,
                payment_number=row.get("payment_number"),
                wallet_transaction_id=(
                    int(row["payment_id"]) - 1_000_000_000
                    if int(row.get("payment_id") or 0) >= 1_000_000_000
                    else None
                ),
            )
        )
    for row in pending:
        receipt = row.get("receipt_file_url")
        amt = float(row.get("amount_applied_to_sale") or row.get("amount") or 0)
        notes_raw = ""
        cpid = row.get("payment_id")
        cp_manual = False
        cp_confidence: Optional[int] = None
        if cpid is not None:
            cp_row = db.get(ClientPayment, int(cpid))
            if cp_row is not None:
                notes_raw = str(cp_row.notes or "")
                cp_manual = bool(getattr(cp_row, "is_manually_edited", False))
                cp_confidence = getattr(cp_row, "ai_confidence_score", None)
        from app.services.client_payment_service import credit_reserved_restore_from_notes

        credit_part = float(credit_reserved_restore_from_notes(notes_raw))
        cash_part = max(0.0, round(amt - credit_part, 2))
        kind = "receipt_under_review"
        status_label = "En revisión"
        if credit_part > 1e-9 and cash_part <= 1e-9:
            kind = "credit_under_review"
            status_label = "Cruce saldo a favor — En revisión"
        elif credit_part > 1e-9:
            kind = "mixed_under_review"
            status_label = "Depósito + saldo a favor — En revisión"
        out.append(
            WalletRechargeLinkedPaymentAdmin(
                kind=kind,
                occurred_at=row.get("created_at"),
                amount=round(amt, 2),
                amount_applied=round(amt, 2),
                currency=str(row.get("currency") or cur),
                status_label=status_label,
                receipt_url=receipt,
                receipt_file_url=receipt,
                payment_id=int(row["payment_id"]) if row.get("payment_id") is not None else None,
                payment_number=row.get("payment_number"),
                wallet_transaction_id=None,
                credit_portion=round(credit_part, 2) if credit_part > 1e-9 else None,
                cash_portion=round(cash_part, 2) if cash_part > 1e-9 else None,
                is_manually_edited=cp_manual,
                ai_confidence_score=cp_confidence,
            )
        )
    return out


def _generate_unique_referral_code(db: Session) -> str:
    for _ in range(40):
        code = secrets.token_hex(6).upper()
        exists = db.query(User.id).filter(User.referral_code == code).first()
        if not exists:
            return code
    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="No se pudo generar un código de referido único.",
    )


def _ensure_referral_code(db: Session, user: User) -> None:
    if user.referral_code:
        return
    user.referral_code = _generate_unique_referral_code(db)


def _jwt_user_id(payload: dict) -> int:
    raw = payload.get("user_id")
    if raw is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="La sesión no incluye user_id; cierra sesión y vuelve a entrar con un usuario de base de datos.",
        )
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="user_id inválido en el token.",
        )


def _would_create_parent_cycle(db: Session, child_id: int, new_parent_id: Optional[int]) -> bool:
    if new_parent_id is None:
        return False
    if new_parent_id == child_id:
        return True
    cur: Optional[int] = new_parent_id
    visited: set[int] = set()
    while cur is not None:
        if cur == child_id:
            return True
        if cur in visited:
            return True
        visited.add(cur)
        row = db.get(User, cur)
        if row is None:
            break
        cur = row.parent_id
    return False


def _get_or_create_client_by_distributor_email(db: Session, distributor_email: str) -> Client:
    """Localiza cliente por correo (insensible a mayúsculas) o lo crea para mantener FK de la solicitud."""
    email_norm = (distributor_email or "").strip().lower()
    if not email_norm or "@" not in email_norm:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Correo del distribuidor no válido.",
        )

    client = db.query(Client).filter(func.lower(Client.email) == email_norm).first()
    if client is not None:
        return client

    local_part = email_norm.split("@", 1)[0].strip()[:120] or "distribuidor"
    username = local_part
    suffix = 0
    while db.query(Client.id).filter(Client.username == username).first() is not None:
        suffix += 1
        username = f"{local_part[:95]}_{suffix}"[:120]

    new_row = Client(
        email=email_norm,
        name=local_part,
        username=username,
        status="Activo",
    )
    db.add(new_row)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        client = db.query(Client).filter(func.lower(Client.email) == email_norm).first()
        if client is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="No se pudo registrar el cliente automáticamente; créalo en el CRM e inténtalo de nuevo.",
            ) from None
        return client
    return new_row


def _liquid_deposit_candidates(db: Session) -> tuple[list[Account], dict[int, Account]]:
    rows = db.query(Account).filter(Account.is_active.is_(True)).order_by(Account.name).all()
    cand = [a for a in rows if is_liquid_deposit_account(a)]
    by_id = {a.id: a for a in cand}
    return cand, by_id


def _linked_matches_pm(acc: Account, pm_lower: str, by_id: dict[int, Account]) -> bool:
    lm = (acc.linked_payment_method or "").strip().lower()
    if lm == pm_lower:
        return True
    pid = acc.parent_id
    if pid and pid in by_id:
        parent = by_id[pid]
        plm = (parent.linked_payment_method or "").strip().lower()
        return bool(plm == pm_lower)
    return False


def _is_grouping_parent(acc_id: int, pool: list[Account]) -> bool:
    return any(a.parent_id == acc_id for a in pool)


def _account_public_label(acc: Account, by_id: dict[int, Account]) -> str:
    pid = acc.parent_id
    if pid and pid in by_id:
        par = by_id[pid]
        return f"{par.name} — {acc.name} ({acc.currency})"
    return f"{acc.name} ({acc.currency})"


def _validate_payment_method_ids(db: Session, raw_ids: list[int]) -> list[PaymentMethod]:
    ids = sorted({int(x) for x in raw_ids})
    if not ids:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Indica al menos un método de pago.")
    rows = (
        db.query(PaymentMethod)
        .filter(PaymentMethod.id.in_(ids), PaymentMethod.is_active.is_(True))
        .all()
    )
    if len(rows) != len(ids):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Hay métodos de pago inválidos o inactivos.",
        )
    return rows


def _matched_accounts_for_payment_methods(db: Session, pm_rows: list[PaymentMethod]) -> tuple[list[Account], dict[int, Account]]:
    candidates, by_id = _liquid_deposit_candidates(db)
    lowers = {pm.name.strip().lower() for pm in pm_rows}
    matched: list[Account] = []
    seen: set[int] = set()
    for acc in candidates:
        for ml in lowers:
            if _linked_matches_pm(acc, ml, by_id):
                if acc.id not in seen:
                    seen.add(acc.id)
                    matched.append(acc)
                break
    return matched, by_id


def _apply_deposit_account_filter(
    matched: list[Account],
    by_id: dict[int, Account],
    deposit_ids: Optional[list[int]],
) -> list[Account]:
    if not deposit_ids:
        return matched
    ds = {int(x) for x in deposit_ids}
    return [a for a in matched if a.id in ds]


def _validate_deposit_subset(selected_ids: Optional[list[int]], pool: list[Account]) -> Optional[list[int]]:
    if not selected_ids:
        return None
    pool_ids = {a.id for a in pool}
    chosen = [int(x) for x in selected_ids]
    bad = set(chosen) - pool_ids
    if bad:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Hay cuentas de depósito no válidas para los métodos elegidos.",
        )
    return chosen


def _build_wallet_recharge_public_detail(db: Session, req: WalletRechargeRequest) -> WalletRechargePublicDetail:
    cli = req.client or db.get(Client, req.client_id)
    disp_name = cli.display_name() if cli else "Distribuidor"

    raw_pm = req.allowed_payment_methods or []
    pm_ids = [int(x) for x in raw_pm]
    pm_rows = db.query(PaymentMethod).filter(PaymentMethod.id.in_(pm_ids)).order_by(PaymentMethod.id).all()

    matched, by_id = _matched_accounts_for_payment_methods(db, pm_rows)
    restricted = _apply_deposit_account_filter(matched, by_id, req.allowed_deposit_account_ids)

    method_groups: list[WalletRechargePublicMethodGroup] = []
    for pm in pm_rows:
        ml = pm.name.strip().lower()
        accs = [
            a
            for a in restricted
            if _linked_matches_pm(a, ml, by_id) and not _is_grouping_parent(a.id, restricted)
        ]
        method_groups.append(
            WalletRechargePublicMethodGroup(
                payment_method_id=pm.id,
                payment_method_name=pm.name,
                accounts=[
                    WalletRechargePublicAccount(
                        id=a.id,
                        label=_account_public_label(a, by_id),
                        currency=str(a.currency or "USD"),
                    )
                    for a in accs
                ],
            )
        )

    from app.wallet_recharge_helpers import wallet_recharge_accepts_client_receipt, wallet_recharge_open_balance

    open_bal = wallet_recharge_open_balance(req)
    can_submit = wallet_recharge_accepts_client_receipt(req)

    if req.status == REQ_STATUS_PENDING:
        msg = "Realiza el pago usando una de las cuentas indicadas y sube tu comprobante."
    elif can_submit and open_bal > 1e-6:
        msg = (
            f"Saldo restante a pagar: {open_bal:.2f} "
            f"{normalize_currency_code(getattr(req, 'recharge_currency', None), 'USD')}. "
            "Puedes enviar abonos parciales adicionales con un nuevo comprobante."
        )
    elif req.status == REQ_STATUS_IN_REVIEW:
        msg = "Hay comprobante(s) en revisión. Cuando se aprueben, actualizaremos tu saldo."
    elif req.status == REQ_STATUS_APPROVED and open_bal <= 1e-6:
        msg = "Esta solicitud ya fue aprobada y acreditada."
        can_submit = False
    elif req.status == REQ_STATUS_REJECTED:
        msg = "Esta solicitud fue rechazada. Si necesitas ayuda, contacta a administración."
        can_submit = False
    elif req.status == REQ_STATUS_CANCELED:
        msg = "Esta solicitud fue cancelada. Si necesitas una nueva recarga, solicita otro enlace."
        can_submit = False
    else:
        msg = f"Estado: {req.status}"
        can_submit = False

    precheck = (getattr(req, "admin_precheck_receipt_url", None) or "").strip() or None

    return WalletRechargePublicDetail(
        amount_requested=float(req.amount_requested),
        balance_pending=round(open_bal, 2),
        amount_paid=float(getattr(req, "amount_paid", 0) or 0),
        recharge_currency=normalize_currency_code(getattr(req, "recharge_currency", None), "USD"),
        recharge_exchange_rate=float(getattr(req, "recharge_exchange_rate", None) or 1.0),
        admin_precheck_receipt_url=precheck,
        status=req.status,
        distributor_display_name=disp_name,
        can_submit_receipt=can_submit,
        status_message=msg,
        method_groups=method_groups,
    )


@router.get("/client-credit-preview")
def client_credit_preview_for_recharge(
    db: DbDep,
    _: BaasDistributorsViewDep,
    email: str = Query(..., min_length=3),
    currency: str = Query("USD", max_length=10),
) -> dict[str, object]:
    """Saldo a favor utilizable del cliente (misma fuente que CxC / portal)."""
    em = str(email or "").strip().lower()
    if "@" not in em:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Correo inválido.")
    cur = normalize_currency_code(currency, "USD")
    row = db.query(Client).filter(func.lower(Client.email) == em).first()
    if row is None:
        return {"client_id": None, "currency": cur, "available_credit": 0.0}
    from app.services.client_payment_service import sync_client_credit_from_overpay

    sync_client_credit_from_overpay(db, row)
    db.flush()
    avail = float(get_client_credit_balance(row, cur, db=db))
    return {"client_id": int(row.id), "currency": cur, "available_credit": round(avail, 2)}


@router.get("/catalog-clients", response_model=CatalogClientsPickerResponse)
def list_catalog_clients_for_recharge_picker(db: DbDep, _: BaasDistributorsViewDep) -> CatalogClientsPickerResponse:
    """
    Lista clientes desde el catálogo VIP (Render) vía servidor.

    Intenta ``POST …/api/webhook/listar-clientes`` con ``X-Webhook-Secret``.
    Si la red o Render fallan, devuelve **siempre** 200 con clientes activos del CRM local
    (nunca propaga error 502/503 al frontend).
    """
    rows_out: list[Any] = []
    src = "render"
    warning: Optional[str] = None

    raw_rows, render_ok = render_sync.fetch_listar_clientes_raw_rows()
    if render_ok and raw_rows is not None:
        rows_out = list(raw_rows)
    else:
        rows_out = local_clients_catalog_picker_rows(db)
        src = "local_fallback" if render_sync.bridge_enabled() else "local_only"
        if render_sync.bridge_enabled():
            warning = (
                "No se pudo contactar el catálogo en la nube; se muestran clientes activos del ERP."
            )

    return CatalogClientsPickerResponse(status="ok", clientes=rows_out, source=src, warning=warning)


@router.get("/users", response_model=list[DistributorWalletClientRead])
def list_distributor_users(db: DbDep, _: BaasDistributorsViewDep) -> list[DistributorWalletClientRead]:
    """
    Clientes CRM que usan BaaS de verdad: al menos una solicitud de recarga (cualquier estado)
    o al menos un movimiento en ``wallet_transactions`` (``client_id``).
    Excluye clientes finales sin historial BaaS. Orden: ``wallet_balance`` ascendente.
    """
    req_client_ids = (
        db.query(WalletRechargeRequest.client_id)
        .filter(WalletRechargeRequest.client_id.isnot(None))
        .distinct()
    )
    tx_client_ids = (
        db.query(WalletTransaction.client_id)
        .filter(WalletTransaction.client_id.isnot(None))
        .distinct()
    )
    rows = (
        db.query(Client)
        .filter(Client.email.isnot(None))
        .filter(
            or_(
                Client.id.in_(req_client_ids),
                Client.id.in_(tx_client_ids),
            )
        )
        .order_by(Client.wallet_balance.asc(), Client.id.asc())
        .all()
    )
    out: list[DistributorWalletClientRead] = []
    from app.services.client_currency_service import get_client_currency
    from app.services.wallet_balance_service import get_client_wallet_balance

    for c in rows:
        em = str(c.email or "").strip()
        if "@" not in em:
            continue
        cur = get_client_currency(c)
        bal = float(get_client_wallet_balance(c, cur))
        from app.services.client_payment_service import sync_client_credit_from_overpay

        sync_client_credit_from_overpay(db, c)
        db.flush()
        credit_bal = float(get_client_credit_balance(c, cur, db=db))
        out.append(
            DistributorWalletClientRead(
                id=int(c.id),
                parent_id=int(c.parent_id) if c.parent_id is not None else None,
                name=(str(c.name).strip() if c.name else None) or None,
                email=em,
                username=str(c.username or "").strip(),
                wallet_balance=bal,
                credit_balance=credit_bal,
                currency=cur,
                status=str(c.status) if c.status is not None else None,
                payment_token=c.payment_token,
            )
        )
    return out


@router.get("/{client_uuid}/tree-data", response_model=DistributorTreeNode)
def get_distributor_tree_data(
    client_uuid: uuid_module.UUID,
    db: DbDep,
    _: BaasTreeViewDep,
) -> DistributorTreeNode:
    """
    Árbol genealógico BaaS del cliente identificado por ``payment_token`` (UUID).

    Incluye la raíz y todos los sub-clientes descendientes con saldo BaaS.
    """
    root = get_client_by_payment_token(db, client_uuid)
    tree = build_distributor_tree_node(db, root)
    return DistributorTreeNode(**tree)


@router.post("/recharge", response_model=RechargeResponse)
def recharge_wallet(payload: RechargeRequest, db: DbDep, _: BaasRechargeCreateDep) -> RechargeResponse:
    """Administrador acredita saldo virtual a un distribuidor/usuario interno."""
    user = db.get(User, payload.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario no encontrado.")
    _ensure_referral_code(db, user)

    user.wallet_balance = float(user.wallet_balance) + float(payload.amount)
    tx = WalletTransaction(
        user_id=user.id,
        client_id=None,
        amount=float(payload.amount),
        transaction_type=TX_RECHARGE,
        description=payload.description or "Recarga administrativa",
    )
    db.add(tx)
    db.commit()
    db.refresh(user)
    db.refresh(tx)
    return RechargeResponse(
        user=DistributorUserRead.model_validate(user),
        transaction=WalletTransactionRead.model_validate(tx),
    )


@router.post("/transfer", response_model=TransferResponse)
def transfer_to_child(payload: TransferRequest, db: DbDep, current: BaasDistributorsEditDep) -> TransferResponse:
    """
    El distribuidor autenticado transfiere saldo a un subdistribuidor directo (parent_id == remitente).
    """
    sender_id = _jwt_user_id(current)
    sender = db.get(User, sender_id)
    if sender is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario remitente no encontrado.")

    child = db.get(User, payload.buyer_user_id)
    if child is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subdistribuidor no encontrado.")
    if child.parent_id != sender.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Solo puedes transferir a un usuario cuyo padre jerárquico seas.",
        )

    amt = float(payload.amount)
    if float(sender.wallet_balance) + 1e-9 < amt:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Saldo insuficiente.")

    sender.wallet_balance = float(sender.wallet_balance) - amt
    child.wallet_balance = float(child.wallet_balance) + amt

    tx_out = WalletTransaction(
        user_id=sender.id,
        client_id=None,
        amount=-amt,
        transaction_type=TX_TRANSFER_OUT,
        description=f"Transferencia enviada a usuario #{child.id} ({child.email})",
    )
    tx_in = WalletTransaction(
        user_id=child.id,
        client_id=None,
        amount=amt,
        transaction_type=TX_TRANSFER_IN,
        description=f"Transferencia recibida de usuario #{sender.id} ({sender.email})",
    )
    db.add(tx_out)
    db.add(tx_in)
    db.commit()
    db.refresh(sender)
    db.refresh(child)
    db.refresh(tx_out)
    db.refresh(tx_in)

    return TransferResponse(
        sender=DistributorUserRead.model_validate(sender),
        receiver=DistributorUserRead.model_validate(child),
        transactions=[
            WalletTransactionRead.model_validate(tx_out),
            WalletTransactionRead.model_validate(tx_in),
        ],
    )


@router.post("/set-price", response_model=SetPriceResponse)
def set_custom_price(payload: SetPriceRequest, db: DbDep, current: BaasDistributorsEditDep) -> SetPriceResponse:
    """
    El distribuidor autenticado fija el precio de un paquete (producto) para un subdistribuidor directo.
    """
    seller_id = _jwt_user_id(current)
    seller = db.get(User, seller_id)
    if seller is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vendedor no encontrado.")

    buyer = db.get(User, payload.buyer_user_id)
    if buyer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Comprador no encontrado.")
    if buyer.parent_id != seller.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Solo puedes fijar precios a tu subdistribuidor directo.",
        )

    pkg = db.get(Product, payload.package_id)
    if pkg is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Paquete/producto no encontrado.")

    row = (
        db.query(DistributorCustomPrice)
        .filter(
            DistributorCustomPrice.seller_id == seller.id,
            DistributorCustomPrice.buyer_id == buyer.id,
            DistributorCustomPrice.package_id == pkg.id,
        )
        .first()
    )
    if row:
        row.price = float(payload.price)
    else:
        row = DistributorCustomPrice(
            seller_id=seller.id,
            buyer_id=buyer.id,
            package_id=pkg.id,
            price=float(payload.price),
        )
        db.add(row)

    db.commit()
    db.refresh(row)
    return SetPriceResponse(custom_price=CustomPriceRead.model_validate(row))


@router.post("/assign-parent", response_model=DistributorUserRead)
def assign_parent(payload: AssignParentRequest, db: DbDep, _: BaasDistributorsEditDep) -> User:
    """Define la jerarquía padre-hijo entre usuarios internos (solo administrador)."""
    child = db.get(User, payload.child_user_id)
    if child is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario hijo no encontrado.")

    parent_id = payload.parent_user_id
    if parent_id is not None:
        parent = db.get(User, parent_id)
        if parent is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario padre no encontrado.")

    if _would_create_parent_cycle(db, child.id, parent_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La asignación crearía un ciclo en la jerarquía.",
        )

    child.parent_id = parent_id
    db.commit()
    db.refresh(child)
    _ensure_referral_code(db, child)
    db.commit()
    db.refresh(child)
    return child


def _stored_admin_note(r: WalletRechargeRequest) -> Optional[str]:
    raw = getattr(r, "admin_note", None)
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    return s[:2048] if s else None


def _recharge_auto_hints(r: WalletRechargeRequest) -> Optional[str]:
    """Fragmentos automáticos (declaraciones portal, precheck) cuando no hay nota admin."""
    parts: list[str] = []
    ap = (getattr(r, "admin_precheck_receipt_url", None) or "").strip()
    if ap:
        parts.append("Precheck admin adjunto")
    pad = getattr(r, "portal_declared_payment_amount", None)
    if pad is not None:
        try:
            fv = float(pad)
            if fv > 0:
                parts.append(f"Cliente declaró: {fv:.2f}")
        except (TypeError, ValueError):
            pass
    dep = getattr(r, "portal_submitted_deposit_account_id", None)
    if dep is not None:
        try:
            parts.append(f"Cuenta declarada #{int(dep)}")
        except (TypeError, ValueError):
            parts.append(str(dep))
    return " · ".join(parts) if parts else None


def _recharge_notes_preview(r: WalletRechargeRequest) -> Optional[str]:
    manual = _stored_admin_note(r)
    if manual:
        return manual
    return _recharge_auto_hints(r)
def _pm_rows_from_existing_request(db: Session, req: WalletRechargeRequest) -> list[PaymentMethod]:
    raw_list = req.allowed_payment_methods if isinstance(req.allowed_payment_methods, list) else []
    ids: list[int] = []
    for x in raw_list:
        try:
            ids.append(int(x))
        except (TypeError, ValueError):
            continue
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La solicitud no tiene métodos de pago configurados.",
        )
    return _validate_payment_method_ids(db, ids)


def _row_wallet_recharge_admin(db: Session, r: WalletRechargeRequest) -> WalletRechargeRequestAdminRow:
    c = r.client
    pm_disp = payment_methods_display(db, r.allowed_payment_methods if isinstance(r.allowed_payment_methods, list) else None)
    cur = normalize_currency_code(getattr(r, "recharge_currency", None), "USD")
    xr = float(getattr(r, "recharge_exchange_rate", None) or 1.0)
    pm_ids: Optional[list[int]] = None
    if isinstance(r.allowed_payment_methods, list):
        try:
            pm_ids = [int(x) for x in r.allowed_payment_methods]
        except (TypeError, ValueError):
            pm_ids = None
    dep_ids: Optional[list[int]] = None
    if isinstance(r.allowed_deposit_account_ids, list):
        try:
            dep_ids = [int(x) for x in r.allowed_deposit_account_ids]
        except (TypeError, ValueError):
            dep_ids = None
    precheck = getattr(r, "admin_precheck_receipt_url", None)
    token_str = None
    if c is not None:
        pt = getattr(c, "payment_token", None)
        if pt is not None:
            token_str = str(pt)
    return WalletRechargeRequestAdminRow(
        id=r.id,
        client_id=r.client_id,
        client_name=c.name if c else None,
        client_email=c.email if c else "",
        client_username=c.username if c else "",
        amount_requested=float(r.amount_requested),
        amount_paid=float(getattr(r, "amount_paid", 0) or 0),
        balance_pending=float(getattr(r, "balance_pending", float(r.amount_requested)) or 0),
        surplus_credited=float(getattr(r, "surplus_credited", 0) or 0),
        receipt_url=r.receipt_url or None,
        payment_methods_display=pm_disp,
        status=r.status,
        created_at=r.created_at,
        recharge_currency=cur,
        recharge_exchange_rate=xr,
        allowed_payment_methods=pm_ids,
        allowed_deposit_account_ids=dep_ids,
        link_hash=r.link_hash or None,
        admin_precheck_receipt_url=(precheck.strip()[:2048] if isinstance(precheck, str) and precheck.strip() else None),
        client_payment_token=token_str,
        notes_preview=_recharge_notes_preview(r),
        admin_note=_stored_admin_note(r),
        recharge_detail_lines=(
            getattr(r, "recharge_detail_lines", None)
            if isinstance(getattr(r, "recharge_detail_lines", None), list)
            else None
        ),
        declared_deposit_usd=(
            float(x)
            if (x := getattr(r, "declared_deposit_usd", None)) is not None and float(x) >= 0
            else None
        ),
        portal_declared_payment_amount=(
            float(x)
            if (x := getattr(r, "portal_declared_payment_amount", None)) is not None
            and float(x) > 1e-9
            else None
        ),
        is_manually_edited=bool(getattr(r, "is_manually_edited", False)),
        ai_confidence_score=getattr(r, "ai_confidence_score", None),
        linked_payments=_linked_wallet_payments_admin(db, r),
    )


@router.post("/request-recharge", response_model=WalletRechargeRequestRead)
def request_wallet_recharge(
    payload: WalletRechargeRequestCreate,
    db: DbDep,
    current: BaasRechargeCreateDep,
) -> WalletRechargeRequest:
    """
    El distribuidor solicita una recarga enviando importe y URL del recibo de pago.
    La solicitud queda en estado «en revisión» hasta decisión administrativa.
    """
    uid = _jwt_user_id(current)
    user = db.get(User, uid)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario no encontrado.")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Usuario desactivado.")

    email_norm = user.email.strip().lower()
    client = db.query(Client).filter(func.lower(Client.email) == email_norm).first()
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No existe un cliente en el CRM con el mismo correo que este usuario. Crea el cliente o usa el enlace administrativo de recarga.",
        )

    aq = float(payload.amount_requested)
    req = WalletRechargeRequest(
        client_id=client.id,
        amount_requested=aq,
        receipt_url=payload.receipt_url.strip(),
        status=REQ_STATUS_IN_REVIEW,
        amount_paid=0.0,
        balance_pending=aq,
        surplus_credited=0.0,
    )
    db.add(req)
    db.flush()
    from app.services.client_payment_service import try_sweep_client_credit_on_new_cxc

    try_sweep_client_credit_on_new_cxc(
        db,
        client,
        currency=normalize_currency_code(getattr(req, "recharge_currency", None), "USD"),
        strict_accounting=False,
    )
    db.commit()
    db.refresh(req)
    return req


@router.get("/recharge-requests", response_model=list[WalletRechargeRequestAdminRow])
def list_wallet_recharge_requests(
    db: DbDep,
    _: BaasRechargeViewDep,
    request_status: Annotated[
        str,
        Query(
            alias="status",
            description=(
                "Filtra por estado canónico: pending, partially_paid, in_review, approved, rejected, canceled; "
                "alias legacy pendiente→in_review, pending_payment→pending; «all» todas."
            ),
        ),
    ] = REQ_STATUS_IN_REVIEW,
) -> list[WalletRechargeRequestAdminRow]:
    """
    Lista solicitudes de recarga. Por defecto «en revisión» (`status=in_review`).
    Usa `?status=all` para ver todas.
    """
    q = db.query(WalletRechargeRequest).options(joinedload(WalletRechargeRequest.client))
    try:
        sf = normalize_wallet_recharge_list_status(request_status)
    except InvalidWalletRechargeStatusFilter:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Parámetro status no válido.",
        ) from None
    if sf != "all":
        if sf == REQ_STATUS_PENDING:
            q = q.filter(
                or_(
                    WalletRechargeRequest.status == REQ_STATUS_PENDING,
                    wallet_recharge_admin_pending_sql_filter(),
                )
            )
        elif sf == REQ_STATUS_APPROVED:
            q = q.filter(
                WalletRechargeRequest.status.in_((REQ_STATUS_APPROVED, REQ_STATUS_PARTIALLY_PAID))
            )
        else:
            q = q.filter(WalletRechargeRequest.status == sf)
    rows = q.order_by(WalletRechargeRequest.created_at.desc()).all()
    return [_row_wallet_recharge_admin(db, r) for r in rows]


@router.get("/recharge-requests/metrics", response_model=WalletRechargeRequestsMetrics)
def wallet_recharge_request_metrics(db: DbDep, _: BaasRechargeViewDep) -> WalletRechargeRequestsMetrics:
    """Conteos por estado (insignias en UI, igual patrón que Ventas)."""
    rows = (
        db.query(WalletRechargeRequest.status, func.count(WalletRechargeRequest.id))
        .group_by(WalletRechargeRequest.status)
        .all()
    )
    m = WalletRechargeRequestsMetrics()
    for st, cnt in rows:
        s = str(st or "").strip()
        try:
            c = int(cnt)
        except (TypeError, ValueError):
            c = 0
        if s == REQ_STATUS_PENDING:
            m.pending = c
        elif s == REQ_STATUS_IN_REVIEW:
            m.in_review = c
        elif s in (REQ_STATUS_PARTIALLY_PAID, REQ_STATUS_APPROVED):
            m.approved += c
        elif s == REQ_STATUS_REJECTED:
            m.rejected = c
        elif s == REQ_STATUS_CANCELED:
            m.canceled = c
    open_partial = (
        db.query(func.count(WalletRechargeRequest.id))
        .filter(wallet_recharge_admin_pending_sql_filter())
        .scalar()
    )
    try:
        m.pending += int(open_partial or 0)
    except (TypeError, ValueError):
        pass
    return m


@router.get("/recharge-requests/{request_id}", response_model=WalletRechargeRequestAdminRow)
def get_wallet_recharge_request_detail(
    request_id: int,
    db: DbDep,
    _: BaasRechargeViewDep,
) -> WalletRechargeRequestAdminRow:
    """Detalle de una solicitud BaaS (panel admin), p. ej. modal de consulta desde ficha cliente."""
    req = (
        db.query(WalletRechargeRequest)
        .options(joinedload(WalletRechargeRequest.client))
        .filter(WalletRechargeRequest.id == int(request_id))
        .first()
    )
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Solicitud de recarga no encontrada.")
    return _row_wallet_recharge_admin(db, req)


@router.patch("/recharge-requests/{request_id}", response_model=WalletRechargeRequestAdminRow)
def patch_wallet_recharge_request_fields(
    request_id: int,
    payload: WalletRechargeRequestPendingUpdate,
    db: DbDep,
    _: BaasRechargeEditDep,
) -> WalletRechargeRequestAdminRow:
    """Actualiza importe/métodos/moneda/etc. en ``pending``, ``partially_paid`` o ``in_review``."""
    req = (
        db.query(WalletRechargeRequest)
        .options(joinedload(WalletRechargeRequest.client))
        .filter(WalletRechargeRequest.id == int(request_id))
        .first()
    )
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Solicitud no encontrada.")
    from app.wallet_recharge_helpers import wallet_recharge_editable_by_admin

    if not wallet_recharge_editable_by_admin(req):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Solo se pueden editar solicitudes pendientes, en revisión o activadas con saldo CxC pendiente.",
        )

    pm_rows_updated: Optional[list[PaymentMethod]] = None

    if payload.line_items is not None:
        lis = payload.line_items
        new_amt_calc = round(sum(x.line_charge_amount() for x in lis), 2)
        if payload.amount is not None and abs(float(payload.amount) - new_amt_calc) > 0.02:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El monto solicitado no coincide con la suma de importes de las líneas.",
            )
        new_amt_eff = float(payload.amount) if payload.amount is not None else new_amt_calc
        paid_so_far = float(getattr(req, "amount_paid", 0) or 0)
        if new_amt_eff + 1e-6 < paid_so_far:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El importe solicitado no puede ser menor al ya abonado acumulado.",
            )
        req.amount_requested = new_amt_eff
        req.balance_pending = max(0.0, new_amt_eff - paid_so_far)
        req.recharge_detail_lines = [x.model_dump(mode="json") for x in lis]
    elif payload.amount is not None:
        new_amt = float(payload.amount)
        paid_so_far = float(getattr(req, "amount_paid", 0) or 0)
        if new_amt + 1e-6 < paid_so_far:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El importe solicitado no puede ser menor al ya abonado acumulado.",
            )
        req.amount_requested = new_amt
        req.balance_pending = max(0.0, new_amt - paid_so_far)

    if payload.allowed_payment_methods is not None:
        pm_rows_updated = _validate_payment_method_ids(db, payload.allowed_payment_methods)
        pm_sorted = sorted(pm_rows_updated, key=lambda x: x.id)
        req.allowed_payment_methods = [pm.id for pm in pm_sorted]

    if payload.allowed_deposit_account_ids is not None:
        pm_for_dep = pm_rows_updated if pm_rows_updated is not None else _pm_rows_from_existing_request(db, req)
        matched, _mid = _matched_accounts_for_payment_methods(db, pm_for_dep)
        if len(payload.allowed_deposit_account_ids) == 0:
            req.allowed_deposit_account_ids = None
        else:
            req.allowed_deposit_account_ids = _validate_deposit_subset(payload.allowed_deposit_account_ids, matched)
        from app.services.client_payment_service import (
            sync_pending_payments_deposit_for_wallet_recharge,
            sync_wallet_recharge_submitted_deposit_from_allowlist,
        )

        dep_norm = list(req.allowed_deposit_account_ids or [])
        if dep_norm:
            sync_wallet_recharge_submitted_deposit_from_allowlist(req, dep_norm)
            sync_pending_payments_deposit_for_wallet_recharge(db, req)

    if payload.currency is not None:
        req.recharge_currency = normalize_currency_code(payload.currency, "USD")
    if payload.exchange_rate is not None:
        req.recharge_exchange_rate = float(payload.exchange_rate)
    if payload.admin_precheck_receipt_url is not None:
        s = str(payload.admin_precheck_receipt_url).strip()
        req.admin_precheck_receipt_url = s[:2048] if s else None

    if payload.admin_note is not None:
        nb = str(payload.admin_note).strip()
        req.admin_note = nb[:2048] if nb else None

    declared_updated = False
    if payload.portal_declared_payment_amount is not None:
        pad = float(payload.portal_declared_payment_amount)
        xr_eff = float(getattr(req, "recharge_exchange_rate", None) or 1.0)
        if pad > 1e-9:
            req.portal_declared_payment_amount = round(pad, 2)
            req.declared_deposit_usd = round(pad / xr_eff, 4) if xr_eff > 0 else None
        else:
            req.portal_declared_payment_amount = None
            req.declared_deposit_usd = None
        declared_updated = True
    elif payload.declared_deposit_usd is not None:
        deps_raw = payload.declared_deposit_usd
        deps_f = float(deps_raw)
        xr_eff = float(getattr(req, "recharge_exchange_rate", None) or 1.0)
        if deps_f > 1e-9:
            req.declared_deposit_usd = deps_f
            req.portal_declared_payment_amount = round(deps_f * xr_eff, 2)
        else:
            req.declared_deposit_usd = None
            req.portal_declared_payment_amount = None
        declared_updated = True

    if declared_updated:
        from app.services.client_payment_service import sync_pending_payment_declared_amount_for_wallet_recharge

        sync_pending_payment_declared_amount_for_wallet_recharge(db, req)

    cli = req.client or db.get(Client, req.client_id)
    if cli is not None:
        from app.services.client_currency_service import lock_client_base_currency_on_recharge_create

        cur_lock = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
        lock_client_base_currency_on_recharge_create(db, cli, cur_lock)

    db.commit()
    db.refresh(req)

    pm_ids_flat = [int(x) for x in (req.allowed_payment_methods or [])]

    distributor_email_out = str(cli.email).strip().lower() if cli and cli.email else ""
    cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
    xr = float(getattr(req, "recharge_exchange_rate", None) or 1.0)
    precheck = (getattr(req, "admin_precheck_receipt_url", None) or "").strip()[:2048] or None
    lines_snap = getattr(req, "recharge_detail_lines", None)
    snap_list = lines_snap if isinstance(lines_snap, list) else []

    try:
        if distributor_email_out and pm_ids_flat:
            payload_render = {
                "id_erp": str(req.id),
                "correo": distributor_email_out,
                "monto": float(req.amount_requested),
                "monto_total": float(req.amount_requested),
                "line_items": snap_list,
                "articulos": snap_list,
                "declared_deposit_usd": (
                    float(xdd)
                    if (xdd := getattr(req, "declared_deposit_usd", None)) is not None
                    else None
                ),
                "metodos": pm_ids_flat,
                "moneda": cur,
                "tasa": xr,
                "comprobante_admin": precheck,
                "portal_path": f"/portal/{cli.payment_token}" if cli and getattr(cli, "payment_token", None) else "",
                "creation_note": _stored_admin_note(req),
            }
            requests.post(
                "https://catalogo-vip.onrender.com/api/webhook/nueva-recarga",
                json=payload_render,
                headers={
                    "X-Webhook-Secret": render_sync.VIP_CATALOG_WEBHOOK_SECRET,
                    "Content-Type": "application/json",
                },
                timeout=8,
            )
    except Exception as e:
        print(f"[patch-recharge] webhook Render opcional falló: {e}")

    return _row_wallet_recharge_admin(db, req)


@router.patch("/recharge-requests/{request_id}/note", response_model=WalletRechargeRequestAdminRow)
def patch_wallet_recharge_request_note(
    request_id: int,
    payload: WalletRechargeRequestAdminNoteUpdate,
    db: DbDep,
    _: BaasRechargeEditDep,
) -> WalletRechargeRequestAdminRow:
    """Nota administrativa (columna NOTA). Vacío borra y vuelven las sugerencias automáticas."""
    req = (
        db.query(WalletRechargeRequest)
        .options(joinedload(WalletRechargeRequest.client))
        .filter(WalletRechargeRequest.id == int(request_id))
        .first()
    )
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Solicitud no encontrada.")
    from app.wallet_recharge_helpers import REQ_STATUS_IN_REVIEW as _WR_IN_REVIEW, wallet_recharge_editable_by_admin

    if req.status != _WR_IN_REVIEW and not wallet_recharge_editable_by_admin(req):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Solo se pueden anotar solicitudes pendientes, en revisión o activadas con saldo CxC pendiente.",
        )
    s = str(payload.note).strip()[:2048]
    req.admin_note = s if s else None
    db.commit()
    db.refresh(req)
    return _row_wallet_recharge_admin(db, req)


def _remote_row_request_id_for_sync(row: dict) -> Optional[int]:
    """ID de solicitud local (ERP); Render puede enviarlo como ``id_erp`` o alias, en string o int."""
    for key in ("id_erp", "request_id", "recharge_id", "solicitud_id", "wallet_recharge_id", "id"):
        raw = row.get(key)
        if raw is None:
            continue
        try:
            return int(str(raw).strip())
        except (TypeError, ValueError):
            continue
    return None


@router.get("/sync-recharges", response_model=WalletBridgeSyncResponse)
def sync_wallet_recharges_from_vip_catalog(db: DbDep, _: BaasRechargeEditDep) -> WalletBridgeSyncResponse:
    """
    Trae desde el portal en Render las recargas pendientes de conciliar y actualiza ``receipt_url`` + estado ``in_review``.
    """
    print("Iniciando sincronización con Render...")
    rows: list = []
    try:
        response = requests.get(
            "https://catalogo-vip.onrender.com/api/webhook/recargas-en-revision",
            headers={
                "X-Webhook-Secret": render_sync.VIP_CATALOG_WEBHOOK_SECRET,
                "Content-Type": "application/json",
            },
            timeout=60,
        )

        if response.status_code != 200:
            print(f"Render devolvió error HTTP: {response.status_code} - {response.text[:2000]}")
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Error de comunicación con la nube")

        try:
            recargas_web = response.json()
        except ValueError as je:
            print(f"Respuesta de Render no es JSON válido: {je}")
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Respuesta de la nube no es JSON válido.",
            ) from je

        # Log detallado (puede ser voluminoso si hay muchas filas).
        body_str = str(recargas_web)
        preview = repr(recargas_web) if len(body_str) < 4000 else f"{type(recargas_web).__name__} len≈{len(body_str)} primeros 500c: {body_str[:500]}…"
        print(f"Recargas recibidas de Render: {preview}")

        rows = render_sync.flatten_recarga_payload(recargas_web)
        print(f"Filas normalizadas para procesar: {len(rows)}")
    except requests.exceptions.RequestException as e:
        print(f"Error de red intentando conectar con Render: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="El servidor web (Render) no está respondiendo a tiempo.",
        ) from e
    except HTTPException:
        raise
    except Exception as e:
        print(f"Error interno durante la sincronización (HTTP / parseo): {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error interno al procesar los datos.",
        ) from e

    updated_ids: list[int] = []
    skipped_ids: list[int] = []
    not_found_ids: list[int] = []
    errors: list[str] = []

    try:
        for idx, raw in enumerate(rows):
            if not isinstance(raw, dict):
                errors.append(f"Fila {idx}: formato inválido (se esperaba objeto).")
                continue
            rid = _remote_row_request_id_for_sync(raw)
            if rid is None:
                errors.append(f"Fila {idx}: no se pudo resolver el ID de solicitud (id_erp / request_id / …).")
                continue
            rec_url = render_sync.remote_row_receipt_url(raw)
            req = db.get(WalletRechargeRequest, rid)
            if req is None:
                not_found_ids.append(rid)
                continue
            from app.wallet_recharge_helpers import REQ_STATUS_IN_REVIEW as _WR_IN_REVIEW, wallet_recharge_accepts_client_receipt

            if req.status != _WR_IN_REVIEW and not wallet_recharge_accepts_client_receipt(req):
                skipped_ids.append(rid)
                continue
            if not rec_url or not str(rec_url).strip():
                skipped_ids.append(rid)
                errors.append(f"Solicitud #{rid}: falta receipt_url en la respuesta del portal.")
                continue
            req.receipt_url = str(rec_url).strip()
            req.status = REQ_STATUS_IN_REVIEW
            updated_ids.append(rid)

        db.commit()
        for rid in updated_ids:
            r = db.get(WalletRechargeRequest, rid)
            if r is not None:
                db.refresh(r)
        print(f"Sincronización completada: actualizadas={len(updated_ids)}, omitidas={len(skipped_ids)}, no_encontradas={len(not_found_ids)}")
    except Exception as e:
        db.rollback()
        print(f"Error interno durante la sincronización (DB): {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error interno al procesar los datos.",
        ) from e

    return WalletBridgeSyncResponse(
        updated_ids=sorted(set(updated_ids)),
        skipped_ids=sorted(set(skipped_ids)),
        not_found_ids=sorted(set(not_found_ids)),
        errors=errors,
    )


@router.post("/approve-recharge/{request_id}", response_model=ApproveWalletRechargeResponse)
def approve_wallet_recharge(
    request_id: int,
    db: DbDep,
    _: BaasRechargeApproveDep,
    background_tasks: BackgroundTasks,
    body: Annotated[Optional[ApproveWalletRechargePayload], Body()] = None,
) -> ApproveWalletRechargeResponse:
    """Acreditación contra billetera como estado de cuenta: abono parcial, cierre total o excedente a saldo a favor."""
    EPS = 1e-6
    req = db.get(WalletRechargeRequest, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Solicitud no encontrada.")
    if req.status != REQ_STATUS_IN_REVIEW:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Aprueba sólo cuando hay un comprobante en revisión (incluye abonos adicionales tras un pago parcial).",
        )

    from app.services.client_payment_service import assert_wallet_recharge_has_approvable_declared_amount

    assert_wallet_recharge_has_approvable_declared_amount(db, req)

    client = db.get(Client, req.client_id)
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente de la solicitud no encontrado.")

    notify_email = str(client.email or "").strip()
    if not notify_email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El cliente no tiene correo en el CRM; Render requiere «correo» para registrar el saldo en el portal.",
        )

    pending_before = float(getattr(req, "balance_pending", 0) or 0)
    if pending_before <= EPS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Esta solicitud no tiene saldo pendiente por reconocer.",
        )

    raw_recv = body.received_amount if body is not None else None
    if raw_recv is None:
        from app.services.client_payment_service import _resolve_wallet_recharge_received_default

        recv = _resolve_wallet_recharge_received_default(req, pending_before)
    else:
        recv = float(raw_recv)

    if not (recv > EPS):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El monto percibido debe ser mayor que cero.",
        )

    try:
        tx, _cp, applied, _surplus, wallet_delivered = finalize_wallet_recharge_payment_approval(
            db,
            req,
            client,
            recv,
            wallet_tx_type=TX_RECHARGE,
            strict_accounting=True,
        )
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        logger.exception("Error al aprobar recarga id=%s", request_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error interno al aprobar la recarga y registrar el asiento contable.",
        ) from e

    db.refresh(req)
    db.refresh(client)
    db.refresh(tx)

    print(
        f"[approve-recharge] sumar-saldo Render: correo={notify_email!r} percibido={recv!r} "
        f"solicitud #{req.id} estado={req.status!r}"
    )
    background_tasks.add_task(render_sync.notify_sumar_saldo_billetera, notify_email, wallet_delivered)

    return ApproveWalletRechargeResponse(
        request=WalletRechargeRequestRead.model_validate(req),
        client=ClientWalletBrief.model_validate(client),
        transaction=WalletTransactionRead.model_validate(tx),
    )


@router.post("/reject-recharge/{request_id}", response_model=WalletRechargeRequestRead)
def reject_wallet_recharge(request_id: int, db: DbDep, _: BaasRechargeEditDep) -> WalletRechargeRequest:
    """Rechaza una solicitud en revisión; devuelve saldo a favor reservado si aplica."""
    req = db.get(WalletRechargeRequest, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Solicitud no encontrada.")
    if req.status != REQ_STATUS_IN_REVIEW:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Solo se pueden rechazar solicitudes en revisión.",
        )

    from app.services.client_payment_service import void_client_payment
    from app.services.wallet_recharge_client_payment import find_pending_client_payment_for_wallet_recharge

    pending_cp = find_pending_client_payment_for_wallet_recharge(db, req)
    if pending_cp is not None:
        void_client_payment(
            db,
            pending_cp,
            reason=f"Rechazo solicitud recarga #{int(req.id)}",
        )

    req.status = REQ_STATUS_REJECTED
    db.commit()
    db.refresh(req)
    return req


@router.post("/cancel-recharge/{request_id}", response_model=WalletRechargeRequestRead)
def cancel_wallet_recharge_request(request_id: int, db: DbDep, _: BaasRechargeEditDep) -> WalletRechargeRequest:
    """Cancela una solicitud en estado pendiente (sin comprobante todavía)."""
    req = db.get(WalletRechargeRequest, request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Solicitud no encontrada.")
    if req.status != REQ_STATUS_PENDING:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Solo se pueden cancelar solicitudes pendientes sin comprobante.",
        )

    req.status = REQ_STATUS_CANCELED
    db.commit()
    db.refresh(req)
    return req


@router.get("/screen-catalog-products", response_model=list[FlujoPackageForPricing])
def list_screen_catalog_products_for_admin_pricing(
    db: DbDep,
    _: BaasDistributorsViewDep,
) -> list[FlujoPackageForPricing]:
    """Catálogo global de paquetes «crédito por pantalla» activos (costo base y stock libre)."""
    return list_screen_catalog_products_for_pricing(db)


@router.post("/generate-recharge-link", response_model=GenerateRechargeLinkResponse)
def generate_wallet_recharge_link(
    payload: GenerateRechargeLinkPayload,
    db: DbDep,
    _: BaasRechargeCreateDep,
) -> GenerateRechargeLinkResponse:
    """Crea una solicitud en estado pending (sin recibo) con métodos permitidos y devuelve la ruta del portal público."""
    try:
        client = _get_or_create_client_by_distributor_email(db, str(payload.distributor_email))

        pm_rows = _validate_payment_method_ids(db, payload.allowed_payment_methods)
        matched, _mid = _matched_accounts_for_payment_methods(db, pm_rows)
        deposit_norm = _validate_deposit_subset(payload.allowed_deposit_account_ids, matched)

        pm_sorted = sorted(pm_rows, key=lambda x: x.id)
        cur = normalize_currency_code(payload.currency, "USD")
        xr = float(payload.exchange_rate)
        precheck_raw = (payload.admin_precheck_receipt_url or "").strip()
        precheck = precheck_raw[:2048] if precheck_raw else None

        li_payload = payload.line_items
        if li_payload:
            aq = round(sum(x.line_charge_amount() for x in li_payload), 2)
            lines_json = []
            for x in li_payload:
                try:
                    lines_json.append(x.model_dump(mode="json"))
                except Exception as dumpe:
                    raise ValueError(
                        "No se pudo serializar las líneas de recarga para almacenar en BD.",
                    ) from dumpe
        else:
            aq = round(float(payload.amount), 2)
            lines_json = None

        dep_raw = payload.deposit_amount_usd
        dep_usd: Optional[float] = None
        if dep_raw is not None:
            try:
                dep_usd_f = float(dep_raw)
            except (TypeError, ValueError):
                dep_usd_f = float("nan")
            if dep_usd_f == dep_usd_f and dep_usd_f >= 0 and dep_usd_f > 1e-9:
                dep_usd = dep_usd_f

        portal_declared: Optional[float] = None
        if dep_usd is not None and dep_usd > 1e-9:
            portal_declared = round(dep_usd * xr, 2)

        creation_note_trim = _trim_wallet_creation_note(payload.creation_note)

        req = WalletRechargeRequest(
            client_id=client.id,
            amount_requested=aq,
            receipt_url=None,
            status=REQ_STATUS_PENDING,
            allowed_payment_methods=[pm.id for pm in pm_sorted],
            allowed_deposit_account_ids=deposit_norm,
            link_hash=None,
            recharge_currency=cur,
            recharge_exchange_rate=xr,
            admin_precheck_receipt_url=precheck,
            amount_paid=0.0,
            balance_pending=aq,
            surplus_credited=0.0,
            admin_note=creation_note_trim,
            recharge_detail_lines=lines_json,
            declared_deposit_usd=dep_usd,
            portal_declared_payment_amount=portal_declared,
        )
        db.add(req)
        db.flush()

        from app.services.client_currency_service import lock_client_base_currency_on_recharge_create
        from app.services.client_payment_service import try_sweep_client_credit_on_new_cxc

        lock_client_base_currency_on_recharge_create(db, client, cur)
        try_sweep_client_credit_on_new_cxc(db, client, currency=cur, strict_accounting=False)

        price_items = getattr(payload, "client_product_prices", None) or []
        if price_items:
            upsert_client_product_prices(
                db,
                client_id=int(client.id),
                items=price_items,
                default_price_currency=cur,
            )

        credit_raw = getattr(payload, "credit_applied_amount", None)
        if credit_raw is not None:
            try:
                credit_f = float(credit_raw)
            except (TypeError, ValueError):
                credit_f = 0.0
            if credit_f > 1e-9:
                cur_note = normalize_currency_code(cur, "USD")
                intent_line = f"INTENDED_CREDIT={credit_f:.2f} {cur_note}"
                base_note = _trim_wallet_creation_note(getattr(payload, "creation_note", None))
                req.admin_note = f"{base_note}\n{intent_line}".strip() if base_note else intent_line

        db.commit()
        db.refresh(req)
        db.refresh(client)

        ptok = getattr(client, "payment_token", None)
        if ptok is None:
            raise ValueError(
                "El cliente no tiene token de portal (payment_token). Revisa migraciones o la fila en «clients».",
            )
        token_out = str(ptok)
        portal_path_out = f"/portal/{token_out}"

        pm_ids_flat = [int(x) for x in (req.allowed_payment_methods or [])]
        distributor_email_out = str(client.email or "").strip()

        try:
            payload_render = {
                "id_erp": str(req.id),
                "correo": distributor_email_out,
                "monto": float(req.amount_requested),
                "monto_total": float(req.amount_requested),
                "line_items": lines_json or [],
                "articulos": lines_json or [],
                "declared_deposit_usd": dep_usd,
                "metodos": pm_ids_flat,
                "moneda": cur,
                "tasa": xr,
                "comprobante_admin": precheck,
                "portal_path": portal_path_out,
                "creation_note": creation_note_trim,
            }
            requests.post(
                "https://catalogo-vip.onrender.com/api/webhook/nueva-recarga",
                json=payload_render,
                headers={
                    "X-Webhook-Secret": render_sync.VIP_CATALOG_WEBHOOK_SECRET,
                    "Content-Type": "application/json",
                },
                timeout=5,
            )
        except Exception as e_wh:
            print(f"[generate-recharge-link] webhook externo opcional omitido: {e_wh}")

        print(
            f"[generate-recharge-link] ok id={req.id} monto={req.amount_requested} "
            f"moneda={cur} tasa={xr} correo={distributor_email_out}"
        )
        return GenerateRechargeLinkResponse(
            request_id=req.id,
            client_payment_token=token_out,
            link_hash=None,
            portal_path=portal_path_out,
            amount_requested=float(req.amount_requested),
            allowed_payment_methods=[int(x) for x in (req.allowed_payment_methods or [])],
            currency=cur,
            exchange_rate=xr,
        )
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as e_int:
        db.rollback()
        logger.exception("Error de integridad SQL creando solicitud de recarga: %s", e_int)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"No se pudo guardar la solicitud (violación en base de datos). Indicio: {e_int}",
        ) from e_int
    except Exception as e:
        db.rollback()
        print(f"Error creando recarga (generate-recharge-link): {e}")
        logger.exception("Error creando solicitud de recarga (generate-recharge-link)")
        hint = str(e).strip() or repr(e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Error creando recarga: {hint}",
        ) from e


@router.get("/recharge-public/{link_hash}", response_model=WalletRechargePublicDetail)
def get_wallet_recharge_public(link_hash: str, db: DbDep) -> WalletRechargePublicDetail:
    """Detalle público del enlace de recarga (sin autenticación)."""
    h = (link_hash or "").strip()
    if not h:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Enlace no válido.")
    req = (
        db.query(WalletRechargeRequest)
        .options(joinedload(WalletRechargeRequest.client))
        .filter(WalletRechargeRequest.link_hash == h)
        .first()
    )
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Enlace no encontrado.")
    return _build_wallet_recharge_public_detail(db, req)


@router.post("/recharge-public/{link_hash}/submit-receipt", response_model=WalletRechargeRequestRead)
async def submit_wallet_recharge_public_receipt(
    link_hash: str,
    db: DbDep,
    file: UploadFile = File(...),
) -> WalletRechargeRequest:
    """El distribuidor sube el comprobante; la solicitud pasa a «en revisión»."""
    h = (link_hash or "").strip()
    req = db.query(WalletRechargeRequest).filter(WalletRechargeRequest.link_hash == h).first()
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Enlace no encontrado.")
    if req.status != REQ_STATUS_PENDING:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Esta solicitud ya no admite comprobantes.",
        )

    receipt_url = await _persist_receipt_upload(file)
    req.receipt_url = receipt_url
    req.status = REQ_STATUS_IN_REVIEW
    db.commit()
    db.refresh(req)
    return req
