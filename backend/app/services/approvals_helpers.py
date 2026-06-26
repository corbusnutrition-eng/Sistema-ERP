"""Helpers para el módulo Aprobaciones — tolerancia si falta migración DDL."""

from __future__ import annotations

import logging

from sqlalchemy import inspect
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def journal_line_bank_verified_column_exists(db: Session) -> bool:
    """True si ``journal_entry_lines.is_bank_verified`` existe (migración 9b4c6d8e)."""
    try:
        bind = db.get_bind()
        cols = inspect(bind).get_columns("journal_entry_lines")
        return any(str(c.get("name")) == "is_bank_verified" for c in cols)
    except Exception as exc:
        logger.warning("No se pudo inspeccionar journal_entry_lines: %s", exc)
        return False


def is_missing_bank_verified_column_error(exc: BaseException) -> bool:
    msg = str(getattr(exc, "orig", exc)).lower()
    return "is_bank_verified" in msg and ("does not exist" in msg or "undefinedcolumn" in msg)
