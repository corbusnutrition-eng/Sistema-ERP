from __future__ import annotations

import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


class ExchangeRateRead(BaseModel):
    currency_code: str
    binance_rate: Optional[float] = None
    manual_rate: Optional[float] = None
    use_manual_override: bool = False
    is_active: bool = True
    display_order: int = 0
    tolerance_type: Optional[Literal["percentage", "value"]] = None
    tolerance_value: Optional[float] = None
    active_rate: Optional[float] = None
    updated_at: datetime.datetime

    model_config = {"from_attributes": True}


class ExchangeRateCreateRequest(BaseModel):
    currency_code: str = Field(..., min_length=3, max_length=10)


class ExchangeRateUpdateRequest(BaseModel):
    manual_rate: Optional[float] = Field(default=None, gt=0)
    use_manual_override: Optional[bool] = None
    display_order: Optional[int] = Field(default=None, ge=0)
    tolerance_type: Optional[Literal["percentage", "value"]] = None
    tolerance_value: Optional[float] = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_tolerance_pair(self) -> "ExchangeRateUpdateRequest":
        if self.tolerance_type is None:
            return self
        if self.tolerance_value is None or float(self.tolerance_value) <= 0:
            raise ValueError("Indica un valor de tolerancia válido para la regla seleccionada.")
        return self


class ExchangeRateOrderItem(BaseModel):
    currency_code: str = Field(..., min_length=3, max_length=10)
    display_order: int = Field(..., ge=0)


class ExchangeRateReorderRequest(BaseModel):
    items: list[ExchangeRateOrderItem] = Field(..., min_length=1)


class ExchangeRateSyncResult(BaseModel):
    ok: bool = True
    synced: int = Field(ge=0)
    failed: list[str] = Field(default_factory=list)
    message: str = "Sincronización completada."


class ExchangeRateListResponse(BaseModel):
    items: list[ExchangeRateRead]
    total: int = Field(ge=0)
