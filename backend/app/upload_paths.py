"""Ruta absoluta del directorio de archivos subidos (comprobantes, logos)."""
from __future__ import annotations

from pathlib import Path

# backend/uploads — independiente del cwd del proceso (Render, uvicorn, etc.)
UPLOAD_ROOT = Path(__file__).resolve().parent.parent / "uploads"
