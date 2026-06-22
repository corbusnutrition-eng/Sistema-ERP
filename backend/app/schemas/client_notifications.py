from __future__ import annotations

import datetime
from typing import Literal, Optional, Union

from pydantic import BaseModel, Field


class AdminSendNotificationRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    message: str = Field(..., min_length=1, max_length=8000)
    target_type: Literal["all", "level", "specific"]
    target_value: Optional[Union[int, str]] = Field(
        default=None,
        description="Nivel numérico (target_type=level) o client_id (target_type=specific).",
    )


class AdminSendNotificationResponse(BaseModel):
    ok: bool = True
    created: int = Field(ge=0)
    batch_id: str
    message: str = "Notificaciones enviadas."


class AdminNotificationBatchHistoryItem(BaseModel):
    batch_id: str
    title: str
    message: str
    target_type: str
    target_value: Optional[str] = None
    target_label: str
    created_at: datetime.datetime
    total_count: int = Field(ge=0)
    read_count: int = Field(ge=0)
    unread_count: int = Field(ge=0)


class AdminUpdateNotificationBatchRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    message: str = Field(..., min_length=1, max_length=8000)


class AdminUpdateNotificationBatchResponse(BaseModel):
    ok: bool = True
    batch_id: str
    updated: int = Field(ge=0)
    message: str = "Lote actualizado."


class AdminDeleteNotificationBatchResponse(BaseModel):
    ok: bool = True
    batch_id: str
    deleted: int = Field(ge=0)
    message: str = "Lote eliminado."


class AdminBulkDeleteNotificationBatchesRequest(BaseModel):
    batch_ids: list[str] = Field(..., min_length=1)


class AdminBulkDeleteNotificationBatchesResponse(BaseModel):
    ok: bool = True
    batches_deleted: int = Field(ge=0)
    deleted: int = Field(ge=0)
    message: str = "Lotes eliminados."


class PortalNotificationRead(BaseModel):
    id: int
    title: str
    message: str
    is_read: bool
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class PortalNotificationMarkReadResponse(BaseModel):
    ok: bool = True
    id: int
    is_read: bool = True
