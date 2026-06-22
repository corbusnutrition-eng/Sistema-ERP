"""Tipos de cambio históricos y utilidades de moneda."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from app.api.v1.dependencies import AdminDep
from app.currency_utils import normalize_currency_code
from app.database import get_db
from app.services.currency_consolidation import get_last_exchange_rate
from sqlalchemy.orm import Session
from fastapi import Depends
from pydantic import BaseModel, Field

router = APIRouter(prefix="/currency", tags=["currency"])

DbDep = Annotated[Session, Depends(get_db)]


class LastExchangeRateResponse(BaseModel):
    currency: str = Field(..., description="Código ISO de la moneda.")
    exchange_rate: float = Field(
        ...,
        gt=0,
        description="Unidades de moneda local por 1 USD (última transacción o valor sugerido).",
    )
    from_history: bool = Field(
        default=False,
        description="True si la tasa proviene de una venta, pago o recarga BaaS previa.",
    )
    base_currency: str = Field(default="USD", description="Moneda de consolidación.")


@router.get("/last-rate", response_model=LastExchangeRateResponse)
def get_last_rate(
    db: DbDep,
    _: AdminDep,
    currency: str = Query(..., min_length=3, max_length=10, description="Moneda local (ej. BOB)."),
) -> LastExchangeRateResponse:
    """Devuelve el ``exchange_rate`` de la última venta, pago o recarga BaaS en esa moneda."""
    cur = normalize_currency_code(currency)
    rate, from_history = get_last_exchange_rate(db, cur)
    return LastExchangeRateResponse(
        currency=cur,
        exchange_rate=rate,
        from_history=from_history,
        base_currency="USD",
    )
