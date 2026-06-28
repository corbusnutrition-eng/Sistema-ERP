from __future__ import annotations

from typing import Annotated, Any, Optional

import bcrypt
import secrets
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.v1.dependencies import require_permission
from app.permissions import (
    TEAM_USERS_CREATE,
    TEAM_USERS_EDIT,
    TEAM_USERS_VIEW,
)
from app.database import get_db
from app.account_verifier_access import (
    ROLE_TEMPLATE_ACCOUNT_VERIFIER,
    normalize_assigned_account_ids,
    resolve_assigned_account_ids_for_user,
)
from app.models.user import User, UserRole
from app.permissions import (
    ROLE_TEMPLATE_CUSTOM,
    ROLE_TEMPLATE_FULL_ADMIN,
    expand_permissions_with_legacy,
    infer_role_template,
    normalize_permissions,
    permissions_for_role_template,
    role_template_label,
)
from app.services.catalog_client_picker_rows import local_clients_catalog_picker_rows
from app.services.render_sync import (
    emails_from_listar_clientes_rows,
    fetch_listar_clientes_raw_rows,
    stable_catalog_email_row_id,
)

router = APIRouter(prefix="/users", tags=["users"])

DbDep = Annotated[Session, Depends(get_db)]
TeamUsersViewDep = Annotated[dict, Depends(require_permission(TEAM_USERS_VIEW))]
TeamUsersCreateDep = Annotated[dict, Depends(require_permission(TEAM_USERS_CREATE))]
TeamUsersEditDep = Annotated[dict, Depends(require_permission(TEAM_USERS_EDIT))]


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


def _generate_temporary_password() -> str:
    """Contraseña aleatoria para flujo «Enviar invitación» (mín. 6 caracteres bcrypt)."""
    return secrets.token_urlsafe(16)


def _resolve_create_password(plain: Optional[str]) -> str:
    cleaned = str(plain or "").strip()
    if cleaned:
        if len(cleaned) < 6:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="La contraseña debe tener al menos 6 caracteres.",
            )
        return cleaned
    return _generate_temporary_password()


# ── Schemas ───────────────────────────────────────────────────────────────────

class UserCreate(BaseModel):
    """Payload POST /api/v1/users/ — claves: name, email, password?, role_template, permissions?."""

    name: str = Field(..., min_length=1, max_length=150)
    email: EmailStr
    password: Optional[str] = Field(
        default=None,
        description="Opcional. Si se omite, el backend genera una contraseña temporal.",
    )
    role_template: str = Field(default=ROLE_TEMPLATE_CUSTOM, max_length=64)
    permissions: list[str] = Field(default_factory=list)
    assigned_account_ids: Optional[list[int]] = Field(
        default=None,
        description="Cuentas asignadas (requerido para Verificador de Cuentas).",
    )

    @field_validator("assigned_account_ids", mode="before")
    @classmethod
    def coerce_assigned_account_ids(cls, v: Any) -> Optional[list[int]]:
        if v is None:
            return None
        return normalize_assigned_account_ids(v)

    @field_validator("name", mode="before")
    @classmethod
    def strip_name(cls, v: Any) -> str:
        return str(v or "").strip()

    @field_validator("permissions", mode="before")
    @classmethod
    def coerce_permissions(cls, v: Any) -> list[str]:
        if v is None:
            return []
        return normalize_permissions(v)

    @field_validator("password", mode="before")
    @classmethod
    def empty_password_to_none(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        if isinstance(v, str) and not v.strip():
            return None
        return str(v).strip()

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and len(v) < 6:
            raise ValueError("La contraseña debe tener al menos 6 caracteres.")
        return v

    @field_validator("role_template", mode="before")
    @classmethod
    def coerce_role_template(cls, v: Any) -> str:
        return str(v or ROLE_TEMPLATE_CUSTOM).strip() or ROLE_TEMPLATE_CUSTOM


class UserUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=150)
    email: Optional[EmailStr] = None
    password: Optional[str] = Field(default=None)
    role_template: Optional[str] = Field(default=None, max_length=64)
    permissions: Optional[list[str]] = None
    is_active: Optional[bool] = None
    assigned_account_ids: Optional[list[int]] = Field(
        default=None,
        description="Cuentas asignadas (Verificador de Cuentas).",
    )

    @field_validator("assigned_account_ids", mode="before")
    @classmethod
    def coerce_assigned_account_ids(cls, v: Any) -> Optional[list[int]]:
        if v is None:
            return None
        return normalize_assigned_account_ids(v)

    @field_validator("permissions", mode="before")
    @classmethod
    def coerce_permissions(cls, v: Any) -> Optional[list[str]]:
        if v is None:
            return None
        return normalize_permissions(v)

    @field_validator("password", mode="before")
    @classmethod
    def empty_password_to_none(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        if isinstance(v, str) and not v.strip():
            return None
        return str(v).strip()

    @field_validator("password")
    @classmethod
    def password_min_length(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and len(v) < 6:
            raise ValueError("La contraseña debe tener al menos 6 caracteres.")
        return v

    @field_validator("role_template", mode="before")
    @classmethod
    def coerce_role_template(cls, v: Any) -> Optional[str]:
        if v is None:
            return None
        s = str(v).strip()
        return s or None


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
    role_template: Optional[str] = None
    role_template_label: Optional[str] = None
    assigned_account_ids: list[int] = Field(default_factory=list)

    model_config = {"from_attributes": True}

    @field_validator("permissions", mode="before")
    @classmethod
    def normalize_permissions_response(cls, v: object) -> list[str]:
        return normalize_permissions(v)

    @field_validator("assigned_account_ids", mode="before")
    @classmethod
    def normalize_assigned_accounts_response(cls, v: object) -> list[int]:
        return normalize_assigned_account_ids(v)


def _user_to_response(user: User) -> UserResponse:
    tpl = user.role_template or infer_role_template(role=user.role.value, permissions=user.permissions)
    return UserResponse(
        id=user.id,
        name=user.name,
        email=str(user.email),
        role=user.role,
        is_active=user.is_active,
        parent_id=user.parent_id,
        wallet_balance=float(user.wallet_balance or 0.0),
        referral_code=user.referral_code,
        permissions=normalize_permissions(user.permissions),
        role_template=tpl,
        role_template_label=role_template_label(tpl if user.role == UserRole.worker else ROLE_TEMPLATE_FULL_ADMIN),
        assigned_account_ids=normalize_assigned_account_ids(user.assigned_account_ids),
    )


def _apply_role_template_payload(
    *,
    role_template: str,
    permissions: list[str],
) -> tuple[UserRole, list[str], str]:
    tpl_id = str(role_template or ROLE_TEMPLATE_CUSTOM).strip() or ROLE_TEMPLATE_CUSTOM
    if tpl_id == ROLE_TEMPLATE_CUSTOM:
        perms = expand_permissions_with_legacy(normalize_permissions(permissions))
        return UserRole.worker, perms, ROLE_TEMPLATE_CUSTOM
    system_role, tpl_perms = permissions_for_role_template(tpl_id)
    db_role = UserRole.admin if system_role == "admin" else UserRole.worker
    if tpl_id == ROLE_TEMPLATE_FULL_ADMIN:
        return db_role, [], ROLE_TEMPLATE_FULL_ADMIN
    return db_role, tpl_perms, tpl_id


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
def create_user(payload: UserCreate, db: DbDep, _: TeamUsersCreateDep) -> UserResponse:
    """Registra un nuevo trabajador/administrador. Sin password → contraseña temporal."""
    if not payload.name.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="El nombre es obligatorio.",
        )
    db_role, perms, tpl = _apply_role_template_payload(
        role_template=payload.role_template,
        permissions=payload.permissions,
    )
    plain_password = _resolve_create_password(payload.password)
    assigned_ids = resolve_assigned_account_ids_for_user(
        db,
        role_template=tpl,
        assigned_account_ids=payload.assigned_account_ids,
    )
    user = User(
        name=payload.name.strip(),
        email=payload.email,
        hashed_password=_hash_password(plain_password),
        role=db_role,
        is_active=True,
        referral_code=_unique_referral_code(db),
        permissions=perms if db_role == UserRole.worker else [],
        role_template=tpl if db_role == UserRole.worker else ROLE_TEMPLATE_FULL_ADMIN,
        assigned_account_ids=assigned_ids if tpl == ROLE_TEMPLATE_ACCOUNT_VERIFIER else [],
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
    return _user_to_response(user)


@router.get("/team", response_model=list[UserResponse])
def list_team_users(db: DbDep, _: TeamUsersViewDep) -> list[UserResponse]:
    """Lista miembros del equipo ERP con permisos y plantilla de rol."""
    rows = db.query(User).order_by(User.name.asc()).all()
    for u in rows:
        if not u.referral_code:
            u.referral_code = _unique_referral_code(db)
    if rows:
        db.commit()
        for u in rows:
            db.refresh(u)
    return [_user_to_response(u) for u in rows]


@router.get("", response_model=list[UserPickerRow])
@router.get("/", response_model=list[UserPickerRow])
def list_users(
    db: DbDep,
    _: TeamUsersViewDep,
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


@router.get("/{user_id}", response_model=UserResponse)
def get_user(user_id: int, db: DbDep, _: TeamUsersViewDep) -> UserResponse:
    user: Optional[User] = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario no encontrado.")
    return _user_to_response(user)


@router.patch("/{user_id}", response_model=UserResponse)
def update_user(user_id: int, payload: UserUpdate, db: DbDep, _: TeamUsersEditDep) -> UserResponse:
    user: Optional[User] = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario no encontrado.")

    if payload.name is not None:
        user.name = payload.name.strip()
    if payload.email is not None:
        user.email = payload.email
    if payload.password:
        user.hashed_password = _hash_password(payload.password)
    if payload.is_active is not None:
        user.is_active = payload.is_active

    if payload.role_template is not None or payload.permissions is not None:
        tpl = payload.role_template or user.role_template or ROLE_TEMPLATE_CUSTOM
        perms = (
            payload.permissions
            if payload.permissions is not None
            else normalize_permissions(user.permissions)
        )
        db_role, expanded, resolved_tpl = _apply_role_template_payload(
            role_template=tpl,
            permissions=perms,
        )
        user.role = db_role
        user.role_template = resolved_tpl if db_role == UserRole.worker else ROLE_TEMPLATE_FULL_ADMIN
        user.permissions = expanded if db_role == UserRole.worker else []
        if resolved_tpl == ROLE_TEMPLATE_ACCOUNT_VERIFIER:
            user.assigned_account_ids = resolve_assigned_account_ids_for_user(
                db,
                role_template=resolved_tpl,
                assigned_account_ids=(
                    payload.assigned_account_ids
                    if payload.assigned_account_ids is not None
                    else normalize_assigned_account_ids(user.assigned_account_ids)
                ),
            )
        else:
            user.assigned_account_ids = []

    elif payload.assigned_account_ids is not None:
        tpl = user.role_template or ROLE_TEMPLATE_CUSTOM
        user.assigned_account_ids = resolve_assigned_account_ids_for_user(
            db,
            role_template=tpl,
            assigned_account_ids=payload.assigned_account_ids,
        )

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ya existe un usuario con ese correo electrónico.",
        )
    db.refresh(user)
    return _user_to_response(user)


@router.patch("/{user_id}/toggle-active", response_model=UserResponse)
def toggle_active(user_id: int, db: DbDep, _: TeamUsersEditDep) -> UserResponse:
    """Activa o desactiva un usuario."""
    user: Optional[User] = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario no encontrado.")
    user.is_active = not user.is_active
    db.commit()
    db.refresh(user)
    return _user_to_response(user)
