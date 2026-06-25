from __future__ import annotations

from typing import Annotated, Callable

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.jwt_utils import decode_access_token
from app.database import get_db
from app.models.user import User
from app.permissions import user_has_permission

_bearer = HTTPBearer()
BearerDep = Annotated[HTTPAuthorizationCredentials, Depends(_bearer)]
DbDep = Annotated[Session, Depends(get_db)]


def get_current_user(credentials: BearerDep) -> dict:
    """
    Extrae el JWT del header 'Authorization: Bearer <token>' y lo valida.
    Devuelve el payload del token (incluye 'sub', 'name' y 'role').
    """
    payload = decode_access_token(credentials.credentials)
    if payload is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token inválido o expirado.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return payload


UserDep = Annotated[dict, Depends(get_current_user)]


def get_current_admin_user(current_user: UserDep) -> dict:
    """
    Dependencia de seguridad: solo permite el acceso si el usuario autenticado
    tiene el rol 'admin'. Lanza HTTP 403 para cualquier otro rol.
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
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Permiso requerido: {permission}",
            )
        return current_user

    return _dependency
