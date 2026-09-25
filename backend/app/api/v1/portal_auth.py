"""
Login del portal de autogestión (correo + contraseña) sobre el link permanente.

El link ``/portal/{token}`` (``Client.payment_token``) sigue siendo necesario
para llegar aquí, pero ya no basta: el cliente debe además iniciar sesión (o
crear su contraseña, si aún no tiene una) antes de que ``portal.py`` le
entregue cualquier dato. Ver ``app.security.portal_session`` para el cookie
de sesión.
"""

from __future__ import annotations

import uuid as uuid_pkg
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.audit.forensic import record_forensic_event
from app.database import get_db
from app.models.client import Client
from app.rate_limit import LOGIN_LIMIT, PORTAL_GET_LIMIT, limiter
from app.security.portal_session import (
    clear_portal_session,
    has_portal_session,
    hash_portal_password,
    issue_portal_session,
    verify_client_password,
)

router = APIRouter(prefix="/portal/{portal_token}/auth", tags=["public-client-portal-auth"])

DbDep = Annotated[Session, Depends(get_db)]


# ── Schemas ───────────────────────────────────────────────────────────────────

class PortalLoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1, max_length=200)


class PortalSetupPasswordRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=200)
    password_confirm: str = Field(..., min_length=8, max_length=200)


class PortalAuthStatusResponse(BaseModel):
    authenticated: bool
    has_password: bool
    blocked: bool
    display_name: Optional[str] = None
    email_masked: Optional[str] = None


class PortalAuthSessionResponse(BaseModel):
    ok: bool = True
    display_name: str


class PortalLogoutResponse(BaseModel):
    ok: bool = True


# ── Helpers ───────────────────────────────────────────────────────────────────

def _client_from_token_or_404(db: Session, portal_token: uuid_pkg.UUID) -> Client:
    client = db.query(Client).filter(Client.payment_token == portal_token).first()
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Portal no encontrado.")
    return client


def _mask_email(email: str) -> str:
    email = str(email or "")
    local, sep, domain = email.partition("@")
    if not sep:
        return email
    visible = local[:2] if len(local) > 2 else local[:1]
    return f"{visible}***@{domain}"


def _is_blocked(client: Client) -> bool:
    return str(client.status or "Activo").strip().lower() == "inactivo"


def _emails_match(a: Optional[str], b: Optional[str]) -> bool:
    return str(a or "").strip().lower() == str(b or "").strip().lower()


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/status", response_model=PortalAuthStatusResponse)
@limiter.limit(PORTAL_GET_LIMIT)
def portal_auth_status(
    request: Request, portal_token: uuid_pkg.UUID, db: DbDep
) -> PortalAuthStatusResponse:
    client = _client_from_token_or_404(db, portal_token)
    authenticated = has_portal_session(request, client)
    return PortalAuthStatusResponse(
        authenticated=authenticated,
        has_password=bool(client.password_hash),
        blocked=_is_blocked(client),
        display_name=client.display_name() if authenticated else None,
        email_masked=_mask_email(client.email),
    )


@router.post("/login", response_model=PortalAuthSessionResponse)
@limiter.limit(LOGIN_LIMIT)
def portal_auth_login(
    request: Request,
    response: Response,
    portal_token: uuid_pkg.UUID,
    payload: PortalLoginRequest,
    db: DbDep,
) -> PortalAuthSessionResponse:
    client = _client_from_token_or_404(db, portal_token)
    if _is_blocked(client):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="ACCOUNT_BLOCKED")
    if not client.password_hash:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="PASSWORD_NOT_SET")

    email_ok = _emails_match(client.email, payload.email)
    # Se evalúa bcrypt.checkpw siempre, aunque el correo ya no coincida —
    # mismo motivo que el hash señuelo en auth.py: no filtrar por
    # temporización si el correo introducido es el correcto.
    password_ok = verify_client_password(client, payload.password)

    if not email_ok or not password_ok:
        record_forensic_event(
            "portal.login_failed",
            entity_table="clients",
            entity_id=str(client.id),
            detail={"email": payload.email},
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Correo o contraseña incorrectos.",
        )

    issue_portal_session(response, client)
    record_forensic_event("portal.login_success", entity_table="clients", entity_id=str(client.id))
    return PortalAuthSessionResponse(display_name=client.display_name())


@router.post("/setup-password", response_model=PortalAuthSessionResponse)
@limiter.limit(LOGIN_LIMIT)
def portal_auth_setup_password(
    request: Request,
    response: Response,
    portal_token: uuid_pkg.UUID,
    payload: PortalSetupPasswordRequest,
    db: DbDep,
) -> PortalAuthSessionResponse:
    client = _client_from_token_or_404(db, portal_token)
    if _is_blocked(client):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="ACCOUNT_BLOCKED")
    if client.password_hash:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="PASSWORD_ALREADY_SET")
    if not _emails_match(client.email, payload.email):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="El correo no coincide con este portal.",
        )
    if payload.password != payload.password_confirm:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Las contraseñas no coinciden.")

    client.password_hash = hash_portal_password(payload.password)
    db.commit()
    db.refresh(client)

    issue_portal_session(response, client)
    record_forensic_event("portal.password_set", entity_table="clients", entity_id=str(client.id))
    return PortalAuthSessionResponse(display_name=client.display_name())


@router.post("/logout", response_model=PortalLogoutResponse)
def portal_auth_logout(
    response: Response, portal_token: uuid_pkg.UUID, db: DbDep
) -> PortalLogoutResponse:
    client = _client_from_token_or_404(db, portal_token)
    clear_portal_session(response, client.id)
    return PortalLogoutResponse()
