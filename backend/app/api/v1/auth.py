from __future__ import annotations

from typing import Annotated, Optional

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.api.v1.dependencies import UserDep
from app.database import get_db
from app.jwt_utils import create_access_token
from app.account_verifier_access import normalize_assigned_account_ids
from app.models.user import User, UserRole
from app.permissions import ROLE_TEMPLATE_CUSTOM, ROLE_TEMPLATE_FULL_ADMIN, effective_permissions

router = APIRouter(prefix="/auth", tags=["auth"])

# ── Mock admin fallback (when no admin user exists in the DB yet) ─────────────
MOCK_EMAIL = "admin@erp.com"
MOCK_PASSWORD = "admin123"


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
def login(credentials: LoginRequest, db: DbDep) -> LoginResponse:
    """
    Autentica al usuario contra la BD (bcrypt). Si el email no existe en la BD,
    recurre al admin mock para compatibilidad durante el desarrollo.
    Devuelve un JWT firmado con el nombre y rol del usuario.
    """
    db_user: Optional[User] = db.query(User).filter(User.email == credentials.email).first()

    if db_user:
        password_bytes = credentials.password.encode("utf-8")[:72]
        if not bcrypt.checkpw(password_bytes, db_user.hashed_password.encode("utf-8")):
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

    elif credentials.email == MOCK_EMAIL and credentials.password == MOCK_PASSWORD:
        user_info = UserInfo(
            name="Admin",
            role="admin",
            user_id=None,
            permissions=effective_permissions(role="admin", permissions=None),
        )

    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciales incorrectas.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token_payload: dict = {
        "sub": credentials.email,
        "name": user_info.name,
        "role": user_info.role,
    }
    if db_user is not None:
        token_payload["user_id"] = db_user.id
        token_payload["permissions"] = user_info.permissions
    elif user_info.role == "admin":
        token_payload["permissions"] = user_info.permissions
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
