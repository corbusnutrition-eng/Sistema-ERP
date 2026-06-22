from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

ALLOWED_COLORS = ("sky", "violet", "rose", "teal", "orange", "blue", "green", "amber", "indigo", "pink")


class TagCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=60, description="Nombre único de la etiqueta")
    color: Optional[str] = Field(default=None, description="Color de la etiqueta (nombre de paleta Tailwind)")

    model_config = {"str_strip_whitespace": True}


class TagUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    color: Optional[str] = None

    model_config = {"str_strip_whitespace": True}


class TagResponse(BaseModel):
    id: uuid.UUID
    name: str
    color: Optional[str]
    created_at: datetime

    model_config = {"from_attributes": True}
