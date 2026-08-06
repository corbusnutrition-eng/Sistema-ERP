#!/usr/bin/env python3
"""
Asigna todas las cuentas del plan contable al usuario administrador.

Nota: la tabla ``accounts`` no tiene ``user_id``. El ERP filtra cuentas con
``users.assigned_account_ids`` solo para el rol «Verificador de Cuentas».
Los Master Admin (``role=admin``) ven todas las cuentas; este script deja
``assigned_account_ids`` completo por compatibilidad y para otros roles.

Uso (desde ``backend/``):

    PYTHONPATH=. python scripts/vincular_cuentas.py

Otro usuario:

    PYTHONPATH=. python scripts/vincular_cuentas.py --email otro@erp.com
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy.orm import Session

_backend_dir = Path(__file__).resolve().parent.parent
_repo_root = _backend_dir.parent
load_dotenv(_repo_root / ".env")
load_dotenv(_backend_dir / ".env")

from app.database import DATABASE_URL, SessionLocal  # noqa: E402
from app.models.account import Account  # noqa: E402
from app.models.user import User, UserRole  # noqa: E402
from app.permissions import ROLE_TEMPLATE_FULL_ADMIN  # noqa: E402

DEFAULT_EMAIL = "admin@erp.com"


def _require_postgresql() -> None:
    url = (DATABASE_URL or "").strip()
    if url.startswith("sqlite"):
        print("ERROR: SQLite no soportado. Use PostgreSQL.", file=sys.stderr)
        sys.exit(1)
    if not url.startswith("postgresql"):
        scheme = url.split(":", 1)[0] if url else "(vacío)"
        print(f"ERROR: Esquema de base de datos no soportado: {scheme}", file=sys.stderr)
        sys.exit(1)


def link_all_accounts_to_user(db: Session, *, email: str = DEFAULT_EMAIL) -> dict[str, int | str]:
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise RuntimeError(f"No existe un usuario con email {email!r}.")

    account_ids = [int(row[0]) for row in db.query(Account.id).order_by(Account.id.asc()).all()]
    if not account_ids:
        raise RuntimeError(
            "No hay cuentas en la tabla accounts. Ejecuta primero:\n"
            "  PYTHONPATH=. python seed_cuentas.py"
        )

    user.assigned_account_ids = account_ids

    if user.role == UserRole.admin:
        user.role_template = ROLE_TEMPLATE_FULL_ADMIN
        user.permissions = []

    db.commit()
    db.refresh(user)

    return {
        "user_id": int(user.id),
        "email": str(user.email),
        "role": user.role.value,
        "accounts_linked": len(account_ids),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Vincula todas las cuentas contables a un usuario ERP.")
    parser.add_argument(
        "--email",
        default=DEFAULT_EMAIL,
        help=f"Email del usuario destino (default: {DEFAULT_EMAIL})",
    )
    args = parser.parse_args()

    _require_postgresql()
    db_label = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else DATABASE_URL
    print(f"Base de datos: {db_label}")

    db = SessionLocal()
    try:
        stats = link_all_accounts_to_user(db, email=args.email.strip())
    except Exception as exc:
        db.rollback()
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()

    print(
        f"\n✓ Vinculación completada.\n"
        f"  • Usuario: {stats['email']} (id={stats['user_id']}, rol={stats['role']})\n"
        f"  • Cuentas asignadas en users.assigned_account_ids: {stats['accounts_linked']}\n"
        "\nSi el plan de cuentas sigue vacío en el frontend, cierra sesión y vuelve a entrar\n"
        "con el Master Admin para refrescar el JWT.\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
