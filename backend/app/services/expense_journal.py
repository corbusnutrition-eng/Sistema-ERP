"""Asiento manual gastos/comisiones vía motor journal (sin ``transactions``)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.services.accounting_engine import post_manual_expense_journal
from app.timezone_utils import ensure_aware


def post_expense_journal(
    db: Session,
    *,
    expense_account_id: int,
    source_account_id: int,
    amount: Decimal,
    currency: str,
    occurred_at: Optional[datetime] = None,
    notes: Optional[str] = None,
) -> tuple[int, int]:
    """
    DR cuenta gasto / CR cuenta origen (activo o pasivo).

    Returns:
        (debit_journal_line_id, credit_journal_line_id)
    """
    entry_date: Optional[date] = None
    if occurred_at is not None:
        occ = ensure_aware(occurred_at)
        entry_date = occ.date()

    entry = post_manual_expense_journal(
        db,
        expense_account_id=expense_account_id,
        source_account_id=source_account_id,
        amount=amount,
        currency=currency,
        entry_date=entry_date,
        notes=notes,
    )
    db.refresh(entry)

    dr_line_id = 0
    cr_line_id = 0
    for line in entry.lines:
        if Decimal(str(line.debit)) > 0:
            dr_line_id = int(line.id)
        if Decimal(str(line.credit)) > 0:
            cr_line_id = int(line.id)

    return dr_line_id, cr_line_id
