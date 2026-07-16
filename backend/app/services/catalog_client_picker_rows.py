"""Filas de clientes CRM para pickers cuando el catálogo VIP (Render) no responde."""

from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.client import Client
from app.services.render_sync import _listar_webhook_normalize_email, stable_catalog_email_row_id


def local_clients_catalog_picker_rows(db: Session, limit: int = 5000) -> list[dict[str, Any]]:
    """
    Clientes activos del ERP con correo válido, en forma compatible con
    ``normalizeClienteDesdeWebhook`` en el frontend.

    Incluye clientes directos (``parent_id`` nulo) y sub-clientes BaaS.
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


def _picker_email(row: dict[str, Any]) -> Optional[str]:
    for key in ("email", "correo"):
        em = str(row.get(key) or "").strip().lower()
        if "@" in em:
            return em
    return None


def render_catalog_row_to_picker_dict(row: Any) -> Optional[dict[str, Any]]:
    """Normaliza una fila del webhook ``listar-clientes`` al formato del picker."""
    if isinstance(row, str):
        em = row.strip().lower()
        if "@" not in em:
            return None
        local_part = em.split("@", 1)[0].strip() or em
        return {
            "id": stable_catalog_email_row_id(em),
            "nombre": local_part,
            "full_name": local_part,
            "name": local_part,
            "email": em,
            "correo": em,
            "username": local_part,
            "iptv_username": local_part,
        }

    if not isinstance(row, dict):
        return None

    em = _listar_webhook_normalize_email(row)
    if not em:
        return None

    raw_id = row.get("id") or row.get("cliente_id") or row.get("client_id") or row.get("customer_id")
    try:
        id_num = int(raw_id) if raw_id is not None else stable_catalog_email_row_id(em)
    except (TypeError, ValueError):
        id_num = stable_catalog_email_row_id(em)

    name = str(
        row.get("full_name")
        or row.get("name")
        or row.get("nombre")
        or row.get("cliente")
        or row.get("razon_social")
        or em.split("@", 1)[0]
    ).strip() or em.split("@", 1)[0]
    uname = str(
        row.get("username") or row.get("iptv_username") or row.get("usuario") or row.get("iptv_user") or ""
    ).strip()

    return {
        "id": id_num,
        "nombre": name,
        "full_name": name,
        "name": name,
        "email": em,
        "correo": em,
        "username": uname,
        "iptv_username": uname or name,
    }


def merged_catalog_client_picker_rows(
    db: Session,
    render_rows: list[Any] | None,
    *,
    limit: int = 5000,
) -> list[dict[str, Any]]:
    """
    Unión para el picker de recargas BaaS:

    - Siempre incluye **todos** los clientes activos del CRM (directos y sub-clientes).
    - Añade filas del catálogo Render que aún no existan en el ERP (por correo).
    - Ante duplicado por correo, prevalece el registro local (id real de ``clients``).
    """
    lim = max(1, min(int(limit), 20_000))
    by_email: dict[str, dict[str, Any]] = {}

    for row in local_clients_catalog_picker_rows(db, limit=lim):
        em = _picker_email(row)
        if em:
            by_email[em] = row

    if render_rows:
        for raw in render_rows:
            parsed = render_catalog_row_to_picker_dict(raw)
            if not parsed:
                continue
            em = _picker_email(parsed)
            if not em or em in by_email:
                continue
            by_email[em] = parsed

    out = list(by_email.values())
    out.sort(
        key=lambda r: str(r.get("full_name") or r.get("name") or r.get("email") or "").lower(),
    )
    return out[:lim]
