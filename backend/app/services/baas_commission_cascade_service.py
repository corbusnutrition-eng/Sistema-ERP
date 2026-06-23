"""Comisiones BaaS en cascada (margen de red) al autocomprar paquetes Flujo."""

from __future__ import annotations

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
    resolve_client_package_sale_price,
)

TX_WALLET_DEPOSIT = "wallet_deposit"
TX_NETWORK_PROFIT = "network_profit"
BAAS_COMMISSION_LEDGER_TYPES = frozenset({TX_WALLET_DEPOSIT, TX_NETWORK_PROFIT})

_MAX_CASCADE_HOPS = 256


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
) -> float:
    """
    Precio de adquisición del cliente para un paquete, expresado en ``target_currency``.

    Si no tiene tarifa asignada, usa el costo base global del producto/paquete.
    """
    row = get_client_package_price_row(
        db,
        client_id=int(client.id),
        package_catalog_id=int(package_catalog_id),
    )
    if row is not None:
        local_price, price_cur = resolve_client_package_sale_price(db, client=client, cpp=row)
        return _convert_amount_to_currency(db, float(local_price), price_cur, target_currency)

    cost_usd = float(_package_base_cost_usd(db, product=product, catalog_line=catalog_line))
    return _convert_amount_to_currency(db, cost_usd, "USD", target_currency)


def _buyer_label_for_commission(buyer: Client) -> str:
    cid = int(getattr(buyer, "id", 0) or 0)
    email = (getattr(buyer, "email", None) or "").strip()
    name = (getattr(buyer, "name", None) or "").strip()
    if email:
        return f"#{cid} ({email})"
    if name:
        return f"#{cid} ({name})"
    return f"#{cid}"


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

    current_node: Optional[Client] = buyer
    current_price = round(float(unit_price_paid), 4)
    hops = 0

    while current_node is not None and current_node.parent_id is not None:
        hops += 1
        if hops > _MAX_CASCADE_HOPS:
            break

        parent_id = int(current_node.parent_id)
        parent = db.get(Client, parent_id)
        if parent is None:
            break

        parent_acquisition = resolve_client_acquisition_price_in_currency(
            db,
            client=parent,
            package_catalog_id=int(package_catalog_id),
            target_currency=cur,
            product=product,
            catalog_line=catalog_line,
        )
        profit_per_unit = round(current_price - float(parent_acquisition), 4)
        total_profit = round(profit_per_unit * qty, 4)

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

        current_node = parent
        current_price = round(float(parent_acquisition), 4)

    return created
