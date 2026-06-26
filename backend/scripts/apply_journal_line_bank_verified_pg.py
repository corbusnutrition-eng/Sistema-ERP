#!/usr/bin/env python3
"""Aplica DDL idempotente para ``journal_entry_lines.is_bank_verified`` (PostgreSQL)."""
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
    sql_path = backend_dir / "scripts" / "fix_journal_line_bank_verified_pg.sql"
    stmt = sql_path.read_text(encoding="utf-8")
    with eng.begin() as conn:
        conn.execute(text(stmt))
    print("DDL idempotente aplicado: journal_entry_lines.is_bank_verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
