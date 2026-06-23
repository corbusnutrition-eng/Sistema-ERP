"""
Motor de partida doble automatizada (QuickBooks / IFRS).

El usuario no elige cuentas manualmente: el motor resuelve cuentas ACTIVOS (pasarela),
TICKETS (ingresos operativos) y GASTOS según ``detail_type`` del plan contable.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Literal, Optional, Sequence

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.account import Account, LedgerAccountType
from app.models.journal_entry import JournalEntry, JournalReferenceType, JournalEntryLine
from app.models.payment_method import PaymentMethod
from app.models.sale import Sale, SaleStatus
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.timezone_utils import now_ecuador

logger = logging.getLogger(__name__)

# --- Tipos de ingreso (TICKETS) ---
OperatingIncomeType = Literal["venta_servicios", "recarga"]
TICKETS_DETAIL_BY_INCOME: dict[str, str] = {
    "venta_servicios": "Venta de productos y Servicios",
    "recarga": "Ingresos recarga de saldo",
}

# --- Tipos de gasto operativo ---
ExpenseCommissionType = Literal["tasas_comisiones", "publicidad", "nomina"]
EXPENSE_DETAIL_BY_TYPE: dict[str, str] = {
    "tasas_comisiones": "Tasas y comisiones",
    "publicidad": "Publicidad y Promoción",
    "nomina": "Gasto nómina",
}

FX_LOSS_DETAIL = "Pérdida de cambio"
FX_GAIN_DETAIL = "Otros ingresos principales"

FINANCIAL_EXPENSE_DETAILS = frozenset({FX_LOSS_DETAIL, "Otros gastos", "Liquidaciones"})


def _q4(v: Decimal | float | str | int) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.0001"))


def _q6(v: Decimal | float | str | int) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.000001"))


@dataclass(frozen=True)
class JournalLineDraft:
    account_id: int
    debit: Decimal
    credit: Decimal
    exchange_rate: Decimal = Decimal("1")


def find_asset_by_gateway(db: Session, pasarela_id: int, currency: Optional[str] = None) -> Account:
    """Cuenta ACTIVOS vinculada a la pasarela (``linked_wallet_id`` o ``linked_payment_method``)."""
    pm = db.get(PaymentMethod, pasarela_id)
    if pm is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Pasarela id={pasarela_id} no encontrada.",
        )

    q = db.query(Account).filter(
        Account.is_active.is_(True),
        Account.account_type == LedgerAccountType.asset.value,
    )
    if currency:
        q = q.filter(Account.currency == normalize_currency_code(currency))

    row = q.filter(Account.linked_wallet_id == pasarela_id).first()
    if row is not None:
        return row

    row = q.filter(Account.linked_payment_method == pm.name).first()
    if row is not None:
        return row

    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=(
            f"No hay cuenta ACTIVOS vinculada a la pasarela «{pm.name}» "
            f"(linked_wallet_id o linked_payment_method)."
        ),
    )


def resolve_pasarela_id_from_deposit_account(db: Session, deposit_account_id: int) -> Optional[int]:
    """Obtiene ``payment_methods.id`` desde la cuenta ACTIVOS de depósito."""
    acc = db.get(Account, deposit_account_id)
    if acc is None or not acc.is_active:
        return None
    if acc.linked_wallet_id is not None:
        return int(acc.linked_wallet_id)
    lm = (acc.linked_payment_method or "").strip()
    if lm:
        pm = db.query(PaymentMethod).filter(PaymentMethod.name == lm, PaymentMethod.is_active.is_(True)).first()
        if pm is not None:
            return int(pm.id)
    return None


def resolve_pasarela_id_for_sale(db: Session, sale: Sale) -> Optional[int]:
    pm_id = getattr(sale, "payment_method_id", None)
    if pm_id is not None:
        return int(pm_id)
    dep_id = getattr(sale, "deposit_account_id", None)
    if dep_id is not None:
        return resolve_pasarela_id_from_deposit_account(db, int(dep_id))
    return None


def resolve_pasarela_id_for_wallet_recharge(db: Session, req: WalletRechargeRequest) -> int:
    dep_id = getattr(req, "portal_submitted_deposit_account_id", None)
    if dep_id is not None:
        pid = resolve_pasarela_id_from_deposit_account(db, int(dep_id))
        if pid is not None:
            return pid
    raw = req.allowed_payment_methods if isinstance(req.allowed_payment_methods, list) else []
    ids: list[int] = []
    for x in raw:
        try:
            ids.append(int(x))
        except (TypeError, ValueError):
            continue
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La solicitud no tiene métodos de pago configurados para el asiento contable.",
        )
    pm = db.get(PaymentMethod, ids[0])
    if pm is None or not pm.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Método de pago inválido o inactivo en la solicitud de recarga.",
        )
    return int(pm.id)


def find_tickets_income_account(db: Session, detail_type: str, currency: str) -> Account:
    """Cuenta TICKETS; si no existe en la moneda local, usa USD (plan maestro sembrado)."""
    cur = normalize_currency_code(currency)
    row = (
        db.query(Account)
        .filter(
            Account.is_active.is_(True),
            Account.account_type == LedgerAccountType.income.value,
            Account.detail_type == detail_type,
            Account.currency == cur,
        )
        .order_by(Account.id.asc())
        .first()
    )
    if row is not None:
        return row
    if cur != "USD":
        row = (
            db.query(Account)
            .filter(
                Account.is_active.is_(True),
                Account.account_type == LedgerAccountType.income.value,
                Account.detail_type == detail_type,
                Account.currency == "USD",
            )
            .order_by(Account.id.asc())
            .first()
        )
        if row is not None:
            return row
    raise HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail=f"Cuenta TICKETS no encontrada: detail={detail_type!r}.",
    )


def find_account_by_detail(
    db: Session,
    *,
    account_type: str,
    detail_type: str,
    currency: Optional[str] = None,
) -> Account:
    q = db.query(Account).filter(
        Account.is_active.is_(True),
        Account.account_type == account_type,
        Account.detail_type == detail_type,
    )
    if currency:
        q = q.filter(Account.currency == normalize_currency_code(currency))
    row = q.order_by(Account.id.asc()).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Cuenta no encontrada: type={account_type!r}, detail={detail_type!r}.",
        )
    return row


def _validate_balanced(lines: Sequence[JournalLineDraft], *, fx_weighted: bool = False) -> None:
    if not lines:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El asiento no tiene líneas.")
    if fx_weighted:
        total_dr = sum((_q4(l.debit * l.exchange_rate) for l in lines), Decimal("0"))
        total_cr = sum((_q4(l.credit * l.exchange_rate) for l in lines), Decimal("0"))
    else:
        total_dr = sum((_q4(l.debit) for l in lines), Decimal("0"))
        total_cr = sum((_q4(l.credit) for l in lines), Decimal("0"))
    if total_dr != total_cr:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Asiento desbalanceado: débitos={total_dr} créditos={total_cr}.",
        )
    if total_dr <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El importe del asiento debe ser mayor que cero.",
        )


def _post_journal_atomic(
    db: Session,
    *,
    entry_date: date,
    reference_type: str,
    reference_id: Optional[int],
    description: str,
    lines: Sequence[JournalLineDraft],
    fx_weighted: Optional[bool] = None,
) -> JournalEntry:
    """
    Persiste cabecera + líneas en la sesión actual.
    El llamador debe hacer ``db.commit()`` al final o ``db.rollback()`` si falla.
    """
    if fx_weighted is None:
        fx_weighted = any(_q6(l.exchange_rate) != Decimal("1") for l in lines)
    _validate_balanced(lines, fx_weighted=fx_weighted)

    entry = JournalEntry(
        date=entry_date,
        reference_type=reference_type,
        reference_id=reference_id,
        description=description.strip() or None,
        created_at=now_ecuador(),
    )
    db.add(entry)
    db.flush()

    for draft in lines:
        if _q4(draft.debit) < 0 or _q4(draft.credit) < 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Débitos y créditos no pueden ser negativos.",
            )
        if _q4(draft.debit) > 0 and _q4(draft.credit) > 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cada línea debe ser solo débito o solo crédito.",
            )
        db.add(
            JournalEntryLine(
                journal_entry_id=entry.id,
                account_id=draft.account_id,
                debit=_q4(draft.debit),
                credit=_q4(draft.credit),
                exchange_rate=_q6(draft.exchange_rate),
            )
        )

    db.flush()
    logger.info(
        "Asiento id=%s type=%s ref=%s dr/cr=%s",
        entry.id,
        reference_type,
        reference_id,
        _q4(sum(l.debit for l in lines)),
    )
    return entry


def _sale_amount_paid_local(sale: Sale) -> Decimal:
    ap = getattr(sale, "amount_paid", None)
    if ap is None:
        return Decimal("0")
    return _q4(ap)


def _sale_entry_date(sale: Sale) -> date:
    dt = sale.created_at
    if hasattr(dt, "date"):
        return dt.date()
    return date.today()


def delete_sale_engine_journals(db: Session, sale_id: int) -> None:
    """Elimina asientos del motor ligados a una venta (regeneración idempotente)."""
    db.query(JournalEntry).filter(
        JournalEntry.reference_type == JournalReferenceType.venta.value,
        JournalEntry.reference_id == sale_id,
    ).delete(synchronize_session=False)


def _sale_invoice_total_local(sale: Sale) -> Decimal:
    """Total facturado en moneda de la venta (eje de ``local_amount`` / CxC)."""
    if sale.local_amount is not None:
        return _q4(sale.local_amount)
    return _q4(sale.amount)


def sync_sale_accrual_journal(db: Session, sale: Sale, *, strict: bool = False) -> Optional[JournalEntry]:
    """
    Devengo de la venta (causación): DR Cuentas por cobrar / CR ingresos operativos.

    El cobro en banco (DR banco / CR CxC) lo registra exclusivamente ``ClientPayment``.
    No usa ``amount_paid`` ni pasarela de depósito.
    """
    delete_sale_engine_journals(db, int(sale.id))

    if sale.status in (SaleStatus.cancelled, SaleStatus.rejected, SaleStatus.annulled, SaleStatus.expired):
        return None
    if sale.status not in (
        SaleStatus.pending,
        SaleStatus.payment_submitted,
        SaleStatus.approved,
        SaleStatus.partially_paid,
    ):
        return None

    total = _sale_invoice_total_local(sale)
    if total <= 0:
        return None

    cur = normalize_currency_code(sale.currency)
    income_detail = TICKETS_DETAIL_BY_INCOME["venta_servicios"]

    ar_acc = ensure_accounts_receivable(db, cur)
    if normalize_currency_code(str(getattr(ar_acc, "currency", "") or cur)) != cur:
        msg = f"La cuenta CxC no coincide con la moneda de la venta ({cur})."
        if strict:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
        logger.warning("Asiento devengo venta id=%s omitido: %s", sale.id, msg)
        return None
    errors: list[str] = []

    try:
        income_acc = find_tickets_income_account(db, income_detail, cur)
    except HTTPException as exc:
        errors.append(str(exc.detail))

    if errors:
        msg = " ".join(errors)
        if strict:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
        logger.warning("Asiento devengo venta id=%s omitido: %s", sale.id, msg)
        return None

    assert ar_acc is not None

    desc = f"Venta #{sale.id} devengo {total} {cur}"
    from app.services.currency_consolidation import sale_exchange_rate

    xr = sale_exchange_rate(sale)

    entry = _post_journal_atomic(
        db,
        entry_date=_sale_entry_date(sale),
        reference_type=JournalReferenceType.venta.value,
        reference_id=int(sale.id),
        description=desc,
        lines=[
            JournalLineDraft(ar_acc.id, debit=total, credit=Decimal("0"), exchange_rate=xr),
            JournalLineDraft(income_acc.id, debit=Decimal("0"), credit=total, exchange_rate=xr),
        ],
        fx_weighted=xr != Decimal("1"),
    )

    _refresh_accounts_balance_cache(db, {int(ar_acc.id), int(income_acc.id)})
    return entry


def _wallet_recharge_invoice_total(req: WalletRechargeRequest) -> Decimal:
    return _q4(getattr(req, "amount_requested", 0) or 0)


def _wallet_recharge_entry_date(req: WalletRechargeRequest) -> date:
    created = getattr(req, "created_at", None)
    if created is not None and hasattr(created, "date"):
        return created.date()
    return date.today()


def sync_wallet_recharge_accrual_journal(
    db: Session,
    req: WalletRechargeRequest,
    *,
    strict: bool = False,
) -> Optional[JournalEntry]:
    """
    Devengo recarga BaaS (igual que ventas): DR Cuentas por cobrar / CR ingresos recarga.

    El cobro en banco (DR banco / CR CxC) lo registra exclusivamente ``ClientPayment``.
    """
    from app.wallet_recharge_helpers import (
        REQ_STATUS_APPROVED,
        REQ_STATUS_CANCELED,
        REQ_STATUS_IN_REVIEW,
        REQ_STATUS_PARTIALLY_PAID,
        REQ_STATUS_PENDING,
        REQ_STATUS_REJECTED,
    )

    delete_journals_by_reference(db, JournalReferenceType.recarga.value, int(req.id))

    if str(getattr(req, "status", "") or "") in (
        REQ_STATUS_REJECTED,
        REQ_STATUS_CANCELED,
    ):
        return None
    if str(getattr(req, "status", "") or "") not in (
        REQ_STATUS_PENDING,
        REQ_STATUS_IN_REVIEW,
        REQ_STATUS_PARTIALLY_PAID,
        REQ_STATUS_APPROVED,
    ):
        return None

    total = _wallet_recharge_invoice_total(req)
    if total <= 0:
        return None

    cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
    income_detail = TICKETS_DETAIL_BY_INCOME["recarga"]

    ar_acc = ensure_accounts_receivable(db, cur)
    if normalize_currency_code(str(getattr(ar_acc, "currency", "") or cur)) != cur:
        msg = f"La cuenta CxC no coincide con la moneda de la recarga ({cur})."
        if strict:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
        logger.warning("Asiento devengo recarga id=%s omitido: %s", req.id, msg)
        return None

    try:
        income_acc = find_tickets_income_account(db, income_detail, cur)
    except HTTPException as exc:
        msg = str(exc.detail)
        if strict:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg) from exc
        logger.warning("Asiento devengo recarga id=%s omitido: %s", req.id, msg)
        return None

    xr = Decimal(str(getattr(req, "recharge_exchange_rate", None) or 1))
    desc = f"Recarga BaaS #{req.id} devengo {total} {cur}"

    entry = _post_journal_atomic(
        db,
        entry_date=_wallet_recharge_entry_date(req),
        reference_type=JournalReferenceType.recarga.value,
        reference_id=int(req.id),
        description=desc,
        lines=[
            JournalLineDraft(ar_acc.id, debit=total, credit=Decimal("0"), exchange_rate=xr),
            JournalLineDraft(income_acc.id, debit=Decimal("0"), credit=total, exchange_rate=xr),
        ],
        fx_weighted=xr != Decimal("1"),
    )

    _refresh_accounts_balance_cache(db, {int(ar_acc.id), int(income_acc.id)})
    return entry


def ensure_wallet_recharge_accrual_journal(
    db: Session,
    req: WalletRechargeRequest,
    *,
    strict: bool = True,
) -> Optional[JournalEntry]:
    """Publica el devengo de la recarga una sola vez (idempotente por ``reference_id``)."""
    existing = (
        db.query(JournalEntry)
        .filter(
            JournalEntry.reference_type == JournalReferenceType.recarga.value,
            JournalEntry.reference_id == int(req.id),
        )
        .order_by(JournalEntry.id.asc())
        .first()
    )
    if existing is not None:
        return existing
    return sync_wallet_recharge_accrual_journal(db, req, strict=strict)


# Cuentas que NO deben recibir el asiento automático de COGS (contra-ingreso / ajustes).
_COGS_EXCLUDED_DETAIL_TYPES = frozenset({"Descuentos", "descuentos"})
_COGS_PREFERRED_DETAIL_TYPES = (
    "Costo de ventas",
    "Costo de bienes vendidos",
    "Costos de venta",
)
_COGS_PREFERRED_NAME_FRAGMENTS = (
    "costo de ventas",
    "costo de bienes vendidos",
    "costos de venta",
)


def find_cost_of_sales_account(db: Session, currency: str = "USD") -> Optional[Account]:
    """Cuenta principal de costo de ventas (COGS), nunca «Descuentos» ni similares."""
    cur = normalize_currency_code(currency)
    base = db.query(Account).filter(
        Account.is_active.is_(True),
        Account.currency == cur,
        Account.account_type == LedgerAccountType.cost_of_sales.value,
    )

    for dt in _COGS_PREFERRED_DETAIL_TYPES:
        row = (
            base.filter(Account.detail_type == dt)
            .order_by(Account.parent_id.asc().nullsfirst(), Account.id.asc())
            .first()
        )
        if row is not None:
            return row

    for frag in _COGS_PREFERRED_NAME_FRAGMENTS:
        row = (
            base.filter(func.lower(Account.name).like(f"%{frag}%"))
            .order_by(Account.parent_id.asc().nullsfirst(), Account.id.asc())
            .first()
        )
        if row is not None:
            return row

    for exact in (f"Costo de ventas ({cur})", "Costo de ventas", "Costo de bienes vendidos"):
        row = (
            db.query(Account)
            .filter(
                Account.is_active.is_(True),
                Account.currency == cur,
                Account.name == exact,
            )
            .first()
        )
        if row is not None:
            return row

    row = (
        base.filter(
            ~Account.detail_type.in_(tuple(_COGS_EXCLUDED_DETAIL_TYPES)),
        )
        .order_by(Account.parent_id.asc().nullsfirst(), Account.id.asc())
        .first()
    )
    return row


def sum_ledger_cogs_usd(
    db: Session,
    start_date: date,
    end_date: date,
    *,
    currency: Optional[str] = None,
) -> Decimal:
    """
    Costo de ventas del periodo **solo desde libro mayor** (``journal_entries`` / ``journal_entry_lines``).

    Fórmula: Σ (débito − crédito) por línea en cuentas ``cost_of_sales`` del rango de fechas,
    excluyendo contra-cuentas (Descuentos, etc.). No consulta ventas ni inventario.
    """
    from sqlalchemy import or_

    excluded = tuple(_COGS_EXCLUDED_DETAIL_TYPES)
    xr_safe = func.coalesce(func.nullif(JournalEntryLine.exchange_rate, 0), 1)
    q_usd = (
        db.query(
            func.coalesce(
                func.sum((JournalEntryLine.debit - JournalEntryLine.credit) / xr_safe),
                0,
            )
        )
        .select_from(JournalEntryLine)
        .join(JournalEntry, JournalEntry.id == JournalEntryLine.journal_entry_id)
        .join(Account, Account.id == JournalEntryLine.account_id)
        .filter(
            JournalEntry.date >= start_date,
            JournalEntry.date <= end_date,
            Account.account_type == LedgerAccountType.cost_of_sales.value,
            Account.is_active.is_(True),
            or_(
                Account.detail_type.is_(None),
                ~Account.detail_type.in_(excluded),
            ),
        )
    )
    if currency:
        q_usd = q_usd.filter(Account.currency == normalize_currency_code(currency))
    raw = q_usd.scalar()
    return Decimal(str(raw or 0)).quantize(Decimal("0.01"))


def find_inventory_asset_account(db: Session, currency: str = "USD") -> Optional[Account]:
    """Cuenta de inventario (activo corriente)."""
    cur = normalize_currency_code(currency)
    row = (
        db.query(Account)
        .filter(
            Account.is_active.is_(True),
            Account.currency == cur,
            Account.account_type == LedgerAccountType.asset.value,
            Account.detail_type == "inventario",
        )
        .order_by(Account.id.asc())
        .first()
    )
    if row is not None:
        return row
    row = (
        db.query(Account)
        .filter(
            Account.is_active.is_(True),
            Account.currency == cur,
            Account.name == "Inventario",
        )
        .first()
    )
    return row


def ensure_cost_of_sales_account(db: Session, currency: str = "USD") -> Account:
    cur = normalize_currency_code(currency)
    return _ensure_system_ledger_account(
        db,
        currency=cur,
        account_type=LedgerAccountType.cost_of_sales.value,
        detail_type="Costo de ventas",
        display_name=f"Costo de ventas ({cur})",
        finder=find_cost_of_sales_account,
    )


def ensure_inventory_asset_account(db: Session, currency: str = "USD") -> Account:
    cur = normalize_currency_code(currency)
    return _ensure_system_ledger_account(
        db,
        currency=cur,
        account_type=LedgerAccountType.asset.value,
        detail_type="inventario",
        display_name=f"Inventario ({cur})",
        finder=find_inventory_asset_account,
    )


def sync_sale_cogs_journal(db: Session, sale: Sale, *, strict: bool = False) -> Optional[JournalEntry]:
    """
    Costo de ventas al activar: DR Costo de ventas / CR Inventario.

    Solo para ventas ``approved`` o ``partially_paid`` con costo calculable > 0.
    """
    from app.services.sale_cogs import compute_sale_cogs_breakdown, log_sale_cogs_before_journal

    ref_type = JournalReferenceType.venta_cogs.value
    old_touch = delete_journals_by_reference(db, ref_type, int(sale.id))

    if sale.status not in (SaleStatus.approved, SaleStatus.partially_paid):
        if old_touch:
            _refresh_accounts_balance_cache(db, old_touch)
        return None

    try:
        breakdown = compute_sale_cogs_breakdown(db, sale)
    except Exception as exc:
        logger.exception("Error calculando COGS venta id=%s", sale.id)
        if strict:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error calculando costo de ventas: {exc!s}",
            ) from exc
        from app.services.sale_cogs import SaleCogsBreakdown

        breakdown = SaleCogsBreakdown(total_usd=Decimal("0"), lines=tuple(), method="error")

    cost_usd = breakdown.total_usd
    if cost_usd <= _q4(Decimal("0.0001")):
        if strict and breakdown.method == "none":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"No se puede registrar COGS para la venta #{sale.id}: "
                    "configure «Costo de compra» (purchase_cost_usd) en el producto "
                    "o costo en bodega (screen_stock)."
                ),
            )
        if old_touch:
            _refresh_accounts_balance_cache(db, old_touch)
        return None

    log_sale_cogs_before_journal(sale, breakdown)

    cur = "USD"
    cogs_acc = ensure_cost_of_sales_account(db, cur)
    inv_acc = ensure_inventory_asset_account(db, cur)
    if normalize_currency_code(str(getattr(cogs_acc, "currency", "") or cur)) != cur:
        msg = f"La cuenta COGS no coincide con la moneda esperada ({cur})."
        if strict:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
        logger.warning("COGS venta id=%s omitido: %s", sale.id, msg)
        _refresh_accounts_balance_cache(db, old_touch)
        return None
    if normalize_currency_code(str(getattr(inv_acc, "currency", "") or cur)) != cur:
        msg = f"La cuenta de inventario no coincide con la moneda esperada ({cur})."
        if strict:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
        logger.warning("COGS venta id=%s omitido: %s", sale.id, msg)
        _refresh_accounts_balance_cache(db, old_touch)
        return None

    desc = f"Venta #{sale.id} costo de ventas {cost_usd} {cur}"
    entry = _post_journal_atomic(
        db,
        entry_date=_sale_entry_date(sale),
        reference_type=ref_type,
        reference_id=int(sale.id),
        description=desc,
        lines=[
            JournalLineDraft(cogs_acc.id, debit=cost_usd, credit=Decimal("0")),
            JournalLineDraft(inv_acc.id, debit=Decimal("0"), credit=cost_usd),
        ],
    )
    touched = old_touch | {int(cogs_acc.id), int(inv_acc.id)}
    _refresh_accounts_balance_cache(db, touched)
    return entry


def sync_sale_operating_income(db: Session, sale: Sale, *, strict: bool = False) -> Optional[JournalEntry]:
    """
    Alias de ``sync_sale_accrual_journal`` (devengo DR CxC / CR ingresos).

    Conservado por compatibilidad con importadores existentes; ya no registra cobros en banco.
    """
    return sync_sale_accrual_journal(db, sale, strict=strict)


def post_wallet_recharge_operating_income(
    db: Session,
    *,
    req: WalletRechargeRequest,
    received_amount: Decimal | float,
    wallet_transaction_id: int,
    description: Optional[str] = None,
) -> JournalEntry:
    """Registra un abono de recarga (DR pasarela / CR TICKETS recarga). No hace ``commit``."""
    amt = _q4(received_amount)
    if amt <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El monto percibido debe ser mayor que cero para el asiento contable.",
        )
    pasarela_id = resolve_pasarela_id_for_wallet_recharge(db, req)
    cur = normalize_currency_code(getattr(req, "recharge_currency", None), "USD")
    xr = Decimal(str(getattr(req, "recharge_exchange_rate", None) or 1))
    desc = description or f"Recarga solicitud #{req.id} percibido {amt} {cur}"
    return post_operating_income(
        db,
        monto=amt,
        moneda=cur,
        pasarela_id=pasarela_id,
        tipo_ingreso="recarga",
        reference_id=int(wallet_transaction_id),
        reference_type=JournalReferenceType.recarga.value,
        entry_date=date.today(),
        exchange_rate=xr,
        description=desc,
    )


def post_operating_income(
    db: Session,
    *,
    monto: Decimal,
    moneda: str,
    pasarela_id: int,
    tipo_ingreso: OperatingIncomeType,
    reference_id: Optional[int] = None,
    reference_type: Optional[str] = None,
    entry_date: Optional[date] = None,
    exchange_rate: Decimal = Decimal("1"),
    description: Optional[str] = None,
) -> JournalEntry:
    """
    Ingreso operativo (acción comercial). Persiste en sesión; el llamador hace ``commit``.

    DÉBITO: ACTIVOS vinculados a ``pasarela_id``.
    CRÉDITO: TICKETS según ``tipo_ingreso`` (venta de servicios o recarga).
    """
    cur = normalize_currency_code(moneda)
    amt = _q4(monto)
    if amt <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El monto debe ser mayor que cero.")

    detail = TICKETS_DETAIL_BY_INCOME.get(tipo_ingreso)
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"tipo_ingreso inválido: {tipo_ingreso!r}.",
        )

    asset = find_asset_by_gateway(db, pasarela_id, currency=cur)
    if normalize_currency_code(asset.currency) != cur:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La moneda del monto debe coincidir con la cuenta ACTIVOS de la pasarela.",
        )

    income = find_tickets_income_account(db, detail, cur)

    ref_type = reference_type or (
        JournalReferenceType.recarga.value if tipo_ingreso == "recarga" else JournalReferenceType.venta.value
    )
    desc = description or f"Ingreso {tipo_ingreso} pasarela={pasarela_id} {amt} {cur}"

    return _post_journal_atomic(
        db,
        entry_date=entry_date or date.today(),
        reference_type=ref_type,
        reference_id=reference_id,
        description=desc,
        lines=[
            JournalLineDraft(asset.id, debit=amt, credit=Decimal("0"), exchange_rate=exchange_rate),
            JournalLineDraft(income.id, debit=Decimal("0"), credit=amt, exchange_rate=exchange_rate),
        ],
    )


def record_operating_income(
    db: Session,
    *,
    monto: Decimal,
    moneda: str,
    pasarela_id: int,
    tipo_ingreso: OperatingIncomeType,
    reference_id: Optional[int] = None,
    reference_type: Optional[str] = None,
    entry_date: Optional[date] = None,
    exchange_rate: Decimal = Decimal("1"),
    description: Optional[str] = None,
    commit: bool = True,
) -> JournalEntry:
    """API de conveniencia con ``commit`` opcional (por defecto confirma la transacción)."""
    try:
        entry = post_operating_income(
            db,
            monto=monto,
            moneda=moneda,
            pasarela_id=pasarela_id,
            tipo_ingreso=tipo_ingreso,
            reference_id=reference_id,
            reference_type=reference_type,
            entry_date=entry_date,
            exchange_rate=exchange_rate,
            description=description,
        )
        if commit:
            db.commit()
        return entry
    except Exception:
        if commit:
            db.rollback()
        raise


def post_expense_or_commission(
    db: Session,
    *,
    monto: Decimal,
    pasarela_id: int,
    tipo_gasto: ExpenseCommissionType,
    moneda: str = "USD",
    reference_id: Optional[int] = None,
    entry_date: Optional[date] = None,
    exchange_rate: Decimal = Decimal("1"),
    description: Optional[str] = None,
) -> JournalEntry:
    """
    Gasto o comisión pagada desde la pasarela. Persiste en sesión; el llamador hace ``commit``.

    DÉBITO: GASTOS (tasas, publicidad, nómina).
    CRÉDITO: ACTIVOS vinculados a ``pasarela_id``.
    """
    cur = normalize_currency_code(moneda)
    amt = _q4(monto)
    if amt <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El monto debe ser mayor que cero.")

    detail = EXPENSE_DETAIL_BY_TYPE.get(tipo_gasto)
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"tipo_gasto inválido: {tipo_gasto!r}.",
        )

    expense = find_account_by_detail(
        db,
        account_type=LedgerAccountType.expense.value,
        detail_type=detail,
        currency=cur,
    )
    asset = find_asset_by_gateway(db, pasarela_id, currency=cur)

    desc = description or f"Gasto {tipo_gasto} pasarela={pasarela_id} {amt} {cur}"

    return _post_journal_atomic(
        db,
        entry_date=entry_date or date.today(),
        reference_type=JournalReferenceType.tarifa.value,
        reference_id=reference_id,
        description=desc,
        lines=[
            JournalLineDraft(expense.id, debit=amt, credit=Decimal("0"), exchange_rate=exchange_rate),
            JournalLineDraft(asset.id, debit=Decimal("0"), credit=amt, exchange_rate=exchange_rate),
        ],
    )


def record_expense_or_commission(
    db: Session,
    *,
    monto: Decimal,
    pasarela_id: int,
    tipo_gasto: ExpenseCommissionType,
    moneda: str = "USD",
    reference_id: Optional[int] = None,
    entry_date: Optional[date] = None,
    exchange_rate: Decimal = Decimal("1"),
    description: Optional[str] = None,
    commit: bool = True,
) -> JournalEntry:
    try:
        entry = post_expense_or_commission(
            db,
            monto=monto,
            pasarela_id=pasarela_id,
            tipo_gasto=tipo_gasto,
            moneda=moneda,
            reference_id=reference_id,
            entry_date=entry_date,
            exchange_rate=exchange_rate,
            description=description,
        )
        if commit:
            db.commit()
        return entry
    except Exception:
        if commit:
            db.rollback()
        raise


def post_fx_reconciliation(
    db: Session,
    *,
    monto_esperado_usd: Decimal,
    monto_real_recibido: Decimal,
    pasarela_id: int,
    reference_id: Optional[int] = None,
    entry_date: Optional[date] = None,
    description: Optional[str] = None,
) -> JournalEntry:
    """
    Ajuste por diferencia de tipo de cambio en cobro USD. Persiste en sesión; el llamador hace ``commit``.

    Si se recibió menos de lo esperado (pérdida FX):
      DR GASTOS «Pérdida por tipo de cambio» / CR ACTIVOS pasarela.

    Si se recibió más (ganancia FX):
      DR ACTIVOS pasarela / CR INGRESOS «Ganancia por tipo de cambio».
    """
    expected = _q4(monto_esperado_usd)
    received = _q4(monto_real_recibido)
    diff = _q4(received - expected)

    if diff == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No hay diferencia de tipo de cambio que registrar.",
        )

    amt = _q4(abs(diff))
    asset = find_asset_by_gateway(db, pasarela_id, currency="USD")

    if diff < 0:
        loss = find_account_by_detail(
            db,
            account_type=LedgerAccountType.expense.value,
            detail_type=FX_LOSS_DETAIL,
            currency="USD",
        )
        lines = [
            JournalLineDraft(loss.id, debit=amt, credit=Decimal("0")),
            JournalLineDraft(asset.id, debit=Decimal("0"), credit=amt),
        ]
        desc = description or f"Pérdida FX pasarela={pasarela_id} esperado={expected} recibido={received}"
    else:
        gain = find_account_by_detail(
            db,
            account_type=LedgerAccountType.income.value,
            detail_type=FX_GAIN_DETAIL,
            currency="USD",
        )
        lines = [
            JournalLineDraft(asset.id, debit=amt, credit=Decimal("0")),
            JournalLineDraft(gain.id, debit=Decimal("0"), credit=amt),
        ]
        desc = description or f"Ganancia FX pasarela={pasarela_id} esperado={expected} recibido={received}"

    return _post_journal_atomic(
        db,
        entry_date=entry_date or date.today(),
        reference_type=JournalReferenceType.ajuste_fx.value,
        reference_id=reference_id,
        description=desc,
        lines=lines,
    )


def record_fx_reconciliation(
    db: Session,
    *,
    monto_esperado_usd: Decimal,
    monto_real_recibido: Decimal,
    pasarela_id: int,
    reference_id: Optional[int] = None,
    entry_date: Optional[date] = None,
    description: Optional[str] = None,
    commit: bool = True,
) -> JournalEntry:
    try:
        entry = post_fx_reconciliation(
            db,
            monto_esperado_usd=monto_esperado_usd,
            monto_real_recibido=monto_real_recibido,
            pasarela_id=pasarela_id,
            reference_id=reference_id,
            entry_date=entry_date,
            description=description,
        )
        if commit:
            db.commit()
        return entry
    except Exception:
        if commit:
            db.rollback()
        raise


_REVERSAL_MARKER_PREFIX = "REVERSIÓN asiento #"


def _reversal_description(original_entry_id: int, original_desc: Optional[str], reason: str) -> str:
    base = f"{_REVERSAL_MARKER_PREFIX}{original_entry_id}"
    if original_desc:
        base += f" — {str(original_desc).strip()[:200]}"
    extra = (reason or "").strip()
    if extra:
        base += f" [{extra}]"
    return base[:500]


def _journal_entry_already_reversed(db: Session, original_entry_id: int) -> bool:
    marker = f"{_REVERSAL_MARKER_PREFIX}{original_entry_id}"
    row = (
        db.query(JournalEntry.id)
        .filter(JournalEntry.description.isnot(None), JournalEntry.description.like(f"{marker}%"))
        .first()
    )
    return row is not None


def resolve_transaction_ref(db: Session, transaction_ref: str) -> tuple[str, int]:
    """
    Resuelve una referencia humana (``FAC-0004``, ``PAG-1005``) a ``(reference_type, reference_id)``.

    También acepta prefijos ``VENTA-`` / ``SALE-`` y numérico puro (id de venta o pago).
    """
    from app.models.client_payment import ClientPayment

    raw = (transaction_ref or "").strip()
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Referencia contable vacía.",
        )

    upper = raw.upper()
    if upper.startswith("FAC-") or upper.startswith("VENTA-") or upper.startswith("SALE-"):
        suffix = raw.split("-", 1)[1].strip()
        try:
            sale_id = int(suffix)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Referencia de factura inválida: {transaction_ref!r}.",
            ) from exc
        return JournalReferenceType.venta.value, sale_id

    if upper.startswith("PAG-"):
        pnum = raw.strip()
        row = (
            db.query(ClientPayment.id)
            .filter(func.upper(ClientPayment.payment_number) == pnum.upper())
            .first()
        )
        if row is not None:
            return JournalReferenceType.client_payment.value, int(row[0])
        try:
            seq = int(raw.split("-", 1)[1].strip())
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Referencia de pago inválida: {transaction_ref!r}.",
            ) from exc
        if seq >= 1000:
            pid = seq - 1000
        else:
            pid = seq
        if db.get(ClientPayment, pid) is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No existe pago con referencia {transaction_ref!r}.",
            )
        return JournalReferenceType.client_payment.value, pid

    if raw.isdigit():
        n = int(raw)
        if db.get(ClientPayment, n) is not None:
            return JournalReferenceType.client_payment.value, n
        return JournalReferenceType.venta.value, n

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=(
            f"Referencia no reconocida: {transaction_ref!r}. "
            "Use FAC-#### (venta) o PAG-#### (pago)."
        ),
    )


def reverse_journals_by_reference(
    db: Session,
    reference_type: str,
    reference_id: int,
    *,
    reason: str = "",
) -> tuple[list[JournalEntry], set[int]]:
    """
    Genera asientos de reversión (intercambia débitos y créditos) para cada asiento original
    del documento que aún no fue revertido. No elimina el historial.
    """
    from app.models.journal_entry import JournalEntryLine

    originals = (
        db.query(JournalEntry)
        .filter(
            JournalEntry.reference_type == reference_type,
            JournalEntry.reference_id == reference_id,
        )
        .order_by(JournalEntry.id.asc())
        .all()
    )

    created: list[JournalEntry] = []
    touched: set[int] = set()

    for original in originals:
        if original.reference_type == JournalReferenceType.reversal.value:
            continue
        if _journal_entry_already_reversed(db, int(original.id)):
            continue

        line_rows = (
            db.query(JournalEntryLine)
            .filter(JournalEntryLine.journal_entry_id == int(original.id))
            .all()
        )
        if not line_rows:
            continue

        rev_lines = [
            JournalLineDraft(
                int(ln.account_id),
                debit=_q4(ln.credit),
                credit=_q4(ln.debit),
                exchange_rate=_q6(ln.exchange_rate),
            )
            for ln in line_rows
        ]

        rev_entry = _post_journal_atomic(
            db,
            entry_date=date.today(),
            reference_type=JournalReferenceType.reversal.value,
            reference_id=int(reference_id),
            description=_reversal_description(int(original.id), original.description, reason),
            lines=rev_lines,
        )
        created.append(rev_entry)
        touched.update(int(ln.account_id) for ln in line_rows)

    if touched:
        _refresh_accounts_balance_cache(db, touched)
    return created, touched


def reverse_accounting_entries(
    db: Session,
    transaction_ref: str,
    *,
    reason: str = "",
    reference_type: Optional[str] = None,
    reference_id: Optional[int] = None,
) -> list[JournalEntry]:
    """
    Revierte contablemente un documento por referencia legible (``PAG-1005``, ``FAC-0004``)
    o por ``reference_type`` + ``reference_id`` explícitos.
    """
    if reference_type is not None and reference_id is not None:
        rtype, rid = reference_type, int(reference_id)
    else:
        rtype, rid = resolve_transaction_ref(db, transaction_ref)

    label = (transaction_ref or "").strip() or f"{rtype}#{rid}"
    merged_reason = (reason or "").strip() or f"Reversión {label}"
    created, _ = reverse_journals_by_reference(db, rtype, rid, reason=merged_reason)
    return created


def delete_journals_by_reference(db: Session, reference_type: str, reference_id: int) -> set[int]:
    """Elimina asientos ligados a un documento y devuelve cuentas afectadas (para refresco de saldos)."""
    entry_ids = [
        int(eid)
        for (eid,) in db.query(JournalEntry.id)
        .filter(
            JournalEntry.reference_type == reference_type,
            JournalEntry.reference_id == reference_id,
        )
        .all()
    ]
    if not entry_ids:
        return set()
    touched = {
        int(aid)
        for (aid,) in db.query(JournalEntryLine.account_id)
        .filter(JournalEntryLine.journal_entry_id.in_(entry_ids))
        .distinct()
        .all()
    }
    db.query(JournalEntry).filter(JournalEntry.id.in_(entry_ids)).delete(synchronize_session=False)
    return touched


def find_accounts_receivable(db: Session, currency: str) -> Optional[Account]:
    """CxC por moneda (activo + detail_type «Cuentas x cobrar»)."""
    cur = normalize_currency_code(currency)
    canonical_name = f"Cuentas x cobrar ({cur})"
    row = (
        db.query(Account)
        .filter(
            Account.name == canonical_name,
            Account.parent_id.is_(None),
            Account.is_active.is_(True),
            Account.currency == cur,
        )
        .first()
    )
    if row is not None:
        return row
    base = db.query(Account).filter(
        Account.parent_id.is_(None),
        Account.is_active.is_(True),
        Account.currency == cur,
    )
    row = base.filter(Account.account_type == "Cuentas por cobrar").first()
    if row is not None:
        return row
    row = base.filter(
        Account.account_type == LedgerAccountType.asset.value,
        Account.detail_type == "Cuentas x cobrar",
    ).first()
    if row is not None:
        return row
    row = base.filter(Account.detail_type == "Cuentas x cobrar").first()
    if row is not None:
        return row
    return (
        db.query(Account)
        .filter(
            Account.name == canonical_name,
            Account.parent_id.is_(None),
            Account.is_active.is_(True),
        )
        .first()
    )


_CUSTOMER_ADVANCE_DETAIL_TYPES = (
    "Anticipos de clientes",
    "Saldos a favor",
    "Anticipo de clientes",
)


def find_customer_advance_liability(db: Session, currency: str) -> Optional[Account]:
    """Pasivo por pagos excedentes / saldo a favor del cliente (moneda local)."""
    cur = normalize_currency_code(currency)
    base = db.query(Account).filter(
        Account.parent_id.is_(None),
        Account.is_active.is_(True),
        Account.currency == cur,
        Account.account_type == LedgerAccountType.liability.value,
    )
    for dt in _CUSTOMER_ADVANCE_DETAIL_TYPES:
        row = base.filter(Account.detail_type == dt).first()
        if row is not None:
            return row
    for name in (
        f"Anticipos de clientes ({cur})",
        f"Saldos a favor ({cur})",
        "Anticipos de clientes",
        "Saldos a favor",
    ):
        row = (
            db.query(Account)
            .filter(
                Account.name == name,
                Account.parent_id.is_(None),
                Account.is_active.is_(True),
                Account.currency == cur,
            )
            .first()
        )
        if row is not None:
            return row
    return None


def _ensure_system_ledger_account(
    db: Session,
    *,
    currency: str,
    account_type: str,
    detail_type: str,
    display_name: str,
    finder,
) -> Account:
    """
    Busca una cuenta del plan maestro; si no existe, la crea en la sesión actual (``flush``).

    No hace ``commit``: el llamador confirma la transacción atómica (pago + asiento).
    """
    cur = normalize_currency_code(currency)
    existing = finder(db, cur)
    if existing is not None:
        return existing

    acc = Account(
        code=f"COA-{uuid.uuid4().hex[:12]}",
        name=display_name,
        account_number=None,
        account_type=account_type,
        detail_type=detail_type,
        description="Autogenerada por el motor contable.",
        parent_id=None,
        currency=cur,
        opening_balance=Decimal("0"),
        opening_balance_date=date.today(),
        current_balance=Decimal("0"),
        balance=Decimal("0"),
        is_active=True,
    )
    db.add(acc)
    db.flush()
    logger.info("Cuenta autogenerada: %r (%s, %s)", display_name, detail_type, cur)
    return acc


def ensure_accounts_receivable(db: Session, currency: str) -> Account:
    """CxC por moneda; la crea si aún no existe en el plan de cuentas."""
    cur = normalize_currency_code(currency)
    return _ensure_system_ledger_account(
        db,
        currency=cur,
        account_type=LedgerAccountType.asset.value,
        detail_type="Cuentas x cobrar",
        display_name=f"Cuentas x cobrar ({cur})",
        finder=find_accounts_receivable,
    )


def ensure_customer_advance_liability(db: Session, currency: str) -> Account:
    """Pasivo «Anticipos de clientes» por moneda; autogenera si falta."""
    cur = normalize_currency_code(currency)
    return _ensure_system_ledger_account(
        db,
        currency=cur,
        account_type=LedgerAccountType.liability.value,
        detail_type="Anticipos de clientes",
        display_name=f"Anticipos de clientes ({cur})",
        finder=find_customer_advance_liability,
    )


def is_baas_wallet_settlement_payment(payment) -> bool:
    """Cobro virtual BaaS (autocompra portal): cierra CxC sin banco ni anticipos."""
    notes = str(getattr(payment, "notes", None) or "")
    return "BAAS_WALLET_AUTO_PURCHASE=1" in notes


def is_credit_only_client_payment(payment) -> bool:
    """Pagos con saldo a favor del cliente: no hay movimiento bancario."""
    pm = (getattr(payment, "payment_method", None) or "").strip().lower()
    notes = str(getattr(payment, "notes", None) or "")
    return (
        pm == "saldo a favor"
        or "PARTE_SALDO_FAVOR=" in notes
        or "credit_auto_portal" in notes
    )


def _client_payment_applied_to_ar_amount(db: Session, payment) -> Decimal:
    """Monto del cobro que reduce CxC (suma de allocations, tope al importe del pago)."""
    from app.models.client_payment import PaymentAllocation

    amt = _q4(payment.amount)
    if amt <= 0:
        return Decimal("0")
    applied_raw = (
        db.query(func.coalesce(func.sum(PaymentAllocation.amount_applied), 0))
        .filter(PaymentAllocation.payment_id == int(payment.id))
        .scalar()
    )
    applied = _q4(applied_raw)
    if applied > _q4(Decimal("0.0001")):
        return min(applied, amt)
    if is_credit_only_client_payment(payment):
        return amt
    return Decimal("0")


def sync_client_credit_balance_payment_journal(
    db: Session,
    payment,
    *,
    strict: bool = True,
) -> Optional[JournalEntry]:
    """
    Cruce de saldo a favor contra factura: DR Anticipos de clientes / CR Cuentas por cobrar.

    Sin movimiento bancario. El monto es lo aplicado a facturas (allocations), no el bruto
    si hubiera excedente (en pagos solo-crédito suele coincidir con ``payment.amount``).
    """
    from app.models.client_payment import ClientPayment, ClientPaymentStatus

    if not isinstance(payment, ClientPayment):
        raise TypeError("payment debe ser instancia de ClientPayment")

    old_touch = delete_journals_by_reference(
        db,
        JournalReferenceType.client_payment.value,
        int(payment.id),
    )

    if payment.status != ClientPaymentStatus.approved:
        _refresh_accounts_balance_cache(db, old_touch)
        return None

    if not is_credit_only_client_payment(payment):
        _refresh_accounts_balance_cache(db, old_touch)
        return None

    cur = normalize_currency_code(str(payment.currency or "USD"))
    applied = _client_payment_applied_to_ar_amount(db, payment)
    if applied <= _q4(Decimal("0.0001")):
        if strict:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El pago con saldo a favor no tiene monto aplicado a facturas para registrar.",
            )
        logger.warning("Pago saldo a favor id=%s sin monto CxC; asiento omitido.", payment.id)
        _refresh_accounts_balance_cache(db, old_touch)
        return None

    advance_acc = ensure_customer_advance_liability(db, cur)
    ar_acc = ensure_accounts_receivable(db, cur)
    if normalize_currency_code(str(getattr(advance_acc, "currency", "") or cur)) != cur:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"La cuenta de anticipos no coincide con la moneda del pago ({cur}).",
        )
    if normalize_currency_code(str(getattr(ar_acc, "currency", "") or cur)) != cur:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"La cuenta CxC no coincide con la moneda del pago ({cur}).",
        )

    approved_at = getattr(payment, "approved_at", None)
    if approved_at is not None and hasattr(approved_at, "date"):
        entry_date = approved_at.date()
    else:
        created = getattr(payment, "created_at", None)
        entry_date = created.date() if created is not None and hasattr(created, "date") else date.today()

    pn = (payment.payment_number or f"PAG-{payment.id}").strip()
    memo = (payment.notes or "").strip().replace("\n", " ")[:120]
    desc = f"Cruce saldo a favor {pn} {applied} {cur} (DR anticipos / CR CxC)"
    if memo:
        desc += f" — {memo}"

    from app.services.currency_consolidation import payment_exchange_rate

    xr = payment_exchange_rate(payment, db)

    entry = _post_journal_atomic(
        db,
        entry_date=entry_date,
        reference_type=JournalReferenceType.client_payment.value,
        reference_id=int(payment.id),
        description=desc,
        lines=[
            JournalLineDraft(advance_acc.id, debit=applied, credit=Decimal("0"), exchange_rate=xr),
            JournalLineDraft(ar_acc.id, debit=Decimal("0"), credit=applied, exchange_rate=xr),
        ],
        fx_weighted=xr != Decimal("1"),
    )

    touched = old_touch | {int(advance_acc.id), int(ar_acc.id)}
    _refresh_accounts_balance_cache(db, touched)
    return entry


def sync_client_payment_journal(db: Session, payment, *, strict: bool = True) -> Optional[JournalEntry]:
    """
    Cobro CxC aprobado: DR banco / CR CxC (solo lo aplicado a facturas) + CR anticipos (excedente).

    El crédito a Cuentas por cobrar se topa al monto aplicado a facturas; el excedente va a
    pasivo «Anticipos de clientes» / «Saldos a favor» para no dejar CxC en negativo.
    """
    from app.models.client_payment import ClientPayment, ClientPaymentStatus, PaymentAllocation

    if not isinstance(payment, ClientPayment):
        raise TypeError("payment debe ser instancia de ClientPayment")

    old_touch = delete_journals_by_reference(
        db,
        JournalReferenceType.client_payment.value,
        int(payment.id),
    )

    if payment.status != ClientPaymentStatus.approved:
        _refresh_accounts_balance_cache(db, old_touch)
        return None

    if is_credit_only_client_payment(payment):
        return sync_client_credit_balance_payment_journal(db, payment, strict=strict)

    dep_id = getattr(payment, "deposit_account_id", None)
    if dep_id is None:
        from app.services.client_payment_service import resolve_client_payment_deposit_account_id

        resolved = resolve_client_payment_deposit_account_id(db, payment)
        if resolved is not None:
            dep_id = resolved
            payment.deposit_account_id = int(resolved)
    if dep_id is None:
        msg = (
            f"El pago {payment.payment_number} no tiene cuenta de depósito; "
            "no se puede registrar el cobro en el libro mayor."
        )
        if strict:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
        logger.warning(msg)
        _refresh_accounts_balance_cache(db, old_touch)
        return None

    bank = db.get(Account, int(dep_id))
    if bank is None or not bank.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cuenta de depósito del pago no existe o está inactiva.",
        )
    if bank.account_type != LedgerAccountType.asset.value:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cuenta de depósito debe ser un activo (banco/caja).",
        )

    cur = normalize_currency_code(str(payment.currency or "USD"))
    if normalize_currency_code(bank.currency) != cur:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La moneda del pago debe coincidir con la de la cuenta de depósito.",
        )

    ar_acc = ensure_accounts_receivable(db, cur)
    if normalize_currency_code(str(getattr(ar_acc, "currency", "") or cur)) != cur:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"La cuenta CxC del plan no coincide con la moneda del pago ({cur}).",
        )

    amt = _q4(payment.amount)
    if amt <= 0:
        _refresh_accounts_balance_cache(db, old_touch)
        return None

    applied_raw = (
        db.query(func.coalesce(func.sum(PaymentAllocation.amount_applied), 0))
        .filter(PaymentAllocation.payment_id == int(payment.id))
        .scalar()
    )
    applied_to_ar = _q4(applied_raw)
    if applied_to_ar <= _q4(Decimal("0.0001")):
        from app.services.client_payment_service import infer_client_payment_applied_to_ar

        inferred = infer_client_payment_applied_to_ar(db, payment)
        if inferred > _q4(Decimal("0.0001")):
            applied_to_ar = inferred
    if applied_to_ar > amt:
        applied_to_ar = amt
    advance_amt = _q4(amt - applied_to_ar)
    if advance_amt < Decimal("0"):
        advance_amt = Decimal("0")

    approved_at = getattr(payment, "approved_at", None)
    if approved_at is not None and hasattr(approved_at, "date"):
        entry_date = approved_at.date()
    else:
        created = getattr(payment, "created_at", None)
        entry_date = created.date() if created is not None and hasattr(created, "date") else date.today()

    pn = (payment.payment_number or f"PAG-{payment.id}").strip()
    memo = (payment.notes or "").strip().replace("\n", " ")[:120]
    desc = f"Cobro cliente {pn} {amt} {cur}"
    if applied_to_ar > 0 and advance_amt > 0:
        desc += f" (CxC {applied_to_ar} + anticipo {advance_amt})"
    elif advance_amt > 0:
        desc += f" (anticipo cliente {advance_amt})"
    if memo:
        desc += f" — {memo}"

    from app.services.currency_consolidation import payment_exchange_rate

    xr = payment_exchange_rate(payment, db)

    journal_lines: list[JournalLineDraft] = [
        JournalLineDraft(bank.id, debit=amt, credit=Decimal("0"), exchange_rate=xr),
    ]
    touched_accounts: set[int] = {int(bank.id)}

    if applied_to_ar > 0:
        journal_lines.append(
            JournalLineDraft(ar_acc.id, debit=Decimal("0"), credit=applied_to_ar, exchange_rate=xr)
        )
        touched_accounts.add(int(ar_acc.id))

    if advance_amt > 0:
        advance_acc = ensure_customer_advance_liability(db, cur)
        if normalize_currency_code(str(getattr(advance_acc, "currency", "") or cur)) != cur:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"La cuenta de anticipos no coincide con la moneda del pago ({cur}).",
            )
        journal_lines.append(
            JournalLineDraft(advance_acc.id, debit=Decimal("0"), credit=advance_amt, exchange_rate=xr)
        )
        touched_accounts.add(int(advance_acc.id))

    entry = _post_journal_atomic(
        db,
        entry_date=entry_date,
        reference_type=JournalReferenceType.client_payment.value,
        reference_id=int(payment.id),
        description=desc,
        lines=journal_lines,
        fx_weighted=xr != Decimal("1"),
    )

    touched = old_touch | touched_accounts
    _refresh_accounts_balance_cache(db, touched)
    return entry


def reverse_client_payment_journal(db: Session, payment_id: int, *, reason: str = "") -> list[JournalEntry]:
    """Asientos de reversión para un cobro CxC (sustituye borrar el historial)."""
    created, _ = reverse_journals_by_reference(
        db,
        JournalReferenceType.client_payment.value,
        int(payment_id),
        reason=reason or f"Reversión pago id={payment_id}",
    )
    return created


def delete_client_payment_journal(db: Session, payment_id: int) -> set[int]:
    """Elimina asientos del cobro CxC (solo regeneración idempotente; en anulaciones usar reversión)."""
    touched = delete_journals_by_reference(
        db,
        JournalReferenceType.client_payment.value,
        int(payment_id),
    )
    _refresh_accounts_balance_cache(db, touched)
    return touched


def reverse_sale_journal(db: Session, sale_id: int, *, reason: str = "") -> list[JournalEntry]:
    """Asientos de reversión del devengo y COGS de una venta."""
    ref = f"FAC-{int(sale_id):04d}"
    base_reason = reason or f"Reversión venta {ref}"
    created, _ = reverse_journals_by_reference(
        db,
        JournalReferenceType.venta.value,
        int(sale_id),
        reason=base_reason,
    )
    cogs_rev, _ = reverse_journals_by_reference(
        db,
        JournalReferenceType.venta_cogs.value,
        int(sale_id),
        reason=base_reason,
    )
    created.extend(cogs_rev)
    return created


def _refresh_accounts_balance_cache(db: Session, account_ids: set[int]) -> None:
    from app.api.v1.accounts import refresh_accounts_balance_cache

    refresh_accounts_balance_cache(db, account_ids)


def _find_sales_tax_expense_account(db: Session, currency: str) -> Account | None:
    """Impuesto sobre ventas (proxy QB): cuenta gasto «Tasas y comisiones» en misma moneda."""
    cur = normalize_currency_code(currency)
    return (
        db.query(Account)
        .filter(
            Account.parent_id.is_(None),
            Account.is_active.is_(True),
            Account.currency == cur,
            Account.account_type == LedgerAccountType.expense.value,
            Account.detail_type == "Tasas y comisiones",
        )
        .first()
    )


def find_accounts_payable(db: Session, currency: str) -> Account | None:
    """Pasivo «Cuentas por pagar» en la misma moneda."""
    cur = normalize_currency_code(currency)
    base = (
        db.query(Account)
        .filter(
            Account.parent_id.is_(None),
            Account.is_active.is_(True),
            Account.currency == cur,
            Account.account_type == LedgerAccountType.liability.value,
            Account.detail_type == "Cuentas por pagar",
        )
    )
    row = base.first()
    if row:
        return row
    return (
        db.query(Account)
        .filter(
            Account.parent_id.is_(None),
            Account.is_active.is_(True),
            Account.currency == cur,
            Account.name == "Cuentas por pagar",
        )
        .first()
    )


def post_manual_expense_journal(
    db: Session,
    *,
    expense_account_id: int,
    source_account_id: int,
    amount: Decimal,
    currency: str,
    entry_date: Optional[date] = None,
    notes: Optional[str] = None,
) -> JournalEntry:
    """
    Asiento manual gasto/comisión: DR cuenta gasto / CR activo o pasivo origen.
    Persiste en sesión; el llamador hace ``commit``.
    """
    exp = db.get(Account, expense_account_id)
    src = db.get(Account, source_account_id)
    if exp is None or src is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta no encontrada.")
    if not exp.is_active or not src.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Las cuentas deben estar activas.")
    if exp.account_type not in (LedgerAccountType.expense.value, LedgerAccountType.cost_of_sales.value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cuenta de gasto debe ser de tipo expense o cost_of_sales.",
        )
    if src.account_type not in (LedgerAccountType.asset.value, LedgerAccountType.liability.value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cuenta origen debe ser activo (banco) o pasivo (CxP).",
        )

    cur = normalize_currency_code(currency)
    if normalize_currency_code(exp.currency) != cur or normalize_currency_code(src.currency) != cur:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La moneda debe coincidir con la de ambas cuentas.",
        )

    amt = _q4(amount)
    if amt <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El importe debe ser mayor que cero.")

    tail = (notes or "").strip().replace("\n", " ")[:180]
    desc = tail or f"Gasto manual {amt} {cur}"

    from app.services.currency_consolidation import get_last_exchange_rate, normalize_exchange_rate

    hist_rate, _ = get_last_exchange_rate(db, cur)
    xr = normalize_exchange_rate(hist_rate, currency=cur)

    return _post_journal_atomic(
        db,
        entry_date=entry_date or date.today(),
        reference_type=JournalReferenceType.gasto.value,
        reference_id=None,
        description=desc,
        lines=[
            JournalLineDraft(exp.id, debit=amt, credit=Decimal("0"), exchange_rate=xr),
            JournalLineDraft(src.id, debit=Decimal("0"), credit=amt, exchange_rate=xr),
        ],
        fx_weighted=xr != Decimal("1"),
    )


def sync_expense_document_journal(db: Session, expense) -> Optional[JournalEntry]:
    """
    Gasto multilínea (módulo Expenses): DR categorías [+ impuesto] / CR cuenta de pago.
    Idempotente por ``reference_type=gasto`` + ``reference_id=expense.id``.
    """
    from app.models.expense import Expense

    if not isinstance(expense, Expense):
        raise TypeError("expense debe ser instancia de Expense")

    old_touch = delete_journals_by_reference(db, JournalReferenceType.gasto.value, int(expense.id))

    if expense.status != "posted":
        _refresh_accounts_balance_cache(db, old_touch)
        return None

    payment_acc = db.get(Account, expense.payment_account_id)
    if payment_acc is None or not payment_acc.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cuenta de pago inválida.")
    if payment_acc.account_type not in (LedgerAccountType.asset.value, LedgerAccountType.liability.value):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cuenta de pago debe ser activo (banco/caja) o pasivo.",
        )

    cur = normalize_currency_code(payment_acc.currency)
    memo = (expense.memo or "").strip().replace("\n", " ")[:120]
    desc = f"Gasto #{expense.id}" + (f" — {memo}" if memo else "")

    drafts: list[JournalLineDraft] = []
    subtotal = Decimal("0")
    lines_sorted = sorted(expense.lines, key=lambda ln: (ln.line_no, ln.id))

    for line in lines_sorted:
        exp_acc = db.get(Account, line.expense_account_id)
        if exp_acc is None or not exp_acc.is_active:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cuenta de categoría inválida.")
        if exp_acc.account_type not in (LedgerAccountType.expense.value, LedgerAccountType.cost_of_sales.value):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La categoría debe ser Gastos u Otros gastos (tipo expense) o Costos de venta.",
            )
        if normalize_currency_code(exp_acc.currency) != cur:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Todas las cuentas deben usar la misma moneda que la cuenta de pago.",
            )
        amt = _q4(line.amount)
        if amt <= 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Importe de línea inválido.")
        subtotal += amt
        drafts.append(JournalLineDraft(exp_acc.id, debit=amt, credit=Decimal("0")))

    tax_amt = _q4(expense.tax_amount)
    if tax_amt > 0:
        tax_acc = _find_sales_tax_expense_account(db, cur)
        if tax_acc is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Hay impuesto pero no existe cuenta de gasto «Tasas y comisiones» "
                    f"en moneda {cur}; créala en el plan de cuentas."
                ),
            )
        drafts.append(JournalLineDraft(tax_acc.id, debit=tax_amt, credit=Decimal("0")))

    expected_total = _q4(subtotal + tax_amt)
    declared_total = _q4(expense.total_amount)
    if expected_total != declared_total:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Total declarado {declared_total} no coincide con líneas + impuesto ({expected_total}).",
        )

    drafts.append(JournalLineDraft(payment_acc.id, debit=Decimal("0"), credit=declared_total))

    entry = _post_journal_atomic(
        db,
        entry_date=expense.payment_date,
        reference_type=JournalReferenceType.gasto.value,
        reference_id=int(expense.id),
        description=desc,
        lines=drafts,
    )

    touched = old_touch | {payment_acc.id}
    for line in expense.lines:
        touched.add(int(line.expense_account_id))
    if tax_amt > 0:
        ta = _find_sales_tax_expense_account(db, cur)
        if ta is not None:
            touched.add(int(ta.id))
    _refresh_accounts_balance_cache(db, touched)
    return entry


def validate_vendor_bill_line_account(acc: Account | None) -> None:
    if acc is None or not acc.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cuenta de categoría inválida.")
    dt = (acc.detail_type or "").strip().lower()
    if acc.account_type in (LedgerAccountType.expense.value, LedgerAccountType.cost_of_sales.value):
        return
    if acc.account_type == LedgerAccountType.asset.value and dt == "inventario":
        return
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="La categoría debe ser Gastos, Costos de venta o Inventario.",
    )


def _vendor_bill_currency(db: Session, bill) -> str:
    from app.models.vendor import Vendor

    v = getattr(bill, "vendor", None)
    if v is None:
        v = db.get(Vendor, bill.vendor_id)
    return normalize_currency_code(getattr(v, "currency", None))


def sync_vendor_bill_journal(db: Session, bill) -> JournalEntry:
    """
    Factura proveedor: DR líneas (gasto/inventario) / CR Cuentas por pagar.
    Idempotente por ``reference_type=vendor_bill`` + ``reference_id=bill.id``.
    """
    from app.models.vendor import VendorBill

    if not isinstance(bill, VendorBill):
        raise TypeError("bill debe ser instancia de VendorBill")

    old_touch = delete_journals_by_reference(db, JournalReferenceType.vendor_bill.value, int(bill.id))

    cur = _vendor_bill_currency(db, bill)
    ap_acc = find_accounts_payable(db, cur)
    if ap_acc is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"No existe cuenta «Cuentas por pagar» en moneda {cur}. Créala en el plan de cuentas.",
        )

    memo = (bill.memo or "").strip().replace("\n", " ")[:120]
    desc = f"Factura proveedor #{bill.id}" + (f" — {memo}" if memo else "")

    drafts: list[JournalLineDraft] = []
    subtotal = Decimal("0")
    sorted_lines = sorted(bill.lines, key=lambda ln: (ln.line_no, ln.id))

    for ln in sorted_lines:
        acc = db.get(Account, ln.account_id)
        validate_vendor_bill_line_account(acc)
        if normalize_currency_code(acc.currency) != cur:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Todas las cuentas deben estar en la moneda del proveedor/factura.",
            )
        amt = _q4(ln.amount)
        if amt <= 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Importe de línea inválido.")
        subtotal += amt
        drafts.append(JournalLineDraft(acc.id, debit=amt, credit=Decimal("0")))

    declared_total = _q4(bill.total_amount)
    if _q4(subtotal) != declared_total:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El total de la factura no coincide con la suma de líneas.",
        )

    drafts.append(JournalLineDraft(ap_acc.id, debit=Decimal("0"), credit=declared_total))

    entry = _post_journal_atomic(
        db,
        entry_date=bill.bill_date,
        reference_type=JournalReferenceType.vendor_bill.value,
        reference_id=int(bill.id),
        description=desc,
        lines=drafts,
    )

    touched = old_touch | {ap_acc.id}
    for ln in bill.lines:
        touched.add(int(ln.account_id))
    _refresh_accounts_balance_cache(db, touched)
    return entry


def sync_vendor_payment_journal(db: Session, payment) -> JournalEntry:
    """
    Pago a proveedor: DR Cuentas por pagar / CR banco (activo líquido).
    Idempotente por ``reference_type=vendor_payment`` + ``reference_id=payment.id``.
    """
    from app.account_constants import is_liquid_deposit_account
    from app.models.vendor import VendorPayment

    if not isinstance(payment, VendorPayment):
        raise TypeError("payment debe ser instancia de VendorPayment")

    old_touch = delete_journals_by_reference(db, JournalReferenceType.vendor_payment.value, int(payment.id))

    bank = db.get(Account, payment.payment_account_id)
    if bank is None or not bank.is_active:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cuenta de pago inválida.")
    if not is_liquid_deposit_account(bank):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cuenta de pago debe ser un activo líquido (Banco).",
        )

    cur = normalize_currency_code(bank.currency)
    ap_acc = find_accounts_payable(db, cur)
    if ap_acc is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"No existe cuenta «Cuentas por pagar» en moneda {cur}.",
        )

    total = _q4(payment.total_amount)
    if total <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El importe total debe ser mayor que cero.")

    memo = (payment.memo or "").strip().replace("\n", " ")[:120]
    desc = f"Pago proveedor #{payment.id}" + (f" — {memo}" if memo else "")

    entry = _post_journal_atomic(
        db,
        entry_date=payment.payment_date,
        reference_type=JournalReferenceType.vendor_payment.value,
        reference_id=int(payment.id),
        description=desc,
        lines=[
            JournalLineDraft(ap_acc.id, debit=total, credit=Decimal("0")),
            JournalLineDraft(bank.id, debit=Decimal("0"), credit=total),
        ],
    )

    touched = old_touch | {ap_acc.id, bank.id}
    _refresh_accounts_balance_cache(db, touched)
    return entry


TRANSFER_REFERENCE_TYPE = "transferencia"


def post_account_transfer(
    db: Session,
    *,
    source_account_id: int,
    destination_account_id: int,
    amount_src: Decimal,
    amount_dst: Decimal,
    exchange_rate: Decimal,
    transfer_date: date,
    description: str,
) -> tuple[JournalEntry, JournalEntryLine, JournalEntryLine]:
    """
    Transferencia entre cuentas líquidas vía libro mayor.

    En monedas distintas, ``exchange_rate`` es unidades destino por 1 unidad origen;
    la partida cuadra ponderando crédito origen × tasa frente al débito destino.
    """
    xr = _q6(exchange_rate)
    desc = (description or "").strip()[:255] or "Transferencia entre cuentas"

    lines = [
        JournalLineDraft(
            account_id=source_account_id,
            debit=Decimal("0"),
            credit=_q4(amount_src),
            exchange_rate=xr,
        ),
        JournalLineDraft(
            account_id=destination_account_id,
            debit=_q4(amount_dst),
            credit=Decimal("0"),
            exchange_rate=Decimal("1"),
        ),
    ]
    _validate_balanced(lines, fx_weighted=True)

    entry = JournalEntry(
        date=transfer_date,
        reference_type=TRANSFER_REFERENCE_TYPE,
        reference_id=None,
        description=desc,
        created_at=now_ecuador(),
    )
    db.add(entry)
    db.flush()

    src_line: Optional[JournalEntryLine] = None
    dst_line: Optional[JournalEntryLine] = None
    for draft in lines:
        row = JournalEntryLine(
            journal_entry_id=entry.id,
            account_id=draft.account_id,
            debit=_q4(draft.debit),
            credit=_q4(draft.credit),
            exchange_rate=_q6(draft.exchange_rate),
        )
        db.add(row)
        db.flush()
        if draft.account_id == source_account_id:
            src_line = row
        elif draft.account_id == destination_account_id:
            dst_line = row

    if src_line is None or dst_line is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="No se pudieron crear las líneas de transferencia.",
        )

    db.flush()
    return entry, src_line, dst_line
