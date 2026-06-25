from __future__ import annotations

import uuid
from datetime import date, datetime, time, timezone
from decimal import Decimal
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.api.v1.dependencies import require_permission, UserDep
from app.permissions import (
    ACCOUNTING_CHART_CREATE,
    ACCOUNTING_CHART_EDIT,
    ACCOUNTING_CHART_VIEW,
    ACCOUNTING_RECONCILE_EDIT,
)
from app.currency_utils import normalize_currency_code
from app.database import get_db
from app.account_constants import is_liquid_deposit_account
from app.account_structure import validate_linked_payment_method_name
from app.models.account import Account
from app.models.client_payment import ClientPayment
from app.models.journal_entry import JournalEntry, JournalEntryLine, JournalReferenceType
from app.models.sale import Sale
from app.services.accounting_engine import TRANSFER_REFERENCE_TYPE, post_account_transfer
from app.timezone_utils import datetime_at_ecuador_midnight
from app.schemas.chart_accounts import (
    AccountHistoryEntry,
    AccountHistoryResponse,
    AccountTransferCreate,
    AccountTransferResponse,
    ChartAccountCreate,
    ChartAccountResponse,
    ChartAccountUpdate,
    DepositAccountOption,
    LedgerDisplayMode,
)

router = APIRouter(prefix="/accounts", tags=["accounts"])

DbDep = Annotated[Session, Depends(get_db)]
ChartViewDep = Annotated[dict, Depends(require_permission(ACCOUNTING_CHART_VIEW))]
ChartCreateDep = Annotated[dict, Depends(require_permission(ACCOUNTING_CHART_CREATE))]
ChartEditDep = Annotated[dict, Depends(require_permission(ACCOUNTING_CHART_EDIT))]
ReconcileEditDep = Annotated[dict, Depends(require_permission(ACCOUNTING_RECONCILE_EDIT))]


def _amount_to_decimal(value: Optional[object]) -> Decimal:
    """Normaliza importes desde API (Decimal, float, int, str con coma/punto)."""
    if value is None:
        return Decimal("0")
    if isinstance(value, Decimal):
        return value
    s = str(value).strip().replace(" ", "").replace("\u00a0", "")
    if s == "":
        return Decimal("0")
    s = s.replace(",", ".")
    return Decimal(s)


def _effective_opening(acc: Account) -> Decimal:
    if acc.opening_balance is None:
        return Decimal("0")
    return Decimal(str(acc.opening_balance))


def _sync_current_balance_from_opening_and_journal(db: Session, acc: Account) -> None:
    """current_balance = saldo de apertura + movimientos del libro mayor (journal_entry_lines)."""
    ob = _effective_opening(acc)
    journal_net = _journal_balances(db).get(acc.id, Decimal("0"))
    acc.current_balance = ob + journal_net
    acc.balance = acc.current_balance


def refresh_accounts_balance_cache(db: Session, account_ids: set[int]) -> None:
    """
    Recalcula ``current_balance`` / ``balance`` desde apertura + líneas del libro mayor.

    Usado tras asientos automáticos para que el plan de cuentas refleje movimientos
    sin depender de un PATCH manual de la cuenta.
    """
    if not account_ids:
        return
    bal_map = _journal_balances(db)
    for aid in account_ids:
        acc = db.get(Account, aid)
        if acc is None:
            continue
        ob = _effective_opening(acc)
        journal_net = bal_map.get(acc.id, Decimal("0"))
        acc.current_balance = ob + journal_net
        acc.balance = acc.current_balance


def _journal_balances(db: Session) -> dict[int, Decimal]:
    """Suma neta débito − crédito por cuenta desde ``journal_entry_lines``."""
    rows = (
        db.query(
            JournalEntryLine.account_id,
            func.coalesce(func.sum(JournalEntryLine.debit - JournalEntryLine.credit), 0),
        )
        .group_by(JournalEntryLine.account_id)
        .all()
    )
    return {int(aid): Decimal(str(bal or 0)) for aid, bal in rows}


def _descendant_account_ids(db: Session, root_id: int) -> set[int]:
    found: set[int] = set()
    frontier = [root_id]
    while frontier:
        pid = frontier.pop()
        for (cid,) in db.query(Account.id).filter(Account.parent_id == pid).all():
            if cid not in found:
                found.add(cid)
                frontier.append(cid)
    return found


def _validate_parent_for_account(db: Session, account_id: int, parent_id: Optional[int]) -> None:
    if parent_id is None:
        return
    if parent_id == account_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cuenta no puede ser padre de sí misma.",
        )
    parent = db.get(Account, parent_id)
    if parent is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="La cuenta padre no existe.",
        )
    if parent_id in _descendant_account_ids(db, account_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No puedes asignar una subcuenta como cuenta padre.",
        )


def _require_parent_currency_match(parent: Optional[Account], currency: str) -> None:
    """Subcuenta: misma moneda que el padre."""
    if parent is None:
        return
    pc = (parent.currency or "USD").strip().upper()
    cc = (currency or "USD").strip().upper()
    if pc != cc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La moneda de la subcuenta debe coincidir con la de la cuenta padre.",
        )


def _sale_amount_paid_local(sale: Sale) -> Decimal:
    """Abono registrado en moneda de cobro de la venta (fallback: total local si falta dato)."""
    ap = getattr(sale, "amount_paid", None)
    if ap is not None:
        return Decimal(str(ap))
    if sale.local_amount is not None:
        return Decimal(str(sale.local_amount))
    return Decimal("0")


def _journal_reference_label(entry: JournalEntry) -> str:
    ref_type = (entry.reference_type or "").strip()
    ref_id = entry.reference_id
    if ref_type == JournalReferenceType.venta.value and ref_id is not None:
        return f"{int(ref_id):04d}"
    if ref_type == TRANSFER_REFERENCE_TYPE:
        desc = (entry.description or "").strip()
        if desc.startswith("TRX-"):
            return desc.split(" | ", 1)[0].strip() or desc.split(" ", 1)[0].strip()
        return f"TRX-JE-{entry.id}"
    if ref_type and ref_id is not None:
        return f"{ref_type}#{ref_id}"
    if ref_type:
        return ref_type
    return f"JE-{int(entry.id):06d}"


def _journal_line_kind(acc: Account, signed: Decimal, ref_type: str) -> str:
    rt = (ref_type or "").strip().lower()
    if rt == TRANSFER_REFERENCE_TYPE:
        return "Transferencia"
    if rt in (JournalReferenceType.venta.value, JournalReferenceType.recarga.value):
        return _auto_sale_line_kind(acc, signed)
    if rt == JournalReferenceType.gasto.value:
        return "Gasto"
    if rt == JournalReferenceType.vendor_bill.value:
        return "Factura proveedor"
    if rt == JournalReferenceType.client_payment.value:
        return "Cobro cliente"
    if rt == JournalReferenceType.vendor_payment.value:
        return "Pago proveedor"
    if rt == JournalReferenceType.ajuste_fx.value:
        return "Ajuste FX"
    return rt.title() if rt else "Asiento"


def _peer_account_for_journal_line(
    line: JournalEntryLine,
    entry_lines: list[JournalEntryLine],
    accounts_by_id: dict[int, Account],
) -> Optional[Account]:
    for other in entry_lines:
        if other.id == line.id:
            continue
        if other.account_id != line.account_id:
            peer = accounts_by_id.get(int(other.account_id))
            if peer is not None:
                return peer
    return None


def _history_line_from_journal_line(
    line: JournalEntryLine,
    entry: JournalEntry,
    line_account: Account,
    *,
    peer: Optional[Account],
    sale: Optional[Sale],
    client_payment: Optional[ClientPayment] = None,
    cur_code: str,
    running_balance: Decimal,
) -> AccountHistoryEntry:
    dr = Decimal(str(line.debit)).quantize(Decimal("0.0001"))
    cr = Decimal(str(line.credit)).quantize(Decimal("0.0001"))
    signed = (dr - cr).quantize(Decimal("0.0001"))
    charge = dr if dr > 0 else None
    pay_mag = cr if cr > 0 else None
    mo = (dr if dr > 0 else cr).copy_abs().quantize(Decimal("0.0001"))
    cur_up = (cur_code or "USD").strip().upper()
    ref_type = (entry.reference_type or "").strip()
    ref = _journal_reference_label(entry)
    desc_raw = (entry.description or "").strip()
    peer_name = peer.name if peer is not None else None
    line_kind = _journal_line_kind(line_account, signed, ref_type)

    if ref_type == TRANSFER_REFERENCE_TYPE:
        peer_nm = peer_name or "—"
        label = f"Transferencia → {peer_nm}" if signed < 0 else f"Transferencia desde {peer_nm}"
        user_notes = _transfer_user_notes_from_description(entry.description)
        return AccountHistoryEntry(
            sale_id=None,
            ledger_transaction_id=line.id,
            occurred_at=datetime_at_ecuador_midnight(entry.date),
            reference_number=ref,
            reference=ref,
            client_id=None,
            client_name=label,
            notes=user_notes,
            balance_effect=signed,
            charge_amount=charge,
            payment_amount=pay_mag,
            line_kind=line_kind,
            deposit=charge,
            payment=pay_mag,
            deposit_account_id=line.account_id,
            amount_paid=None,
            amount_currency=cur_up,
            transaction_currency=cur_up,
            exchange_rate=float(line.exchange_rate or 1),
            local_amount=mo,
            amount_usd=mo if cur_up == "USD" else Decimal("0"),
            status="posted",
            running_balance=running_balance,
            iptv_username=None,
            receipt_url=None,
            transaction_reason="Transferencia entre cuentas",
        )

    if ref_type == JournalReferenceType.venta.value and entry.reference_id is not None:
        cli = sale.client if sale is not None else None
        client_name = cli.display_name() if cli is not None else (desc_raw[:80] or peer_name or "—")
        notes_val = sale.notes if sale is not None else None
        receipt_url = sale.receipt_url if sale is not None else None
        u = (cli.username or "").strip() if cli is not None else ""
        iptv_u = u if u else None
        cid = sale.client_id if sale is not None else None
        er = float(sale.exchange_rate or 1.0) if sale is not None else float(line.exchange_rate or 1)
        tc = (sale.currency or "USD").strip().upper() if sale is not None else cur_up
        la = sale.local_amount if sale is not None else None
        ap = _sale_amount_paid_local(sale) if sale is not None else None
        dep_acc_id = sale.deposit_account_id if sale is not None else line.account_id
        st = sale.status.value if sale is not None else "posted"
        amt_usd = Decimal(str(sale.amount)) if sale is not None else (mo if cur_up == "USD" else Decimal("0"))
        return AccountHistoryEntry(
            sale_id=int(entry.reference_id),
            ledger_transaction_id=line.id,
            occurred_at=datetime_at_ecuador_midnight(entry.date),
            reference_number=ref,
            reference=ref,
            client_id=cid,
            client_name=client_name,
            notes=notes_val or (desc_raw if desc_raw else None),
            balance_effect=signed,
            charge_amount=charge,
            payment_amount=pay_mag,
            line_kind=line_kind,
            deposit=charge,
            payment=pay_mag,
            deposit_account_id=dep_acc_id,
            amount_paid=ap,
            amount_currency=cur_up,
            transaction_currency=tc,
            exchange_rate=er,
            local_amount=la,
            amount_usd=amt_usd,
            status=st,
            running_balance=running_balance,
            iptv_username=iptv_u,
            receipt_url=receipt_url,
            transaction_reason=line_kind,
        )

    if ref_type == JournalReferenceType.client_payment.value and entry.reference_id is not None:
        cp_receipt = (
            str(client_payment.receipt_file_url or "").strip()
            if client_payment is not None and client_payment.receipt_file_url
            else None
        )
        memo = desc_raw[:500] if desc_raw else None
        label = desc_raw[:120] if desc_raw else (peer_name or line_kind)
        cid = int(client_payment.client_id) if client_payment is not None else None
        return AccountHistoryEntry(
            sale_id=None,
            ledger_transaction_id=line.id,
            occurred_at=datetime_at_ecuador_midnight(entry.date),
            reference_number=ref,
            reference=ref,
            client_id=cid,
            client_name=label,
            notes=memo,
            balance_effect=signed,
            charge_amount=charge,
            payment_amount=pay_mag,
            line_kind=line_kind,
            deposit=charge,
            payment=pay_mag,
            deposit_account_id=line.account_id,
            amount_paid=float(client_payment.amount) if client_payment is not None else None,
            amount_currency=cur_up,
            transaction_currency=(
                str(client_payment.currency or cur_up).strip().upper()[:10]
                if client_payment is not None
                else cur_up
            ),
            exchange_rate=float(client_payment.exchange_rate or 1.0) if client_payment is not None else float(line.exchange_rate or 1),
            local_amount=mo,
            amount_usd=mo if cur_up == "USD" else Decimal("0"),
            status="posted",
            running_balance=running_balance,
            iptv_username=None,
            receipt_url=cp_receipt,
            transaction_reason=line_kind,
        )

    memo = desc_raw[:500] if desc_raw else None
    label = desc_raw[:120] if desc_raw else (peer_name or line_kind)
    return AccountHistoryEntry(
        sale_id=None,
        ledger_transaction_id=line.id,
        occurred_at=datetime_at_ecuador_midnight(entry.date),
        reference_number=ref,
        reference=ref,
        client_id=None,
        client_name=label,
        notes=memo,
        balance_effect=signed,
        charge_amount=charge,
        payment_amount=pay_mag,
        line_kind=line_kind,
        deposit=charge,
        payment=pay_mag,
        deposit_account_id=line.account_id,
        amount_paid=None,
        amount_currency=cur_up,
        transaction_currency=cur_up,
        exchange_rate=float(line.exchange_rate or 1),
        local_amount=mo,
        amount_usd=mo if cur_up == "USD" else Decimal("0"),
        status="posted",
        running_balance=running_balance,
        iptv_username=None,
        receipt_url=None,
        transaction_reason=label,
    )


def _build_account_journal_ledger(
    db: Session,
    account_id: int,
    *,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
) -> AccountHistoryResponse:
    """Libro mayor de una cuenta desde ``journal_entry_lines`` (incluye subcuentas)."""
    acc = db.get(Account, account_id)
    if acc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta no encontrada.")

    account_scope_ids = {account_id} | _descendant_account_ids(db, account_id)

    q = (
        db.query(JournalEntryLine)
        .join(JournalEntry, JournalEntry.id == JournalEntryLine.journal_entry_id)
        .filter(JournalEntryLine.account_id.in_(account_scope_ids))
    )
    if acc.opening_balance_date:
        q = q.filter(JournalEntry.date >= acc.opening_balance_date)
    if date_from is not None:
        q = q.filter(JournalEntry.date >= date_from)
    if date_to is not None:
        q = q.filter(JournalEntry.date <= date_to)

    line_rows = q.order_by(
        JournalEntry.date.asc(),
        JournalEntry.id.asc(),
        JournalEntryLine.id.asc(),
    ).all()

    entry_ids = {int(l.journal_entry_id) for l in line_rows}
    entries: dict[int, JournalEntry] = {}
    if entry_ids:
        for entry in db.query(JournalEntry).filter(JournalEntry.id.in_(entry_ids)).all():
            entries[int(entry.id)] = entry

    lines_by_entry: dict[int, list[JournalEntryLine]] = {}
    if entry_ids:
        for el in db.query(JournalEntryLine).filter(JournalEntryLine.journal_entry_id.in_(entry_ids)).all():
            lines_by_entry.setdefault(int(el.journal_entry_id), []).append(el)

    sale_ids = {
        int(e.reference_id)
        for e in entries.values()
        if e.reference_type == JournalReferenceType.venta.value and e.reference_id is not None
    }
    sales_by_id: dict[int, Sale] = {}
    if sale_ids:
        rows = (
            db.query(Sale)
            .options(joinedload(Sale.client))
            .filter(Sale.id.in_(sale_ids))
            .all()
        )
        sales_by_id = {int(s.id): s for s in rows}

    payment_ids = {
        int(e.reference_id)
        for e in entries.values()
        if e.reference_type == JournalReferenceType.client_payment.value and e.reference_id is not None
    }
    payments_by_id: dict[int, ClientPayment] = {}
    if payment_ids:
        for prow in db.query(ClientPayment).filter(ClientPayment.id.in_(payment_ids)).all():
            payments_by_id[int(prow.id)] = prow

    account_ids_needed = {l.account_id for l in line_rows}
    for entry_lines in lines_by_entry.values():
        for el in entry_lines:
            account_ids_needed.add(el.account_id)
    acct_by_id: dict[int, Account] = {}
    if account_ids_needed:
        for arow in db.query(Account).filter(Account.id.in_(account_ids_needed)).all():
            acct_by_id[int(arow.id)] = arow

    cur_code = (acc.currency or "USD").strip().upper()
    ob = _effective_opening(acc)
    running = ob
    lines: list[AccountHistoryEntry] = []
    display_mode = _ledger_display_mode_for_account(acc)

    for line in line_rows:
        entry = entries.get(int(line.journal_entry_id))
        if entry is None:
            continue
        line_acc = acct_by_id.get(int(line.account_id), acc)
        peer = _peer_account_for_journal_line(
            line,
            lines_by_entry.get(int(line.journal_entry_id), []),
            acct_by_id,
        )
        sale = (
            sales_by_id.get(int(entry.reference_id))
            if entry.reference_type == JournalReferenceType.venta.value and entry.reference_id is not None
            else None
        )
        client_payment = (
            payments_by_id.get(int(entry.reference_id))
            if entry.reference_type == JournalReferenceType.client_payment.value and entry.reference_id is not None
            else None
        )
        dr = Decimal(str(line.debit)).quantize(Decimal("0.0001"))
        cr = Decimal(str(line.credit)).quantize(Decimal("0.0001"))
        running += dr - cr
        lines.append(
            _history_line_from_journal_line(
                line,
                entry,
                line_acc,
                peer=peer,
                sale=sale,
                client_payment=client_payment,
                cur_code=cur_code,
                running_balance=running,
            ),
        )

    return AccountHistoryResponse(
        account_id=acc.id,
        account_name=acc.name,
        account_type=acc.account_type,
        detail_type=acc.detail_type,
        currency=cur_code,
        ledger_display_mode=display_mode,
        opening_balance=ob,
        closing_balance=running,
        lines=lines,
    )


def _ledger_display_mode_for_account(acc: Account) -> LedgerDisplayMode:
    dt = (acc.detail_type or "").strip().lower()
    if dt in ("cuentas x cobrar", "accounts_receivable"):
        return "ar_register"
    return "cash_register"


def _auto_sale_line_kind(acc: Account, signed: Decimal) -> str:
    dt = (acc.detail_type or "").strip().lower()
    if dt in ("cuentas x cobrar", "accounts_receivable"):
        return "Factura" if signed > 0 else "Pago"
    if is_liquid_deposit_account(acc):
        return "Pago" if signed > 0 else "Retiro"
    if dt == "venta de productos y servicios":
        return "Factura" if signed < 0 else "Ajuste"
    return "Asiento de venta"


def _linked_payment_method_storage(payload: ChartAccountCreate | ChartAccountUpdate) -> Optional[str]:
    """Persiste vínculo a método de pago solo para cuentas de activos (efectivo / equivalentes en UI)."""
    if getattr(payload, "account_type", None) != "asset":
        return None
    link = getattr(payload, "linked_payment_method", None)
    link_s = str(link).strip() if link is not None else ""
    return link_s or None


def _resolve_payment_method_fields(
    db: Session,
    payload: ChartAccountCreate | ChartAccountUpdate,
) -> tuple[Optional[str], Optional[str]]:
    """Valida método de pago en BD y devuelve (linked_payment_method, detail_type) normalizados."""
    link = _linked_payment_method_storage(payload)
    detail_raw = (payload.detail_type or "").strip() or None
    if not link:
        return None, detail_raw
    try:
        canonical = validate_linked_payment_method_name(db, link)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    detail = detail_raw or canonical
    if detail != canonical:
        # UI envía el mismo nombre en ambos campos; priorizamos el catálogo validado.
        detail = canonical
    return canonical, detail


def _truncate_memo255(base: str, notes: Optional[str]) -> str:
    notes_s = (notes or "").strip()
    if not notes_s:
        return base[:255]
    sep = " — "
    room = 255 - len(base) - len(sep)
    if room < 8:
        return base[:255]
    if len(notes_s) <= room:
        joined = base + sep + notes_s
    else:
        joined = base + sep + notes_s[: room - 1] + "…"
    return joined[:255]


def _transfer_user_notes_from_description(desc: Optional[str]) -> Optional[str]:
    d = (desc or "").strip()
    if " — " not in d:
        return None
    tail = d.rsplit(" — ", 1)[-1].strip()
    return tail if tail else None


def _build_response(
    acc: Account,
    balance: Decimal,
    *,
    parent_name: Optional[str] = None,
) -> ChartAccountResponse:
    return ChartAccountResponse(
        id=acc.id,
        code=acc.code,
        name=acc.name,
        account_number=acc.account_number,
        account_type=acc.account_type,
        detail_type=acc.detail_type,
        linked_payment_method=getattr(acc, "linked_payment_method", None),
        description=acc.description,
        parent_id=acc.parent_id,
        parent_name=parent_name,
        currency=acc.currency,
        opening_balance=acc.opening_balance,
        opening_balance_date=acc.opening_balance_date,
        current_balance=acc.current_balance,
        system_balance=balance,
        is_active=acc.is_active,
    )


@router.get("/", response_model=list[ChartAccountResponse])
def list_chart_accounts(
    db: DbDep,
    _: ChartViewDep,
    include_inactive: bool = False,
) -> list[ChartAccountResponse]:
    """Plan de cuentas con saldo según líneas del libro mayor. Incluye ``currency`` por cuenta (autoselección en formularios)."""
    balances = _journal_balances(db)
    q = db.query(Account).order_by(Account.account_type, Account.name)
    if not include_inactive:
        q = q.filter(Account.is_active.is_(True))
    accounts = q.all()
    parents = {a.id: a for a in accounts}
    out: list[ChartAccountResponse] = []
    for a in accounts:
        pname = parents[a.parent_id].name if a.parent_id and a.parent_id in parents else None
        out.append(
            _build_response(a, balances.get(a.id, Decimal("0")), parent_name=pname),
        )
    return out


@router.get("/deposit-options", response_model=list[DepositAccountOption])
def list_deposit_account_options(db: DbDep, _: UserDep) -> list[DepositAccountOption]:
    """
    Cuentas donde puede depositarse cobro líquido (tipo asset + detalle «Efectivo y equivalentes»).
    Incluye ``currency`` (ISO) por cuenta para cascada moneda/tipo de cambio en el frontend.
    """
    rows = (
        db.query(Account)
        .filter(Account.is_active.is_(True))
        .order_by(Account.name)
        .all()
    )
    out: list[DepositAccountOption] = []
    for a in rows:
        if not is_liquid_deposit_account(a):
            continue
        out.append(
            DepositAccountOption(
                id=a.id,
                name=a.name,
                currency=a.currency,
                parent_id=a.parent_id,
                linked_payment_method=getattr(a, "linked_payment_method", None),
            ),
        )
    return out


@router.post("/transfer", response_model=AccountTransferResponse, status_code=status.HTTP_201_CREATED)
def transfer_between_accounts(payload: AccountTransferCreate, db: DbDep, _: ReconcileEditDep) -> AccountTransferResponse:
    """Partida doble: egreso en origen e ingreso en destino, enlazados por referencia TRX-…."""
    src = db.get(Account, payload.source_account_id)
    dst = db.get(Account, payload.destination_account_id)
    if src is None or dst is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Cuenta origen o destino no encontrada.",
        )
    if not src.is_active or not dst.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ambas cuentas deben estar activas.",
        )
    if not is_liquid_deposit_account(src) or not is_liquid_deposit_account(dst):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Solo se pueden transferir fondos entre cuentas líquidas (efectivo y equivalentes).",
        )
    sc = normalize_currency_code(src.currency)
    dc = normalize_currency_code(dst.currency)

    amount_q = Decimal(str(payload.amount)).quantize(Decimal("0.0001"))
    if amount_q <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El monto debe ser mayor que cero.")

    if sc != dc:
        if payload.exchange_rate is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Indica tipo de cambio (unidades destino por 1 unidad origen) para transferencias en distinta moneda.",
            )
        xr = Decimal(str(payload.exchange_rate)).quantize(Decimal("0.000001"))
        if xr <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Tipo de cambio inválido.",
            )
        amount_dst = (amount_q * xr).quantize(Decimal("0.0001"))
        if amount_dst <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El importe equivalente destino debe ser mayor que cero.",
            )
    else:
        xr = Decimal("1")
        amount_dst = amount_q

    trx_ref = f"TRX-{uuid.uuid4().hex[:12].upper()}"
    desc = _truncate_memo255(f"{trx_ref} | Transferencia hacia {dst.name}", payload.notes)

    entry, src_line, dst_line = post_account_transfer(
        db,
        source_account_id=src.id,
        destination_account_id=dst.id,
        amount_src=amount_q,
        amount_dst=amount_dst,
        exchange_rate=xr,
        transfer_date=payload.date,
        description=desc,
    )

    _sync_current_balance_from_opening_and_journal(db, src)
    _sync_current_balance_from_opening_and_journal(db, dst)
    db.commit()
    db.refresh(entry)
    db.refresh(src_line)
    db.refresh(dst_line)

    return AccountTransferResponse(
        transfer_reference=trx_ref,
        journal_entry_id=entry.id,
        source_journal_line_id=src_line.id,
        destination_journal_line_id=dst_line.id,
        source_transaction_id=src_line.id,
        destination_transaction_id=dst_line.id,
    )


@router.get("/{account_id}/ledger", response_model=AccountHistoryResponse)
def get_account_ledger(
    account_id: int,
    db: DbDep,
    _: ChartViewDep,
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
) -> AccountHistoryResponse:
    """
    Libro mayor de la cuenta desde ``journal_entry_lines`` (fecha, descripción, débito, crédito, saldo).
    """
    return _build_account_journal_ledger(db, account_id, date_from=date_from, date_to=date_to)


@router.get("/{account_id}/history", response_model=AccountHistoryResponse)
def get_account_history(
    account_id: int,
    db: DbDep,
    _: ChartViewDep,
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
) -> AccountHistoryResponse:
    """Alias de ``/ledger`` (libro mayor desde journal entries)."""
    return _build_account_journal_ledger(db, account_id, date_from=date_from, date_to=date_to)


@router.post("/", response_model=ChartAccountResponse, status_code=status.HTTP_201_CREATED)
def create_chart_account(payload: ChartAccountCreate, db: DbDep, _: ChartCreateDep) -> ChartAccountResponse:
    """Crea una cuenta en el plan."""
    code = f"ACC-{uuid.uuid4().hex[:12]}"

    parent: Optional[Account] = None
    if payload.parent_id is not None:
        parent = db.get(Account, payload.parent_id)
        if parent is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="La cuenta padre no existe.",
            )
        _require_parent_currency_match(parent, payload.currency)

    opening = payload.opening_balance
    ob_date = payload.opening_balance_date
    if opening is not None:
        ob_dec = _amount_to_decimal(opening)
        opening_balance_val: Optional[Decimal] = ob_dec
    else:
        ob_dec = Decimal("0")
        opening_balance_val = None

    linked_pm, detail_type = _resolve_payment_method_fields(db, payload)

    acc = Account(
        code=code,
        name=payload.name.strip(),
        account_number=(payload.account_number or "").strip() or None,
        account_type=payload.account_type,
        detail_type=detail_type,
        linked_payment_method=linked_pm,
        description=(payload.description or "").strip() or None,
        parent_id=payload.parent_id,
        currency=payload.currency,
        opening_balance=opening_balance_val,
        opening_balance_date=ob_date if opening is not None else None,
        current_balance=ob_dec,
        balance=ob_dec,
        is_active=True,
    )
    db.add(acc)
    db.commit()
    db.refresh(acc)

    _sync_current_balance_from_opening_and_journal(db, acc)
    db.commit()
    db.refresh(acc)

    bal = _journal_balances(db).get(acc.id, Decimal("0"))
    return _build_response(acc, bal, parent_name=parent.name if parent else None)


@router.patch("/{account_id}/deactivate", response_model=ChartAccountResponse)
def deactivate_chart_account(account_id: int, db: DbDep, _: ChartEditDep) -> ChartAccountResponse:
    acc = db.get(Account, account_id)
    if acc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta no encontrada.")
    acc.is_active = False
    db.commit()
    db.refresh(acc)
    bal = _journal_balances(db).get(acc.id, Decimal("0"))
    parent_name = None
    if acc.parent_id:
        p = db.get(Account, acc.parent_id)
        parent_name = p.name if p else None
    return _build_response(acc, bal, parent_name=parent_name)


@router.patch("/{account_id}", response_model=ChartAccountResponse)
def update_chart_account(
    account_id: int,
    payload: ChartAccountUpdate,
    db: DbDep,
    _: ChartEditDep,
) -> ChartAccountResponse:
    acc = db.get(Account, account_id)
    if acc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta no encontrada.")
    parent_id = payload.parent_id if payload.is_subaccount else None
    _validate_parent_for_account(db, account_id, parent_id)

    opening = payload.opening_balance
    ob_date = payload.opening_balance_date

    parent: Optional[Account] = db.get(Account, parent_id) if parent_id is not None else None
    _require_parent_currency_match(parent, payload.currency)

    linked_pm, detail_type = _resolve_payment_method_fields(db, payload)

    acc.name = payload.name.strip()
    acc.account_number = (payload.account_number or "").strip() or None
    acc.account_type = payload.account_type
    acc.detail_type = detail_type
    acc.linked_payment_method = linked_pm
    acc.description = (payload.description or "").strip() or None
    acc.parent_id = parent_id
    acc.currency = normalize_currency_code(payload.currency)
    if opening is not None:
        ob_dec = _amount_to_decimal(opening)
        acc.opening_balance = ob_dec
        acc.opening_balance_date = ob_date
    else:
        acc.opening_balance = None
        acc.opening_balance_date = None

    _sync_current_balance_from_opening_and_journal(db, acc)

    db.commit()
    db.refresh(acc)

    bal = _journal_balances(db).get(acc.id, Decimal("0"))
    return _build_response(acc, bal, parent_name=parent.name if parent else None)
