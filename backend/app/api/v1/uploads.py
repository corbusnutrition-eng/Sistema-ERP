from __future__ import annotations

from fastapi import APIRouter, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse

from app.cloudinary_storage import upload_comprobante

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
    Recibe una imagen de comprobante de pago, la sube a Cloudinary
    y devuelve la URL HTTPS pública (``secure_url``).
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

    file_url = upload_comprobante(
        content,
        content_type=file.content_type or "",
        filename=file.filename,
    )

    return JSONResponse({"receipt_url": file_url})
