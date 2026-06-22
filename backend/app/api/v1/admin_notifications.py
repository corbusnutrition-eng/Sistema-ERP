"""Envío masivo de notificaciones a clientes BaaS (bandeja del portal)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.v1.dependencies import AdminDep
from app.database import get_db
from app.schemas.client_notifications import (
    AdminBulkDeleteNotificationBatchesRequest,
    AdminBulkDeleteNotificationBatchesResponse,
    AdminDeleteNotificationBatchResponse,
    AdminNotificationBatchHistoryItem,
    AdminSendNotificationRequest,
    AdminSendNotificationResponse,
    AdminUpdateNotificationBatchRequest,
    AdminUpdateNotificationBatchResponse,
)
from app.services.client_notification_service import (
    delete_notification_batch,
    delete_notification_batches,
    list_notification_batch_history,
    send_client_notifications,
    update_notification_batch,
)

router = APIRouter(prefix="/admin/notifications", tags=["admin-notifications"])

DbDep = Annotated[Session, Depends(get_db)]


@router.post("/send", response_model=AdminSendNotificationResponse)
def admin_send_notifications(
    payload: AdminSendNotificationRequest,
    db: DbDep,
    _: AdminDep,
) -> AdminSendNotificationResponse:
    """Crea notificaciones de bandeja para todos, un nivel de red o un cliente específico."""
    created, batch_id = send_client_notifications(
        db,
        title=payload.title,
        message=payload.message,
        target_type=payload.target_type,
        target_value=payload.target_value,
    )
    return AdminSendNotificationResponse(
        created=created,
        batch_id=batch_id,
        message=f"Se enviaron {created} notificación(es).",
    )


@router.get("/history", response_model=list[AdminNotificationBatchHistoryItem])
def admin_notification_history(db: DbDep, _: AdminDep) -> list[AdminNotificationBatchHistoryItem]:
    """Historial agrupado por lote de envío masivo."""
    rows = list_notification_batch_history(db)
    return [AdminNotificationBatchHistoryItem.model_validate(r) for r in rows]


@router.put("/batch/{batch_id}", response_model=AdminUpdateNotificationBatchResponse)
def admin_update_notification_batch(
    batch_id: str,
    payload: AdminUpdateNotificationBatchRequest,
    db: DbDep,
    _: AdminDep,
) -> AdminUpdateNotificationBatchResponse:
    """Actualiza título y mensaje de todas las notificaciones de un lote."""
    updated = update_notification_batch(
        db,
        batch_id=batch_id,
        title=payload.title,
        message=payload.message,
    )
    return AdminUpdateNotificationBatchResponse(
        batch_id=str(batch_id),
        updated=updated,
        message=f"Se actualizaron {updated} notificación(es) del lote.",
    )


@router.delete("/batch/{batch_id}", response_model=AdminDeleteNotificationBatchResponse)
def admin_delete_notification_batch(
    batch_id: str,
    db: DbDep,
    _: AdminDep,
) -> AdminDeleteNotificationBatchResponse:
    """Elimina permanentemente todas las notificaciones de un lote."""
    deleted = delete_notification_batch(db, batch_id=batch_id)
    return AdminDeleteNotificationBatchResponse(
        batch_id=str(batch_id),
        deleted=deleted,
        message=f"Se eliminaron {deleted} notificación(es) del lote.",
    )


@router.post("/batch/bulk-delete", response_model=AdminBulkDeleteNotificationBatchesResponse)
def admin_bulk_delete_notification_batches(
    payload: AdminBulkDeleteNotificationBatchesRequest,
    db: DbDep,
    _: AdminDep,
) -> AdminBulkDeleteNotificationBatchesResponse:
    """Elimina permanentemente varios lotes de notificaciones en una sola operación."""
    batches_deleted, deleted = delete_notification_batches(db, batch_ids=payload.batch_ids)
    return AdminBulkDeleteNotificationBatchesResponse(
        batches_deleted=batches_deleted,
        deleted=deleted,
        message=f"Se eliminaron {batches_deleted} lote(s) ({deleted} notificación(es)).",
    )
