from __future__ import annotations

from typing import Annotated, Optional

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.api.v1.dependencies import UserDep
from app.database import get_db
from app.jwt_utils import TokenError, create_access_token, decode_token
from app.rate_limit import LOGIN_LIMIT, get_client_ip, limiter
from app.security.cookies import (
    REFRESH_COOKIE_NAME,
    clear_session_cookies,
    set_session_cookies,
)
from app.services.refresh_token_service import (
    RefreshTokenReuseDetected,
    issue_refresh_token,
    revoke_all_for_user,
    revoke_by_jti,
    rotate_refresh_token,
)
from app.account_verifier_access import normalize_assigned_account_ids
from app.models.user import User, UserRole
from app.permissions import ROLE_TEMPLATE_CUSTOM, ROLE_TEMPLATE_FULL_ADMIN, effective_permissions

router = APIRouter(prefix="/auth", tags=["auth"])

# Hash señuelo (bcrypt) contra el que se compara cuando el email no existe en
# la BD, para que un login con email inexistente tome un tiempo comparable a
# uno con contraseña incorrecta — sin esto, medir el tiempo de respuesta
# permite enumerar qué correos están registrados.
_DECOY_PASSWORD_HASH = bcrypt.hashpw(b"decoy-password-timing-safety", bcrypt.gensalt()).decode("utf-8")


# ── Schemas ───────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserInfo(BaseModel):
    name: str
    role: str
    user_id: Optional[int] = None
    permissions: list[str] = []
    role_template: Optional[str] = None
    assigned_account_ids: list[int] = Field(default_factory=list)


class SessionResponse(BaseModel):
    """Respuesta de login/refresh: el token viaja en cookies HttpOnly, no en el cuerpo."""

    user: UserInfo


class MeResponse(BaseModel):
    name: str
    role: str
    email: str
    user_id: Optional[int] = None
    permissions: list[str] = []
    role_template: Optional[str] = None
    assigned_account_ids: list[int] = Field(default_factory=list)


class LogoutResponse(BaseModel):
    ok: bool = True


# ── Helpers ───────────────────────────────────────────────────────────────────

DbDep = Annotated[Session, Depends(get_db)]


def _user_info(db_user: User) -> UserInfo:
    perms = effective_permissions(role=db_user.role.value, permissions=db_user.permissions)
    tpl = db_user.role_template or ROLE_TEMPLATE_CUSTOM
    return UserInfo(
        name=db_user.name,
        role=db_user.role.value,
        user_id=db_user.id,
        permissions=perms,
        role_template=tpl if db_user.role == UserRole.worker else ROLE_TEMPLATE_FULL_ADMIN,
        assigned_account_ids=normalize_assigned_account_ids(db_user.assigned_account_ids),
    )


def _access_token_payload(db_user: User) -> dict:
    # Sin `permissions`: las rutas protegidas las resuelven contra la BD en
    # cada request (`require_permission`), así un cambio de rol/permiso
    # aplica de inmediato y no hasta que expire el token viejo.
    return {"sub": db_user.email, "name": db_user.name, "role": db_user.role.value, "user_id": db_user.id}


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.post("/login", response_model=SessionResponse)
@limiter.limit(LOGIN_LIMIT)
def login(request: Request, response: Response, credentials: LoginRequest, db: DbDep) -> SessionResponse:
    """
    Autentica al usuario contra la BD (bcrypt) y abre sesión vía cookies HttpOnly.

    Sin backdoor: el único camino de acceso es un ``User`` real en la BD con
    ``is_active=True``. El caso "email no existe" ejecuta igualmente un
    ``bcrypt.checkpw`` contra un hash señuelo (``_DECOY_PASSWORD_HASH``) para
    no filtrar por temporización qué correos están registrados.
    """
    db_user: Optional[User] = db.query(User).filter(User.email == credentials.email).first()

    password_bytes = credentials.password.encode("utf-8")[:72]
    stored_hash = (db_user.hashed_password if db_user else _DECOY_PASSWORD_HASH).encode("utf-8")
    password_ok = bcrypt.checkpw(password_bytes, stored_hash)

    if db_user is None or not password_ok:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciales incorrectas.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not db_user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Usuario desactivado. Contacta al administrador.",
        )

    access_token = create_access_token(_access_token_payload(db_user))
    refresh_token, _row = issue_refresh_token(
        db,
        user_id=db_user.id,
        email=db_user.email,
        role=db_user.role.value,
        user_agent=request.headers.get("user-agent"),
        ip=get_client_ip(request),
    )
    db.commit()

    set_session_cookies(response, access_token=access_token, refresh_token=refresh_token)
    return SessionResponse(user=_user_info(db_user))


@router.post("/refresh", response_model=SessionResponse)
@limiter.limit(LOGIN_LIMIT)
def refresh_session(request: Request, db: DbDep) -> Response:
    """
    Rota el par access/refresh a partir de la cookie de refresh vigente.

    Las fallas se devuelven como ``JSONResponse`` construido a mano (en vez de
    levantar ``HTTPException``) para poder limpiar las cookies en la misma
    respuesta — un ``raise`` perdería las mutaciones hechas sobre un
    ``Response`` inyectado por dependencia.
    """
    raw_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if not raw_token:
        resp = JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"detail": "no_refresh_token"})
        clear_session_cookies(resp)
        return resp

    try:
        payload = decode_token(raw_token)
    except TokenError as exc:
        resp = JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"detail": exc.reason})
        clear_session_cookies(resp)
        return resp

    if payload.get("token_type") != "refresh":
        resp = JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"detail": "token_invalid"})
        clear_session_cookies(resp)
        return resp

    jti = payload.get("jti")
    family_id = payload.get("family_id")
    user_id = payload.get("user_id")
    if not jti or not family_id or user_id is None:
        resp = JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"detail": "token_invalid"})
        clear_session_cookies(resp)
        return resp

    db_user = db.get(User, int(user_id))
    if db_user is None or not db_user.is_active:
        resp = JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"detail": "user_inactive"})
        clear_session_cookies(resp)
        return resp

    try:
        new_refresh_token, _row = rotate_refresh_token(
            db,
            jti=str(jti),
            family_id=str(family_id),
            user_id=db_user.id,
            email=db_user.email,
            role=db_user.role.value,
            user_agent=request.headers.get("user-agent"),
            ip=get_client_ip(request),
        )
    except RefreshTokenReuseDetected:
        db.commit()  # persiste la revocación de toda la familia hecha dentro de rotate_refresh_token
        resp = JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"detail": "refresh_reuse_detected"})
        clear_session_cookies(resp)
        return resp
    except ValueError:
        db.rollback()
        resp = JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"detail": "token_invalid"})
        clear_session_cookies(resp)
        return resp

    new_access_token = create_access_token(_access_token_payload(db_user))
    db.commit()

    body = SessionResponse(user=_user_info(db_user))
    resp = JSONResponse(status_code=status.HTTP_200_OK, content=body.model_dump())
    set_session_cookies(resp, access_token=new_access_token, refresh_token=new_refresh_token)
    return resp


@router.post("/logout", response_model=LogoutResponse)
def logout(request: Request, response: Response, db: DbDep) -> LogoutResponse:
    """Revoca el refresh token presentado (si lo hay) y limpia las cookies."""
    raw_token = request.cookies.get(REFRESH_COOKIE_NAME)
    if raw_token:
        try:
            payload = decode_token(raw_token)
            jti = payload.get("jti")
            if jti:
                revoke_by_jti(db, str(jti))
                db.commit()
        except TokenError:
            pass  # token ya inválido: nada que revocar, igualmente limpiamos cookies
    clear_session_cookies(response)
    return LogoutResponse(ok=True)


@router.post("/logout-all", response_model=LogoutResponse)
def logout_all(current_user: UserDep, response: Response, db: DbDep) -> LogoutResponse:
    """Revoca TODAS las sesiones del usuario autenticado (todos los dispositivos)."""
    user_id = current_user.get("user_id")
    if user_id is not None:
        revoke_all_for_user(db, int(user_id))
        db.commit()
    clear_session_cookies(response)
    return LogoutResponse(ok=True)


@router.get("/me", response_model=MeResponse)
def auth_me(current_user: UserDep, db: DbDep) -> MeResponse:
    """Devuelve el perfil y permisos efectivos del usuario autenticado."""
    user_id = current_user.get("user_id")
    db_user: Optional[User] = db.get(User, int(user_id)) if user_id is not None else None

    # `get_current_user` ya exige que el usuario exista y esté activo, así que
    # en la práctica `db_user` siempre resuelve aquí. Se conserva el fallback
    # a los claims del token únicamente como defensa en profundidad.
    role = str(current_user.get("role") or "worker")
    email = str(current_user.get("sub") or "")
    name = str(current_user.get("name") or "")

    if db_user is not None:
        role = db_user.role.value
        email = str(db_user.email or email)
        name = db_user.name
        perms = effective_permissions(role=role, permissions=db_user.permissions)
        tpl = db_user.role_template or ROLE_TEMPLATE_CUSTOM
        if db_user.role == UserRole.admin:
            tpl = ROLE_TEMPLATE_FULL_ADMIN
        assigned = normalize_assigned_account_ids(db_user.assigned_account_ids)
    else:
        perms = effective_permissions(role=role, permissions=None)
        tpl = None
        assigned = []

    return MeResponse(
        name=name,
        role=role,
        email=email,
        user_id=int(user_id) if user_id is not None else None,
        permissions=perms,
        role_template=tpl,
        assigned_account_ids=assigned,
    )
