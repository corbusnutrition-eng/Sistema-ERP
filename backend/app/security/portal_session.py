"""
Sesión del portal de autogestión del cliente (``/portal/{token}``).

El UUID en la URL (``Client.payment_token``) sigue siendo el link permanente
del cliente, pero ya no basta por sí solo: además hace falta una sesión de
portal (correo + contraseña) vigente, guardada en una cookie HttpOnly
**por cliente** (``erp_portal_{client.id}``) para no pisar la sesión de un
subcliente al abrir su portal en otra pestaña.

Separado a propósito de ``app.security.cookies`` (sesión de staff): el portal
usa ``withCredentials: true`` solo contra rutas ``/api/v1`` y nunca debe poder
leer ni emitir la cookie de staff, ni viceversa (``jwt_utils`` ya distingue
``token_type="portal"`` de ``"access"``).
"""

from __future__ import annotations

import hashlib

import bcrypt
from fastapi import HTTPException, Request, Response, status

from app.jwt_utils import PORTAL_TOKEN_EXPIRE_DAYS, TokenError, create_portal_token, decode_token
from app.models.client import Client
from app.security.cookies import COOKIE_DOMAIN, COOKIE_SECURE

# Mismo prefijo que cubre tanto /portal/{token}/... como /payments/portal-abono,
# de forma que un único cookie de sesión sirve para ambos sin exponerse a rutas
# de staff fuera de /api/v1.
PORTAL_COOKIE_PATH = "/api/v1"

# Hash señuelo (bcrypt), mismo propósito que ``_DECOY_PASSWORD_HASH`` en
# ``api/v1/auth.py``: mantiene un tiempo de respuesta comparable cuando el
# cliente no tiene contraseña o el correo no coincide, para no filtrar por
# temporización qué clientes tienen contraseña configurada.
_DECOY_PORTAL_HASH = bcrypt.hashpw(b"decoy-portal-password-timing-safety", bcrypt.gensalt()).decode("utf-8")


def _portal_cookie_name(client_id: int) -> str:
    return f"erp_portal_{int(client_id)}"


def hash_portal_password(password: str) -> str:
    password_bytes = password.encode("utf-8")[:72]
    return bcrypt.hashpw(password_bytes, bcrypt.gensalt()).decode("utf-8")


def verify_client_password(client: Client, password: str) -> bool:
    """
    ``bcrypt.checkpw`` contra el hash del cliente.

    Si no tiene contraseña o el hash guardado no tiene formato bcrypt (por
    ejemplo, uno futuro que llegue con otro algoritmo desde catalogo-vip),
    compara igual contra el hash señuelo y devuelve ``False`` — nunca 500.
    """
    password_bytes = password.encode("utf-8")[:72]
    stored_hash = (client.password_hash or _DECOY_PORTAL_HASH).encode("utf-8")
    try:
        return bcrypt.checkpw(password_bytes, stored_hash)
    except ValueError:
        return False


def _password_version(client: Client) -> str:
    """
    Huella corta del hash actual de la contraseña.

    Viaja como claim ``pwv`` dentro del JWT de sesión: si el cliente crea o
    el admin resetea su contraseña, el hash cambia y esta huella deja de
    coincidir, invalidando de inmediato cualquier sesión emitida con el hash
    anterior — sin necesidad de una tabla de sesiones/blacklist.
    """
    raw = (client.password_hash or "").encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def issue_portal_session(response: Response, client: Client) -> None:
    token = create_portal_token({"sub": str(client.id), "pwv": _password_version(client)})
    response.set_cookie(
        key=_portal_cookie_name(client.id),
        value=token,
        max_age=PORTAL_TOKEN_EXPIRE_DAYS * 24 * 3600,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        domain=COOKIE_DOMAIN,
        path=PORTAL_COOKIE_PATH,
    )


def clear_portal_session(response: Response, client_id: int) -> None:
    response.delete_cookie(
        key=_portal_cookie_name(client_id),
        domain=COOKIE_DOMAIN,
        path=PORTAL_COOKIE_PATH,
        secure=COOKIE_SECURE,
        samesite="lax",
        httponly=True,
    )


def has_portal_session(request: Request, client: Client) -> bool:
    token = request.cookies.get(_portal_cookie_name(client.id))
    if not token:
        return False
    try:
        payload = decode_token(token)
    except TokenError:
        return False
    if payload.get("token_type") != "portal":
        return False
    if str(payload.get("sub")) != str(client.id):
        return False
    if payload.get("pwv") != _password_version(client):
        return False
    return True


def require_portal_session(request: Request, client: Client) -> None:
    if not has_portal_session(request, client):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="portal_session_required",
        )
