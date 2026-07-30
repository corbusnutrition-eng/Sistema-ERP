"""Purga en cascada de un producto maestro y todo su árbol (solo entornos de prueba)."""

from __future__ import annotations

import logging

from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.client_product_price import ClientProductPrice
from app.models.distributor_custom_price import DistributorCustomPrice
from app.models.inventory_screen_credit_drawdown import InventoryScreenCreditDrawdown
from app.models.iptv_account import IPTVAccount
from app.models.product import Product, ProductPackageCatalog
from app.models.sale import Sale, SaleStatus
from app.models.screen_stock import ScreenStock
from app.services.accounting_engine import delete_sale_engine_journals
from app.services.sale_journal import delete_sale_auto_journals

logger = logging.getLogger(__name__)

_PURGE_BLOCKED_DETAIL = (
    "No se puede purgar el producto: hay ventas o registros contables enlazados que "
    "no se pudieron eliminar. Limpia primero las ventas de prueba o usa el script "
    "wipe_transactions."
)


def _delete_sale_for_product_purge(db: Session, sale: Sale) -> None:
    from app.api.v1.sales import _safe_release_pending_sale_inventory

    _safe_release_pending_sale_inventory(db, sale, context="purga producto")
    delete_sale_engine_journals(db, int(sale.id))
    delete_sale_auto_journals(db, int(sale.id))
    db.delete(sale)


def purge_product_tree(db: Session, product: Product) -> dict[str, int]:
    """
    Elimina stock, catálogo, precios y ventas de prueba asociadas al producto,
    luego borra el registro maestro en ``products``.
    """
    pid = int(product.id)
    stats = {
        "screen_stock": 0,
        "drawdowns": 0,
        "iptv_accounts": 0,
        "sales": 0,
        "client_prices": 0,
        "distributor_prices": 0,
        "catalog_lines": 0,
    }

    stock_rows = db.query(ScreenStock).filter(ScreenStock.product_id == pid).all()
    batch_ids = {str(r.batch_id) for r in stock_rows if r.batch_id}
    stats["screen_stock"] = len(stock_rows)

    sale_ids_from_stock = {int(r.sale_id) for r in stock_rows if r.sale_id is not None}
    sales_by_product = db.query(Sale).filter(Sale.product_id == pid).all()
    sale_ids = sale_ids_from_stock | {int(s.id) for s in sales_by_product}

    for sid in sorted(sale_ids):
        sale = db.get(Sale, int(sid))
        if sale is None:
            continue
        if sale.status in (
            SaleStatus.cancelled,
            SaleStatus.rejected,
            SaleStatus.annulled,
        ):
            delete_sale_engine_journals(db, int(sale.id))
            delete_sale_auto_journals(db, int(sale.id))
            db.delete(sale)
            stats["sales"] += 1
            continue
        try:
            _delete_sale_for_product_purge(db, sale)
            stats["sales"] += 1
        except Exception as exc:
            logger.warning("purge_product_tree: no se pudo eliminar venta %s: %s", sid, exc)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=_PURGE_BLOCKED_DETAIL,
            ) from exc

    if batch_ids:
        stats["drawdowns"] = int(
            db.query(InventoryScreenCreditDrawdown)
            .filter(InventoryScreenCreditDrawdown.batch_id.in_(sorted(batch_ids)))
            .delete(synchronize_session=False)
            or 0
        )

    for row in stock_rows:
        db.delete(row)

    stats["iptv_accounts"] = int(
        db.query(IPTVAccount).filter(IPTVAccount.product_id == pid).delete(synchronize_session=False) or 0
    )
    stats["client_prices"] = int(
        db.query(ClientProductPrice).filter(ClientProductPrice.product_id == pid).delete(synchronize_session=False)
        or 0
    )
    stats["distributor_prices"] = int(
        db.query(DistributorCustomPrice)
        .filter(DistributorCustomPrice.package_id == pid)
        .delete(synchronize_session=False)
        or 0
    )
    stats["catalog_lines"] = int(
        db.query(ProductPackageCatalog)
        .filter(ProductPackageCatalog.product_id == pid)
        .delete(synchronize_session=False)
        or 0
    )

    product.inventory_credit_reserved_qty = Decimal("0")
    product.inventory_credit_assigned_qty = Decimal("0")

    db.delete(product)
    try:
        db.flush()
    except IntegrityError as exc:
        logger.warning("purge_product_tree integrity: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_PURGE_BLOCKED_DETAIL,
        ) from exc

    return stats
