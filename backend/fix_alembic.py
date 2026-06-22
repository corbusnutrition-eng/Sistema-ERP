#!/usr/bin/env python3
"""
Script temporal: borra la fila de ``alembic_version`` para desbloquear Alembic cuando
quedó apuntando a una revisión cuyo archivo ya no existe (p. ej. KeyError: 'cli_self_portal_001').

Ejecución (desde la carpeta ``backend/``):

  cd backend && PYTHONPATH=. python fix_alembic.py

Luego vuelve a alinear la BD con tus migraciones locales, por ejemplo:

  alembic stamp head        # si el esquema ya coincide con el último archivo
  # o
  alembic upgrade head      # para aplicar migraciones pendientes

  alembic revision --autogenerate -m "describe cambio"
"""

from __future__ import annotations

from sqlalchemy import text

from app.database import SessionLocal


def main() -> None:
    session = SessionLocal()
    try:
        result = session.execute(text("DELETE FROM alembic_version"))
        session.commit()
        print("OK: ejecutado DELETE FROM alembic_version; (transacción confirmada).")
        try:
            print(f"    Filas afectadas (referencia): {result.rowcount}")
        except Exception:
            pass
    finally:
        session.close()


if __name__ == "__main__":
    main()
