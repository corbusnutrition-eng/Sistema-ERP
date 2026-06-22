"""Rutas ``/customers`` — alias ERP + webhooks sincronización catalogo-vip (Render)."""

from __future__ import annotations

import re
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.client import Client
from app.schemas.client import ClientCreate, ClientResponse
from app.schemas.customers_webhook import WebCustomerRegisterWebhookIn, WebCustomerRegisterWebhookOut
from app.services.catalog_vip_sync import (
    notify_catalog_vip_new_manual_customer,
    verify_inbound_webhook_secret,
)

router = APIRouter(prefix="/customers", tags=["customers"])

DbDep = Annotated[Session, Depends(get_db)]

_EMAIL_LOCAL_SAFE = re.compile(r"[^a-zA-Z0-9_.-]")


def _username_from_email(email: str) -> str:
    local = email.split("@", 1)[0].strip() or "cliente"
    local = _EMAIL_LOCAL_SAFE.sub("", local)
    if not local:
        local = "cliente"
    return local[:120]


def _allocate_unique_username_from_email(db: Session, email_norm: str) -> str:
    """Evita conflicto ``username`` único cuando varios registros derivan del mismo local-part."""
    base = _username_from_email(email_norm)
    username = base
    for i in range(0, 200):
        clash = db.query(Client).filter(Client.username == username).first()
        if not clash:
            return username
        suffix = str(i + 1)
        username = f"{base[: max(1, 120 - len(suffix))]}{suffix}"[:120]
    return (base[:100] + "x")[:120]


@router.post(
    "/webhook-register-web",
    response_model=WebCustomerRegisterWebhookOut,
    status_code=status.HTTP_201_CREATED,
    summary="Webhook: alta de cliente desde la web (hash de contraseña)",
)
def webhook_register_web(
    payload: WebCustomerRegisterWebhookIn,
    db: DbDep,
    x_webhook_secret: Annotated[Optional[str], Header(alias="X-Webhook-Secret")] = None,
) -> WebCustomerRegisterWebhookOut:
    if not verify_inbound_webhook_secret(x_webhook_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Cabecera X-Webhook-Secret inválida.",
        )
    email_norm = str(payload.email).strip().lower()
    username = _allocate_unique_username_from_email(db, email_norm)

    client = Client(
        username=username,
        name=None,
        email=email_norm,
        phone=None,
        lead_source="catalogo_vip_web",
        status="Activo",
        password_hash=payload.password_hash.strip(),
        custom_fields={},
    )
    db.add(client)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Ya existe un cliente con el email '{email_norm}'.",
        ) from None
    db.refresh(client)
    return WebCustomerRegisterWebhookOut(id=client.id, email=client.email)  # type: ignore[arg-type]


@router.post("/", response_model=ClientResponse, status_code=status.HTTP_201_CREATED)
def create_customer(payload: ClientCreate, db: DbDep) -> Client:
    """
    Crea un cliente en el ERP (igual que ``POST /clients``) y notifica la web (cuenta VIP remota).

    Mantener ``POST /clients`` para compatibilidad; ambos pueden convivir.
    """
    client = Client(
        username=payload.username,
        name=payload.name,
        email=payload.email,
        phone=payload.phone,
        country=payload.country,
        lead_source=payload.lead_source,
        status=payload.status,
        custom_fields=payload.custom_fields,
        note=payload.note,
        tags=payload.tags,
    )
    db.add(client)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Ya existe un cliente con el email '{payload.email}'.",
        ) from None
    db.refresh(client)
    notify_catalog_vip_new_manual_customer(client.email)
    return client
