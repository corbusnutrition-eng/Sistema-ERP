from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


class PaymentMethodCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        t = (v or "").strip()
        if not t:
            raise ValueError("El nombre es obligatorio.")
        return t


class PaymentMethodUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        t = (v or "").strip()
        if not t:
            raise ValueError("El nombre es obligatorio.")
        return t


class PaymentMethodStatusUpdate(BaseModel):
    is_active: bool


class PaymentMethodResponse(BaseModel):
    id: int
    name: str
    is_active: bool

    model_config = {"from_attributes": True}
