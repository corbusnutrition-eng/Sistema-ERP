"""Operaciones administrativas sobre movimientos BaaS (Control Total / God Mode)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.v1.dependencies import AdminDep
from app.database import get_db
from app.services.client_reseller_service import revert_baas_wallet_transfer

router = APIRouter(prefix="/admin", tags=["admin"])

DbDep = Annotated[Session, Depends(get_db)]


class BaasTransferRevertResponse(BaseModel):
    ok: bool = True
    message: str
    amount_reverted: float = Field(ge=0)
    sender_client_id: int
    sender_client_name: str
    receiver_client_id: int
    receiver_client_name: str
    original_transaction_id: int
    reversal_transaction_ids: list[int] = Field(default_factory=list)


@router.post(
    "/transactions/{transaction_id}/revert",
    response_model=BaasTransferRevertResponse,
    summary="Revertir transferencia BaaS (solo administrador)",
)
def revert_baas_transfer(
    transaction_id: int,
    db: DbDep,
    _: AdminDep,
) -> BaasTransferRevertResponse:
    """
    Devuelve saldo BaaS del sub-cliente al distribuidor emisor.

    Valida saldo suficiente en el receptor; no permite saldo negativo.
    """
    result = revert_baas_wallet_transfer(db, int(transaction_id))
    return BaasTransferRevertResponse(**result)
