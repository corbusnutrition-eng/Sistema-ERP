from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class InvoiceCreate(BaseModel):
    customer_name: str = Field(..., min_length=2, max_length=120)
    amount: float = Field(..., gt=0)
    status: Literal["pending", "paid", "cancelled"] = "pending"


class InvoiceRead(BaseModel):
    id: int
    customer_name: str
    amount: float
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}
