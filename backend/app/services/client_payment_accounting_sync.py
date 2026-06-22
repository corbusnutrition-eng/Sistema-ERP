"""Puente contable para cobros CxC (ClientPayment) → motor journal."""

from __future__ import annotations

from typing import Optional

from sqlalchemy.orm import Session

from app.models.client_payment import ClientPayment
from app.models.journal_entry import JournalEntry
from app.services.accounting_engine import (
    reverse_client_payment_journal,
    sync_client_payment_journal,
)


def sync_client_payment_accounting_ledgers(
    db: Session,
    payment: ClientPayment,
    *,
    strict: bool = True,
) -> Optional[JournalEntry]:
    """Registra cobro CxC: banco/anticipos según tipo de pago (sin ``commit``)."""
    from app.services.accounting_engine import (
        is_credit_only_client_payment,
        sync_client_credit_balance_payment_journal,
        sync_client_payment_journal,
    )

    if is_credit_only_client_payment(payment):
        return sync_client_credit_balance_payment_journal(db, payment, strict=strict)
    return sync_client_payment_journal(db, payment, strict=strict)


def remove_client_payment_accounting_ledgers(db: Session, payment_id: int) -> list[JournalEntry]:
    """Revierte asientos del pago (rechazo/anulación; conserva historial)."""
    return reverse_client_payment_journal(
        db,
        int(payment_id),
        reason=f"Reversión pago id={payment_id}",
    )
