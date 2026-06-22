"""Disponibilidad de créditos por producto de catálogo (crédito normal)."""

from __future__ import annotations

from sqlalchemy import func
from typing import Optional

from sqlalchemy.orm import Session

from app.models.iptv_account import IPTVAccount
from app.models.product import Product
from app.models.sale import Sale, SaleStatus

_CATALOG_CONSUMED_SALE_STATUSES = (
    SaleStatus.approved,
    SaleStatus.partially_paid,
)

_CATALOG_PENDING_SALE_STATUSES = (
    SaleStatus.pending,
    SaleStatus.payment_submitted,
)

_FULL_CREDIT_INVENTORY_CHANNELS = frozenset({"full_credits", "mixed"})


def catalog_product_kind(product: Product) -> str:
    pt = (getattr(product, "product_type", None) or "").strip().lower()
    if pt == "credito_pantalla":
        return "credito_pantalla"
    if pt == "credito_normal":
        return "credito_normal"
    st = (product.service_type or "").strip().lower()
    if st == "paquete pantalla":
        return "credito_pantalla"
    return "credito_normal"


def _norm_provider_key(name: str | None) -> str:
    return (name or "").strip().lower()


def _iptv_credits_sum_for_product(db: Session, product: Product) -> float:
    """
    Suma de créditos en recargas ``full`` enlazadas al producto.

    Incluye filas con ``product_id`` explícito y, si aplica, recargas legadas del mismo
    proveedor sin FK cuando solo hay un producto activo de crédito normal con ese proveedor.
    """
    pid = int(product.id)
    prov_key = _norm_provider_key(product.iptv_provider)

    by_product = (
        db.query(func.coalesce(func.sum(IPTVAccount.credits_spent), 0.0))
        .filter(
            IPTVAccount.service_type == "full",
            IPTVAccount.product_id == pid,
        )
        .scalar()
    )
    loaded = float(by_product or 0.0)

    if prov_key:
        siblings = (
            db.query(func.count(Product.id))
            .filter(
                Product.is_active.is_(True),
                Product.id != pid,
                func.lower(func.trim(Product.iptv_provider)) == prov_key,
            )
            .scalar()
        )
        sibling_count = int(siblings or 0)
        if sibling_count == 0:
            orphan = (
                db.query(func.coalesce(func.sum(IPTVAccount.credits_spent), 0.0))
                .filter(
                    IPTVAccount.service_type == "full",
                    IPTVAccount.product_id.is_(None),
                    func.lower(func.trim(IPTVAccount.provider_name)) == prov_key,
                )
                .scalar()
            )
            loaded += float(orphan or 0.0)

    return loaded


def catalog_physical_credits_total(db: Session, product: Product) -> float:
    """Stock total cargado (recargas IPTV enlazadas o saldo inicial de apertura)."""
    loaded = _iptv_credits_sum_for_product(db, product)
    if loaded <= 0 and product.inventory_opening_qty is not None:
        oq = float(product.inventory_opening_qty or 0)
        if oq > 0:
            loaded = oq
    return loaded


def catalog_consumed_credits(db: Session, product: Product) -> float:
    """
    Créditos ya vendidos / asignados.

    Usa ``inventory_credit_assigned_qty`` y ventas ``approved`` + ``partially_paid``.
    Si el ledger de asignados supera el stock físico (dato histórico inconsistente),
    se confía en la suma de ventas para no mostrar 0 disponible tras recargar.
    """
    assigned = float(product.inventory_credit_assigned_qty or 0)
    pid = int(product.id)
    sold = (
        db.query(func.coalesce(func.sum(Sale.credits_quantity), 0.0))
        .filter(
            Sale.product_id == pid,
            Sale.credits_quantity.isnot(None),
            Sale.status.in_(_CATALOG_CONSUMED_SALE_STATUSES),
        )
        .scalar()
    )
    sold_f = float(sold or 0)
    total = _iptv_credits_sum_for_product(db, product)
    if total > 0 and assigned > total + 0.0001:
        return sold_f
    return max(assigned, sold_f)


def _catalog_credit_reserved_qty(
    product: Product,
    *,
    exclude_sale_id: Optional[int] = None,
    db: Optional[Session] = None,
) -> float:
    """
    Créditos reservados en preventas (``inventory_credit_reserved_qty``).

    Al activar/editar una venta pendiente, su propia reserva se libera del cómputo.
    """
    reserved = float(product.inventory_credit_reserved_qty or 0)
    if exclude_sale_id is None or db is None:
        return reserved
    ex = db.get(Sale, int(exclude_sale_id))
    if ex is None:
        return reserved
    if ex.status not in _CATALOG_PENDING_SALE_STATUSES:
        return reserved
    if ex.product_id is None or int(ex.product_id) != int(product.id):
        return reserved
    ch = str(getattr(ex, "inventory_channel", "") or "").strip().lower()
    if ch not in _FULL_CREDIT_INVENTORY_CHANNELS and ex.credits_quantity is None:
        return reserved
    return max(0.0, reserved - float(ex.credits_quantity or 0))


def catalog_credits_available(
    db: Session,
    product: Product,
    *,
    exclude_sale_id: Optional[int] = None,
) -> float:
    """
    Stock real disponible para la UI y validación de ventas.

    ``recargas IPTV (total físico) − vendido/asignado − reservado (preventas)``

    No consulta APIs externas del panel IPTV: es cálculo interno del ERP.
    """
    if catalog_product_kind(product) != "credito_normal":
        return 0.0
    total = catalog_physical_credits_total(db, product)
    consumed = catalog_consumed_credits(db, product)
    reserved = _catalog_credit_reserved_qty(product, exclude_sale_id=exclude_sale_id, db=db)
    return round(max(0.0, total - consumed - reserved), 4)


def catalog_credits_available_for_activation(
    db: Session,
    product: Product,
    *,
    exclude_sale_id: Optional[int] = None,
) -> float:
    """Alias explícito para activación / edición de preventa (libera reserva de la venta objetivo)."""
    return catalog_credits_available(db, product, exclude_sale_id=exclude_sale_id)


def apply_full_recharge_to_product(
    db: Session,
    product_id: int,
    credits_added: float,
) -> None:
    """
    Tras registrar una recarga ``full`` con ``product_id``.

    Sincroniza ``inventory_opening_qty`` con el total físico de recargas cuando ayuda
    a la UI legada; el cálculo principal sigue siendo la suma de ``iptv_accounts``.
    """
    if credits_added <= 0:
        return
    p = db.get(Product, int(product_id))
    if p is None or catalog_product_kind(p) != "credito_normal":
        return
    total = catalog_physical_credits_total(db, p)
    if total > 0:
        p.inventory_opening_qty = round(total, 4)
        db.add(p)
