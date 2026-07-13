"""Rate limiting compartido (slowapi) para rutas públicas."""
from __future__ import annotations

from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.requests import Request

# Lectura del portal / checkout público (GET).
PORTAL_GET_LIMIT = "20/minute"
# Pagos, autocompras BaaS y subida de comprobantes (POST).
PORTAL_FINANCIAL_LIMIT = "5/minute"
# Alias histórico usado en uploads y comprobantes.
RECEIPT_UPLOAD_LIMIT = PORTAL_FINANCIAL_LIMIT

RATE_LIMIT_EXCEEDED_MESSAGE = (
    "Has superado el límite de peticiones permitidas. "
    "Espera un momento antes de volver a intentarlo."
)


def get_client_ip(request: Request) -> str:
    """
    IP real del cliente cuando la app está detrás de un proxy (Render).

    Render reenvía ``X-Forwarded-For``; el primer valor es el cliente original.
    """
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        client_ip = forwarded.split(",")[0].strip()
        if client_ip:
            return client_ip

    real_ip = request.headers.get("X-Real-IP")
    if real_ip:
        return real_ip.strip()

    return get_remote_address(request)


limiter = Limiter(key_func=get_client_ip)


def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """HTTP 429 con mensaje claro para el portal y links de pago públicos."""
    response = JSONResponse(
        status_code=429,
        content={"detail": RATE_LIMIT_EXCEEDED_MESSAGE},
    )
    if hasattr(request.app.state, "limiter"):
        response = request.app.state.limiter._inject_headers(
            response,
            getattr(request.state, "view_rate_limit", None),
        )
    return response
