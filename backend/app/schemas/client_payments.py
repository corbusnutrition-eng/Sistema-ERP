from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class PaymentAllocationOut(BaseModel):
    sale_id: int
    sale_ref: str
    amount_applied: Decimal
    currency: Optional[str] = None
    sale_date: Optional[datetime] = None
    invoice_total: Optional[float] = None
    open_balance: Optional[float] = None


class ClientPaymentOut(BaseModel):
    id: int
    payment_number: str
    client_id: int
    client_name: Optional[str] = None
    amount: Decimal
    currency: str
    status: str
    payment_method: Optional[str] = None
    payment_method_id: Optional[int] = None
    reference_number: Optional[str] = None
    receipt_file_url: Optional[str] = None
    deposit_account_id: Optional[int] = None
    notes: Optional[str] = None
    created_at: Optional[datetime] = None
    approved_at: Optional[datetime] = None
    allocations: list[PaymentAllocationOut] = Field(default_factory=list)
    encapsulated_in_sale_review: bool = Field(
        default=False,
        description=(
            "True si el pago es el comprobante inicial de una venta pending/payment_submitted "
            "y debe revisarse desde la fila de la venta (no como abono suelto)."
        ),
    )

    model_config = {"from_attributes": True}


class PortalAbonoResponse(BaseModel):
    message: str
    payment_id: int
    payment_number: str
    status: str


class UnpaidInvoiceOut(BaseModel):
    sale_id: int
    reference: str
    date: Optional[datetime] = None
    total_amount: float
    open_balance: float
    currency: str = "USD"


class PaymentAllocationIn(BaseModel):
    sale_id: int
    applied_amount: float = Field(gt=0, description="Monto a aplicar a esta factura.")


class PaymentCreateBody(BaseModel):
    """Crear y aprobar un pago manual desde admin (Recibir pago)."""

    client_id: int
    amount: Decimal = Field(gt=0)
    currency: str = "USD"
    exchange_rate: float = Field(
        default=1.0,
        gt=0,
        description="Unidades de moneda local por 1 USD (consolidación P&L).",
    )
    deposit_account_id: Optional[int] = None
    reference_number: Optional[str] = None
    notes: Optional[str] = None
    allocations: list[PaymentAllocationIn] = Field(default_factory=list)


class PaymentApproveBody(BaseModel):
    """Asignación explícita a facturas; si vacío, FIFO automático."""

    allocations: list[PaymentAllocationIn] = Field(default_factory=list)
    amount: Optional[Decimal] = Field(
        default=None,
        gt=0,
        description="Importe total cobrado (permite sobrepago; el excedente va a saldo a favor).",
    )
    reference_number: Optional[str] = None
    notes: Optional[str] = None


class LedgerRelatedDoc(BaseModel):
    type: str
    ref_number: str
    amount: float
    sale_id: Optional[int] = None


class LedgerEntry(BaseModel):
    date: str
    type: str
    ref_number: str
    note: str
    amount: float
    currency: str
    status: str
    entity_id: int
    entity_kind: str
    payment_id: Optional[int] = None
    receipt_file_url: Optional[str] = None
    related_docs: list[LedgerRelatedDoc] = Field(default_factory=list)
    wallet_transaction_id: Optional[int] = None
    can_revert: bool = False
    revert_counterparty_id: Optional[int] = None
    revert_counterparty_name: Optional[str] = None
    baas_transfer_amount: Optional[float] = None


class ClientLedgerResponse(BaseModel):
    client_id: int
    entries: list[LedgerEntry]
