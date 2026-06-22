"""Esquemas API — cuentas por pagar (proveedores)."""

from __future__ import annotations

import datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.currency_utils import normalize_currency_code


class VendorCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    company_name: Optional[str] = Field(default=None, max_length=300)
    email: Optional[str] = Field(default=None, max_length=254)
    phone: Optional[str] = Field(default=None, max_length=80)
    address: Optional[str] = Field(default=None, max_length=2000)
    currency: str = Field(default="USD", min_length=3, max_length=10)
    notes: Optional[str] = Field(default=None, max_length=8000)

    @field_validator("currency", mode="before")
    @classmethod
    def _norm_currency_vendor_create(cls, v: object) -> str:
        return normalize_currency_code(v) if v not in (None, "") else "USD"


class VendorUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    company_name: Optional[str] = Field(default=None, max_length=300)
    email: Optional[str] = Field(default=None, max_length=254)
    phone: Optional[str] = Field(default=None, max_length=80)
    address: Optional[str] = Field(default=None, max_length=2000)
    currency: Optional[str] = Field(default=None, min_length=3, max_length=10)
    notes: Optional[str] = Field(default=None, max_length=8000)

    @field_validator("currency", mode="before")
    @classmethod
    def _norm_currency_vendor_update(cls, v: object) -> Optional[str]:
        if v is None:
            return None
        if isinstance(v, str) and not v.strip():
            return None
        return normalize_currency_code(v)


class VendorResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    name: str
    company_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    currency: str
    notes: Optional[str] = None
    created_at: datetime.datetime


class VendorListRow(VendorResponse):
    """Ítem de tabla con métricas agregadas."""

    balance_pending: Decimal = Decimal("0")
    bill_count: int = 0
    has_overdue: bool = False


class VendorDashboardStats(BaseModel):
    never_billed: int
    with_open_balance: int
    paid_up: int


class VendorBillLineCreate(BaseModel):
    account_id: int = Field(..., ge=1)
    description: Optional[str] = Field(default=None, max_length=500)
    amount: Decimal = Field(..., gt=0)


class VendorBillCreate(BaseModel):
    vendor_id: int = Field(..., ge=1)
    bill_number: Optional[str] = Field(default=None, max_length=80)
    bill_date: datetime.date
    due_date: Optional[datetime.date] = None
    terms: Optional[str] = Field(default=None, max_length=200)
    memo: Optional[str] = Field(default=None, max_length=2000)
    lines: list[VendorBillLineCreate] = Field(..., min_length=1)


class VendorBillLineResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    bill_id: int
    account_id: int
    account_name: str = ""
    description: Optional[str] = None
    amount: Decimal
    line_no: int


class VendorBillResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    vendor_id: int
    vendor_name: str = ""
    bill_number: Optional[str] = None
    bill_date: datetime.date
    due_date: Optional[datetime.date] = None
    terms: Optional[str] = None
    memo: Optional[str] = None
    total_amount: Decimal
    balance_due: Decimal
    status: str
    created_at: datetime.datetime
    lines: list[VendorBillLineResponse] = Field(default_factory=list)


class VendorPaymentLineCreate(BaseModel):
    bill_id: int = Field(..., ge=1)
    amount_applied: Decimal = Field(..., gt=0)


class VendorPaymentCreate(BaseModel):
    vendor_id: int = Field(..., ge=1)
    payment_account_id: int = Field(..., ge=1)
    payment_date: datetime.date
    reference_number: Optional[str] = Field(default=None, max_length=120)
    memo: Optional[str] = Field(default=None, max_length=2000)
    lines: list[VendorPaymentLineCreate] = Field(..., min_length=1)


class VendorPaymentLineResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    payment_id: int
    bill_id: int
    bill_reference: Optional[str] = None
    amount_applied: Decimal


class VendorPaymentResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    vendor_id: int
    vendor_name: str = ""
    payment_account_id: int
    payment_account_name: str = ""
    payment_date: datetime.date
    reference_number: Optional[str] = None
    memo: Optional[str] = None
    total_amount: Decimal
    created_at: datetime.datetime
    lines: list[VendorPaymentLineResponse] = Field(default_factory=list)


class VendorLedgerRow(BaseModel):
    """Fila unificada factura/pago para historial QB."""

    date: datetime.date
    sort_ts: datetime.datetime
    row_kind: str  # vendor_bill | vendor_payment
    record_id: int
    transaction_type_label: str
    reference_display: str
    category_label: str
    beneficiary_label: str
    amount_signed: Decimal
    bill_balance_due: Optional[Decimal] = None  # Solo filas factura — saldo pendiente actual
    overdue: Optional[bool] = None


class VendorDetailResponse(VendorResponse):
    balance_pending: Decimal = Decimal("0")
