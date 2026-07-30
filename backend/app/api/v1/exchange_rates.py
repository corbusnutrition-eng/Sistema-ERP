"""API de tipos de cambio de mercado USD con override manual."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.v1.dependencies import AdminDep, UserDep
from app.database import get_db
from app.schemas.exchange_rate import (
    ExchangeRateCreateRequest,
    ExchangeRateListResponse,
    ExchangeRateRead,
    ExchangeRateReorderRequest,
    ExchangeRateSyncResult,
    ExchangeRateUpdateRequest,
)
from app.services.exchange_rate_service import (
    create_exchange_rate,
    list_exchange_rates,
    reorder_exchange_rates,
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
        is_active=bool(row.is_active),
        display_order=int(row.display_order or 0),
        tolerance_type=row.tolerance_type,
        tolerance_value=row.tolerance_value,
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


@router.post("", response_model=ExchangeRateRead, status_code=201)
def post_exchange_rate(
    payload: ExchangeRateCreateRequest,
    db: DbDep,
    _: AdminDep,
) -> ExchangeRateRead:
    """Agrega (o reactiva) una moneda y obtiene su tasa desde Open Exchange Rates."""
    row = create_exchange_rate(db, currency_code=payload.currency_code)
    return _to_read(row)


@router.post("/reorder", status_code=204)
def post_exchange_rates_reorder(
    payload: ExchangeRateReorderRequest,
    db: DbDep,
    _: AdminDep,
) -> None:
    """Actualiza ``display_order`` de varias monedas en una sola transacción."""
    reorder_exchange_rates(
        db,
        order_updates=[(item.currency_code, item.display_order) for item in payload.items],
    )


@router.put("/{currency_code}", response_model=ExchangeRateRead)
def put_exchange_rate(
    currency_code: str,
    payload: ExchangeRateUpdateRequest,
    db: DbDep,
    _: AdminDep,
) -> ExchangeRateRead:
    payload_data = payload.model_dump(exclude_unset=True)
    clear_tolerance = "tolerance_type" in payload_data and payload_data["tolerance_type"] is None

    row = update_exchange_rate(
        db,
        currency_code=normalize_currency_code(currency_code),
        manual_rate=payload.manual_rate,
        use_manual_override=payload.use_manual_override,
        display_order=payload.display_order,
        tolerance_type=payload.tolerance_type,
        tolerance_value=payload.tolerance_value,
        clear_tolerance=clear_tolerance,
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
        message = f"Sincronizadas {synced} moneda(s) desde Open Exchange Rates."
    return ExchangeRateSyncResult(
        synced=synced,
        failed=failed,
        message=message,
    )
