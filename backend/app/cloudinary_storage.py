"""Subida de comprobantes de pago a Cloudinary (sin almacenamiento local)."""
from __future__ import annotations

import io
import logging
import os
import uuid
from pathlib import Path

import cloudinary
import cloudinary.uploader
from fastapi import HTTPException, status

logger = logging.getLogger(__name__)

_CLOUDINARY_CONFIGURED = False

_CLOUDINARY_UPLOAD_ERROR = (
    "Error al subir el comprobante a la nube de Cloudinary. Por favor, intenta de nuevo."
)


def configure_cloudinary() -> None:
    """Inicializa el SDK con variables de entorno (idempotente)."""
    global _CLOUDINARY_CONFIGURED
    if _CLOUDINARY_CONFIGURED:
        return

    cloud_name = os.getenv("CLOUDINARY_CLOUD_NAME", "").strip()
    api_key = os.getenv("CLOUDINARY_API_KEY", "").strip()
    api_secret = os.getenv("CLOUDINARY_API_SECRET", "").strip()
    if not all((cloud_name, api_key, api_secret)):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=_CLOUDINARY_UPLOAD_ERROR,
        )

    cloudinary.config(
        cloud_name=cloud_name,
        api_key=api_key,
        api_secret=api_secret,
        secure=True,
    )
    _CLOUDINARY_CONFIGURED = True


def _receipt_suffix(content_type: str, filename: str | None) -> str:
    suffix = Path(filename or "receipt").suffix.lower()
    if suffix not in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf"):
        suffix = ".pdf" if content_type == "application/pdf" else ".jpg"
    return suffix


def upload_comprobante(content: bytes, *, content_type: str, filename: str | None = None) -> str:
    """
    Sube el comprobante a Cloudinary y devuelve la URL HTTPS pública (``secure_url``).
    Si Cloudinary falla, lanza HTTP 500 (sin respaldo en disco local).
    """
    suffix = _receipt_suffix(content_type, filename)

    try:
        configure_cloudinary()

        resource_type = "raw" if content_type == "application/pdf" else "image"
        public_id = f"{uuid.uuid4().hex}{suffix}"

        result = cloudinary.uploader.upload(
            io.BytesIO(content),
            folder="comprobantes_erp",
            public_id=public_id,
            resource_type=resource_type,
        )
        file_url = result.get("secure_url")
        if file_url:
            return str(file_url)

        logger.error("Cloudinary no devolvió secure_url para comprobante.")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Error en Cloudinary: %s", exc, exc_info=True)

    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=_CLOUDINARY_UPLOAD_ERROR,
    )
