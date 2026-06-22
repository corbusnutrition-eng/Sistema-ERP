from __future__ import annotations

import uuid
from collections import defaultdict, deque

from fastapi import HTTPException, status
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.models.client import Client
from app.models.client_notification import ClientNotification
from app.timezone_utils import now_ecuador


def compute_client_network_levels(db: Session) -> dict[int, int]:
    """Profundidad BaaS desde raíces (``parent_id`` null): raíz = 1, hijos = padre + 1."""
    children_by_parent: dict[int, list[int]] = defaultdict(list)
    roots: list[int] = []
    for row in db.query(Client.id, Client.parent_id).all():
        cid = int(row.id)
        pid = row.parent_id
        if pid is None:
            roots.append(cid)
        else:
            children_by_parent[int(pid)].append(cid)

    levels: dict[int, int] = {}
    queue = deque((rid, 1) for rid in roots)
    while queue:
        cid, lvl = queue.popleft()
        if cid in levels:
            continue
        levels[cid] = lvl
        for child_id in children_by_parent.get(cid, []):
            queue.append((child_id, lvl + 1))
    return levels


def _normalize_target_value_str(target_type: str, target_value: object | None) -> str | None:
    kind = str(target_type or "").strip().lower()
    if kind == "all":
        return None
    if target_value is None:
        return None
    return str(target_value).strip() or None


def format_notification_target_label(
    db: Session,
    *,
    target_type: str | None,
    target_value: str | None,
) -> str:
    kind = str(target_type or "").strip().lower()
    if kind == "all":
        return "Todos los clientes"
    if kind == "level":
        lvl = str(target_value or "").strip()
        return f"Nivel {lvl}" if lvl else "Nivel (sin especificar)"
    if kind == "specific":
        raw = str(target_value or "").strip()
        if not raw.isdigit():
            return "Cliente específico"
        client = db.get(Client, int(raw))
        if client is None:
            return f"Cliente #{raw}"
        label = client.display_name()
        return f"{label} (#{client.id})"
    return "Destinatario desconocido"


def resolve_notification_recipient_ids(
    db: Session,
    *,
    target_type: str,
    target_value: object | None,
) -> list[int]:
    kind = str(target_type or "").strip().lower()
    if kind == "all":
        return [int(r.id) for r in db.query(Client.id).all()]

    if kind == "level":
        if target_value is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Indica el nivel objetivo.",
            )
        try:
            level = int(target_value)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El nivel debe ser un número entero.",
            ) from exc
        if level < 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El nivel debe ser mayor o igual a 1.",
            )
        levels = compute_client_network_levels(db)
        return [cid for cid, lvl in levels.items() if lvl == level]

    if kind == "specific":
        if target_value is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Indica el cliente destinatario.",
            )
        try:
            client_id = int(target_value)
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El cliente destinatario no es válido.",
            ) from exc
        client = db.get(Client, client_id)
        if client is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Cliente no encontrado.",
            )
        return [client_id]

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="target_type no válido. Use all, level o specific.",
    )


def send_client_notifications(
    db: Session,
    *,
    title: str,
    message: str,
    target_type: str,
    target_value: object | None,
) -> tuple[int, str]:
    subject = (title or "").strip()
    body = (message or "").strip()
    if not subject:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El título es obligatorio.")
    if not body:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El mensaje es obligatorio.")

    recipient_ids = resolve_notification_recipient_ids(
        db,
        target_type=target_type,
        target_value=target_value,
    )
    if not recipient_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No hay destinatarios para este criterio.",
        )

    batch_id = str(uuid.uuid4())
    target_type_norm = str(target_type or "").strip().lower()
    target_value_norm = _normalize_target_value_str(target_type_norm, target_value)
    now = now_ecuador()
    rows = [
        ClientNotification(
            client_id=int(cid),
            batch_id=batch_id,
            title=subject,
            message=body,
            target_type=target_type_norm,
            target_value=target_value_norm,
            is_read=False,
            created_at=now,
        )
        for cid in recipient_ids
    ]
    db.bulk_save_objects(rows)
    db.commit()
    return len(rows), batch_id


def list_notification_batch_history(db: Session) -> list[dict[str, object]]:
    read_sum = func.sum(case((ClientNotification.is_read.is_(True), 1), else_=0))
    rows = (
        db.query(
            ClientNotification.batch_id.label("batch_id"),
            func.min(ClientNotification.title).label("title"),
            func.min(ClientNotification.message).label("message"),
            func.min(ClientNotification.target_type).label("target_type"),
            func.min(ClientNotification.target_value).label("target_value"),
            func.min(ClientNotification.created_at).label("created_at"),
            func.count(ClientNotification.id).label("total_count"),
            read_sum.label("read_count"),
        )
        .filter(ClientNotification.batch_id.isnot(None))
        .group_by(ClientNotification.batch_id)
        .order_by(func.min(ClientNotification.created_at).desc())
        .all()
    )

    out: list[dict[str, object]] = []
    for row in rows:
        total = int(row.total_count or 0)
        read_count = int(row.read_count or 0)
        target_type = str(row.target_type or "")
        target_value = str(row.target_value).strip() if row.target_value is not None else None
        out.append(
            {
                "batch_id": str(row.batch_id),
                "title": str(row.title or ""),
                "message": str(row.message or ""),
                "target_type": target_type,
                "target_value": target_value,
                "target_label": format_notification_target_label(
                    db,
                    target_type=target_type,
                    target_value=target_value,
                ),
                "created_at": row.created_at,
                "total_count": total,
                "read_count": read_count,
                "unread_count": max(0, total - read_count),
            }
        )
    return out


def update_notification_batch(
    db: Session,
    *,
    batch_id: str,
    title: str,
    message: str,
) -> int:
    bid = str(batch_id or "").strip()
    if not bid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="batch_id inválido.")
    subject = (title or "").strip()
    body = (message or "").strip()
    if not subject:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El título es obligatorio.")
    if not body:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El mensaje es obligatorio.")

    rows = (
        db.query(ClientNotification)
        .filter(ClientNotification.batch_id == bid)
        .all()
    )
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lote de notificaciones no encontrado.")

    for row in rows:
        row.title = subject
        row.message = body
    db.commit()
    return len(rows)


def delete_notification_batch(db: Session, *, batch_id: str) -> int:
    bid = str(batch_id or "").strip()
    if not bid:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="batch_id inválido.")

    deleted = (
        db.query(ClientNotification)
        .filter(ClientNotification.batch_id == bid)
        .delete(synchronize_session=False)
    )
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Lote de notificaciones no encontrado.",
        )
    db.commit()
    return int(deleted)


def delete_notification_batches(db: Session, *, batch_ids: list[str]) -> tuple[int, int]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in batch_ids:
        bid = str(raw or "").strip()
        if not bid or bid in seen:
            continue
        seen.add(bid)
        normalized.append(bid)
    if not normalized:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Indica al menos un batch_id válido.",
        )

    distinct_batches = (
        db.query(ClientNotification.batch_id)
        .filter(ClientNotification.batch_id.in_(normalized))
        .distinct()
        .all()
    )
    if not distinct_batches:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No se encontraron lotes para eliminar.",
        )

    deleted_rows = (
        db.query(ClientNotification)
        .filter(ClientNotification.batch_id.in_(normalized))
        .delete(synchronize_session=False)
    )
    db.commit()
    return len(distinct_batches), int(deleted_rows)


def list_client_notifications(db: Session, client_id: int) -> list[ClientNotification]:
    return (
        db.query(ClientNotification)
        .filter(ClientNotification.client_id == int(client_id))
        .order_by(ClientNotification.created_at.desc(), ClientNotification.id.desc())
        .all()
    )


def mark_client_notification_read(
    db: Session,
    *,
    client_id: int,
    notification_id: int,
) -> ClientNotification:
    row = db.get(ClientNotification, int(notification_id))
    if row is None or int(row.client_id) != int(client_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notificación no encontrada.")
    row.is_read = True
    db.commit()
    db.refresh(row)
    return row
