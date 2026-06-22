from __future__ import annotations

import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload

from app.database import get_db
from app.models.client import Client
from app.models.iptv_screen import IPTVScreen
from app.models.sale import Sale
from app.timezone_utils import ensure_aware, now_ecuador

router = APIRouter(prefix="/subscriptions", tags=["subscriptions"])

DbDep = Annotated[Session, Depends(get_db)]

SUBSCRIPTION_DAYS = 30


class SubscriptionStatus(BaseModel):
    client_id: int
    client_name: str
    phone: Optional[str]
    provider: Optional[str]
    screen_credential: Optional[str]
    screen_number: Optional[int]
    last_sale_date: Optional[datetime.datetime]
    expiration_date: Optional[datetime.datetime]
    days_remaining: Optional[int]
    status: str
    payment_link_id: str


@router.get("/status/", response_model=list[SubscriptionStatus])
def get_subscriptions_status(db: DbDep) -> list[SubscriptionStatus]:
    """
    Devuelve el estado de suscripción de todos los clientes con al menos una venta.
    Calcula la fecha de vencimiento sumando 30 días a la última venta aprobada.
    """
    clients = (
        db.query(Client)
        .options(
            joinedload(Client.sales),
            joinedload(Client.screens).joinedload(IPTVScreen.iptv_account),
        )
        .all()
    )

    now = now_ecuador()
    result: list[SubscriptionStatus] = []

    for client in clients:
        approved_sales = [s for s in client.sales if s.status.value == "approved"]
        if not approved_sales:
            continue

        last_sale: Sale = max(approved_sales, key=lambda s: s.created_at)

        last_sale_date = last_sale.created_at
        if last_sale_date.tzinfo is None:
            last_sale_date = ensure_aware(last_sale_date)

        expiration_date = last_sale_date + datetime.timedelta(days=SUBSCRIPTION_DAYS)
        delta = expiration_date - now
        days_remaining = delta.days

        if days_remaining > 3:
            sub_status = "Activo"
        elif days_remaining > 0:
            sub_status = "Por Vencer"
        else:
            sub_status = "Vencido"

        # Pantalla asignada a través de la última venta
        screen = None
        if last_sale.iptv_screen_id:
            screen = db.get(IPTVScreen, last_sale.iptv_screen_id)

        provider: Optional[str] = None
        credential: Optional[str] = None
        screen_number: Optional[int] = None

        if screen and screen.iptv_account:
            provider = screen.iptv_account.provider_name
            credential = screen.iptv_account.username
            screen_number = screen.screen_number

        result.append(
            SubscriptionStatus(
                client_id=client.id,
                client_name=client.display_name(),
                phone=client.phone,
                provider=provider,
                screen_credential=credential,
                screen_number=screen_number,
                last_sale_date=last_sale_date,
                expiration_date=expiration_date,
                days_remaining=days_remaining,
                status=sub_status,
                payment_link_id=str(client.payment_token),
            )
        )

    result.sort(key=lambda x: x.days_remaining if x.days_remaining is not None else -999)
    return result
