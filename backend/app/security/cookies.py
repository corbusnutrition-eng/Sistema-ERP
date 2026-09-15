"""
Cookies de sesión (access + refresh) — HttpOnly, inmunes a robo por XSS.

Nombres y atributos centralizados aquí para que login/refresh/logout y la
dependencia de autenticación usen exactamente la misma configuración.
"""

from __future__ import annotations

import os

from fastapi import Response

from app.jwt_utils import ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS

ACCESS_COOKIE_NAME = "erp_access_token"
REFRESH_COOKIE_NAME = "erp_refresh_token"
# El refresh solo se envía al propio endpoint que lo consume: limita qué
# rutas del backend reciben ese cookie de mayor duración.
REFRESH_COOKIE_PATH = "/api/v1/auth"

ENVIRONMENT = (os.getenv("ENVIRONMENT") or os.getenv("ENV") or "development").strip().lower()
_IS_PRODUCTION = ENVIRONMENT in {"production", "prod"}

# Dominio compartido entre frontend y backend (ej. ".tudominio.com") cuando
# ambos son subdominios de un dominio propio. Vacío en desarrollo local —
# un cookie sin Domain es un "host-only cookie", correcto para localhost.
COOKIE_DOMAIN = (os.getenv("COOKIE_DOMAIN") or "").strip() or None

# Secure exige HTTPS. En desarrollo local (http://localhost) desactivarlo,
# o el navegador descarta el cookie silenciosamente.
COOKIE_SECURE = _IS_PRODUCTION or (os.getenv("COOKIE_SECURE", "").strip().lower() == "true")


def set_session_cookies(response: Response, *, access_token: str, refresh_token: str) -> None:
    response.set_cookie(
        key=ACCESS_COOKIE_NAME,
        value=access_token,
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        domain=COOKIE_DOMAIN,
        path="/",
    )
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=refresh_token,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 24 * 3600,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        domain=COOKIE_DOMAIN,
        path=REFRESH_COOKIE_PATH,
    )


def clear_session_cookies(response: Response) -> None:
    response.delete_cookie(
        key=ACCESS_COOKIE_NAME,
        domain=COOKIE_DOMAIN,
        path="/",
        secure=COOKIE_SECURE,
        samesite="lax",
        httponly=True,
    )
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        domain=COOKIE_DOMAIN,
        path=REFRESH_COOKIE_PATH,
        secure=COOKIE_SECURE,
        samesite="lax",
        httponly=True,
    )
