#!/usr/bin/env python3
"""
DDL idempotente: ``payment_allocations.wallet_recharge_id`` (CxC polimórfico).

Uso desde ``backend``::

  export DATABASE_URL=postgresql://user:pass@host:5432/dbname
  python scripts/apply_payment_allocation_wallet_recharge_pg.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


DDL = """
ALTER TABLE payment_allocations
    ADD COLUMN IF NOT EXISTS wallet_recharge_id INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_allocations_wallet_recharge_id'
    ) THEN
        ALTER TABLE payment_allocations
            ADD CONSTRAINT fk_payment_allocations_wallet_recharge_id
            FOREIGN KEY (wallet_recharge_id)
            REFERENCES wallet_recharge_requests(id)
            ON DELETE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_payment_allocations_wallet_recharge_id
    ON payment_allocations (wallet_recharge_id);

ALTER TABLE payment_allocations
    ALTER COLUMN sale_id DROP NOT NULL;
"""


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

    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(text(DDL))
    print("OK: payment_allocations.wallet_recharge_id aplicado.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
