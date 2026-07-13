"""Verificación de ownership / scope BaaS para prevenir IDOR."""
from __future__ import annotations

from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.client import Client


def resolve_client_for_jwt_user(db: Session, current_user: dict) -> Optional[Client]:
    """Cliente CRM vinculado al email del JWT (``sub``), si existe."""
    email = str(current_user.get("sub") or "").strip().lower()
    if "@" not in email:
        return None
    return db.query(Client).filter(func.lower(Client.email) == email).first()


def _jwt_user_id(current_user: dict) -> Optional[int]:
    raw = current_user.get("user_id")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def is_client_in_caller_network(db: Session, caller_client_id: int, target_client_id: int) -> bool:
    """True si ``target`` es el caller o un descendiente directo/indirecto (``parent_id``)."""
    if int(target_client_id) == int(caller_client_id):
        return True
    cur = db.get(Client, int(target_client_id))
    seen: set[int] = set()
    while cur is not None:
        cid = int(cur.id)
        if cid in seen:
            return False
        seen.add(cid)
        pid = getattr(cur, "parent_id", None)
        if pid is None:
            return False
        if int(pid) == int(caller_client_id):
            return True
        cur = db.get(Client, int(pid))
    return False


def is_client_managed_by_erp_user(db: Session, user_id: int, target_client_id: int) -> bool:
    """True si el usuario ERP gestiona al cliente o a algún ancestro vía ``parent_distributor_id``."""
    cur = db.get(Client, int(target_client_id))
    seen: set[int] = set()
    while cur is not None:
        cid = int(cur.id)
        if cid in seen:
            break
        seen.add(cid)
        pdid = getattr(cur, "parent_distributor_id", None)
        if pdid is not None and int(pdid) == int(user_id):
            return True
        pid = getattr(cur, "parent_id", None)
        if pid is None:
            break
        cur = db.get(Client, int(pid))
    return False


def assert_client_in_caller_scope(db: Session, current_user: dict, client_id: int) -> Client:
    """
    Verifica que el caller pueda acceder al cliente indicado.

    - ``admin``: acceso total.
    - Distribuidor CRM (email = JWT ``sub``): self + sub-árbol ``parent_id``.
    - Usuario ERP: clientes con ``parent_distributor_id`` en su cadena ascendente.
    """
    target = db.get(Client, int(client_id))
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")

    if str(current_user.get("role") or "") == "admin":
        return target

    caller_client = resolve_client_for_jwt_user(db, current_user)
    if caller_client is not None and is_client_in_caller_network(
        db, int(caller_client.id), int(client_id)
    ):
        return target

    uid = _jwt_user_id(current_user)
    if uid is not None and is_client_managed_by_erp_user(db, uid, int(client_id)):
        return target

    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="No autorizado para acceder a este cliente.",
    )
