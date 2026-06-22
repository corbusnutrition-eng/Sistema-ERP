"""Acciones administrativas sobre clientes BaaS (bloqueo y ajuste de saldo)."""

from __future__ import annotations

import os
import uuid as uuid_module
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.v1.dependencies import AdminDep
from app.database import get_db
from app.models.client import CLIENT_STATUSES, Client
from app.models.wallet_transaction import WalletTransaction
from app.schemas.client_payment_methods import (
    ClientPaymentMethodsConfigResponse,
    ClientPaymentMethodsUpsertBody,
    ClientPaymentMethodsUpsertResponse,
)
from app.schemas.client_product_prices import (
    AdminClientAssignedPackagePrice,
    AdminClientPackagePriceRow,
    AdminClientPackagePricesUpsertBody,
    AdminClientPackagePricesUpsertResponse,
)
from app.services.client_payment_method_service import (
    get_client_payment_methods_config,
    set_client_payment_methods,
)
from app.services.client_product_price_service import (
    list_admin_client_package_price_matrix,
    list_client_assigned_package_prices,
    upsert_admin_client_package_prices_local,
)
from app.services.client_reseller_service import get_client_by_payment_token

router = APIRouter(prefix="/admin/clients", tags=["admin"])

DbDep = Annotated[Session, Depends(get_db)]

MASTER_ADMIN_PIN = (os.getenv("MASTER_ADMIN_PIN") or "301985").strip()
TX_ADMIN_ADJUST = "admin_adjust"
ADMIN_ADJUST_DESCRIPTION = "Ajuste manual de Admin"


class AdminPinBody(BaseModel):
    pin: str = Field(..., min_length=1, max_length=32)


class AdminAdjustBalanceBody(BaseModel):
    pin: str = Field(..., min_length=1, max_length=32)
    operation: Literal["add", "remove"]
    amount: float = Field(..., gt=0)


class AdminToggleStatusResponse(BaseModel):
    ok: bool = True
    message: str
    client_id: int
    payment_token: str
    status: str


class AdminAdjustBalanceResponse(BaseModel):
    ok: bool = True
    message: str
    client_id: int
    payment_token: str
    wallet_balance: float = Field(ge=0)
    transaction_id: int
    amount_applied: float


def _require_master_pin(pin: str) -> None:
    if str(pin or "").strip() != MASTER_ADMIN_PIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="PIN maestro incorrecto.",
        )


@router.post("/{client_uuid}/toggle-status", response_model=AdminToggleStatusResponse)
def admin_toggle_client_status(
    client_uuid: uuid_module.UUID,
    payload: AdminPinBody,
    db: DbDep,
    _: AdminDep,
) -> AdminToggleStatusResponse:
    """Invierte Activo ↔ Inactivo del cliente identificado por ``payment_token``."""
    _require_master_pin(payload.pin)
    client = get_client_by_payment_token(db, client_uuid)
    current = str(client.status or "Activo").strip()
    new_status = "Inactivo" if current.lower() != "inactivo" else "Activo"
    if new_status not in CLIENT_STATUSES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Estado de cliente no válido.")
    client.status = new_status
    db.commit()
    db.refresh(client)
    verb = "bloqueado" if new_status == "Inactivo" else "desbloqueado"
    label = client.display_name()
    return AdminToggleStatusResponse(
        message=f"Cliente {label} {verb} correctamente.",
        client_id=int(client.id),
        payment_token=str(client.payment_token),
        status=new_status,
    )


@router.post("/{client_uuid}/adjust-balance", response_model=AdminAdjustBalanceResponse)
def admin_adjust_client_balance(
    client_uuid: uuid_module.UUID,
    payload: AdminAdjustBalanceBody,
    db: DbDep,
    _: AdminDep,
) -> AdminAdjustBalanceResponse:
    """Ajusta saldo BaaS del cliente (sumar o restar) con movimiento en ledger."""
    _require_master_pin(payload.pin)
    client = get_client_by_payment_token(db, client_uuid)
    amt = round(float(payload.amount), 2)
    if amt <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El monto debe ser mayor a cero.")

    if payload.operation == "add":
        signed = amt
    else:
        from app.services.wallet_balance_service import get_client_wallet_balance, subtract_client_wallet_balance

        current = round(float(get_client_wallet_balance(client, "USD")), 2)
        if current + 1e-9 < amt:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Saldo insuficiente para quitar ${amt:.2f} (disponible ${current:.2f}).",
            )
        signed = -amt

    if signed > 0:
        from app.services.wallet_balance_service import add_client_wallet_balance

        add_client_wallet_balance(db, client, "USD", signed)
    else:
        from app.services.wallet_balance_service import subtract_client_wallet_balance

        subtract_client_wallet_balance(db, client, "USD", abs(signed))
    tx = WalletTransaction(
        user_id=None,
        client_id=int(client.id),
        amount=signed,
        transaction_type=TX_ADMIN_ADJUST,
        description=ADMIN_ADJUST_DESCRIPTION,
    )
    db.add(tx)
    db.commit()
    db.refresh(client)
    db.refresh(tx)

    op_label = "añadido" if signed > 0 else "quitado"
    label = client.display_name()
    return AdminAdjustBalanceResponse(
        message=f"Saldo {op_label} a {label}: ${abs(signed):.2f} USD.",
        client_id=int(client.id),
        payment_token=str(client.payment_token),
        wallet_balance=round(float(client.wallet_balance or 0), 2),
        transaction_id=int(tx.id),
        amount_applied=abs(signed),
    )


@router.get("/{client_id}/assigned-package-prices", response_model=list[AdminClientAssignedPackagePrice])
def admin_list_client_assigned_package_prices(
    client_id: int,
    db: DbDep,
    _: AdminDep,
) -> list[AdminClientAssignedPackagePrice]:
    """Solo precios ya asignados al cliente (sin catálogo global)."""
    client = db.get(Client, int(client_id))
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")
    rows = list_client_assigned_package_prices(db, int(client_id))
    out: list[AdminClientAssignedPackagePrice] = []
    for row in rows:
        pkg_id = int(row["package_catalog_id"])
        out.append(
            AdminClientAssignedPackagePrice(
                package_id=pkg_id,
                package_catalog_id=pkg_id,
                product_id=int(row["product_id"]),
                sale_price_local=float(row["precio_venta_local"]),
                currency=str(row.get("currency") or "USD"),
            )
        )
    return out


@router.get("/{client_id}/package-prices", response_model=list[AdminClientPackagePriceRow])
def admin_list_client_package_prices(
    client_id: int,
    db: DbDep,
    _: AdminDep,
) -> list[AdminClientPackagePriceRow]:
    """Catálogo global (crédito por pantalla) LEFT JOIN precios locales del cliente."""
    rows = list_admin_client_package_price_matrix(db, int(client_id))
    return [AdminClientPackagePriceRow(**row) for row in rows]


@router.put("/{client_id}/package-prices", response_model=AdminClientPackagePricesUpsertResponse)
def admin_upsert_client_package_prices(
    client_id: int,
    payload: AdminClientPackagePricesUpsertBody,
    db: DbDep,
    _: AdminDep,
) -> AdminClientPackagePricesUpsertResponse:
    """Upsert masivo de precios de venta locales por paquete Flujo."""
    if not payload.prices:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Debe enviar al menos un precio.",
        )
    client = db.get(Client, int(client_id))
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")

    touched = upsert_admin_client_package_prices_local(
        db,
        client_id=int(client_id),
        items=payload.prices,
    )
    db.commit()
    label = client.display_name()
    return AdminClientPackagePricesUpsertResponse(
        updated=touched,
        message=f"Precios actualizados para {label} ({touched} paquete(s)).",
    )


@router.get("/{client_id}/payment-methods", response_model=ClientPaymentMethodsConfigResponse)
def admin_get_client_payment_methods(
    client_id: int,
    db: DbDep,
    _: AdminDep,
) -> ClientPaymentMethodsConfigResponse:
    """Catálogo filtrado por moneda del cliente + métodos ya asignados."""
    cfg = get_client_payment_methods_config(db, int(client_id))
    return ClientPaymentMethodsConfigResponse(**cfg)


@router.put("/{client_id}/payment-methods", response_model=ClientPaymentMethodsUpsertResponse)
def admin_set_client_payment_methods(
    client_id: int,
    payload: ClientPaymentMethodsUpsertBody,
    db: DbDep,
    _: AdminDep,
) -> ClientPaymentMethodsUpsertResponse:
    """Reemplaza los métodos de pago habilitados para el portal del cliente."""
    client = db.get(Client, int(client_id))
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")

    touched = set_client_payment_methods(
        db,
        client_id=int(client_id),
        selections=payload.selections,
    )
    db.commit()
    label = client.display_name()
    return ClientPaymentMethodsUpsertResponse(
        updated=touched,
        message=f"Cuentas de pago actualizadas para {label} ({touched} cuenta(s)).",
    )
