"""Utilidades JWT compartidas (evita import circular auth ↔ dependencies)."""

from __future__ import annotations

import datetime
import os
import secrets
import uuid
from typing import Literal, Optional, TypedDict

from jose import ExpiredSignatureError, JWTError, jwt

from app.timezone_utils import now_utc

ENVIRONMENT = (os.getenv("ENVIRONMENT") or os.getenv("ENV") or "development").strip().lower()
_IS_PRODUCTION = ENVIRONMENT in {"production", "prod"}

ALGORITHM = "HS256"
ISSUER = "erp-iptv-baas"

# Vida de los tokens. El access token es corto a propósito: los permisos ya
# no viajan en el payload (ver create_access_token) y se resuelven contra la
# BD en cada request, así que un token de vida corta no cuesta UX y limita
# la ventana de un token robado.
ACCESS_TOKEN_EXPIRE_MINUTES = 15
REFRESH_TOKEN_EXPIRE_DAYS = 7


def _load_secret_key() -> str:
    """
    Carga ``JWT_SECRET_KEY`` desde el entorno.

    En producción, la ausencia de esta variable es un error de arranque: no
    hay valor por defecto seguro. En desarrollo se genera uno efímero (con
    aviso) para no bloquear a quien clona el repo por primera vez — ese
    secreto cambia en cada reinicio del proceso, así que nunca debe usarse
    fuera de una máquina local.
    """
    secret = (os.getenv("JWT_SECRET_KEY") or "").strip()
    if secret:
        return secret

    if _IS_PRODUCTION:
        raise RuntimeError(
            "JWT_SECRET_KEY no está configurada. En producción (ENVIRONMENT=production) "
            "el servidor no puede arrancar con un secreto JWT ausente o hardcodeado. "
            "Genera uno con: python -c \"import secrets; print(secrets.token_urlsafe(64))\" "
            "y cárgalo como variable de entorno en Render."
        )

    generated = secrets.token_urlsafe(64)
    print(
        "WARN: JWT_SECRET_KEY no configurada; usando un secreto EFÍMERO generado en memoria "
        "(válido solo para esta ejecución local). Define JWT_SECRET_KEY en backend/.env."
    )
    return generated


SECRET_KEY = _load_secret_key()


class TokenError(Exception):
    """Error al decodificar un token, con motivo clasificado para la API."""

    def __init__(self, reason: Literal["token_expired", "token_invalid"]) -> None:
        self.reason = reason
        super().__init__(reason)


class DecodedToken(TypedDict, total=False):
    sub: str
    name: str
    role: str
    user_id: int
    jti: str
    token_type: str
    family_id: str
    iat: int
    nbf: int
    exp: int
    iss: str


def create_access_token(data: dict, *, expires_delta: Optional[datetime.timedelta] = None) -> str:
    """
    Emite un access token de vida corta.

    Los permisos ya NO se incrustan aquí (antes vivían hasta 8h desactualizados
    tras un cambio de rol/permiso): las rutas protegidas los resuelven contra la
    BD en cada request vía ``require_permission``/``require_any_permission``.
    """
    to_encode = data.copy()
    now = now_utc()
    expire = now + (expires_delta or datetime.timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.setdefault("jti", uuid.uuid4().hex)
    to_encode["token_type"] = "access"
    to_encode["iat"] = now
    to_encode["nbf"] = now
    to_encode["exp"] = expire
    to_encode["iss"] = ISSUER
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def create_refresh_token(
    data: dict,
    *,
    jti: Optional[str] = None,
    family_id: Optional[str] = None,
    expires_delta: Optional[datetime.timedelta] = None,
) -> tuple[str, str, str]:
    """Emite un refresh token. Devuelve ``(token, jti, family_id)``."""
    now = now_utc()
    expire = now + (expires_delta or datetime.timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS))
    jti = jti or uuid.uuid4().hex
    family_id = family_id or uuid.uuid4().hex
    to_encode = data.copy()
    to_encode["jti"] = jti
    to_encode["family_id"] = family_id
    to_encode["token_type"] = "refresh"
    to_encode["iat"] = now
    to_encode["nbf"] = now
    to_encode["exp"] = expire
    to_encode["iss"] = ISSUER
    token = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return token, jti, family_id


def decode_token(token: str) -> DecodedToken:
    """
    Decodifica y valida la firma/expiración de un JWT.

    Lanza ``TokenError`` con motivo clasificado (``token_expired`` vs.
    ``token_invalid``) para que el caller pueda decidir entre refrescar la
    sesión o forzar un nuevo login.
    """
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM], issuer=ISSUER)
    except ExpiredSignatureError as exc:
        raise TokenError("token_expired") from exc
    except JWTError as exc:
        raise TokenError("token_invalid") from exc


def decode_access_token(token: str) -> Optional[dict]:
    """
    Retrocompatible: decodifica sin distinguir el motivo del fallo.

    Preferir ``decode_token`` en código nuevo, que permite distinguir
    ``token_expired`` de ``token_invalid`` (necesario para que el frontend
    decida entre refrescar o cerrar sesión).
    """
    try:
        return decode_token(token)
    except TokenError:
        return None
