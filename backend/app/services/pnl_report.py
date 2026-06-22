"""Construcción jerárquica del estado de resultados (P&L) tipo QuickBooks — consolidado en USD."""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal
from typing import Optional

from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.models.account import Account
from app.models.journal_entry import JournalEntry, JournalEntryLine
from app.schemas.reports_financial import PnlAccountRow
from app.services.accounting_engine import FINANCIAL_EXPENSE_DETAILS

_OTROS_INGRESOS_DETAILS = frozenset({"Otros ingresos principales"})
# No agrupar contra-cuentas de COGS bajo «Costo de Ventas» en el P&L.
_COGS_PNL_EXCLUDED_DETAIL_TYPES = frozenset({"Descuentos", "descuentos"})
_EPS = Decimal("0.0001")


def _q2(v: Decimal) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.01"))


def _pnl_section_key(account_type: str, detail_type: Optional[str]) -> str:
    dt = (detail_type or "").strip()
    if account_type == "income":
        if dt in _OTROS_INGRESOS_DETAILS:
            return "otros_ingresos"
        return "ingresos"
    if account_type == "cost_of_sales":
        if dt in _COGS_PNL_EXCLUDED_DETAIL_TYPES:
            return "other"
        return "costo_ventas"
    if account_type == "expense":
        if dt in FINANCIAL_EXPENSE_DETAILS:
            return "otros_gastos_financieros"
        return "gastos"
    return "other"


def _fetch_account_activity(
    db: Session,
    start_date: date,
    end_date: date,
) -> dict[int, Decimal]:
    """
    Monto por cuenta en **USD** (actividad P&L del periodo).

    Cada línea del libro mayor se convierte con su ``exchange_rate`` histórico
    (unidades de moneda local por 1 USD).
    """
    xr_safe = func.coalesce(func.nullif(JournalEntryLine.exchange_rate, 0), 1)
    income_usd = (JournalEntryLine.credit - JournalEntryLine.debit) / xr_safe
    expense_usd = (JournalEntryLine.debit - JournalEntryLine.credit) / xr_safe
    usd_net = case(
        (Account.account_type == "income", income_usd),
        else_=expense_usd,
    )

    rows = (
        db.query(
            Account.id,
            func.coalesce(func.sum(usd_net), 0),
        )
        .join(JournalEntryLine, JournalEntryLine.account_id == Account.id)
        .join(JournalEntry, JournalEntry.id == JournalEntryLine.journal_entry_id)
        .filter(
            JournalEntry.date >= start_date,
            JournalEntry.date <= end_date,
            Account.account_type.in_(("income", "expense", "cost_of_sales")),
            Account.is_active.is_(True),
        )
        .group_by(Account.id)
        .all()
    )
    out: dict[int, Decimal] = {}
    for aid, amt_raw in rows:
        amt = _q2(Decimal(str(amt_raw)))
        if abs(amt) >= _EPS:
            out[int(aid)] = amt
    return out


def _build_account_forest(
    db: Session,
    activity: dict[int, Decimal],
) -> tuple[dict[int, Account], dict[Optional[int], list[Account]], dict[int, str]]:
    if not activity:
        accounts = (
            db.query(Account)
            .filter(
                Account.is_active.is_(True),
                Account.account_type.in_(("income", "expense", "cost_of_sales")),
            )
            .all()
        )
    else:
        needed: set[int] = set(activity.keys())
        all_accs = (
            db.query(Account)
            .filter(
                Account.is_active.is_(True),
                Account.account_type.in_(("income", "expense", "cost_of_sales")),
            )
            .all()
        )
        by_id = {int(a.id): a for a in all_accs}
        for aid in list(activity.keys()):
            cur = by_id.get(aid)
            while cur is not None and cur.parent_id is not None:
                pid = int(cur.parent_id)
                if pid in needed:
                    break
                needed.add(pid)
                cur = by_id.get(pid)
        accounts = [by_id[i] for i in needed if i in by_id]

    by_id = {int(a.id): a for a in accounts}
    children_map: dict[Optional[int], list[Account]] = defaultdict(list)
    section_by_id: dict[int, str] = {}
    for a in accounts:
        children_map[a.parent_id].append(a)
        section_by_id[int(a.id)] = _pnl_section_key(a.account_type, a.detail_type)
    for pid in children_map:
        children_map[pid].sort(key=lambda x: (x.name or "").lower())
    return by_id, children_map, section_by_id


def _subtree_total(aid: int, activity: dict[int, Decimal], children_map: dict[Optional[int], list[Account]]) -> Decimal:
    direct = activity.get(aid, Decimal("0"))
    total = direct
    for ch in children_map.get(aid, []):
        total += _subtree_total(int(ch.id), activity, children_map)
    return total


def _build_row(
    aid: int,
    by_id: dict[int, Account],
    activity: dict[int, Decimal],
    children_map: dict[Optional[int], list[Account]],
) -> Optional[PnlAccountRow]:
    acc = by_id.get(aid)
    if acc is None:
        return None
    subs: list[PnlAccountRow] = []
    for ch in children_map.get(aid, []):
        row = _build_row(int(ch.id), by_id, activity, children_map)
        if row is not None:
            subs.append(row)
    total = _subtree_total(aid, activity, children_map)
    if abs(total) < _EPS and not subs:
        return None
    return PnlAccountRow(
        cuenta=acc.name,
        account_id=int(acc.id),
        monto=_q2(total),
        subcuentas=subs,
    )


def build_pnl_category_trees(
    db: Session,
    start_date: date,
    end_date: date,
) -> dict[str, list[PnlAccountRow]]:
    """
    Árbol de cuentas por bloque P&L (montos consolidados en USD).

    Claves: ``ingresos``, ``otros_ingresos``, ``costo_ventas``, ``gastos``, ``otros_gastos_financieros``.
    """
    activity = _fetch_account_activity(db, start_date, end_date)
    by_id, children_map, section_by_id = _build_account_forest(db, activity)

    roots_by_section: dict[str, list[int]] = defaultdict(list)
    for aid, acc in by_id.items():
        if acc.parent_id is not None and int(acc.parent_id) in by_id:
            continue
        sec = section_by_id.get(aid, "other")
        if sec != "other":
            roots_by_section[sec].append(aid)

    out: dict[str, list[PnlAccountRow]] = {
        "ingresos": [],
        "otros_ingresos": [],
        "costo_ventas": [],
        "gastos": [],
        "otros_gastos_financieros": [],
    }
    for sec, root_ids in roots_by_section.items():
        rows: list[PnlAccountRow] = []
        for rid in sorted(root_ids, key=lambda i: (by_id[i].name or "").lower()):
            row = _build_row(rid, by_id, activity, children_map)
            if row is not None:
                rows.append(row)
        out[sec] = rows
    return out


def sum_pnl_rows(rows: list[PnlAccountRow]) -> Decimal:
    return _q2(sum((r.monto for r in rows), Decimal("0")))
