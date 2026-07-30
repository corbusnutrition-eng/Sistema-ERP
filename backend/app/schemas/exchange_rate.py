from __future__ import annotations

import datetime
from typing import Optional

from pydantic import BaseModel, Field


class ExchangeRateRead(BaseModel):
    currency_code: str
    binance_rate: Optional[float] = None
    manual_rate: Optional[float] = None
    use_manual_override: bool = False
    is_active: bool = True
    display_order: int = 0
    active_rate: Optional[float] = None
    updated_at: datetime.datetime

    model_config = {"from_attributes": True}


class ExchangeRateCreateRequest(BaseModel):
    currency_code: str = Field(..., min_length=3, max_length=10)


class ExchangeRateUpdateRequest(BaseModel):
    manual_rate: Optional[float] = Field(default=None, gt=0)
    use_manual_override: Optional[bool] = None
    display_order: Optional[int] = Field(default=None, ge=0)


class ExchangeRateSyncResult(BaseModel):
    ok: bool = True
    synced: int = Field(ge=0)
    failed: list[str] = Field(default_factory=list)
    message: str = "Sincronización completada."


class ExchangeRateListResponse(BaseModel):
    items: list[ExchangeRateRead]
    total: int = Field(ge=0)
