"""Acciones administrativas sobre clientes BaaS (bloqueo y ajuste de saldo)."""

from __future__ import annotations

import os
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.v1.dependencies import AdminDep, require_permission
from app.permissions import BAAS_SALE_PRICES_EDIT, BAAS_SALE_PRICES_VIEW, BAAS_TREE_EDIT
from app.database import get_db
from app.models.client import CLIENT_STATUSES, Client
from app.models.wallet_transaction import WalletTransaction
from app.schemas.client_payment_methods import (
    ClientPaymentAccountsConfigResponse,
    ClientPaymentAccountsUpsertBody,
    ClientPaymentAccountsUpsertResponse,
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
    get_client_payment_accounts_config,
    get_client_payment_methods_config,
    prune_pending_transaction_deposit_accounts_for_client,
    set_client_payment_accounts_from_ids,
    set_client_payment_methods,
)
from app.services.client_product_price_service import (
    list_admin_client_package_price_matrix,
    list_client_assigned_package_prices,
    upsert_admin_client_package_prices_local,
)
from app.security.ownership import assert_client_in_caller_scope

router = APIRouter(prefix="/admin/clients", tags=["admin"])

DbDep = Annotated[Session, Depends(get_db)]
BaasTreeEditDep = Annotated[dict, Depends(require_permission(BAAS_TREE_EDIT))]
BaasSalePricesViewDep = Annotated[dict, Depends(require_permission(BAAS_SALE_PRICES_VIEW))]
BaasSalePricesEditDep = Annotated[dict, Depends(require_permission(BAAS_SALE_PRICES_EDIT))]

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
    status: str


class AdminAdjustBalanceResponse(BaseModel):
    ok: bool = True
    message: str
    client_id: int
    wallet_balance: float = Field(ge=0)
    transaction_id: int
    amount_applied: float


def _configured_master_pin() -> str:
    pin = (os.getenv("MASTER_ADMIN_PIN") or "").strip()
    if not pin:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="PIN maestro no configurado (variable MASTER_ADMIN_PIN).",
        )
    return pin


def _require_master_pin(pin: str) -> None:
    if str(pin or "").strip() != _configured_master_pin():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="PIN maestro incorrecto.",
        )


@router.post("/{client_id}/toggle-status", response_model=AdminToggleStatusResponse)
def admin_toggle_client_status(
    client_id: int,
    payload: AdminPinBody,
    db: DbDep,
    current: BaasTreeEditDep,
) -> AdminToggleStatusResponse:
    """Invierte Activo ↔ Inactivo del cliente BaaS."""
    _require_master_pin(payload.pin)
    client = assert_client_in_caller_scope(db, current, int(client_id))
    status_now = str(client.status or "Activo").strip()
    new_status = "Inactivo" if status_now.lower() != "inactivo" else "Activo"
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
        status=new_status,
    )


@router.post("/{client_id}/adjust-balance", response_model=AdminAdjustBalanceResponse)
def admin_adjust_client_balance(
    client_id: int,
    payload: AdminAdjustBalanceBody,
    db: DbDep,
    current: BaasTreeEditDep,
) -> AdminAdjustBalanceResponse:
    """Ajusta saldo BaaS del cliente (sumar o restar) con movimiento en ledger."""
    _require_master_pin(payload.pin)
    client = assert_client_in_caller_scope(db, current, int(client_id))
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
        wallet_balance=round(float(client.wallet_balance or 0), 2),
        transaction_id=int(tx.id),
        amount_applied=abs(signed),
    )


@router.get("/{client_id}/assigned-package-prices", response_model=list[AdminClientAssignedPackagePrice])
def admin_list_client_assigned_package_prices(
    client_id: int,
    db: DbDep,
    _: BaasSalePricesViewDep,
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
    _: BaasSalePricesViewDep,
) -> list[AdminClientPackagePriceRow]:
    """Catálogo global (crédito por pantalla) LEFT JOIN precios locales del cliente."""
    rows = list_admin_client_package_price_matrix(db, int(client_id))
    return [AdminClientPackagePriceRow(**row) for row in rows]


@router.put("/{client_id}/package-prices", response_model=AdminClientPackagePricesUpsertResponse)
def admin_upsert_client_package_prices(
    client_id: int,
    payload: AdminClientPackagePricesUpsertBody,
    db: DbDep,
    _: BaasSalePricesEditDep,
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


@router.get("/{client_id}/payment-accounts", response_model=ClientPaymentAccountsConfigResponse)
def admin_get_client_payment_accounts(
    client_id: int,
    db: DbDep,
    _: AdminDep,
) -> ClientPaymentAccountsConfigResponse:
    """Preferencias planas de cuentas de depósito habilitadas para el portal del cliente."""
    cfg = get_client_payment_accounts_config(db, int(client_id))
    return ClientPaymentAccountsConfigResponse(**cfg)


@router.put("/{client_id}/payment-accounts", response_model=ClientPaymentAccountsUpsertResponse)
def admin_set_client_payment_accounts(
    client_id: int,
    payload: ClientPaymentAccountsUpsertBody,
    db: DbDep,
    _: AdminDep,
) -> ClientPaymentAccountsUpsertResponse:
    """Reemplaza las cuentas de pago del cliente (array vacío = configuración global en portal)."""
    client = db.get(Client, int(client_id))
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")

    touched = set_client_payment_accounts_from_ids(
        db,
        client_id=int(client_id),
        account_ids=payload.account_ids,
    )
    sales_pruned, recharges_pruned = prune_pending_transaction_deposit_accounts_for_client(
        db,
        client_id=int(client_id),
        allowed_account_ids=payload.account_ids,
    )
    db.commit()
    label = client.display_name()
    if touched == 0:
        msg = f"Preferencias de cuentas eliminadas para {label}. El portal usará la configuración global."
    else:
        msg = f"Cuentas de pago actualizadas para {label} ({touched} cuenta(s))."
    if sales_pruned or recharges_pruned:
        parts: list[str] = []
        if sales_pruned:
            parts.append(f"{sales_pruned} venta(s) pendiente(s)")
        if recharges_pruned:
            parts.append(f"{recharges_pruned} recarga(s) abierta(s)")
        msg = f"{msg} · Allowlists recortados en {', '.join(parts)}."
    return ClientPaymentAccountsUpsertResponse(updated=touched, message=msg)
