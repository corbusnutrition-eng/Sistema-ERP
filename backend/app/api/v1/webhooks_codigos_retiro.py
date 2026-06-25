"""Webhook del socio de recaudo físico (Códigos de Retiro)."""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Header, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas.codigos_retiro_webhook import CodigosRetiroWebhookIn, CodigosRetiroWebhookOut
from app.services.codigos_retiro_webhook_service import (
    run_codigos_retiro_webhook_background,
    verify_codigos_retiro_webhook_api_key,
)

router = APIRouter(prefix="/webhooks", tags=["webhooks"])

DbDep = Annotated[Session, Depends(get_db)]


@router.post(
    "/codigos-retiro",
    response_model=CodigosRetiroWebhookOut,
    status_code=status.HTTP_200_OK,
    summary="Webhook: resultado de código de retiro en calle",
)
def webhook_codigos_retiro(
    payload: CodigosRetiroWebhookIn,
    background_tasks: BackgroundTasks,
    x_api_key: Annotated[Optional[str], Header(alias="X-API-Key")] = None,
) -> CodigosRetiroWebhookOut:
    """
    Recibe la señal del socio cuando un retiro físico se completa o falla.

    **Completado:** registra abono por el monto X; cierra CxC de venta o recarga BaaS.

    **Fallido / fallido_revision:** solo nota en la venta/recarga; CxC al 100% intacta.

    ``referencia_externa``: ``FAC-0001`` (venta) o ``REC-00001`` (recarga BaaS).

    ``receipt_url`` (o alias ``comprobante_url``, ``url_comprobante``, etc.): URL del comprobante.

    Responde de inmediato con HTTP 200; el procesamiento ocurre en segundo plano.
    """
    verify_codigos_retiro_webhook_api_key(x_api_key)
    background_tasks.add_task(
        run_codigos_retiro_webhook_background,
        payload.model_dump(mode="json"),
    )
    return CodigosRetiroWebhookOut(
        ok=True,
        accepted=True,
        message="Webhook recibido; procesamiento en curso.",
    )
