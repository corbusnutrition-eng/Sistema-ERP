#!/usr/bin/env python3
"""
Crea (o actualiza) un usuario administrador total para desarrollo / pruebas locales.

Credenciales por defecto:
  Email:    admin@erp.com
  Password: admin123

Uso (desde ``backend/``):

    PYTHONPATH=. python scripts/create_local_admin.py
"""

from __future__ import annotations

import secrets
import sys
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy.orm import Session

_backend_dir = Path(__file__).resolve().parent.parent
_repo_root = _backend_dir.parent
load_dotenv(_repo_root / ".env")
load_dotenv(_backend_dir / ".env")

from app.api.v1.users import _hash_password  # noqa: E402
from app.database import DATABASE_URL, SessionLocal  # noqa: E402
from app.models.user import User, UserRole  # noqa: E402
from app.permissions import ROLE_TEMPLATE_FULL_ADMIN  # noqa: E402

DEFAULT_EMAIL = "admin@erp.com"
DEFAULT_PASSWORD = "admin123"
DEFAULT_NAME = "Master Admin"


def _require_postgresql() -> None:
    url = (DATABASE_URL or "").strip()
    if url.startswith("sqlite"):
        print("ERROR: SQLite no soportado. Use PostgreSQL.", file=sys.stderr)
        sys.exit(1)
    if not url.startswith("postgresql"):
        scheme = url.split(":", 1)[0] if url else "(vacío)"
        print(f"ERROR: Esquema de base de datos no soportado: {scheme}", file=sys.stderr)
        sys.exit(1)


def _unique_referral_code(db: Session) -> str:
    for _ in range(40):
        code = secrets.token_hex(6).upper()
        if db.query(User.id).filter(User.referral_code == code).first() is None:
            return code
    raise RuntimeError("No se pudo generar código de referido único.")


def upsert_master_admin(
    db: Session,
    *,
    email: str = DEFAULT_EMAIL,
    password: str = DEFAULT_PASSWORD,
    name: str = DEFAULT_NAME,
) -> tuple[User, bool]:
    """Inserta o actualiza el admin. Devuelve (usuario, created)."""
    user = db.query(User).filter(User.email == email).first()
    created = user is None

    if created:
        user = User(
            name=name,
            email=email,
            hashed_password=_hash_password(password),
            role=UserRole.admin,
            is_active=True,
            permissions=[],
            role_template=ROLE_TEMPLATE_FULL_ADMIN,
            referral_code=_unique_referral_code(db),
            wallet_balance=0.0,
            parent_id=None,
            assigned_account_ids=[],
        )
        db.add(user)
    else:
        user.name = name
        user.hashed_password = _hash_password(password)
        user.role = UserRole.admin
        user.is_active = True
        user.permissions = []
        user.role_template = ROLE_TEMPLATE_FULL_ADMIN
        user.assigned_account_ids = []
        if not user.referral_code:
            user.referral_code = _unique_referral_code(db)

    db.commit()
    db.refresh(user)
    return user, created


def main() -> int:
    _require_postgresql()

    db_label = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else DATABASE_URL
    print(f"Base de datos: {db_label}")

    db = SessionLocal()
    try:
        user, created = upsert_master_admin(db)
    except Exception as exc:
        db.rollback()
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()

    action = "creado" if created else "actualizado"
    print(
        f"\n✓ Usuario Master Admin {action}.\n"
        f"  • ID:    {user.id}\n"
        f"  • Email: {user.email}\n"
        f"  • Rol:   {user.role.value} ({ROLE_TEMPLATE_FULL_ADMIN})\n"
        f"\nCredenciales de acceso:\n"
        f"  Email:    {DEFAULT_EMAIL}\n"
        f"  Password: {DEFAULT_PASSWORD}\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
