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
    allowed = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf", ".mp4", ".webm", ".mov", ".mpeg", ".mpg")
    if suffix not in allowed:
        if content_type == "application/pdf":
            suffix = ".pdf"
        elif content_type.startswith("video/"):
            suffix = ".mp4"
        else:
            suffix = ".jpg"
    return suffix


def _media_type_from_upload(content_type: str, cloudinary_resource_type: str | None) -> str:
    ct = (content_type or "").split(";")[0].strip().lower()
    rt = (cloudinary_resource_type or "").strip().lower()
    if ct == "application/pdf" or rt == "raw":
        return "pdf"
    if ct.startswith("video/") or rt == "video":
        return "video"
    return "image"


def upload_comprobante_meta(content: bytes, *, content_type: str, filename: str | None = None) -> tuple[str, str]:
    """
    Sube el archivo a Cloudinary con ``resource_type="auto"`` (imagen, video o PDF).
    Devuelve ``(secure_url, media_type)`` con media_type en ``image`` | ``video`` | ``pdf``.
    """
    suffix = _receipt_suffix(content_type, filename)

    try:
        configure_cloudinary()

        public_id = f"{uuid.uuid4().hex}{suffix}"

        result = cloudinary.uploader.upload(
            io.BytesIO(content),
            folder="comprobantes_erp",
            public_id=public_id,
            resource_type="auto",
        )
        file_url = result.get("secure_url")
        if file_url:
            media_type = _media_type_from_upload(content_type, result.get("resource_type"))
            return str(file_url), media_type

        logger.error("Cloudinary no devolvió secure_url para comprobante.")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Error en Cloudinary: %s", exc, exc_info=True)

    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=_CLOUDINARY_UPLOAD_ERROR,
    )


def upload_comprobante(content: bytes, *, content_type: str, filename: str | None = None) -> str:
    """Sube el comprobante y devuelve solo la URL HTTPS pública."""
    url, _ = upload_comprobante_meta(content, content_type=content_type, filename=filename)
    return url
