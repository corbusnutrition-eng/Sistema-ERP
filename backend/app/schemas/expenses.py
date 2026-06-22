from __future__ import annotations

import datetime
from decimal import Decimal
from typing import Any, Optional

from pydantic import BaseModel, Field


class ExpenseLineCreate(BaseModel):
    expense_account_id: int = Field(..., ge=1)
    description: Optional[str] = Field(default=None, max_length=500)
    amount: Decimal = Field(..., gt=0)
    customer_id: Optional[int] = Field(default=None, ge=1)
    class_id: Optional[int] = Field(default=None, ge=1)


class ExpenseLineResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    expense_id: int
    expense_account_id: int
    expense_account_name: str = ""
    description: Optional[str] = None
    amount: Decimal
    customer_id: Optional[int] = None
    customer_name: Optional[str] = None
    class_id: Optional[int] = None
    class_name: Optional[str] = None
    line_no: int


class ExpenseCreate(BaseModel):
    payee_id: int = Field(..., ge=1)
    payment_account_id: int = Field(..., ge=1)
    payment_date: datetime.date
    payment_method: Optional[str] = Field(default=None, max_length=120)
    reference_number: Optional[str] = Field(default=None, max_length=80)
    memo: Optional[str] = None
    tax_amount: Decimal = Field(default=Decimal("0"), ge=0)
    lines: list[ExpenseLineCreate] = Field(..., min_length=1)
    attachment_urls: list[str] = Field(default_factory=list)


class ExpenseResponse(BaseModel):
    model_config = {"from_attributes": True}

    id: int
    payee_id: int
    payee_name: str = ""
    payment_account_id: int
    payment_account_name: str = ""
    payment_date: datetime.date
    payment_method: Optional[str] = None
    reference_number: Optional[str] = None
    memo: Optional[str] = None
    subtotal_amount: Decimal
    tax_amount: Decimal
    total_amount: Decimal
    status: str
    attachments_json: list[Any] = Field(default_factory=list)
    created_at: datetime.datetime
    lines: list[ExpenseLineResponse] = Field(default_factory=list)


class ExpenseListItem(BaseModel):
    """Fila de lista estilo QB."""

    id: int
    payment_date: datetime.date
    type_label: str = "Gasto"
    reference_number: Optional[str] = None
    payee_name: str
    category_label: str
    currency: str = "USD"
    subtotal_amount: Decimal
    tax_amount: Decimal
    total_amount: Decimal
    status: str
