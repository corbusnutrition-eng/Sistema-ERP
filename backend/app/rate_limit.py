"""Rate limiting compartido (slowapi) para rutas públicas."""
from __future__ import annotations

from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request

PORTAL_GET_LIMIT = "20/minute"
RECEIPT_UPLOAD_LIMIT = "5/minute"


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
