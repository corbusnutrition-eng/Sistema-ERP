import os
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

DATABASE_URL: str = os.getenv(
    "DATABASE_URL",
    "postgresql://admin:adminpassword@localhost:5432/iptv_erp",
)

if DATABASE_URL.startswith("sqlite"):
    # SQLite usa SingletonThreadPool/NullPool según el caso: no acepta
    # pool_size/max_overflow/pool_timeout (exclusivos de pools tipo QueuePool
    # como el que usa PostgreSQL). Solo relevante para dev/tests locales —
    # producción siempre corre contra PostgreSQL (ver DOCUMENTACION_BACKEND.md).
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    engine = create_engine(
        DATABASE_URL,
        pool_size=15,
        max_overflow=5,
        pool_timeout=30,
        pool_pre_ping=True,
        pool_recycle=1800,
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator[Session, None, None]:
    """Sesión por petición; ``close()`` devuelve la conexión al pool."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Bitácora de auditoría (before/after): listeners a nivel de `Session`, no de
# este `engine` concreto — cubren cualquier Session creada con `SessionLocal`
# en toda la app (routers, scripts, scheduler). Ver app/audit/listeners.py.
# Import local para evitar cualquier ciclo con módulos que a su vez importen
# `app.database` en tiempo de import de `app.audit.*`.
from app.audit.listeners import install_audit_listeners  # noqa: E402

install_audit_listeners()
