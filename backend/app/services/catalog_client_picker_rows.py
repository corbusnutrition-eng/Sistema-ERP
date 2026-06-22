"""Filas de clientes CRM para pickers cuando el catálogo VIP (Render) no responde."""

from __future__ import annotations

from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.client import Client


def local_clients_catalog_picker_rows(db: Session, limit: int = 5000) -> list[dict[str, Any]]:
    """
    Clientes activos del ERP con correo válido, en forma compatible con
    ``normalizeClienteDesdeWebhook`` en el frontend.
    """
    lim = max(1, min(int(limit), 20_000))
    rows = (
        db.query(Client)
        .filter(or_(Client.status.is_(None), Client.status != "Inactivo"))
        .filter(Client.email.isnot(None))
        .order_by(Client.id.asc())
        .limit(lim)
        .all()
    )
    out: list[dict[str, Any]] = []
    for c in rows:
        em = str(c.email or "").strip().lower()
        if "@" not in em:
            continue
        name = (str(c.name or "").strip()) or em.split("@", 1)[0]
        uname = str(c.username or "").strip()
        out.append(
            {
                "id": int(c.id),
                "nombre": name,
                "full_name": name,
                "name": name,
                "email": em,
                "correo": em,
                "username": uname,
                "iptv_username": uname,
            }
        )
    return out
