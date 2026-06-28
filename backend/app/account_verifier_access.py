"""Acceso restringido para el rol plantilla «Verificador de Cuentas»."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.account_constants import is_liquid_deposit_account
from app.models.account import Account
from app.models.user import User, UserRole

ROLE_TEMPLATE_ACCOUNT_VERIFIER = "account_verifier"


def _is_inventory_ledger_account(acc: Account) -> bool:
    dt = (acc.detail_type or "").strip().lower()
    return dt == "inventario"


def is_account_verifier(user: Optional[User]) -> bool:
    if user is None:
        return False
    if user.role == UserRole.admin:
        return False
    return str(user.role_template or "").strip() == ROLE_TEMPLATE_ACCOUNT_VERIFIER


def normalize_assigned_account_ids(raw: Any) -> list[int]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        return []
    out: list[int] = []
    for item in raw:
        try:
            n = int(item)
        except (TypeError, ValueError):
            continue
        if n > 0:
            out.append(n)
    return sorted(set(out))


def is_assignable_verifier_account(acc: Account) -> bool:
    if not acc.is_active:
        return False
    if _is_inventory_ledger_account(acc):
        return True
    return is_liquid_deposit_account(acc)


def validate_assigned_accounts_for_verifier(db: Session, account_ids: list[int]) -> list[int]:
    ids = normalize_assigned_account_ids(account_ids)
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="El verificador debe tener al menos una cuenta asignada.",
        )
    for aid in ids:
        acc = db.get(Account, aid)
        if acc is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"La cuenta con id {aid} no existe.",
            )
        if not is_assignable_verifier_account(acc):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"La cuenta «{acc.name}» no es asignable (solo bancarias o inventario).",
            )
    return ids


def resolve_assigned_account_ids_for_user(
    db: Session,
    *,
    role_template: str,
    assigned_account_ids: Optional[list[int]] = None,
    existing: Optional[list[int]] = None,
) -> list[int]:
    tpl = str(role_template or "").strip()
    if tpl != ROLE_TEMPLATE_ACCOUNT_VERIFIER:
        return []
    raw = assigned_account_ids if assigned_account_ids is not None else existing
    return validate_assigned_accounts_for_verifier(db, normalize_assigned_account_ids(raw))


def user_may_access_account(user: Optional[User], account_id: int) -> bool:
    if user is None:
        return True
    if user.role == UserRole.admin:
        return True
    if not is_account_verifier(user):
        return True
    allowed = set(normalize_assigned_account_ids(user.assigned_account_ids))
    return int(account_id) in allowed


def load_user_from_token(db: Session, current_user: dict) -> Optional[User]:
    user_id = current_user.get("user_id")
    if user_id is None:
        return None
    try:
        return db.get(User, int(user_id))
    except (TypeError, ValueError):
        return None


def assert_account_access(db: Session, current_user: dict, account_id: int) -> None:
    db_user = load_user_from_token(db, current_user)
    if db_user is None:
        return
    if not user_may_access_account(db_user, account_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No tienes acceso a esta cuenta contable.",
        )


def filter_accounts_for_user(accounts: list[Account], user: Optional[User]) -> list[Account]:
    if user is None or not is_account_verifier(user):
        return accounts
    allowed = set(normalize_assigned_account_ids(user.assigned_account_ids))
    return [a for a in accounts if a.id in allowed]
