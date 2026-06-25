from __future__ import annotations

from typing import Annotated, Optional

import bcrypt
import secrets
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.v1.dependencies import AdminDep
from app.database import get_db
from app.models.user import User, UserRole
from app.permissions import normalize_permissions
from app.services.catalog_client_picker_rows import local_clients_catalog_picker_rows
from app.services.render_sync import (
    emails_from_listar_clientes_rows,
    fetch_listar_clientes_raw_rows,
    stable_catalog_email_row_id,
)

router = APIRouter(prefix="/users", tags=["users"])

DbDep = Annotated[Session, Depends(get_db)]


# bcrypt hard-limits passwords to 72 bytes. We encode to UTF-8 and truncate
# explicitly so multi-byte characters are counted correctly as bytes.
def _hash_password(plain: str) -> str:
    """Return a bcrypt hash of the password (UTF-8, max 72 bytes)."""
    password_bytes = plain.encode("utf-8")[:72]
    return bcrypt.hashpw(password_bytes, bcrypt.gensalt()).decode("utf-8")


def _verify_password(plain: str, hashed: str) -> bool:
    """Verify a plain password against a stored bcrypt hash."""
    password_bytes = plain.encode("utf-8")[:72]
    return bcrypt.checkpw(password_bytes, hashed.encode("utf-8"))


# ── Schemas ───────────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=150)
    email: EmailStr
    password: str = Field(..., min_length=6)
    role: UserRole = UserRole.worker
    permissions: list[str] = Field(default_factory=list)

    @field_validator("permissions")
    @classmethod
    def validate_permissions(cls, v: list[str]) -> list[str]:
        return normalize_permissions(v)


class UserResponse(BaseModel):
    id: int
    name: str
    email: str
    role: UserRole
    is_active: bool
    parent_id: Optional[int] = None
    wallet_balance: float = 0.0
    referral_code: Optional[str] = None
    permissions: list[str] = Field(default_factory=list)

    model_config = {"from_attributes": True}

    @field_validator("permissions", mode="before")
    @classmethod
    def normalize_permissions_response(cls, v: object) -> list[str]:
        return normalize_permissions(v)


class UserPickerRow(BaseModel):
    """Fila para listados: usuario ERP o cliente CRM (véase ``role=client`` en GET /users)."""

    id: int
    name: str
    email: str = ""
    role: str
    is_active: bool = True
    parent_id: Optional[int] = None
    wallet_balance: float = 0.0
    referral_code: Optional[str] = None
    iptv_username: Optional[str] = None
    #: Cuando viene de Render ``listar-clientes``: ``render_listar_clientes``.
    source: Optional[str] = None


def _unique_referral_code(db: Session) -> str:
    for _ in range(40):
        code = secrets.token_hex(6).upper()
        if db.query(User.id).filter(User.referral_code == code).first() is None:
            return code
    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="No se pudo generar código de referido único.",
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(payload: UserCreate, db: DbDep, _: AdminDep) -> User:
    """Registra un nuevo trabajador/administrador con contraseña hasheada."""
    user = User(
        name=payload.name,
        email=payload.email,
        hashed_password=_hash_password(payload.password),
        role=payload.role,
        is_active=True,
        referral_code=_unique_referral_code(db),
        permissions=(
            normalize_permissions(payload.permissions)
            if payload.role == UserRole.worker
            else []
        ),
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Ya existe un usuario con el email '{payload.email}'.",
        )
    db.refresh(user)
    return user


@router.get("", response_model=list[UserPickerRow])
@router.get("/", response_model=list[UserPickerRow])
def list_users(
    db: DbDep,
    _: AdminDep,
    role: Annotated[
        Optional[str],
        Query(
            description="'client' lista correos desde Render (webhook ``listar-clientes``); admin|worker filtra tabla ``users``",
        ),
    ] = None,
    search: Annotated[
        Optional[str],
        Query(description="Sólo ``role=client``: subcadena a buscar dentro del correo (minúsculas)."),
    ] = None,
    skip: int = 0,
    limit: int = Query(default=100, ge=1, le=500),
) -> list[UserPickerRow]:
    """
    Lista desde el ERP tabla ``users`` o, si ``role=client``, clientes desde Render
    ``POST …/api/webhook/listar-clientes`` vía puente; si la nube falla, usa la tabla ``clients`` local.
    ``search`` (modo cliente CRM) filtra por subcadena dentro del correo en minúsculas.
    """
    rl = (role or "").strip().lower()

    if rl == "client":
        rows, render_ok = fetch_listar_clientes_raw_rows()

        term = (search or "").strip().lower()

        if render_ok and rows is not None:
            emails = emails_from_listar_clientes_rows(rows)
            if term:
                emails = [e for e in emails if term in e]
            page = emails[skip : skip + limit]
            return [
                UserPickerRow(
                    id=stable_catalog_email_row_id(email),
                    name=email.split("@", 1)[0].strip() if "@" in email else email,
                    email=email,
                    role="client",
                    is_active=True,
                    wallet_balance=0.0,
                    iptv_username=email.split("@", 1)[0].strip() if "@" in email else None,
                    source="render_listar_clientes",
                )
                for email in page
            ]

        picker = local_clients_catalog_picker_rows(db)
        if term:
            picker = [r for r in picker if term in str(r.get("email") or "").lower()]
        page_slice = picker[skip : skip + limit]
        return [
            UserPickerRow(
                id=int(r["id"]),
                name=str(r.get("full_name") or r.get("name") or ""),
                email=str(r.get("email") or ""),
                role="client",
                is_active=True,
                wallet_balance=0.0,
                iptv_username=(
                    str(r.get("iptv_username") or r.get("username") or "").strip() or None
                ),
                source="local_clients_table",
            )
            for r in page_slice
        ]

    q_users = db.query(User)
    if rl == "admin":
        q_users = q_users.filter(User.role == UserRole.admin)
    elif rl == "worker":
        q_users = q_users.filter(User.role == UserRole.worker)

    rows = q_users.offset(skip).limit(limit).all()

    # Poblar códigos de referido sólo sobre filas tabla ``users``.
    for u in rows:
        if not u.referral_code:
            u.referral_code = _unique_referral_code(db)
    if rows:
        db.commit()
        for u in rows:
            db.refresh(u)

    return [
        UserPickerRow(
            id=int(u.id),
            name=u.name,
            email=str(u.email or "").strip(),
            role=u.role.value,
            is_active=bool(u.is_active),
            parent_id=u.parent_id,
            wallet_balance=float(u.wallet_balance or 0.0),
            referral_code=u.referral_code,
        )
        for u in rows
    ]


@router.patch("/{user_id}/toggle-active", response_model=UserResponse)
def toggle_active(user_id: int, db: DbDep, _: AdminDep) -> User:
    """Activa o desactiva un usuario."""
    user: Optional[User] = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario no encontrado.")
    user.is_active = not user.is_active
    db.commit()
    db.refresh(user)
    return user
