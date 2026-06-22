from __future__ import annotations

import uuid
from datetime import timedelta
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.client_product_price import ClientProductPrice
from app.models.wallet_transaction import WalletTransaction
from app.schemas.client_product_prices import ClientProductPriceItem
from app.services.catalog_vip_sync import notify_catalog_vip_new_manual_customer
from app.services.client_product_price_service import (
    _get_package_catalog_line,
    _package_display_name_for_product,
    get_client_package_price_row,
)

TX_BAAS_TRANSFER_OUT = "baas_transfer_out"
TX_BAAS_TRANSFER_IN = "baas_transfer_in"
TX_BAAS_TRANSFER_REVERT_OUT = "baas_transfer_revert_out"
TX_BAAS_TRANSFER_REVERT_IN = "baas_transfer_revert_in"

BAAS_TRANSFER_TYPES = frozenset({TX_BAAS_TRANSFER_OUT, TX_BAAS_TRANSFER_IN})
BAAS_TRANSFER_LEDGER_TYPES = frozenset(
    {
        TX_BAAS_TRANSFER_OUT,
        TX_BAAS_TRANSFER_IN,
        TX_BAAS_TRANSFER_REVERT_OUT,
        TX_BAAS_TRANSFER_REVERT_IN,
    }
)


def acquisition_cost_message(floor_usd: float, *, currency: str = "USD") -> str:
    cur = normalize_currency_code(currency, "USD")
    return f"El precio no puede ser menor a tu costo de adquisición de {float(floor_usd):.2f} {cur}"


def get_parent_acquisition_cost_usd(
    db: Session,
    *,
    parent_id: int,
    package_catalog_id: int,
) -> float:
    """
    Costo de adquisición del distribuidor padre en su moneda base (precio asignado).
    """
    parent = db.get(Client, int(parent_id))
    if parent is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Distribuidor padre no encontrado.",
        )
    row = get_client_package_price_row(
        db,
        client_id=int(parent_id),
        package_catalog_id=int(package_catalog_id),
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No tienes autorización de venta para uno de los paquetes indicados.",
        )
    from app.services.client_product_price_service import resolve_client_package_sale_price

    local_floor, _cur = resolve_client_package_sale_price(db, client=parent, cpp=row)
    if local_floor > 0:
        return float(local_floor)
    try:
        cost = float(row.custom_price)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tarifa de adquisición inválida para uno de los paquetes.",
        )
    if cost <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Tarifa de adquisición inválida para uno de los paquetes.",
        )
    return cost


def validate_subclient_price_vs_acquisition_cost(
    *,
    custom_price: float,
    acquisition_cost_usd: float,
    currency: str = "USD",
) -> None:
    if float(custom_price) + 1e-9 < float(acquisition_cost_usd):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=acquisition_cost_message(acquisition_cost_usd, currency=currency),
        )


def _persist_client_product_prices_for_child(
    db: Session,
    *,
    child_id: int,
    items: list[ClientProductPriceItem],
) -> int:
    """Persiste precios del hijo sin validar costo de bodega (margen ya validado vs padre)."""
    touched = 0
    for item in items:
        line, product = _get_package_catalog_line(db, int(item.package_catalog_id))
        if int(line.product_id) != int(item.product_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="product_id no coincide con el paquete de catálogo indicado.",
            )
        row = (
            db.query(ClientProductPrice)
            .filter(
                ClientProductPrice.client_id == int(child_id),
                ClientProductPrice.package_catalog_id == int(item.package_catalog_id),
            )
            .first()
        )
        price_f = round(float(item.custom_price), 4)
        if row is None:
            db.add(
                ClientProductPrice(
                    client_id=int(child_id),
                    product_id=int(product.id),
                    package_catalog_id=int(line.id),
                    custom_price=price_f,
                )
            )
        else:
            row.product_id = int(product.id)
            row.custom_price = price_f
            db.add(row)
        touched += 1
    return touched


def _would_create_client_parent_cycle(db: Session, child_id: int, new_parent_id: Optional[int]) -> bool:
    if new_parent_id is None:
        return False
    if new_parent_id == child_id:
        return True
    cur: Optional[int] = int(new_parent_id)
    seen: set[int] = set()
    while cur is not None:
        if cur == child_id:
            return True
        if cur in seen:
            return True
        seen.add(cur)
        row = db.get(Client, cur)
        if row is None:
            break
        cur = int(row.parent_id) if row.parent_id is not None else None
    return False


def get_direct_subclient(db: Session, parent: Client, child_id: int) -> Client:
    child = db.get(Client, int(child_id))
    if child is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Sub-cliente no encontrado.")
    if child.parent_id != parent.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Este cliente no pertenece a tu red directa.",
        )
    return child


def list_subclients_for_parent(
    db: Session,
    parent_id: int,
    *,
    active_only: bool = False,
) -> list[Client]:
    q = db.query(Client).filter(Client.parent_id == int(parent_id))
    if active_only:
        q = q.filter(Client.status == "Activo")
    return q.order_by(Client.name.asc().nulls_last(), Client.username.asc(), Client.id.asc()).all()


def _build_subclient_row(
    parent: Client,
    *,
    username: str,
    email: str,
    name: Optional[str] = None,
    phone: Optional[str] = None,
) -> Client:
    u = (username or "").strip()
    if not u:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Usuario IPTV obligatorio.")
    em = (email or "").strip().lower()
    if not em:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email obligatorio.")
    from app.services.client_currency_service import get_client_currency, set_client_currency

    child = Client(
        parent_id=int(parent.id),
        username=u,
        email=em,
        name=(name or "").strip() or None,
        phone=(phone or "").strip() or None,
        status="Activo",
        custom_fields={},
        payment_token=uuid.uuid4(),
        currency=get_client_currency(parent),
    )
    set_client_currency(child, get_client_currency(parent))
    return child


def create_subclient_for_parent(
    db: Session,
    parent: Client,
    *,
    username: str,
    email: str,
    name: Optional[str] = None,
    phone: Optional[str] = None,
) -> Client:
    child = _build_subclient_row(
        parent,
        username=username,
        email=email,
        name=name,
        phone=phone,
    )
    from app.services.client_currency_service import get_client_currency, set_client_currency

    set_client_currency(child, get_client_currency(parent))
    db.add(child)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ya existe un cliente con ese email o usuario.",
        ) from exc

    try:
        notify_catalog_vip_new_manual_customer(child.email)
    except Exception:
        pass

    db.commit()
    db.refresh(child)
    return child


def _validate_subclient_price_items_for_parent(
    db: Session,
    parent: Client,
    items: list[ClientProductPriceItem],
    *,
    require_all_authorized: bool,
) -> list[ClientProductPriceItem]:
    authorized = list_parent_selling_packages(db, int(parent.id))
    if not authorized:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No tienes paquetes Flujo autorizados para revender. Solicita tu matriz de precios al administrador.",
        )
    authorized_by_pkg = {int(p["package_catalog_id"]): p for p in authorized}
    from app.services.client_currency_service import get_client_currency

    parent_cur = get_client_currency(parent)
    if require_all_authorized:
        submitted_ids = {int(i.package_catalog_id) for i in items}
        missing = set(authorized_by_pkg.keys()) - submitted_ids
        if missing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Debes asignar precio de venta a todos los paquetes autorizados.",
            )

    validated: list[ClientProductPriceItem] = []
    for item in items:
        pkg_id = int(item.package_catalog_id)
        if pkg_id not in authorized_by_pkg:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No tienes autorización de venta para uno de los paquetes indicados.",
            )
        line, product = _get_package_catalog_line(db, pkg_id)
        acquisition = get_parent_acquisition_cost_usd(db, parent_id=int(parent.id), package_catalog_id=pkg_id)
        validate_subclient_price_vs_acquisition_cost(
            custom_price=float(item.custom_price),
            acquisition_cost_usd=acquisition,
            currency=parent_cur,
        )
        validated.append(
            ClientProductPriceItem(
                product_id=int(product.id),
                package_catalog_id=int(line.id),
                custom_price=float(item.custom_price),
            )
        )
    return validated


def create_subclient_with_prices(
    db: Session,
    parent: Client,
    *,
    username: str,
    email: str,
    name: Optional[str] = None,
    phone: Optional[str] = None,
    prices: list[ClientProductPriceItem],
    initial_transfer_amount: float,
) -> Client:
    """Crea sub-cliente, asigna precios y transfiere saldo BaaS inicial en una sola transacción."""
    amt = round(float(initial_transfer_amount), 4)
    if amt <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La transferencia inicial debe ser mayor a cero.",
        )
    if not prices:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Debes asignar al menos un precio de venta al sub-cliente.",
        )

    from app.services.wallet_balance_service import get_client_wallet_balance
    from app.services.client_currency_service import get_client_currency

    parent_cur = get_client_currency(parent)
    parent_bal = float(get_client_wallet_balance(parent, parent_cur))
    if parent_bal + 1e-9 < amt:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Saldo BaaS insuficiente para la transferencia inicial. Disponible: {parent_bal:.2f} {parent_cur}.",
        )

    validated = _validate_subclient_price_items_for_parent(
        db, parent, prices, require_all_authorized=True
    )

    try:
        child = _build_subclient_row(
            parent,
            username=username,
            email=email,
            name=name,
            phone=phone,
        )
        from app.services.client_currency_service import get_client_currency, set_client_currency

        set_client_currency(child, get_client_currency(parent))
        db.add(child)
        db.flush()

        _persist_client_product_prices_for_child(db, child_id=int(child.id), items=validated)

        _apply_baas_transfer_parent_to_child(db, parent, child, amt, currency=parent_cur)

        try:
            notify_catalog_vip_new_manual_customer(child.email)
        except Exception:
            pass

        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ya existe un cliente con ese email o usuario.",
        ) from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"No se pudo crear el sub-cliente: {exc}",
        ) from exc

    db.refresh(parent)
    db.refresh(child)
    return child


def soft_delete_subclient_for_parent(db: Session, parent: Client, child_id: int) -> Client:
    """Elimina un sub-cliente de la red del padre (soft delete: status Inactivo)."""
    child = get_direct_subclient(db, parent, int(child_id))
    from app.services.wallet_balance_service import client_wallet_balances_map

    balances = client_wallet_balances_map(child)
    if any(float(v) > 1e-9 for v in balances.values()):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El sub-cliente aún posee saldo",
        )
    if str(child.status or "").strip().lower() == "inactivo":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El sub-cliente ya fue eliminado de tu red.",
        )
    child.status = "Inactivo"
    db.commit()
    db.refresh(child)
    return child


def update_subclient_for_parent(
    db: Session,
    parent: Client,
    child_id: int,
    *,
    name: Optional[str] = None,
    email: Optional[str] = None,
    phone: Optional[str] = None,
) -> Client:
    """Actualiza nombre, email o teléfono de un sub-cliente directo."""
    child = get_direct_subclient(db, parent, int(child_id))
    if name is not None:
        child.name = (name or "").strip() or None
    if email is not None:
        em = (email or "").strip().lower()
        if not em:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email obligatorio.")
        child.email = em
    if phone is not None:
        child.phone = (phone or "").strip() or None
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ya existe un cliente con ese email o usuario.",
        ) from exc
    db.refresh(child)
    return child


def _apply_baas_transfer_parent_to_child(
    db: Session,
    parent: Client,
    child: Client,
    amount: float,
    *,
    currency: str = "USD",
) -> tuple[WalletTransaction, WalletTransaction]:
    """Ajusta saldos y registra movimientos BaaS (sin ``commit``)."""
    from app.services.wallet_balance_service import (
        get_client_wallet_balance,
        subtract_client_wallet_balance,
        add_client_wallet_balance,
    )

    amt = round(float(amount), 4)
    if amt <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El monto debe ser mayor a cero.")

    get_direct_subclient(db, parent, int(child.id))

    cur = normalize_currency_code(currency, "USD")
    parent_bal = float(get_client_wallet_balance(parent, cur))
    if parent_bal + 1e-9 < amt:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Saldo BaaS insuficiente en {cur}. Disponible: {parent_bal:.2f} {cur}.",
        )

    subtract_client_wallet_balance(db, parent, cur, amt)
    add_client_wallet_balance(db, child, cur, amt)

    child_label = child.display_name()
    parent_label = parent.display_name()

    tx_out = WalletTransaction(
        user_id=None,
        client_id=int(parent.id),
        amount=-amt,
        transaction_type=TX_BAAS_TRANSFER_OUT,
        description=f"Transferencia a sub-cliente — {child_label}",
    )
    tx_in = WalletTransaction(
        user_id=None,
        client_id=int(child.id),
        amount=amt,
        transaction_type=TX_BAAS_TRANSFER_IN,
        description=f"Recarga de distribuidor — {parent_label}",
    )
    db.add(parent)
    db.add(child)
    db.add(tx_out)
    db.add(tx_in)
    db.flush()
    return tx_out, tx_in


def transfer_baas_balance_parent_to_child(
    db: Session,
    parent: Client,
    child: Client,
    amount: float,
) -> tuple[WalletTransaction, WalletTransaction]:
    from app.services.client_currency_service import get_client_currency

    tx_out, tx_in = _apply_baas_transfer_parent_to_child(
        db,
        parent,
        child,
        amount,
        currency=get_client_currency(parent),
    )
    db.commit()
    db.refresh(parent)
    db.refresh(child)
    db.refresh(tx_out)
    db.refresh(tx_in)
    return tx_out, tx_in


def list_parent_selling_packages(db: Session, parent_id: int) -> list[dict[str, object]]:
    """
    Paquetes Flujo que el distribuidor puede revender (su ``ClientProductPrice``).
    ``parent_floor_price_usd`` = costo de adquisición del creador.
    """
    from app.models.client import Client
    from app.models.product import Product, ProductPackageCatalog
    from app.services.client_product_price_service import (
        _inventory_provider_for_product,
        _is_credito_pantalla_product,
        count_free_screen_stock_for_flujo_package,
        resolve_client_package_sale_price,
    )

    parent = db.get(Client, int(parent_id))
    if parent is None:
        return []

    rows = (
        db.query(ClientProductPrice, ProductPackageCatalog, Product)
        .join(ProductPackageCatalog, ProductPackageCatalog.id == ClientProductPrice.package_catalog_id)
        .join(Product, Product.id == ClientProductPrice.product_id)
        .filter(
            ClientProductPrice.client_id == int(parent_id),
            Product.is_active.is_(True),
        )
        .order_by(Product.name.asc(), ProductPackageCatalog.sort_order.asc(), ProductPackageCatalog.id.asc())
        .all()
    )
    out: list[dict[str, object]] = []
    for parent_cpp, catalog_line, prod in rows:
        if not _is_credito_pantalla_product(prod):
            continue
        pkg_label = (catalog_line.package_label or "").strip()
        if not pkg_label:
            continue
        try:
            acquisition = float(parent_cpp.custom_price)
        except (TypeError, ValueError):
            continue
        if acquisition <= 0:
            continue
        local_floor, floor_cur = resolve_client_package_sale_price(
            db,
            client=parent,
            cpp=parent_cpp,
        )
        inv_prov = _inventory_provider_for_product(prod)
        out.append(
            {
                "package_catalog_id": int(catalog_line.id),
                "product_id": int(prod.id),
                "display_name": _package_display_name_for_product(prod, pkg_label),
                "package_label": pkg_label,
                "reference_cost_usd": acquisition,
                "parent_floor_price_usd": acquisition,
                "parent_floor_price_local": local_floor,
                "floor_currency": floor_cur,
                "child_custom_price": None,
                "free_stock": count_free_screen_stock_for_flujo_package(
                    db,
                    product_id=int(prod.id),
                    package_label=pkg_label,
                    inventory_provider=inv_prov,
                ),
            }
        )
    return out


def list_subclient_pricing_matrix(
    db: Session,
    *,
    parent_id: int,
    child_id: int,
) -> list[dict[str, object]]:
    """Paquetes autorizados del padre con precios actuales del hijo."""
    child_prices = {
        int(r.package_catalog_id): float(r.custom_price)
        for r in db.query(ClientProductPrice)
        .filter(ClientProductPrice.client_id == int(child_id))
        .all()
    }
    out: list[dict[str, object]] = []
    for row in list_parent_selling_packages(db, int(parent_id)):
        pkg_id = int(row["package_catalog_id"])
        merged = dict(row)
        merged["child_custom_price"] = child_prices.get(pkg_id)
        out.append(merged)
    return out


def upsert_subclient_product_prices(
    db: Session,
    *,
    parent: Client,
    child: Client,
    items: list[ClientProductPriceItem],
) -> int:
    """Precios del sub-cliente con piso = costo de adquisición del padre (``ClientProductPrice``)."""
    get_direct_subclient(db, parent, int(child.id))
    if not items:
        return 0

    validated = _validate_subclient_price_items_for_parent(
        db, parent, items, require_all_authorized=False
    )
    touched = _persist_client_product_prices_for_child(db, child_id=int(child.id), items=validated)
    db.commit()
    return touched


def baas_transfer_ref_number(tx_id: int) -> str:
    return f"BTF-{int(tx_id):04d}"


def _baas_revert_marker(original_tx_id: int) -> str:
    return f"Reversión transferencia BaaS #{int(original_tx_id)}"


def baas_transfer_already_reverted(db: Session, original_tx_id: int) -> bool:
    marker = _baas_revert_marker(original_tx_id)
    row = (
        db.query(WalletTransaction.id)
        .filter(
            WalletTransaction.transaction_type.in_(
                (TX_BAAS_TRANSFER_REVERT_OUT, TX_BAAS_TRANSFER_REVERT_IN)
            ),
            WalletTransaction.description.contains(marker),
        )
        .first()
    )
    return row is not None


def _find_paired_baas_transfer_in(
    db: Session,
    *,
    parent_id: int,
    amount: float,
    out_tx: WalletTransaction,
) -> Optional[WalletTransaction]:
    window_start = out_tx.created_at - timedelta(seconds=120)
    window_end = out_tx.created_at + timedelta(seconds=120)
    child_ids = [
        int(r[0])
        for r in db.query(Client.id).filter(Client.parent_id == int(parent_id)).all()
    ]
    if not child_ids:
        return None
    return (
        db.query(WalletTransaction)
        .filter(
            WalletTransaction.client_id.in_(child_ids),
            WalletTransaction.transaction_type == TX_BAAS_TRANSFER_IN,
            WalletTransaction.amount == float(amount),
            WalletTransaction.created_at >= window_start,
            WalletTransaction.created_at <= window_end,
        )
        .order_by(WalletTransaction.created_at.asc(), WalletTransaction.id.asc())
        .first()
    )


def resolve_baas_transfer_parties(
    db: Session,
    tx: WalletTransaction,
) -> tuple[Client, Client, float, int]:
    """Devuelve (emisor, receptor, monto positivo, id canónico para reversión)."""
    amt = abs(float(tx.amount or 0))
    if amt <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Monto de transferencia inválido.")

    if tx.transaction_type == TX_BAAS_TRANSFER_IN:
        child = db.get(Client, int(tx.client_id)) if tx.client_id else None
        if child is None or child.parent_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No se puede identificar el emisor de la transferencia BaaS.",
            )
        parent = db.get(Client, int(child.parent_id))
        if parent is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Distribuidor emisor no encontrado.",
            )
        return parent, child, amt, int(tx.id)

    if tx.transaction_type == TX_BAAS_TRANSFER_OUT:
        parent = db.get(Client, int(tx.client_id)) if tx.client_id else None
        if parent is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente emisor no encontrado.")
        paired = _find_paired_baas_transfer_in(db, parent_id=int(parent.id), amount=amt, out_tx=tx)
        if paired is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No se encontró la transferencia emparejada en el sub-cliente.",
            )
        child = db.get(Client, int(paired.client_id)) if paired.client_id else None
        if child is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Sub-cliente receptor no encontrado.")
        return parent, child, amt, int(paired.id)

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="La transacción no es una transferencia BaaS reversible.",
    )


def can_revert_baas_transfer(db: Session, tx: WalletTransaction) -> bool:
    if tx.transaction_type not in BAAS_TRANSFER_TYPES:
        return False
    try:
        _, child, amt, canonical_id = resolve_baas_transfer_parties(db, tx)
    except HTTPException:
        return False
    if baas_transfer_already_reverted(db, canonical_id):
        return False
    from app.services.wallet_balance_service import get_client_wallet_balance

    child_bal = float(get_client_wallet_balance(child, "USD"))
    if child_bal + 1e-9 < amt:
        return False
    return True


def get_baas_transfer_counterparty(db: Session, tx: WalletTransaction) -> tuple[Optional[int], Optional[str]]:
    if tx.transaction_type in BAAS_TRANSFER_TYPES:
        try:
            parent, child, _, _ = resolve_baas_transfer_parties(db, tx)
        except HTTPException:
            return None, None
        if tx.transaction_type == TX_BAAS_TRANSFER_IN:
            return int(parent.id), parent.display_name()
        return int(child.id), child.display_name()
    if tx.transaction_type == TX_BAAS_TRANSFER_REVERT_OUT:
        child = db.get(Client, int(tx.client_id)) if tx.client_id else None
        if child and child.parent_id:
            parent = db.get(Client, int(child.parent_id))
            if parent:
                return int(parent.id), parent.display_name()
    if tx.transaction_type == TX_BAAS_TRANSFER_REVERT_IN:
        desc = str(tx.description or "")
        if "desde " in desc:
            name = desc.rsplit("desde ", 1)[-1].strip()
            if name:
                return None, name
    return None, None


def revert_baas_wallet_transfer(db: Session, transaction_id: int) -> dict[str, object]:
    """
    Revierte una transferencia BaaS: debita al receptor y acredita al emisor.

    Bloquea si el sub-cliente no tiene saldo suficiente.
    """
    tx = db.get(WalletTransaction, int(transaction_id))
    if tx is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transacción no encontrada.")

    if tx.transaction_type not in BAAS_TRANSFER_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La transacción no es una transferencia BaaS reversible.",
        )

    parent, child, amt, canonical_id = resolve_baas_transfer_parties(db, tx)

    from app.services.wallet_balance_service import (
        add_client_wallet_balance,
        get_client_wallet_balance,
        subtract_client_wallet_balance,
    )

    if baas_transfer_already_reverted(db, canonical_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Esta transferencia ya fue revertida.",
        )

    child_bal = float(get_client_wallet_balance(child, "USD"))
    if child_bal + 1e-9 < amt:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"No se puede revertir: el sub-cliente ya no tiene saldo suficiente "
                f"(disponible: {child_bal:.2f} USD)."
            ),
        )

    subtract_client_wallet_balance(db, child, "USD", amt)
    add_client_wallet_balance(db, parent, "USD", amt)

    marker = _baas_revert_marker(canonical_id)
    parent_label = parent.display_name()
    child_label = child.display_name()

    tx_revert_out = WalletTransaction(
        user_id=None,
        client_id=int(child.id),
        amount=-amt,
        transaction_type=TX_BAAS_TRANSFER_REVERT_OUT,
        description=f"{marker} — devolución a {parent_label}",
    )
    tx_revert_in = WalletTransaction(
        user_id=None,
        client_id=int(parent.id),
        amount=amt,
        transaction_type=TX_BAAS_TRANSFER_REVERT_IN,
        description=f"{marker} — desde {child_label}",
    )
    db.add(parent)
    db.add(child)
    db.add(tx_revert_out)
    db.add(tx_revert_in)
    db.commit()
    db.refresh(tx_revert_out)
    db.refresh(tx_revert_in)

    return {
        "ok": True,
        "message": f"Transferencia revertida: ${amt:.2f} USD devueltos a {parent_label}.",
        "amount_reverted": round(amt, 2),
        "sender_client_id": int(parent.id),
        "sender_client_name": parent_label,
        "receiver_client_id": int(child.id),
        "receiver_client_name": child_label,
        "original_transaction_id": int(canonical_id),
        "reversal_transaction_ids": [int(tx_revert_out.id), int(tx_revert_in.id)],
    }


def get_client_by_payment_token(db: Session, token: uuid.UUID) -> Client:
    row = db.query(Client).filter(Client.payment_token == token).first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")
    return row


def build_distributor_tree_node(db: Session, root: Client) -> dict[str, object]:
    """
    Árbol completo de sub-clientes descendientes del ``root`` (incluye la raíz).

    Carga todos los descendientes en consultas acotadas y arma la jerarquía en memoria.
    """
    from collections import defaultdict

    root_id = int(root.id)
    collected: dict[int, Client] = {root_id: root}
    frontier: list[int] = [root_id]

    while frontier:
        rows = (
            db.query(Client)
            .filter(Client.parent_id.in_(frontier))
            .order_by(Client.name.asc().nulls_last(), Client.username.asc(), Client.id.asc())
            .all()
        )
        if not rows:
            break
        frontier = []
        for row in rows:
            rid = int(row.id)
            if rid not in collected:
                collected[rid] = row
                frontier.append(rid)

    by_parent: dict[int, list[Client]] = defaultdict(list)
    for client in collected.values():
        pid = getattr(client, "parent_id", None)
        if pid is not None and int(pid) in collected:
            by_parent[int(pid)].append(client)

    for pid in by_parent:
        by_parent[pid].sort(
            key=lambda c: (
                (c.name or "").lower(),
                (c.username or "").lower(),
                int(c.id),
            )
        )

    def _node(client: Client, *, nivel: int = 1) -> dict[str, object]:
        from app.services.client_currency_service import get_client_currency
        from app.services.wallet_balance_service import get_client_wallet_balance

        cid = int(client.id)
        display = client.display_name()
        raw_status = str(client.status or "Activo").strip()
        normalized_status = "Inactivo" if raw_status.lower() == "inactivo" else "Activo"
        cur = get_client_currency(client)
        bal = float(get_client_wallet_balance(client, cur))
        return {
            "id": str(cid),
            "name": display,
            "username": str(client.username or "").strip(),
            "email": str(client.email or "").strip(),
            "status": normalized_status,
            "wallet_balance": round(bal, 2),
            "currency": cur,
            "payment_token": str(client.payment_token),
            "nivel": int(nivel),
            "children": [_node(child, nivel=nivel + 1) for child in by_parent.get(cid, [])],
        }

    return _node(collected[root_id], nivel=1)
