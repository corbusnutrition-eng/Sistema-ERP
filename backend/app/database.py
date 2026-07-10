import os
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

DATABASE_URL: str = os.getenv(
    "DATABASE_URL",
    "postgresql://admin:adminpassword@localhost:5432/iptv_erp",
)

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
