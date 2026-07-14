"""Webhook del socio de recaudo físico (Códigos de Retiro)."""

from __future__ import annotations

import logging
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas.codigos_retiro_webhook import CodigosRetiroWebhookIn, CodigosRetiroWebhookOut
from app.services.codigos_retiro_webhook_service import (
    extract_receipt_url_from_webhook_payload,
    process_codigos_retiro_webhook,
    verify_codigos_retiro_webhook_api_key,
)

router = APIRouter(prefix="/webhooks", tags=["webhooks"])
logger = logging.getLogger(__name__)

DbDep = Annotated[Session, Depends(get_db)]


@router.post(
    "/codigos-retiro",
    response_model=CodigosRetiroWebhookOut,
    status_code=status.HTTP_200_OK,
    summary="Webhook: resultado de código de retiro en calle",
)
def webhook_codigos_retiro(
    payload: CodigosRetiroWebhookIn,
    db: DbDep,
    x_api_key: Annotated[Optional[str], Header(alias="X-API-Key")] = None,
) -> CodigosRetiroWebhookOut:
    """
    Recibe la señal del socio cuando un retiro físico se completa o falla.

    **Completado:** registra abono por el monto X; cierra CxC de venta o recarga BaaS.

    **Fallido / fallido_revision:** solo nota en la venta/recarga; CxC al 100% intacta.

    ``referencia_externa``: ``FAC-0001`` (venta) o ``REC-00001`` (recarga BaaS).

    ``receipt_url`` (o alias ``comprobante_url``, ``url_comprobante``, etc.): URL del comprobante.

    El procesamiento en base de datos es síncrono: responde HTTP 200 solo tras commit exitoso.
    """
    verify_codigos_retiro_webhook_api_key(x_api_key)

    payload_dict = payload.model_dump(mode="json")
    receipt_url = extract_receipt_url_from_webhook_payload(payload_dict)

    logger.info(
        "Webhook códigos retiro recibido: estado=%s es_prueba=%s cliente=%r monto=%s ref=%r receipt=%s",
        payload.estado,
        payload.es_prueba,
        payload.cliente,
        payload.monto,
        payload.referencia_externa,
        "yes" if receipt_url else "no",
    )

    try:
        result = process_codigos_retiro_webhook(
            db,
            cliente=payload.cliente,
            estado=payload.estado,
            monto=payload.monto,
            referencia_externa=payload.referencia_externa,
            es_prueba=payload.es_prueba,
            receipt_url=receipt_url,
        )
    except Exception:
        db.rollback()
        logger.exception(
            "Webhook códigos retiro: error fatal en procesamiento síncrono ref=%r",
            payload.referencia_externa,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error interno al procesar el webhook.",
        ) from None

    ok = bool(result.get("ok"))
    if ok:
        logger.info("Webhook códigos retiro procesado OK: %s", result)
    else:
        logger.warning("Webhook códigos retiro procesado con ok=False: %s", result)

    sale_id = result.get("sale_id")
    client_id = result.get("client_id")
    return CodigosRetiroWebhookOut(
        ok=ok,
        accepted=ok,
        message=str(result.get("message") or ("Procesado." if ok else "No procesado.")),
        sale_id=int(sale_id) if sale_id is not None else None,
        client_id=int(client_id) if client_id is not None else None,
    )
