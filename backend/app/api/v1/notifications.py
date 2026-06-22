"""Notificaciones del header (campanita) para el administrador."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.v1.dependencies import AdminDep
from app.database import get_db
from app.schemas.notification import PendingPaymentsNotificationResponse
from app.services.notification_service import list_pending_payment_notifications

router = APIRouter(prefix="/notifications", tags=["notifications"])

DbDep = Annotated[Session, Depends(get_db)]


@router.get("/pending-payments", response_model=PendingPaymentsNotificationResponse)
def get_pending_payment_notifications(db: DbDep, _: AdminDep) -> PendingPaymentsNotificationResponse:
    """Comprobantes del portal (ventas, BaaS y abonos CxC) pendientes de aprobación."""
    return list_pending_payment_notifications(db)
