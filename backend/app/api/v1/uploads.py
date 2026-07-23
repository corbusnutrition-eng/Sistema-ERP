from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, UploadFile, status
from fastapi.responses import JSONResponse

from app.cloudinary_storage import upload_comprobante_meta
from app.rate_limit import RECEIPT_UPLOAD_LIMIT, limiter

ALLOWED_CONTENT_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/mpeg",
    "video/x-msvideo",
}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

router = APIRouter(prefix="/uploads", tags=["uploads"])


@router.post(
    "/receipt",
    summary="Subir comprobante de pago",
    tags=["public"],
)
@limiter.limit(RECEIPT_UPLOAD_LIMIT)
async def upload_receipt(request: Request, file: UploadFile) -> JSONResponse:
    """
    Recibe imagen, video o PDF, lo sube a Cloudinary (resource_type=auto)
    y devuelve la URL HTTPS pública y el tipo de medio detectado.
    Endpoint público – no requiere autenticación.
    """
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Solo se aceptan imágenes (JPEG, PNG, GIF, WEBP), videos (MP4, WEBM, MOV) o PDF.",
        )

    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="El archivo supera el límite de 10 MB.",
        )

    file_url, media_type = upload_comprobante_meta(
        content,
        content_type=content_type,
        filename=file.filename,
    )

    return JSONResponse({"receipt_url": file_url, "media_type": media_type})
