"""
Ciclo de vida de los refresh tokens de sesión de staff.

Rotación con detección de reutilización (OAuth 2.0 BCP): cada uso de un
refresh token emite uno nuevo y revoca el anterior dentro de la misma
``family_id``. Si llega un ``jti`` que ya fue revocado, es la señal de que
un token robado se está reutilizando — se revoca la familia completa.
"""

from __future__ import annotations

import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.jwt_utils import REFRESH_TOKEN_EXPIRE_DAYS, create_refresh_token
from app.models.refresh_token import RefreshToken
from app.timezone_utils import now_utc


class RefreshTokenReuseDetected(Exception):
    """
    Se presentó un refresh token ya revocado.

    Señal de robo/reutilización: el caller debe tratar esto como comprometida
    TODA la familia (ya revocada por esta misma función) y exigir un login
    limpio, no solo rechazar la petición.
    """


def issue_refresh_token(
    db: Session,
    *,
    user_id: int,
    email: str,
    role: str,
    family_id: Optional[str] = None,
    user_agent: Optional[str] = None,
    ip: Optional[str] = None,
) -> tuple[str, RefreshToken]:
    """Emite un refresh token nuevo (login, o primer eslabón de una familia)."""
    token, jti, family_id = create_refresh_token(
        {"sub": email, "role": role, "user_id": user_id},
        family_id=family_id,
    )
    row = RefreshToken(
        user_id=user_id,
        jti=jti,
        family_id=family_id,
        expires_at=now_utc() + datetime.timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
        user_agent=(user_agent or "")[:300] or None,
        ip=(ip or "")[:45] or None,
    )
    db.add(row)
    db.flush()
    return token, row


def revoke_family(db: Session, family_id: str) -> None:
    """Revoca todos los refresh tokens vivos de una familia (login comprometido)."""
    now = now_utc()
    (
        db.query(RefreshToken)
        .filter(RefreshToken.family_id == family_id, RefreshToken.revoked_at.is_(None))
        .update({"revoked_at": now}, synchronize_session=False)
    )


def revoke_all_for_user(db: Session, user_id: int) -> None:
    """Revoca todas las sesiones del usuario ("cerrar sesión en todos los dispositivos")."""
    now = now_utc()
    (
        db.query(RefreshToken)
        .filter(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .update({"revoked_at": now}, synchronize_session=False)
    )


def revoke_by_jti(db: Session, jti: str) -> None:
    row = db.query(RefreshToken).filter(RefreshToken.jti == jti).first()
    if row is not None and row.revoked_at is None:
        row.revoked_at = now_utc()


def rotate_refresh_token(
    db: Session,
    *,
    jti: str,
    family_id: str,
    user_id: int,
    email: str,
    role: str,
    user_agent: Optional[str] = None,
    ip: Optional[str] = None,
) -> tuple[str, RefreshToken]:
    """
    Valida y rota un refresh token.

    Lanza ``RefreshTokenReuseDetected`` (y revoca la familia entera antes de
    lanzar) si el ``jti`` presentado ya estaba revocado. Lanza ``ValueError``
    si el ``jti`` no existe, expiró, o no pertenece al usuario/familia
    indicados (payload del JWT manipulado).
    """
    row = db.query(RefreshToken).filter(RefreshToken.jti == jti).first()
    if row is None:
        raise ValueError("Refresh token no reconocido.")
    if row.user_id != user_id or row.family_id != family_id:
        raise ValueError("Refresh token no corresponde al usuario/familia esperados.")

    if row.revoked_at is not None:
        revoke_family(db, family_id)
        raise RefreshTokenReuseDetected(
            f"Refresh token ya revocado reutilizado (family_id={family_id})."
        )

    now = now_utc()
    expires_at = row.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
    if expires_at < now:
        raise ValueError("Refresh token expirado.")

    new_token, new_row = issue_refresh_token(
        db,
        user_id=user_id,
        email=email,
        role=role,
        family_id=family_id,
        user_agent=user_agent,
        ip=ip,
    )
    row.revoked_at = now
    row.replaced_by_jti = new_row.jti
    return new_token, new_row
