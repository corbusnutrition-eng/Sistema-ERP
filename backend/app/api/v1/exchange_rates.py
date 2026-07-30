"""API de tipos de cambio Binance P2P con override manual."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.v1.dependencies import AdminDep, UserDep
from app.database import get_db
from app.schemas.exchange_rate import (
    ExchangeRateListResponse,
    ExchangeRateRead,
    ExchangeRateSyncResult,
    ExchangeRateUpdateRequest,
)
from app.services.exchange_rate_service import (
    list_exchange_rates,
    resolve_active_rate,
    sync_exchange_rates_from_binance,
    update_exchange_rate,
)
from app.currency_utils import normalize_currency_code

router = APIRouter(prefix="/exchange-rates", tags=["exchange-rates"])

DbDep = Annotated[Session, Depends(get_db)]


def _to_read(row) -> ExchangeRateRead:
    return ExchangeRateRead(
        currency_code=str(row.currency_code),
        binance_rate=row.binance_rate,
        manual_rate=row.manual_rate,
        use_manual_override=bool(row.use_manual_override),
        active_rate=resolve_active_rate(row),
        updated_at=row.updated_at,
    )


@router.get("", response_model=ExchangeRateListResponse)
def get_exchange_rates(
    db: DbDep,
    _: UserDep,
) -> ExchangeRateListResponse:
    rows = list_exchange_rates(db)
    items = [_to_read(row) for row in rows]
    return ExchangeRateListResponse(items=items, total=len(items))


@router.put("/{currency_code}", response_model=ExchangeRateRead)
def put_exchange_rate(
    currency_code: str,
    payload: ExchangeRateUpdateRequest,
    db: DbDep,
    _: AdminDep,
) -> ExchangeRateRead:
    row = update_exchange_rate(
        db,
        currency_code=normalize_currency_code(currency_code),
        manual_rate=payload.manual_rate,
        use_manual_override=payload.use_manual_override,
    )
    return _to_read(row)


@router.post("/sync", response_model=ExchangeRateSyncResult)
def post_exchange_rates_sync(
    db: DbDep,
    _: AdminDep,
) -> ExchangeRateSyncResult:
    synced, failed = sync_exchange_rates_from_binance(db)
    if failed and synced == 0:
        message = "No se pudo sincronizar ninguna moneda. Se conservaron las tasas anteriores."
    elif failed:
        message = f"Sincronizadas {synced} moneda(s). Fallaron: {', '.join(failed)}."
    else:
        message = f"Sincronizadas {synced} moneda(s) desde Binance P2P."
    return ExchangeRateSyncResult(
        synced=synced,
        failed=failed,
        message=message,
    )
