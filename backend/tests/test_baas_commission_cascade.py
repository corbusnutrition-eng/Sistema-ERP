"""Pruebas del motor de comisiones en cascada BaaS (multi-paquete / labels con «+»)."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.orm import Session

from app.models.client import Client
from app.models.client_product_price import ClientProductPrice
from app.models.product import Product, ProductPackageCatalog, TargetAudience
from app.models.wallet_transaction import WalletTransaction
from app.services.baas_commission_cascade_service import (
    TX_WALLET_DEPOSIT,
    distribute_baas_commission_cascade,
)
from app.services.client_product_price_service import (
    _package_base_cost_usd,
    normalize_package_label_key,
)
from app.services.wallet_balance_service import get_client_wallet_balance


def test_normalize_package_label_key_handles_plus_months() -> None:
    assert normalize_package_label_key("6 MESES + 1 MES") == "6 meses + 1 mes"
    assert (
        normalize_package_label_key("12 MESES + 2 MESES (PRO GRATIS)")
        == "12 meses + 2 meses"
    )


def test_package_base_cost_uses_per_package_reference_not_product_global(
    db: Session,
    patched_database,
) -> None:
    product = Product(
        name="Flujo Test Multi",
        product_type="credito_pantalla",
        service_type="Paquete pantalla",
        iptv_provider="Flujo",
        target_audience=TargetAudience.cliente,
        listing_price=15.5,
        listing_currency="USD",
        purchase_cost_usd=15.5,
        is_active=True,
    )
    db.add(product)
    db.flush()

    line_3m = ProductPackageCatalog(
        product_id=int(product.id),
        package_label="3 MESES",
        reference_cost_usd=3.0,
        listing_price_usd=4.5,
        screens_per_package=1,
        sort_order=1,
    )
    line_6m = ProductPackageCatalog(
        product_id=int(product.id),
        package_label="6 MESES + 1 MES",
        reference_cost_usd=6.0,
        listing_price_usd=8.5,
        screens_per_package=1,
        sort_order=2,
    )
    db.add_all([line_3m, line_6m])
    db.flush()

    cost_3m = _package_base_cost_usd(db, product=product, catalog_line=line_3m)
    cost_6m = _package_base_cost_usd(db, product=product, catalog_line=line_6m)

    assert cost_3m == pytest.approx(3.0)
    assert cost_6m == pytest.approx(6.0)
    assert cost_6m != pytest.approx(15.5)


def test_commission_cascade_pays_upline_for_six_month_plus_package(
    db: Session,
    patched_database,
) -> None:
    parent = Client(
        email="upline-sixmo@test.local",
        username="upline_sixmo",
        wallet_balance=0.0,
        currency="USD",
        payment_token=uuid.uuid4(),
    )
    db.add(parent)
    db.flush()

    product = Product(
        name="Flujo",
        product_type="credito_pantalla",
        service_type="Paquete pantalla",
        iptv_provider="Flujo",
        target_audience=TargetAudience.cliente,
        listing_price=8.5,
        listing_currency="USD",
        purchase_cost_usd=15.5,
        is_active=True,
    )
    db.add(product)
    db.flush()

    catalog = ProductPackageCatalog(
        product_id=int(product.id),
        package_label="6 MESES + 1 MES",
        reference_cost_usd=6.0,
        listing_price_usd=8.5,
        screens_per_package=1,
        sort_order=2,
    )
    db.add(catalog)
    db.flush()

    child = Client(
        parent_id=int(parent.id),
        email="child-sixmo@test.local",
        username="child_sixmo",
        wallet_balance=0.0,
        currency="USD",
        payment_token=uuid.uuid4(),
    )
    db.add(child)
    db.flush()

    db.add_all(
        [
            ClientProductPrice(
                client_id=int(parent.id),
                product_id=int(product.id),
                package_catalog_id=int(catalog.id),
                custom_price=6.0,
                sale_price_local=6.0,
                price_currency="USD",
            ),
            ClientProductPrice(
                client_id=int(child.id),
                product_id=int(product.id),
                package_catalog_id=int(catalog.id),
                custom_price=8.5,
                sale_price_local=8.5,
                price_currency="USD",
            ),
        ]
    )
    db.commit()

    txs = distribute_baas_commission_cascade(
        db,
        buyer=child,
        package_catalog_id=int(catalog.id),
        quantity=1,
        sale_id=9001,
        purchase_currency="USD",
        unit_price_paid=8.5,
        product_name="Flujo 6 MESES + 1 MES",
        product=product,
        catalog_line=catalog,
    )
    db.commit()

    assert len(txs) == 1
    assert float(txs[0].amount) == pytest.approx(2.5, abs=0.01)
    db.refresh(parent)
    assert float(get_client_wallet_balance(parent, "USD")) == pytest.approx(2.5, abs=0.01)

    commission_txs = (
        db.query(WalletTransaction)
        .filter(
            WalletTransaction.client_id == int(parent.id),
            WalletTransaction.transaction_type == TX_WALLET_DEPOSIT,
        )
        .all()
    )
    assert len(commission_txs) == 1
    assert float(commission_txs[0].amount) == pytest.approx(2.5, abs=0.01)
