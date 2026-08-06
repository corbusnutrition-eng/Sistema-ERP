#!/usr/bin/env python3
"""
Siembra cuentas regionales (bancos), pasarelas, cripto y códigos de retiro.

La tabla ``accounts`` no tiene ``user_id``; al final asigna todas las cuentas al
admin en ``users.assigned_account_ids`` (y confirma rol Master Admin).

Uso (desde ``backend/``):

    PYTHONPATH=. python scripts/seed_cuentas_regionales.py
"""

from __future__ import annotations

import sys
import uuid
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from sqlalchemy.orm import Session

_backend_dir = Path(__file__).resolve().parent.parent
_repo_root = _backend_dir.parent
load_dotenv(_repo_root / ".env")
load_dotenv(_backend_dir / ".env")

from app.currency_utils import normalize_currency_code  # noqa: E402
from app.database import DATABASE_URL, SessionLocal  # noqa: E402
from app.models.account import Account  # noqa: E402
from app.models.payment_method import PaymentMethod  # noqa: E402
from app.models.user import User, UserRole  # noqa: E402
from app.permissions import ROLE_TEMPLATE_FULL_ADMIN  # noqa: E402

DEFAULT_ADMIN_EMAIL = "admin@erp.com"
OPENING = Decimal("0.0000")
AS_OF = date(2026, 5, 13)

PAYMENT_METHOD_NAMES: tuple[str, ...] = (
    "Cuentas Ecuador",
    "Cuentas Bolivia",
    "Cuentas Peru",
    "Tarjeta de Crédito HT",
    "Tarjeta Credito PayPhone",
    "Criptomonedas USDT",
    "Codigos de Retiro",
)


@dataclass
class BankGroup:
    parent_name: str
    tipo: str
    currency: str
    children: list[str] = field(default_factory=list)


@dataclass
class StandaloneAccount:
    name: str
    tipo: str
    currency: str
    linked_payment_method: Optional[str] = None
    crypto_network: Optional[str] = None


BANK_GROUPS: tuple[BankGroup, ...] = (
    BankGroup(
        parent_name="Bancos Ecuador",
        tipo="Cuentas Ecuador",
        currency="USD",
        children=[
            "Banco Pichincha - GEOVANNI BURGOS CORAL",
            "Banco Pichincha - JENNYFER AFONSO",
        ],
    ),
    BankGroup(
        parent_name="Bancos Bolivia",
        tipo="Cuentas Bolivia",
        currency="BOB",
        children=[
            "BANCO UNION - Mauricio Gonzáles Virgo",
            "MERCANTIL SANTACRUZ - Mauricio Gonzáles Virgo",
            "SOLI PAGOS BCP - Mauricio Gonzáles Virgo",
            "TIGO MONEY - Mauricio Gonzáles Virgo",
        ],
    ),
    BankGroup(
        parent_name="Bancos Perú - Dólares",
        tipo="Cuentas Peru",
        currency="USD",
        children=[
            "BBVA Dólares - Daniela Geraldine Chávez Chiroque",
            "BCP Dólares - Daniela Geraldine Chávez Chiroque",
            "INTERBANK Dólares - Daniela Geraldine Chávez Chiroque",
            "SCOTIABANK Dólares - Daniela Geraldine Chávez Chiroque",
        ],
    ),
    BankGroup(
        parent_name="Bancos Perú - Soles",
        tipo="Cuentas Peru",
        currency="PEN",
        children=[
            "BBVA SOLES - Daniela Geraldine Chávez Chiroque",
            "BCP SOLES - Daniela Geraldine Chávez Chiroque",
            "INTERBANK SOLES - Daniela Geraldine Chávez Chiroque",
            "Lemon - Daniela Geraldine Chávez Chiroque",
        ],
    ),
)

STANDALONE_ACCOUNTS: tuple[StandaloneAccount, ...] = (
    StandaloneAccount(
        name="CUENTAS POR COBRAR ECUADOR",
        tipo="Cuentas x cobrar",
        currency="USD",
    ),
    StandaloneAccount(
        name="CUENTAS POR COBRAR BOLIVIA",
        tipo="Cuentas x cobrar",
        currency="BOB",
    ),
    StandaloneAccount(
        name="HOTMART",
        tipo="Tarjeta de Crédito HT",
        currency="USD",
        linked_payment_method="Tarjeta de Crédito HT",
    ),
    StandaloneAccount(
        name="Pay phone G",
        tipo="Tarjeta Credito PayPhone",
        currency="USD",
        linked_payment_method="Tarjeta Credito PayPhone",
    ),
    StandaloneAccount(
        name="Billeteras -CTM-USDT",
        tipo="Criptomonedas USDT",
        currency="USD",
        linked_payment_method="Criptomonedas USDT",
        crypto_network="TRC20",
    ),
    StandaloneAccount(
        name="CUENTAS POR COBRAR CRIPTOMONEDAS",
        tipo="Cuentas x cobrar",
        currency="USDT",
    ),
    StandaloneAccount(
        name="Códigos de Retiro",
        tipo="Codigos de Retiro",
        currency="USD",
        linked_payment_method="Codigos de Retiro",
    ),
)


def _require_postgresql() -> None:
    url = (DATABASE_URL or "").strip()
    if url.startswith("sqlite"):
        print("ERROR: SQLite no soportado. Use PostgreSQL.", file=sys.stderr)
        sys.exit(1)
    if not url.startswith("postgresql"):
        scheme = url.split(":", 1)[0] if url else "(vacío)"
        print(f"ERROR: Esquema de base de datos no soportado: {scheme}", file=sys.stderr)
        sys.exit(1)


def _new_code() -> str:
    return f"REG-{uuid.uuid4().hex[:12]}"


def _find_account(
    db: Session,
    *,
    name: str,
    currency: str,
    parent_id: Optional[int],
) -> Optional[Account]:
    q = db.query(Account).filter(
        Account.name == name,
        Account.currency == currency,
    )
    if parent_id is None:
        q = q.filter(Account.parent_id.is_(None))
    else:
        q = q.filter(Account.parent_id == parent_id)
    return q.first()


def _ensure_payment_methods(db: Session) -> int:
    created = 0
    for name in PAYMENT_METHOD_NAMES:
        row = db.query(PaymentMethod).filter(PaymentMethod.name == name).first()
        if row is None:
            db.add(PaymentMethod(name=name, is_active=True))
            created += 1
    if created:
        db.commit()
    return created


def _create_liquid_account(
    db: Session,
    *,
    name: str,
    currency: str,
    linked_payment_method: str,
    parent_id: Optional[int] = None,
    crypto_network: Optional[str] = None,
) -> tuple[Account, bool]:
    cur = normalize_currency_code(currency)
    existing = _find_account(db, name=name, currency=cur, parent_id=parent_id)
    if existing is not None:
        return existing, False

    acc = Account(
        code=_new_code(),
        name=name,
        account_number=None,
        account_type="asset",
        detail_type=linked_payment_method,
        linked_payment_method=linked_payment_method,
        crypto_network=crypto_network,
        description=None,
        parent_id=parent_id,
        currency=cur,
        opening_balance=OPENING,
        opening_balance_date=AS_OF,
        current_balance=OPENING,
        balance=OPENING,
        is_active=True,
    )
    db.add(acc)
    db.flush()
    return acc, True


def _create_receivable_account(
    db: Session,
    *,
    name: str,
    currency: str,
) -> tuple[Account, bool]:
    cur = normalize_currency_code(currency)
    existing = _find_account(db, name=name, currency=cur, parent_id=None)
    if existing is not None:
        return existing, False

    acc = Account(
        code=_new_code(),
        name=name,
        account_number=None,
        account_type="asset",
        detail_type="Cuentas x cobrar",
        linked_payment_method=None,
        description=None,
        parent_id=None,
        currency=cur,
        opening_balance=OPENING,
        opening_balance_date=AS_OF,
        current_balance=OPENING,
        balance=OPENING,
        is_active=True,
    )
    db.add(acc)
    db.flush()
    return acc, True


def _link_all_accounts_to_admin(db: Session, *, email: str = DEFAULT_ADMIN_EMAIL) -> int:
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise RuntimeError(f"No existe usuario {email!r}. Ejecuta create_local_admin.py primero.")

    account_ids = [int(row[0]) for row in db.query(Account.id).order_by(Account.id.asc()).all()]
    user.assigned_account_ids = account_ids
    if user.role == UserRole.admin:
        user.role_template = ROLE_TEMPLATE_FULL_ADMIN
        user.permissions = []
    db.commit()
    return len(account_ids)


def seed_regional_accounts(db: Session) -> dict[str, int]:
    stats = {
        "payment_methods_created": 0,
        "parents_inserted": 0,
        "children_inserted": 0,
        "standalone_inserted": 0,
        "skipped": 0,
    }

    stats["payment_methods_created"] = _ensure_payment_methods(db)

    for group in BANK_GROUPS:
        parent, created = _create_liquid_account(
            db,
            name=group.parent_name,
            currency=group.currency,
            linked_payment_method=group.tipo,
        )
        if created:
            stats["parents_inserted"] += 1
        else:
            stats["skipped"] += 1

        for child_name in group.children:
            _, child_created = _create_liquid_account(
                db,
                name=child_name,
                currency=group.currency,
                linked_payment_method=group.tipo,
                parent_id=parent.id,
            )
            if child_created:
                stats["children_inserted"] += 1
            else:
                stats["skipped"] += 1

    for spec in STANDALONE_ACCOUNTS:
        if spec.linked_payment_method:
            _, created = _create_liquid_account(
                db,
                name=spec.name,
                currency=spec.currency,
                linked_payment_method=spec.linked_payment_method,
                crypto_network=spec.crypto_network,
            )
        else:
            _, created = _create_receivable_account(
                db,
                name=spec.name,
                currency=spec.currency,
            )
        if created:
            stats["standalone_inserted"] += 1
        else:
            stats["skipped"] += 1

    db.commit()
    return stats


def main() -> int:
    _require_postgresql()
    db_label = DATABASE_URL.split("@")[-1] if "@" in DATABASE_URL else DATABASE_URL
    print(f"Base de datos: {db_label}")

    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.email == DEFAULT_ADMIN_EMAIL).first()
        if admin is None:
            raise RuntimeError(
                f"Usuario {DEFAULT_ADMIN_EMAIL!r} no encontrado. "
                "Ejecuta: PYTHONPATH=. python scripts/create_local_admin.py"
            )
        print(f"Admin destino: id={admin.id} ({admin.email})")

        stats = seed_regional_accounts(db)
        linked = _link_all_accounts_to_admin(db)
    except Exception as exc:
        db.rollback()
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()

    print(
        "\n✓ Siembra regional completada.\n"
        f"  • Métodos de pago nuevos: {stats['payment_methods_created']}\n"
        f"  • Padres insertados: {stats['parents_inserted']}\n"
        f"  • Hijas insertadas: {stats['children_inserted']}\n"
        f"  • Independientes insertadas: {stats['standalone_inserted']}\n"
        f"  • Omitidas (ya existían): {stats['skipped']}\n"
        f"  • Cuentas vinculadas al admin (assigned_account_ids): {linked}\n"
        "\nCierra sesión y vuelve a entrar como admin@erp.com para refrescar el JWT.\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
