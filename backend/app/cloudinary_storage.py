"""Subida de comprobantes de pago a Cloudinary con respaldo local."""
from __future__ import annotations

import io
import logging
import os
import uuid
from pathlib import Path

import cloudinary
import cloudinary.uploader

from app.upload_paths import UPLOAD_ROOT

logger = logging.getLogger(__name__)

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


def _receipt_suffix(content_type: str, filename: str | None) -> str:
    suffix = Path(filename or "receipt").suffix.lower()
    if suffix not in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf"):
        suffix = ".pdf" if content_type == "application/pdf" else ".jpg"
    return suffix


def _save_comprobante_local(content: bytes, *, suffix: str) -> str:
    """Respaldo: guarda en ``backend/uploads/`` y devuelve ruta relativa ``/uploads/…``."""
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    local_name = f"{uuid.uuid4().hex}{suffix}"
    (UPLOAD_ROOT / local_name).write_bytes(content)
    return f"/uploads/{local_name}"


def upload_comprobante(content: bytes, *, content_type: str, filename: str | None = None) -> str:
    """
    Intenta subir a Cloudinary; si falla (credenciales, red, etc.),
    guarda localmente en ``/uploads/`` como respaldo.
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

        logger.warning("Cloudinary no devolvió secure_url; usando almacenamiento local.")
    except Exception as exc:
        logger.error("Error en Cloudinary: %s", exc)

    return _save_comprobante_local(content, suffix=suffix)
