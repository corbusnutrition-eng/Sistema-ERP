from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse

from app.upload_paths import UPLOAD_ROOT

UPLOAD_DIR = UPLOAD_ROOT
ALLOWED_CONTENT_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

router = APIRouter(prefix="/uploads", tags=["uploads"])


@router.post(
    "/receipt",
    summary="Subir comprobante de pago",
    tags=["public"],
)
async def upload_receipt(file: UploadFile) -> JSONResponse:
    """
    Recibe una imagen de comprobante de pago, la guarda en uploads/
    y devuelve la URL relativa accesible via /uploads/<filename>.
    Endpoint público – no requiere autenticación.
    """
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Solo se aceptan JPEG, PNG, GIF, WEBP o PDF.",
        )

    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="El archivo supera el límite de 10 MB.",
        )

    suf = Path(file.filename or "receipt").suffix.lower()
    suffix = suf if suf in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf") else (
        ".pdf" if file.content_type == "application/pdf" else ".jpg"
    )
    filename = f"{uuid.uuid4().hex}{suffix}"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    dest = UPLOAD_DIR / filename
    dest.write_bytes(content)

    return JSONResponse({"receipt_url": f"/uploads/{filename}"})
