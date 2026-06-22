"""
Asientos automáticos ligados a ventas (partida doble).

Convención de ``transactions.monto_convertido_a_base`` / ``monto_original``:
- Débito a una cuenta → saldo positivo en la línea.
- Crédito → saldo negativo.

Convención ``description``:
- ``AUTO-SALE-<id>-JE`` — asiento compuesto de la venta (CR ingresos, DR banco si hubo cobro, DR CxC por saldo pendiente).
  Omitidas del libro mayor mezclado con líneas de ventas para evitar duplicar efectivo.
"""

from __future__ import annotations

import logging
from datetime import datetime
from decimal import Decimal
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.api.v1.accounts import refresh_accounts_balance_cache
from app.currency_utils import normalize_currency_code
from app.models.account import Account, LedgerAccountType
from app.models.sale import Sale, SaleStatus
from app.models.transaction import Transaction
from app.timezone_utils import ensure_aware, to_utc


AUTO_SALE_PREFIX = "AUTO-SALE-"

logger = logging.getLogger(__name__)


def _q_amt(v: Decimal | float | str) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.0001"))


def invoice_amount_local(sale: Sale) -> Decimal:
    if sale.local_amount is not None:
        return _q_amt(sale.local_amount)
    return _q_amt(sale.amount)


def amount_paid_local(sale: Sale) -> Decimal:
    ap = getattr(sale, "amount_paid", None)
    if ap is None:
        return Decimal("0")
    return _q_amt(ap)


def find_accounts_receivable(db: Session, currency: str) -> Optional[Account]:
    """
    CxC por moneda: prioriza tipo QuickBooks (``asset`` + detail_type), etiqueta legacy en español
    si existiera en BD, y nombre sembrado.
    """
    cur = normalize_currency_code(currency)
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
    name = f"Cuentas x cobrar ({cur})"
    return (
        db.query(Account)
        .filter(Account.name == name, Account.parent_id.is_(None), Account.is_active.is_(True))
        .first()
    )


def find_revenue_sales_account(db: Session) -> Optional[Account]:
    """Ingreso por ventas: ``detail_type`` o nombre legacy."""
    row = (
        db.query(Account)
        .filter(
            Account.parent_id.is_(None),
            Account.is_active.is_(True),
            Account.detail_type == "Venta de productos y Servicios",
        )
        .first()
    )
    if row is not None:
        return row
    return (
        db.query(Account)
        .filter(
            Account.name == "Venta de productos y Servicios",
            Account.parent_id.is_(None),
            Account.is_active.is_(True),
        )
        .first()
    )


def delete_sale_auto_journals(db: Session, sale_id: int) -> set[int]:
    """Elimina líneas AUTO-SALE del libro y devuelve ids de cuentas afectadas (para refrescar saldos)."""
    prefix = f"{AUTO_SALE_PREFIX}{sale_id}-"
    filt = (
        Transaction.description.isnot(None),
        Transaction.description.startswith(prefix),
    )
    ids = {
        int(aid)
        for (aid,) in db.query(Transaction.account_id).filter(*filt).distinct().all()
    }
    db.query(Transaction).filter(*filt).delete(synchronize_session=False)
    return ids


def _occurred_at(sale: Sale) -> datetime:
    return ensure_aware(sale.created_at)


def _append_tx(
    db: Session,
    *,
    account_id: int,
    occurred_at: datetime,
    amount_signed: Decimal,
    currency: str,
    description: str,
    related_account_id: Optional[int] = None,
) -> None:
    amt = _q_amt(amount_signed)
    cur = normalize_currency_code(currency)
    db.add(
        Transaction(
            account_id=account_id,
            occurred_at=to_utc(occurred_at),
            related_account_id=related_account_id,
            description=(description or "")[:255],
            monto_original=amt.copy_abs(),
            moneda_original=cur,
            tasa_cambio_del_dia=Decimal("1"),
            monto_convertido_a_base=amt,
        ),
    )


def sync_sale_journal_entries(db: Session, sale: Sale, *, strict: bool = False) -> None:
    """
    Regenera el asiento automático de la venta (creación pendiente, PATCH, activación).

    Partida doble (signo: débito +, crédito −), todo en ``sale.currency``:
    - CR ingresos por el total facturado.
    - DR banco por ``amount_paid`` (>0 y cuenta depósito válida y misma moneda).
    - DR CxC por ``total − amount_paid`` si queda saldo por cobrar.

    Se aplica con venta ``pending`` o ``approved``. En ``cancelled`` / ``rejected`` / ``annulled``
    solo se eliminan los movimientos AUTO previos.

    ``strict=True`` (ERP): si el catálogo no permite completar la partida, lanza 400.
    ``strict=False``: omite el asiento y deja constancia en logs (flujos públicos legacy).
    """
    cleared_accounts = delete_sale_auto_journals(db, sale.id)

    if sale.status in (SaleStatus.cancelled, SaleStatus.rejected, SaleStatus.annulled):
        refresh_accounts_balance_cache(db, cleared_accounts)
        return
    if sale.status not in (SaleStatus.pending, SaleStatus.payment_submitted, SaleStatus.approved):
        refresh_accounts_balance_cache(db, cleared_accounts)
        return

    total = invoice_amount_local(sale)
    if total <= 0:
        refresh_accounts_balance_cache(db, cleared_accounts)
        return

    paid_raw = amount_paid_local(sale)
    paid = min(paid_raw, total) if paid_raw > 0 else Decimal("0")
    balance_due = _q_amt(total - paid)
    if balance_due < 0:
        balance_due = Decimal("0")

    cur = normalize_currency_code(sale.currency)

    income = find_revenue_sales_account(db)
    cxc = find_accounts_receivable(db, cur) if balance_due > 0 else None

    dep_id = getattr(sale, "deposit_account_id", None)
    bank: Optional[Account] = None
    bank_errors: list[str] = []
    if paid > 0:
        if dep_id is None:
            bank_errors.append(
                "Hay monto pagado pero falta la cuenta de depósito (deposit_account_id).",
            )
        else:
            bank = db.get(Account, dep_id)
            if bank is None or not bank.is_active:
                bank_errors.append("La cuenta de depósito no existe o está inactiva.")
            else:
                b_cur = normalize_currency_code(bank.currency)
                if b_cur != cur:
                    bank_errors.append(
                        "La moneda de la cuenta de depósito debe coincidir con la de la venta.",
                    )

    errors: list[str] = []
    if income is None:
        errors.append(
            "No se encontró la cuenta de ingresos con detail_type «Venta de productos y Servicios».",
        )
    errors.extend(bank_errors)
    if balance_due > 0 and cxc is None:
        errors.append(f"No hay cuenta de cuentas por cobrar para la moneda {cur}.")
        logger.warning(
            "CxC no encontrada para venta id=%s moneda=%s saldo_pendiente=%s",
            sale.id,
            cur,
            balance_due,
        )

    if errors:
        msg = " ".join(errors)
        refresh_accounts_balance_cache(db, cleared_accounts)
        if strict:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=msg)
        logger.warning("Asiento AUTO-SALE omitido (sale id=%s): %s", sale.id, msg)
        return

    assert income is not None  # errores vacíos garantizan income

    occ = _occurred_at(sale)
    tag = f"{AUTO_SALE_PREFIX}{sale.id}-JE"

    if balance_due > 0 and cxc is not None:
        logger.info(
            "Registrando saldo por cobrar %.4f %s en cuenta id=%s (%s)",
            balance_due,
            cur,
            cxc.id,
            cxc.name,
        )

    rel_income = cxc.id if cxc is not None else (bank.id if bank is not None else None)

    # Crédito ingresos (total facturado)
    _append_tx(
        db,
        account_id=income.id,
        occurred_at=occ,
        amount_signed=-total,
        currency=cur,
        description=tag,
        related_account_id=rel_income,
    )

    # Débito banco (cobrado)
    if paid > 0 and bank is not None:
        _append_tx(
            db,
            account_id=bank.id,
            occurred_at=occ,
            amount_signed=paid,
            currency=cur,
            description=tag,
            related_account_id=income.id,
        )

    # Débito CxC (pendiente)
    if balance_due > 0 and cxc is not None:
        _append_tx(
            db,
            account_id=cxc.id,
            occurred_at=occ,
            amount_signed=balance_due,
            currency=cur,
            description=tag,
            related_account_id=income.id,
        )

    touched: set[int] = set(cleared_accounts)
    touched.add(income.id)
    if bank is not None:
        touched.add(bank.id)
    if cxc is not None:
        touched.add(cxc.id)
    refresh_accounts_balance_cache(db, touched)
