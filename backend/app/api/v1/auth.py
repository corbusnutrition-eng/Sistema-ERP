from __future__ import annotations

from typing import Annotated, Optional

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.api.v1.dependencies import UserDep
from app.database import get_db
from app.jwt_utils import create_access_token
from app.rate_limit import LOGIN_LIMIT, limiter
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


class LoginResponse(BaseModel):
    access_token: str
    token_type: str
    user: UserInfo


class MeResponse(BaseModel):
    name: str
    role: str
    email: str
    user_id: Optional[int] = None
    permissions: list[str] = []
    role_template: Optional[str] = None
    assigned_account_ids: list[int] = Field(default_factory=list)


# ── Endpoint ──────────────────────────────────────────────────────────────────

DbDep = Annotated[Session, Depends(get_db)]


@router.post("/login", response_model=LoginResponse)
@limiter.limit(LOGIN_LIMIT)
def login(request: Request, credentials: LoginRequest, db: DbDep) -> LoginResponse:
    """
    Autentica al usuario contra la BD (bcrypt) y devuelve un JWT.

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

    perms = effective_permissions(role=db_user.role.value, permissions=db_user.permissions)
    tpl = db_user.role_template or ROLE_TEMPLATE_CUSTOM
    user_info = UserInfo(
        name=db_user.name,
        role=db_user.role.value,
        user_id=db_user.id,
        permissions=perms,
        role_template=tpl if db_user.role == UserRole.worker else ROLE_TEMPLATE_FULL_ADMIN,
        assigned_account_ids=normalize_assigned_account_ids(db_user.assigned_account_ids),
    )

    # El payload del JWT NO lleva `permissions`: las rutas protegidas las
    # resuelven contra la BD en cada request (`require_permission`), así un
    # cambio de rol/permiso aplica de inmediato y no hasta que expire el token.
    token_payload = {
        "sub": credentials.email,
        "name": user_info.name,
        "role": user_info.role,
        "user_id": db_user.id,
    }
    token = create_access_token(token_payload)
    return LoginResponse(access_token=token, token_type="bearer", user=user_info)


@router.get("/me", response_model=MeResponse)
def auth_me(current_user: UserDep, db: DbDep) -> MeResponse:
    """Devuelve el perfil y permisos efectivos del usuario autenticado."""
    db_user: Optional[User] = None
    user_id = current_user.get("user_id")
    if user_id is not None:
        try:
            db_user = db.get(User, int(user_id))
        except (TypeError, ValueError):
            db_user = None

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
        perms = effective_permissions(role=role, permissions=current_user.get("permissions"))
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
