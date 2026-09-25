from __future__ import annotations

from typing import Annotated, Callable, Optional

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.audit.context import ACTOR_STAFF, set_actor
from app.audit.forensic import record_forensic_event
from app.jwt_utils import DecodedToken, TokenError, decode_token
from app.database import get_db
from app.models.user import User
from app.permissions import user_has_permission
from app.security.cookies import ACCESS_COOKIE_NAME

DbDep = Annotated[Session, Depends(get_db)]


def _extract_access_token(request: Request) -> str:
    """
    Cookie primero (flujo final); header ``Authorization: Bearer`` como
    respaldo durante la ventana de transición del frontend a cookies — ver
    Fase 3.4 del plan de seguridad. Retirar el respaldo una vez el frontend
    desplegado ya no dependa de él.
    """
    cookie_token = request.cookies.get(ACCESS_COOKIE_NAME)
    if cookie_token:
        return cookie_token

    auth_header = request.headers.get("Authorization") or ""
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="No autenticado.",
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user_payload(request: Request) -> DecodedToken:
    """Extrae y valida el JWT (cookie o header). Devuelve el payload crudo."""
    token = _extract_access_token(request)
    try:
        payload = decode_token(token)
    except TokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=exc.reason,  # "token_expired" | "token_invalid" — el frontend distingue
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    if payload.get("token_type") not in (None, "access"):
        # Defensa en profundidad: un refresh token no debe poder usarse como access token.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="token_invalid",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return payload


PayloadDep = Annotated[DecodedToken, Depends(get_current_user_payload)]


def get_current_user(payload: PayloadDep, db: DbDep) -> dict:
    """
    Valida el JWT y verifica contra la BD que el usuario exista y esté activo.

    Antes de este cambio, esta dependencia solo miraba el payload del token:
    un usuario desactivado (o eliminado) conservaba acceso hasta que el token
    expirara (hasta 8h). Ahora cada request re-verifica ``is_active`` en BD.
    El admin mock (``user_id=None``) ya no existe (ver auth.py) — todo token
    válido debe tener un ``user_id`` que resuelva a un ``User`` real.
    """
    user_id = payload.get("user_id")
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido o expirado.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido o expirado.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    db_user = db.get(User, uid)
    if db_user is None or not db_user.is_active:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuario inactivo o inexistente.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Se conserva el payload dict (compatibilidad con el resto del código que
    # lo consume como current_user.get("sub"/"name"/"role"/"user_id")), pero
    # el rol se toma SIEMPRE del registro fresco en BD, nunca del claim del
    # token — así una degradación de rol aplica de inmediato.
    merged = dict(payload)
    merged["role"] = db_user.role.value
    merged["user_id"] = db_user.id

    # Anclaje del actor para la bitácora: única línea que cubre TODAS las
    # rutas protegidas con JWT de staff (UserDep/AdminDep/require_permission).
    set_actor(actor_type=ACTOR_STAFF, actor_id=db_user.id, actor_label=db_user.email, role=db_user.role.value)

    return merged


UserDep = Annotated[dict, Depends(get_current_user)]


def get_current_admin_user(current_user: UserDep) -> dict:
    """
    Dependencia de seguridad: solo permite el acceso si el usuario autenticado
    tiene el rol 'admin'. Lanza HTTP 403 para cualquier otro rol.

    El rol viene de ``get_current_user``, que ya lo releyó de la BD — no hay
    atajo posible falsificando el claim del token.
    """
    if current_user.get("role") != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No tienes permisos para realizar esta acción.",
        )
    return current_user


AdminDep = Annotated[dict, Depends(get_current_admin_user)]


def _resolve_db_user(db: Session, current_user: dict) -> User | None:
    user_id = current_user.get("user_id")
    if user_id is None:
        return None
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return None
    return db.get(User, uid)


def require_permission(permission: str) -> Callable[..., dict]:
    """
    Factory de dependencia FastAPI: exige un permiso granular.
    Los administradores omiten la verificación (acceso total).
    """

    def _dependency(current_user: UserDep, db: DbDep) -> dict:
        role = str(current_user.get("role") or "")
        if role == "admin":
            return current_user

        db_user = _resolve_db_user(db, current_user)
        if db_user is None or not db_user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="No tienes permisos para realizar esta acción.",
            )

        if not user_has_permission(
            role=role,
            permissions=db_user.permissions,
            permission=permission,
        ):
            record_forensic_event(
                "rbac.denied",
                entity_table="users",
                entity_id=str(db_user.id),
                detail={"permission_required": permission},
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permiso requerido: {permission}",
            )
        return current_user

    return _dependency


def require_any_permission(*permissions: str) -> Callable[..., dict]:
    """Factory: exige al menos uno de los permisos indicados (admin omite verificación)."""

    def _dependency(current_user: UserDep, db: DbDep) -> dict:
        role = str(current_user.get("role") or "")
        if role == "admin":
            return current_user

        db_user = _resolve_db_user(db, current_user)
        if db_user is None or not db_user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="No tienes permisos para realizar esta acción.",
            )

        for permission in permissions:
            if user_has_permission(
                role=role,
                permissions=db_user.permissions,
                permission=permission,
            ):
                return current_user

        record_forensic_event(
            "rbac.denied",
            entity_table="users",
            entity_id=str(db_user.id),
            detail={"permission_required_any": list(permissions)},
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No tienes permisos para realizar esta acción.",
        )

    return _dependency
