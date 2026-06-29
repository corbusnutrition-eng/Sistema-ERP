"""Subida de comprobantes de pago a Cloudinary."""
from __future__ import annotations

import io
import os
import uuid
from pathlib import Path

import cloudinary
import cloudinary.uploader
from fastapi import HTTPException, status

_CLOUDINARY_CONFIGURED = False


def configure_cloudinary() -> None:
    """Inicializa el SDK con variables de entorno (idempotente)."""
    global _CLOUDINARY_CONFIGURED
    if _CLOUDINARY_CONFIGURED:
        return

    cloud_name = os.getenv("CLOUDINARY_CLOUD_NAME", "").strip()
    api_key = os.getenv("CLOUDINARY_API_KEY", "").strip()
    api_secret = os.getenv("CLOUDINARY_API_SECRET", "").strip()
    if not all((cloud_name, api_key, api_secret)):
        raise RuntimeError(
            "Faltan CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY o CLOUDINARY_API_SECRET."
        )

    cloudinary.config(
        cloud_name=cloud_name,
        api_key=api_key,
        api_secret=api_secret,
        secure=True,
    )
    _CLOUDINARY_CONFIGURED = True


def upload_comprobante(content: bytes, *, content_type: str, filename: str | None = None) -> str:
    """
    Sube bytes de comprobante a Cloudinary y devuelve la URL HTTPS pública.
    """
    configure_cloudinary()

    suffix = Path(filename or "receipt").suffix.lower()
    if suffix not in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf"):
        suffix = ".pdf" if content_type == "application/pdf" else ".jpg"

    resource_type = "raw" if content_type == "application/pdf" else "image"
    public_id = f"{uuid.uuid4().hex}{suffix}"

    try:
        result = cloudinary.uploader.upload(
            io.BytesIO(content),
            folder="comprobantes_erp",
            public_id=public_id,
            resource_type=resource_type,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="No se pudo subir el comprobante al almacenamiento en la nube.",
        ) from exc

    file_url = result.get("secure_url")
    if not file_url:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Cloudinary no devolvió URL del comprobante.",
        )
    return str(file_url)
