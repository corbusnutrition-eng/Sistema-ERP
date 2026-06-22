from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.timezone_utils import now_ecuador

MAX_TAGS = 10


class Tag(Base):
    __tablename__ = "tags"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(
        String(60), nullable=False, unique=True, index=True
    )
    color: Mapped[Optional[str]] = mapped_column(
        String(20),
        nullable=True,
        comment="Clase de color Tailwind, ej. 'sky' — se mapea en el frontend",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=now_ecuador,
    )
