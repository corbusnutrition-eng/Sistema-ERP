"""
Entorno Alembic: carga ``app`` desde ``backend/`` y registra todos los modelos ORM.

Ejecutar siempre desde el directorio ``backend/``::

    cd backend && alembic revision --autogenerate -m "descripcion"
    cd backend && alembic upgrade head
"""

from __future__ import annotations

import configparser
import os
import sys
from logging.config import fileConfig
from pathlib import Path

# ---------------------------------------------------------------------------
# sys.path: Alembic ejecuta este archivo como script; ``app`` vive en backend/
# ---------------------------------------------------------------------------
_ALEMBIC_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _ALEMBIC_DIR.parent
_REPO_ROOT = _BACKEND_DIR.parent

_backend_str = str(_BACKEND_DIR)
if _backend_str not in sys.path:
    sys.path.insert(0, _backend_str)

# ---------------------------------------------------------------------------
# Variables de entorno (.env en raíz del repo o en backend/)
# ---------------------------------------------------------------------------
try:
    from dotenv import load_dotenv

    for _env_path in (_REPO_ROOT / ".env", _BACKEND_DIR / ".env"):
        if _env_path.exists():
            load_dotenv(_env_path, override=False)
            break
except ImportError:
    pass

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.models.base import Base
from app.models.registry import import_all_models

import_all_models()

config = context.config

_db_url = os.getenv("DATABASE_URL", "").strip()
if _db_url:
    config.set_main_option("sqlalchemy.url", _db_url.replace("%", "%%"))

if config.config_file_name is not None:
    parser = configparser.ConfigParser()
    parser.read(config.config_file_name)
    if parser.has_section("formatters"):
        fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    use_batch = bool(url and "sqlite" in url.lower())
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=use_batch,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        use_batch = connection.dialect.name == "sqlite"
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=use_batch,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
