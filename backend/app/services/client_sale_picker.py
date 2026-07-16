"""Búsqueda de clientes activos del CRM para el picker de ventas."""

from __future__ import annotations

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.client import Client


def search_active_clients_for_sale_picker(
    db: Session,
    *,
    q: str | None,
    mode: str,
    limit: int = 80,
) -> list[Client]:
    """
    Busca clientes activos en ``clients`` (directos, distribuidores y sub-clientes).

    ``mode``:
      - ``nombre``: filtra por ``name`` o ``email``.
      - ``usuario``: filtra estrictamente por ``username`` (usuario IPTV).
    """
    lim = max(1, min(int(limit), 200))
    mode_norm = (mode or "nombre").strip().lower()
    if mode_norm not in {"nombre", "usuario"}:
        mode_norm = "nombre"

    query = (
        db.query(Client)
        .filter(or_(Client.status.is_(None), Client.status != "Inactivo"))
        .filter(Client.email.isnot(None))
    )

    term = (q or "").strip().lower()
    if term:
        pattern = f"%{term}%"
        if mode_norm == "usuario":
            query = query.filter(func.lower(Client.username).like(pattern))
        else:
            query = query.filter(
                or_(
                    func.lower(func.coalesce(Client.name, "")).like(pattern),
                    func.lower(Client.email).like(pattern),
                )
            )

    return (
        query.order_by(
            func.lower(func.coalesce(Client.name, Client.username)).asc(),
            Client.username.asc(),
            Client.id.asc(),
        )
        .limit(lim)
        .all()
    )
