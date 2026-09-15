#!/usr/bin/env python3
"""
Crea (o promueve a admin) el usuario administrador real en PRODUCCIÓN.

Sustituye al backdoor hardcodeado ``admin@erp.com`` / ``admin123`` que existía
en ``app/api/v1/auth.py`` (login mock cuando el email no existía en la BD).
Ese backdoor fue eliminado — este script es el reemplazo seguro para obtener
el primer usuario admin antes de desplegar.

⚠️  IMPORTANTE — orden de despliegue:
    Si el único acceso admin actual es el backdoor mock, ejecuta este script
    contra la base de PRODUCCIÓN *antes* de desplegar el commit que lo
    elimina, o quedarás sin ningún admin en el sistema.

A diferencia de ``create_local_admin.py`` (conveniencia de desarrollo con
credenciales fijas), este script NUNCA usa una contraseña por defecto y
exige una contraseña fuerte explícita — por argumento o variable de entorno.

Uso (desde ``backend/``, con ``DATABASE_URL`` apuntando a producción):

    PYTHONPATH=. python scripts/create_admin.py \\
        --email admin@tudominio.com --name "Nombre Apellido"
    # pedirá la contraseña de forma interactiva (no queda en el historial de shell)

    # o, no interactivo (CI / script de despliegue):
    ADMIN_EMAIL=admin@tudominio.com ADMIN_PASSWORD='...' ADMIN_NAME='Nombre' \\
        PYTHONPATH=. python scripts/create_admin.py --yes
"""

from __future__ import annotations

import argparse
import getpass
import os
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
from app.audit.context import ACTOR_SCRIPT, audit_actor_scope  # noqa: E402
from app.database import DATABASE_URL, SessionLocal  # noqa: E402
from app.models.user import User, UserRole  # noqa: E402
from app.permissions import ROLE_TEMPLATE_FULL_ADMIN  # noqa: E402

MIN_PASSWORD_LENGTH = 12


def _require_postgresql() -> None:
    url = (DATABASE_URL or "").strip()
    if not url.startswith("postgresql"):
        scheme = url.split(":", 1)[0] if url else "(vacío)"
        print(
            f"ERROR: DATABASE_URL apunta a '{scheme}', no a PostgreSQL. "
            "Exporta DATABASE_URL con la cadena de producción antes de ejecutar este script.",
            file=sys.stderr,
        )
        sys.exit(1)


def _validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        print(
            f"ERROR: la contraseña debe tener al menos {MIN_PASSWORD_LENGTH} caracteres.",
            file=sys.stderr,
        )
        sys.exit(1)
    if password.lower() in {"admin123", "password", "12345678", "administrador"}:
        print("ERROR: esa contraseña es demasiado predecible. Elige otra.", file=sys.stderr)
        sys.exit(1)


def _unique_referral_code(db: Session) -> str:
    for _ in range(40):
        code = secrets.token_hex(6).upper()
        if db.query(User.id).filter(User.referral_code == code).first() is None:
            return code
    raise RuntimeError("No se pudo generar código de referido único.")


def upsert_admin(db: Session, *, email: str, password: str, name: str) -> tuple[User, bool]:
    """Inserta el admin si no existe, o promueve a admin si el email ya existe. No pisa
    la contraseña de un usuario existente salvo que se pase explícitamente ``--reset-password``
    (ver ``main``)."""
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
        user.role = UserRole.admin
        user.is_active = True
        user.role_template = ROLE_TEMPLATE_FULL_ADMIN
        if not user.referral_code:
            user.referral_code = _unique_referral_code(db)

    db.commit()
    db.refresh(user)
    return user, created


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", default=os.getenv("ADMIN_EMAIL"))
    parser.add_argument("--name", default=os.getenv("ADMIN_NAME", "Administrador"))
    parser.add_argument(
        "--reset-password",
        action="store_true",
        help="Si el email ya existe, también sobrescribe su contraseña con la indicada.",
    )
    parser.add_argument(
        "--yes", action="store_true", help="No interactivo: usa ADMIN_PASSWORD del entorno."
    )
    args = parser.parse_args()

    _require_postgresql()

    if not args.email:
        print("ERROR: falta --email (o variable ADMIN_EMAIL).", file=sys.stderr)
        return 1

    password = os.getenv("ADMIN_PASSWORD")
    if not password:
        if args.yes:
            print("ERROR: --yes requiere ADMIN_PASSWORD en el entorno.", file=sys.stderr)
            return 1
        password = getpass.getpass(f"Contraseña para {args.email}: ")
        confirm = getpass.getpass("Confírmala: ")
        if password != confirm:
            print("ERROR: las contraseñas no coinciden.", file=sys.stderr)
            return 1

    _validate_password(password)

    db_label = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else DATABASE_URL
    print(f"Base de datos: {db_label}")

    db = SessionLocal()
    try:
        with audit_actor_scope(actor_type=ACTOR_SCRIPT, actor_label="create_admin.py"):
            existing = db.query(User).filter(User.email == args.email).first()
            if existing is not None and args.reset_password:
                existing.hashed_password = _hash_password(password)
                db.commit()
            user, created = upsert_admin(db, email=args.email, password=password, name=args.name)
    except Exception as exc:  # noqa: BLE001 - script de una sola vez, se reporta y sale
        db.rollback()
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()

    action = "creado" if created else "promovido a admin"
    pwd_note = " (contraseña actualizada)" if (not created and args.reset_password) else ""
    print(
        f"\n✓ Usuario admin {action}{pwd_note}.\n"
        f"  • ID:    {user.id}\n"
        f"  • Email: {user.email}\n"
        f"  • Rol:   {user.role.value} ({ROLE_TEMPLATE_FULL_ADMIN})\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
