"""Fixtures compartidas para pruebas del backend."""

from __future__ import annotations

import os
import tempfile
import uuid
from typing import Generator

import pytest
from sqlalchemy import JSON, String, create_engine, event
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool, StaticPool

from app.models.base import Base
from app.models.registry import import_all_models


def _is_postgresql(url: str) -> bool:
    return url.startswith("postgresql") or url.startswith("postgres+")


def _sqlite_compat_metadata() -> None:
    """Adapta tipos PostgreSQL (JSONB, UUID, ARRAY) para ``create_all`` en SQLite."""
    for table in Base.metadata.tables.values():
        for col in table.columns:
            col_type = col.type
            if isinstance(col_type, JSONB):
                col.type = JSON()
            elif isinstance(col_type, UUID):
                col.type = String(36)
            elif isinstance(col_type, ARRAY):
                col.type = JSON()
            if col.server_default is not None:
                default_arg = str(getattr(col.server_default, "arg", col.server_default))
                if "::" in default_arg:
                    col.server_default = None


def _register_sqlite_uuid_coercion() -> None:
    """SQLite no acepta objetos ``uuid.UUID`` en columnas mapeadas como String(36)."""

    @event.listens_for(Session, "before_flush")
    def _coerce_uuid_columns(session, flush_context, instances) -> None:
        bind = session.get_bind()
        if getattr(getattr(bind, "dialect", None), "name", None) != "sqlite":
            return
        for obj in session.new.union(session.dirty):
            for attr in ("payment_token",):
                if not hasattr(obj, attr):
                    continue
                val = getattr(obj, attr, None)
                if isinstance(val, uuid.UUID):
                    setattr(obj, attr, str(val))


def _resolve_test_database_url() -> tuple[str, bool]:
    url = (
        os.getenv("TEST_DATABASE_URL")
        or os.getenv("DATABASE_URL")
        or "sqlite+pysqlite:///:memory:"
    ).strip()
    return url, _is_postgresql(url)


@pytest.fixture(scope="session")
def test_engine():
    """Motor aislado para pruebas (SQLite en memoria por defecto)."""
    import_all_models()
    url, is_pg = _resolve_test_database_url()
    if not is_pg:
        _sqlite_compat_metadata()
        _register_sqlite_uuid_coercion()

    if is_pg:
        engine = create_engine(url, pool_pre_ping=True)
    else:
        if url.endswith(":memory:") or url.rstrip("/").endswith(":memory:"):
            tmp = tempfile.NamedTemporaryFile(suffix="_baas_concurrency.db", delete=False)
            tmp.close()
            url = f"sqlite+pysqlite:///{tmp.name}"
        engine = create_engine(
            url,
            connect_args={"check_same_thread": False},
            poolclass=NullPool,
        )

    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield engine
    Base.metadata.drop_all(bind=engine)
    engine.dispose()


@pytest.fixture(scope="session")
def test_session_factory(test_engine):
    return sessionmaker(autocommit=False, autoflush=False, bind=test_engine)


@pytest.fixture
def db(test_session_factory) -> Generator[Session, None, None]:
    """Sesión con rollback al final de cada test."""
    session = test_session_factory()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def patched_database(test_engine, test_session_factory, monkeypatch):
    """
    Parchea ``app.database`` para que servicios y workers usen la BD de prueba.

    Cada hilo debe abrir su propia sesión vía ``SessionLocal()``.
    """
    import app.database as database_module

    monkeypatch.setattr(database_module, "engine", test_engine)
    monkeypatch.setattr(database_module, "SessionLocal", test_session_factory)
    return test_session_factory


@pytest.fixture
def baas_concurrency_harness(db: Session, patched_database):
    """
    Red BaaS mínima: 1 padre ($0) + N hijos con saldo para autocompra.

    Comisión esperada por compra exitosa: CHILD_SALE_PRICE - PARENT_ACQUISITION.
    """
    from app.models.client import Client
    from app.models.client_product_price import ClientProductPrice
    from app.models.product import Product, ProductPackageCatalog, TargetAudience
    from app.services.wallet_balance_service import add_client_wallet_balance

    parent_acquisition = 10.0
    child_sale_price = 15.0
    child_wallet_seed = 25.0
    num_children = int(os.getenv("BAAS_CONCURRENCY_CHILDREN", "10"))

    parent = Client(
        email="parent-concurrency@test.local",
        username="parent_concurrency",
        wallet_balance=0.0,
        currency="USD",
        payment_token=uuid.uuid4(),
    )
    db.add(parent)
    db.flush()

    product = Product(
        name="Test Flujo Concurrencia",
        product_type="credito_pantalla",
        service_type="Paquete pantalla",
        iptv_provider="Flujo",
        target_audience=TargetAudience.cliente,
        listing_price=child_sale_price,
        listing_currency="USD",
        is_active=True,
    )
    db.add(product)
    db.flush()

    catalog = ProductPackageCatalog(
        product_id=int(product.id),
        package_label="1 mes",
        reference_cost_usd=parent_acquisition,
        listing_price_usd=child_sale_price,
        screens_per_package=1,
        sort_order=0,
    )
    db.add(catalog)
    db.flush()

    db.add(
        ClientProductPrice(
            client_id=int(parent.id),
            product_id=int(product.id),
            package_catalog_id=int(catalog.id),
            custom_price=parent_acquisition,
            sale_price_local=parent_acquisition,
            price_currency="USD",
        )
    )

    child_ids: list[int] = []
    for idx in range(num_children):
        child = Client(
            parent_id=int(parent.id),
            email=f"child-concurrency-{idx}@test.local",
            username=f"child_concurrency_{idx}",
            wallet_balance=0.0,
            currency="USD",
            payment_token=uuid.uuid4(),
        )
        db.add(child)
        db.flush()
        add_client_wallet_balance(db, child, "USD", child_wallet_seed)
        db.add(
            ClientProductPrice(
                client_id=int(child.id),
                product_id=int(product.id),
                package_catalog_id=int(catalog.id),
                custom_price=child_sale_price,
                sale_price_local=child_sale_price,
                price_currency="USD",
            )
        )
        child_ids.append(int(child.id))

    db.commit()

    commission_per_purchase = round(child_sale_price - parent_acquisition, 4)

    return {
        "parent_id": int(parent.id),
        "child_ids": child_ids,
        "package_catalog_id": int(catalog.id),
        "commission_per_purchase": commission_per_purchase,
        "num_children": num_children,
        "session_factory": patched_database,
    }
