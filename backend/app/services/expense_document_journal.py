"""Asientos de gastos (módulo Expenses) vía motor journal — sin tabla legacy ``transactions``."""

from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from app.models.expense import Expense
from app.models.journal_entry import JournalEntry, JournalReferenceType
from app.services.accounting_engine import delete_journals_by_reference, sync_expense_document_journal


def delete_vendor_expense_journal(db: Session, expense_id: int) -> set[int]:
    """Elimina asientos del gasto y devuelve cuentas afectadas."""
    from app.api.v1.accounts import refresh_accounts_balance_cache

    touched = delete_journals_by_reference(db, JournalReferenceType.gasto.value, expense_id)
    refresh_accounts_balance_cache(db, touched)
    return touched


def post_vendor_expense_journal(db: Session, expense: Expense) -> Optional[JournalEntry]:
    """
    Registra partida doble del gasto en ``journal_entries`` / ``journal_entry_lines``.

    DÉBITO: cuentas de gasto por línea (+ impuesto si aplica).
    CRÉDITO: cuenta de pago (activo / pasivo seleccionada en el formulario).
    """
    return sync_expense_document_journal(db, expense)
