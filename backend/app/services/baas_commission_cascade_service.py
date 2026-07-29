"""Comisiones BaaS en cascada (margen de red) al autocomprar paquetes Flujo."""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.product import Product, ProductPackageCatalog
from app.models.wallet_transaction import WalletTransaction
from app.services.client_notification_service import enqueue_client_network_commission_notification
from app.services.client_product_price_service import (
    _package_base_cost_usd,
    get_client_package_price_row,
    normalize_package_label_key,
    resolve_client_assigned_package_price,
    resolve_client_package_sale_price,
)

logger = logging.getLogger(__name__)

TX_WALLET_DEPOSIT = "wallet_deposit"
TX_NETWORK_PROFIT = "network_profit"
BAAS_COMMISSION_LEDGER_TYPES = frozenset({TX_WALLET_DEPOSIT, TX_NETWORK_PROFIT})

_MAX_CASCADE_HOPS = 256


def _lock_parent_client_for_commission(db: Session, parent_id: int) -> Optional[Client]:
    """Bloquea la fila del distribuidor padre antes de acreditar comisión (anti race condition)."""
    q = db.query(Client).filter(Client.id == int(parent_id))
    bind = db.get_bind()
    if bind is not None and getattr(bind.dialect, "name", None) == "postgresql":
        q = q.with_for_update()
    return q.first()


def _convert_amount_to_currency(
    db: Session,
    amount: float,
    from_currency: str,
    to_currency: str,
) -> float:
    from_cur = normalize_currency_code(from_currency, "USD")
    to_cur = normalize_currency_code(to_currency, "USD")
    amt = float(amount)
    if from_cur == to_cur:
        return round(amt, 4)
    from app.services.currency_consolidation import get_last_exchange_rate

    if from_cur == "USD":
        xr, _ = get_last_exchange_rate(db, to_cur)
        if xr <= 0:
            xr = 1.0
        return round(amt * float(xr), 4)
    if to_cur == "USD":
        xr, _ = get_last_exchange_rate(db, from_cur)
        if xr <= 0:
            xr = 1.0
        return round(amt / float(xr), 4)
    usd_amt = _convert_amount_to_currency(db, amt, from_cur, "USD")
    return _convert_amount_to_currency(db, usd_amt, "USD", to_cur)


def resolve_client_acquisition_price_in_currency(
    db: Session,
    *,
    client: Client,
    package_catalog_id: int,
    target_currency: str,
    product: Product,
    catalog_line: ProductPackageCatalog,
) -> tuple[float, str]:
    """
    Precio de adquisición del cliente para un paquete, expresado en ``target_currency``.

    Prioridad: ``ClientProductPrice`` por ``package_catalog_id`` (+ ``product_id``),
    luego costo referencial del paquete en catálogo/bodega (nunca el costo global
    del producto cuando hay matriz multi-paquete).
    """
    amount, price_cur, source = resolve_client_assigned_package_price(
        db,
        client=client,
        package_catalog_id=int(package_catalog_id),
        product_id=int(product.id),
        catalog_line=catalog_line,
        product=product,
    )
    if amount is None or amount <= 0:
        fallback = float(_package_base_cost_usd(db, product=product, catalog_line=catalog_line))
        logger.info(
            "[Comisiones] Sin tarifa asignada client_id=%s package_catalog_id=%s product_id=%s "
            "label=%r → fallback base_cost=%.4f",
            client.id,
            package_catalog_id,
            product.id,
            catalog_line.package_label,
            fallback,
        )
        return _convert_amount_to_currency(db, fallback, "USD", target_currency), "base_cost"

    converted = _convert_amount_to_currency(db, float(amount), price_cur, target_currency)
    if source != "assigned":
        logger.info(
            "[Comisiones] client_id=%s package_catalog_id=%s product_id=%s label=%r "
            "usa %s=%.4f %s",
            client.id,
            package_catalog_id,
            product.id,
            catalog_line.package_label,
            source,
            float(amount),
            price_cur,
        )
    return converted, source


def _buyer_label_for_commission(buyer: Client) -> str:
    cid = int(getattr(buyer, "id", 0) or 0)
    email = (getattr(buyer, "email", "") or "").strip()
    name = (getattr(buyer, "name", "") or "").strip()
    if email:
        return f"#{cid} ({email})"
    if name:
        return f"#{cid} ({name})"
    return f"#{cid}"


def _resolve_buyer_unit_price_paid(
    db: Session,
    *,
    buyer: Client,
    package_catalog_id: int,
    product: Product,
    unit_price_paid: float,
    purchase_currency: str,
) -> float:
    """Precio efectivo pagado por el comprador (tarifa asignada por su upline directo)."""
    row = get_client_package_price_row(
        db,
        client_id=int(buyer.id),
        package_catalog_id=int(package_catalog_id),
        product_id=int(product.id),
    )
    if row is None:
        return round(float(unit_price_paid), 4)
    local_price, price_cur = resolve_client_package_sale_price(db, client=buyer, cpp=row)
    if local_price <= 0:
        return round(float(unit_price_paid), 4)
    cur = normalize_currency_code(purchase_currency, "USD")
    return _convert_amount_to_currency(db, float(local_price), price_cur, cur)


def distribute_baas_commission_cascade(
    db: Session,
    *,
    buyer: Client,
    package_catalog_id: int,
    quantity: int,
    sale_id: int,
    purchase_currency: str,
    unit_price_paid: float,
    product_name: str,
    product: Product,
    catalog_line: ProductPackageCatalog,
) -> list[WalletTransaction]:
    """
    Recorre la cadena ``buyer → parent → … → root`` y acredita el spread de margen
    en la billetera BaaS de cada distribuidor superior.

    Acción financiera permitida por padre (estricto):
    - ``add_client_wallet_balance`` (saldo virtual BaaS en ``wallet_balances_by_currency``).
    - ``WalletTransaction`` tipo ``wallet_deposit`` (ingreso / depósito).
    - ``ClientNotification`` para la bandeja del portal.

    Prohibido: ``Sale``, ``Invoice``, facturación o cualquier obligación CxC al padre.

    ACID: no ejecuta ``db.commit()`` ni ``db.rollback()``. Solo ``db.add`` / ``flush``.
    El llamador confirma o revierte la transacción completa en un único ``commit`` externo.
    """
    from app.services.wallet_balance_service import add_client_wallet_balance

    qty = max(1, int(quantity))
    cur = normalize_currency_code(purchase_currency, "USD")
    buyer_label = _buyer_label_for_commission(buyer)
    created: list[WalletTransaction] = []
    pkg_label = str(getattr(catalog_line, "package_label", "") or "")
    pkg_key = normalize_package_label_key(pkg_label)

    current_node: Optional[Client] = buyer
    current_price = _resolve_buyer_unit_price_paid(
        db,
        buyer=buyer,
        package_catalog_id=int(package_catalog_id),
        product=product,
        unit_price_paid=float(unit_price_paid),
        purchase_currency=cur,
    )
    hops = 0

    logger.info(
        "[Comisiones] Inicio cascada sale_id=%s buyer_id=%s package_catalog_id=%s product_id=%s "
        "label=%r pkg_key=%r qty=%s unit_paid=%.4f %s",
        sale_id,
        buyer.id,
        package_catalog_id,
        product.id,
        pkg_label,
        pkg_key,
        qty,
        current_price,
        cur,
    )

    while current_node is not None and current_node.parent_id is not None:
        hops += 1
        if hops > _MAX_CASCADE_HOPS:
            logger.warning(
                "[Comisiones] Cadena truncada en hop=%s (sale_id=%s buyer_id=%s)",
                hops,
                sale_id,
                buyer.id,
            )
            break

        parent_id = int(current_node.parent_id)
        parent = _lock_parent_client_for_commission(db, parent_id)
        if parent is None:
            logger.warning(
                "[Comisiones] Upline inexistente parent_id=%s hop=%s sale_id=%s",
                parent_id,
                hops,
                sale_id,
            )
            break

        parent_acquisition, price_source = resolve_client_acquisition_price_in_currency(
            db,
            client=parent,
            package_catalog_id=int(package_catalog_id),
            target_currency=cur,
            product=product,
            catalog_line=catalog_line,
        )
        profit_per_unit = round(current_price - float(parent_acquisition), 4)
        total_profit = round(profit_per_unit * qty, 4)

        logger.info(
            "[Comisiones] Evaluando nivel %s | upline_id=%s (#%s) | comprador_nivel=%s | "
            "Producto: %s (catalog_id=%s product_id=%s) | Margen: $%.4f %s "
            "(precio_nivel=%.4f − costo_upline=%.4f [%s])",
            hops,
            parent.id,
            parent.id,
            current_node.id,
            product_name,
            package_catalog_id,
            product.id,
            total_profit,
            cur,
            current_price,
            parent_acquisition,
            price_source,
        )

        if total_profit > 1e-9:
            add_client_wallet_balance(db, parent, cur, total_profit)
            tx = WalletTransaction(
                user_id=None,
                client_id=int(parent.id),
                amount=float(total_profit),
                transaction_type=TX_WALLET_DEPOSIT,
                description=(
                    f"Comisión por red: Compra de {product_name} por el usuario {buyer_label} "
                    f"(venta #{int(sale_id)}) · {cur}"
                ),
            )
            db.add(tx)
            db.add(parent)
            enqueue_client_network_commission_notification(
                db,
                client_id=int(parent.id),
                profit=total_profit,
                currency=cur,
                product_name=product_name,
                sale_id=int(sale_id),
            )
            db.flush()
            created.append(tx)
        elif total_profit < -1e-9:
            logger.warning(
                "[Comisiones] Margen negativo omitido nivel=%s upline_id=%s product_id=%s "
                "catalog_id=%s (precio=%.4f costo=%.4f)",
                hops,
                parent.id,
                product.id,
                package_catalog_id,
                current_price,
                parent_acquisition,
            )

        current_node = parent
        current_price = round(float(parent_acquisition), 4)

    return created
