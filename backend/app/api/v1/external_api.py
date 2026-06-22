"""Integraciones externas (p. ej. web de soporte): API protegida por ``X-API-Key``.

Variables de entorno:
- ``EXTERNAL_API_KEY``: valor esperado del encabezado ``X-API-Key``.
- ``PUBLIC_PORTAL_BASE_URL``: base pública del portal (sin ``/`` final); si falta se usa ``VIP_CATALOG_BRIDGE_URL``.
"""

from __future__ import annotations

import os
import secrets
import traceback
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.client import Client

router = APIRouter(prefix="/external", tags=["external-integration"])


def _portal_public_base_url() -> str:
    """Base pública desde variables de entorno ``os.getenv`` (no usar ``settings.*`` aquí)."""
    raw = (
        os.getenv("PUBLIC_PORTAL_BASE_URL")
        or os.getenv("VIP_CATALOG_BRIDGE_URL")
        or "https://catalogo-vip.onrender.com"
    )
    return str(raw).strip().rstrip("/")


def _external_api_ok_response(payload: dict[str, Any]) -> JSONResponse:
    """Errores de negocio / configuración como HTTP 200 con cuerpo JSON para consumo desde SPA/cross-origin."""
    return JSONResponse(status_code=200, content=payload)


@router.get(
    "/portal-link",
    summary="Obtener enlace permanente del portal por correo del cliente/distribuidor",
    response_model=None,
)
def get_portal_link_by_email(
    request: Request,
    email: str = Query(..., description="Correo del cliente o distribuidor (tabla clients)"),
    db: Session = Depends(get_db),
    x_api_key: Optional[str] = Header(None, alias="X-API-Key"),
) -> Any:
    if request.method == "OPTIONS":
        return _external_api_ok_response({})

    expected = (os.getenv("EXTERNAL_API_KEY") or "").strip()
    if not expected:
        return _external_api_ok_response(
            {
                "status": "error",
                "message": "Integración externa no configurada (falta EXTERNAL_API_KEY).",
            }
        )
    got = (x_api_key or "").strip()
    if len(got) != len(expected) or not secrets.compare_digest(got, expected):
        return _external_api_ok_response(
            {"status": "error", "message": "Clave API inválida o ausente."}
        )

    email_norm = (email or "").strip().lower()
    if not email_norm or "@" not in email_norm:
        return _external_api_ok_response(
            {"status": "error", "message": "Parámetro email inválido."}
        )

    try:
        # Modelo único necesario aquí: ``Client`` (tabla ``clients``, email + payment_token del portal).
        client = db.query(Client).filter(func.lower(Client.email) == email_norm).first()
        if client is None:
            return _external_api_ok_response(
                {"status": "error", "message": "Cliente no encontrado"}
            )

        token = getattr(client, "payment_token", None)
        if token is None:
            return _external_api_ok_response(
                {"status": "error", "message": "Cliente no encontrado"}
            )

        base = _portal_public_base_url()
        portal_url = f"{base}/portal/{token}"
        return {"status": "success", "portal_url": portal_url}
    except Exception as e:  # noqa: BLE001
        print(f"Error en portal-link: {e}")
        traceback.print_exc()
        return _external_api_ok_response({"status": "error", "message": str(e)})
