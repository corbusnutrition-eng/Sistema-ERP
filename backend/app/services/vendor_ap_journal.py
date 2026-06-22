"""Asientos CxP — facturas y pagos de proveedor vía motor journal (sin ``transactions``)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.journal_entry import JournalEntry, JournalReferenceType
from app.models.vendor import VendorBill, VendorPayment
from app.services.accounting_engine import (
    delete_journals_by_reference,
    sync_vendor_bill_journal,
    sync_vendor_payment_journal,
    validate_vendor_bill_line_account,
)

# Compatibilidad con importadores existentes
validate_bill_line_account = validate_vendor_bill_line_account


def delete_vendor_bill_journal(db: Session, bill_id: int) -> set[int]:
    from app.api.v1.accounts import refresh_accounts_balance_cache

    touched = delete_journals_by_reference(db, JournalReferenceType.vendor_bill.value, bill_id)
    refresh_accounts_balance_cache(db, touched)
    return touched


def delete_vendor_payment_journal(db: Session, payment_id: int) -> set[int]:
    from app.api.v1.accounts import refresh_accounts_balance_cache

    touched = delete_journals_by_reference(db, JournalReferenceType.vendor_payment.value, payment_id)
    refresh_accounts_balance_cache(db, touched)
    return touched


def post_vendor_bill_journal(db: Session, bill: VendorBill) -> JournalEntry:
    """
    Factura proveedor: DR gasto/inventario por línea / CR Cuentas por pagar.
    """
    return sync_vendor_bill_journal(db, bill)


def post_vendor_payment_journal(db: Session, payment: VendorPayment) -> JournalEntry:
    """
    Pago proveedor: DR Cuentas por pagar / CR banco (activo líquido).
    """
    return sync_vendor_payment_journal(db, payment)
