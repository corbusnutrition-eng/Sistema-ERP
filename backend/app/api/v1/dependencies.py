from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.api.v1.auth import decode_access_token

_bearer = HTTPBearer()
BearerDep = Annotated[HTTPAuthorizationCredentials, Depends(_bearer)]


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
