#!/usr/bin/env python3
"""
Emergencia: asegura la columna ``clients.password_hash`` sin Alembic.

Desde ``backend``:

    PYTHONPATH=. ../venv/bin/python scripts/ensure_clients_password_hash_column.py

Usa ``DATABASE_URL`` (.env en la raíz del repo o en ``backend/``).
"""
from __future__ import annotations

import sys
from pathlib import Path

_script = Path(__file__).resolve()
_backend = _script.parents[1]
_repo = _backend.parent

try:
    from dotenv import load_dotenv

    for _p in (_repo / ".env", _backend / ".env"):
        if _p.exists():
            load_dotenv(_p, override=False)
            break
except ImportError:
    pass

sys.path.insert(0, str(_backend))

from sqlalchemy import inspect, text  # noqa: E402 — tras sys.path


def main() -> int:
    from app.database import engine  # noqa: WPS433

    insp = inspect(engine)
    cols = {c["name"] for c in insp.get_columns("clients")}
    if "password_hash" in cols:
        print("clients.password_hash ya existe; sin cambios.")
        return 0

    ddl = text("ALTER TABLE clients ADD COLUMN password_hash VARCHAR(512)")
    with engine.begin() as conn:
        conn.execute(ddl)

    print("OK: columna password_hash agregada a clients.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
