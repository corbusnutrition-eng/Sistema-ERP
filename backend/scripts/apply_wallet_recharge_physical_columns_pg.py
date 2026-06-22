#!/usr/bin/env python3
"""
Aplica DDL idempotente a ``wallet_recharge_requests`` en PostgreSQL.
Útil cuando Alembic no está accesible o la BD quedó desincronizada.

Uso desde la carpeta ``backend`` (con PYTHONPATH cargando ``app``)::

  export DATABASE_URL=postgresql://user:pass@host:5432/dbname
  python scripts/apply_wallet_recharge_physical_columns_pg.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> int:
    backend_dir = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(backend_dir))

    try:
        from dotenv import load_dotenv
    except ImportError:
        load_dotenv = None  # type: ignore[assignment,misc]

    if load_dotenv:
        repo_root = backend_dir.parent
        for p in (repo_root / ".env", backend_dir / ".env"):
            if p.exists():
                load_dotenv(p, override=False)
                break

    url = (os.getenv("DATABASE_URL") or "").strip()
    if not url:
        print("Falta DATABASE_URL en el entorno o en .env", file=sys.stderr)
        return 1

    from sqlalchemy import create_engine, text

    eng = create_engine(url)
    sql_path = backend_dir / "scripts" / "fix_wallet_recharge_columns_pg.sql"
    stmt = sql_path.read_text(encoding="utf-8")
    with eng.begin() as conn:
        conn.execute(text(stmt))
    print("DDL idempotente aplicado en wallet_recharge_requests (PostgreSQL).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
