from __future__ import annotations

import logging
import re
import unicodedata
from typing import Optional

from sqlalchemy import and_, func
from sqlalchemy.orm import Session, selectinload

from fastapi import HTTPException, status

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.client_product_price import ClientProductPrice
from app.models.product import Product, ProductPackageCatalog
from app.models.screen_stock import ScreenStock
from app.schemas.client_product_prices import (
    FLUJO_PROVIDER_NAME,
    AdminClientPackagePriceUpsertItem,
    ClientProductPriceItem,
    FlujoPackageForPricing,
    PortalAutoPurchaseProduct,
)

logger = logging.getLogger(__name__)


def normalize_package_label_key(label: Optional[str]) -> str:
    """
    Clave estable para emparejar paquetes entre catálogo, bodega y precios.

    Normaliza espacios, mayúsculas y variantes con «+» / «PRO GRATIS» para evitar
    fallos de match cuando el label incluye caracteres como «6 MESES + 1 MES».
    """
    raw = unicodedata.normalize("NFKC", str(label or "")).strip().lower()
    if not raw:
        return ""
    raw = raw.replace("(", " ").replace(")", " ")
    raw = re.sub(r"\bpro\s*gratis\b", " ", raw, flags=re.IGNORECASE)
    raw = re.sub(r"\s*\+\s*", " + ", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    return raw


def margin_below_cost_message(cost_usd: float) -> str:
    return f"El precio de venta no puede ser menor al costo base de (${float(cost_usd):.2f} USD)"


def resolve_client_package_sale_price_usd(cpp: ClientProductPrice) -> float:
    """Precio de venta en USD (``custom_price``) para cobro con billetera BaaS."""
    try:
        usd = round(float(cpp.custom_price), 4)
    except (TypeError, ValueError) as exc:
        raise ValueError("Precio USD no configurado para este paquete.") from exc
    if usd <= 0:
        raise ValueError("Precio USD no configurado para este paquete.")
    return usd


def resolve_client_package_sale_price(
    db: Session,
    *,
    client: Client,
    cpp: ClientProductPrice,
) -> tuple[float, str]:
    """
    Precio de venta visible en el portal (moneda del cliente).

    ``custom_price`` suele guardar USD; ``sale_price_local`` es el monto asignado en BOB/etc.
    """
    from app.services.client_currency_service import get_client_currency
    from app.services.currency_consolidation import get_last_exchange_rate

    client_cur = get_client_currency(client)
    stored_local = getattr(cpp, "sale_price_local", None)
    stored_cur = normalize_currency_code(
        getattr(cpp, "price_currency", None) or client_cur,
        "USD",
    )
    if stored_local is not None:
        try:
            loc = round(float(stored_local), 4)
            if loc > 0:
                return loc, stored_cur
        except (TypeError, ValueError):
            pass

    usd_price = round(float(cpp.custom_price), 4)
    if client_cur == "USD":
        return usd_price, "USD"

    xr, _ = get_last_exchange_rate(db, client_cur)
    if xr <= 0:
        xr = 1.0
    return round(usd_price * float(xr), 4), client_cur


def list_client_assigned_package_prices(
    db: Session,
    client_id: int,
) -> list[dict[str, object]]:
    """Precios personalizados del cliente para el portal (mapa / lista)."""
    client = db.get(Client, int(client_id))
    if client is None:
        return []

    rows = (
        db.query(ClientProductPrice, ProductPackageCatalog, Product)
        .join(ProductPackageCatalog, ProductPackageCatalog.id == ClientProductPrice.package_catalog_id)
        .join(Product, Product.id == ClientProductPrice.product_id)
        .filter(
            ClientProductPrice.client_id == int(client_id),
            Product.is_active.is_(True),
        )
        .order_by(ProductPackageCatalog.id.asc())
        .all()
    )
    out: list[dict[str, object]] = []
    for cpp, catalog_line, prod in rows:
        if not _is_credito_pantalla_product(prod):
            continue
        sale_price, sale_cur = resolve_client_package_sale_price(db, client=client, cpp=cpp)
        ref_cost = _package_base_cost_usd(db, product=prod, catalog_line=catalog_line)
        out.append(
            {
                "package_catalog_id": int(catalog_line.id),
                "product_id": int(prod.id),
                "precio_venta_local": sale_price,
                "currency": sale_cur,
                "reference_cost_usd": ref_cost,
            }
        )
    return out


def _norm_provider(value: Optional[str]) -> str:
    return (value or "").strip().lower()


def _is_flujo_provider(value: Optional[str]) -> bool:
    return _norm_provider(value) == _norm_provider(FLUJO_PROVIDER_NAME)


def _is_credito_pantalla_product(product: Product) -> bool:
    """Alineado con ``catalogKind`` del frontend (product_type + service_type legado)."""
    pt = (getattr(product, "product_type", None) or "").strip().lower()
    if pt in ("credito_pantalla", "screen_credit"):
        return True
    if pt == "credito_normal":
        return False
    st = (product.service_type or "").strip().lower()
    if st in ("paquete pantalla", "crédito por pantalla", "credito por pantalla"):
        return True
    if "pantalla" in st:
        return True
    return False


def _is_flujo_matrix_product(product: Product) -> bool:
    """
    Matriz Flujo: proveedor IPTV «Flujo» (case-insensitive) o producto de catálogo
    cuyo nombre identifica la línea Flujo (p. ej. producto ``flujo`` con proveedor «General»).
    """
    if _is_flujo_provider(product.iptv_provider):
        return True
    name = (product.name or "").strip().lower()
    if not name:
        return False
    if name == "flujo" or name.startswith("flujo ") or " flujo" in f" {name} ":
        return True
    return False


def _inventory_provider_for_product(product: Product) -> str:
    """Proveedor usado en bodega (``screen_stock.provider``) para este producto."""
    prov = (product.iptv_provider or "").strip()
    if prov:
        return prov
    return FLUJO_PROVIDER_NAME


def _package_display_name(package_label: str) -> str:
    lbl = (package_label or "").strip()
    if not lbl:
        return FLUJO_PROVIDER_NAME
    low = lbl.lower()
    if low.startswith("flujo"):
        return lbl
    return f"{FLUJO_PROVIDER_NAME} {lbl}"


def _package_display_name_for_product(product: Product, package_label: str) -> str:
    """Etiqueta visible en admin/portal según producto y paquete (Flujo u otro proveedor)."""
    if _is_flujo_matrix_product(product):
        return _package_display_name(package_label)
    prod_name = (product.name or "").strip()
    pkg = (package_label or "").strip()
    if prod_name and pkg:
        if pkg.lower() in prod_name.lower():
            return prod_name
        return f"{prod_name} {pkg}"
    return prod_name or pkg or "—"


def _product_package_line_count(product: Product) -> int:
    lines = list(getattr(product, "package_catalog_lines", None) or [])
    return sum(1 for ln in lines if str(getattr(ln, "package_label", "") or "").strip())


def _avg_screen_stock_cost_for_package_label(
    db: Session,
    *,
    product_id: int,
    package_label: str,
    inventory_provider: Optional[str] = None,
) -> Optional[float]:
    """Costo promedio en bodega para un paquete (match exacto y normalizado)."""
    pkg = (package_label or "").strip()
    if not pkg:
        return None
    inv_prov = _norm_provider(inventory_provider)
    target_norm = normalize_package_label_key(pkg)

    exact_avg = (
        db.query(func.avg(ScreenStock.cost_per_package))
        .filter(
            ScreenStock.product_id == int(product_id),
            func.lower(func.trim(ScreenStock.provider)) == inv_prov,
            func.lower(func.trim(ScreenStock.package)) == pkg.lower(),
            ScreenStock.cost_per_package.isnot(None),
        )
        .scalar()
    )
    if exact_avg is not None:
        try:
            val = float(exact_avg)
            if val >= 0:
                return val
        except (TypeError, ValueError):
            pass

    if not target_norm:
        return None

    q = db.query(ScreenStock.package, ScreenStock.cost_per_package).filter(
        ScreenStock.product_id == int(product_id),
        ScreenStock.cost_per_package.isnot(None),
    )
    if inv_prov:
        q = q.filter(func.lower(func.trim(ScreenStock.provider)) == inv_prov)
    costs: list[float] = []
    for row_pkg, row_cost in q.all():
        if normalize_package_label_key(row_pkg) != target_norm:
            continue
        try:
            costs.append(float(row_cost))
        except (TypeError, ValueError):
            continue
    if not costs:
        return None
    return sum(costs) / len(costs)


def _package_base_cost_usd(
    db: Session,
    *,
    product: Product,
    catalog_line: ProductPackageCatalog,
) -> float:
    try:
        ref = float(catalog_line.reference_cost_usd) if catalog_line.reference_cost_usd is not None else None
    except (TypeError, ValueError):
        ref = None
    if ref is not None and ref >= 0:
        return ref

    inv_prov = _inventory_provider_for_product(product)
    pkg = (catalog_line.package_label or "").strip()
    avg = _avg_screen_stock_cost_for_package_label(
        db,
        product_id=int(product.id),
        package_label=pkg,
        inventory_provider=inv_prov,
    )
    if avg is not None and avg >= 0:
        return float(avg)

    # Evitar usar purchase_cost_usd del producto cuando hay matriz multi-paquete:
    # un costo global suele corresponder al paquete más caro y anula márgenes en 6/12 meses.
    if _product_package_line_count(product) <= 1:
        try:
            prod_cost = float(product.purchase_cost_usd or 0)
        except (TypeError, ValueError):
            prod_cost = 0.0
        if prod_cost > 0:
            return prod_cost

    return 0.0


def count_free_screen_stock_for_flujo_package(
    db: Session,
    *,
    product_id: int,
    package_label: str,
    inventory_provider: Optional[str] = None,
) -> int:
    pkg = (package_label or "").strip().lower()
    if not pkg:
        return 0
    q = db.query(func.count(ScreenStock.id)).filter(
        ScreenStock.product_id == int(product_id),
        func.lower(func.trim(ScreenStock.package)) == pkg,
        ScreenStock.status == "free",
        ScreenStock.sale_id.is_(None),
    )
    if inventory_provider:
        q = q.filter(
            func.lower(func.trim(ScreenStock.provider)) == _norm_provider(inventory_provider),
        )
    n = q.scalar()
    return int(n or 0)


def _batch_free_screen_stock_counts(db: Session) -> dict[tuple[int, str, str], int]:
    """Stock libre agrupado por (product_id, package_lower, provider_norm) — evita N+1 en catálogo."""
    rows = (
        db.query(
            ScreenStock.product_id,
            func.lower(func.trim(ScreenStock.package)).label("pkg"),
            func.lower(func.trim(ScreenStock.provider)).label("prov"),
            func.count(ScreenStock.id).label("cnt"),
        )
        .filter(
            ScreenStock.status == "free",
            ScreenStock.sale_id.is_(None),
        )
        .group_by(
            ScreenStock.product_id,
            func.lower(func.trim(ScreenStock.package)),
            func.lower(func.trim(ScreenStock.provider)),
        )
        .all()
    )
    out: dict[tuple[int, str, str], int] = {}
    for row in rows:
        pid = int(row.product_id)
        pkg = str(row.pkg or "").strip()
        prov = str(row.prov or "").strip()
        if not pkg:
            continue
        out[(pid, pkg, prov)] = int(row.cnt or 0)
    return out


def _free_stock_from_batch(
    stock_map: dict[tuple[int, str, str], int],
    *,
    product_id: int,
    package_label: str,
    inventory_provider: Optional[str] = None,
) -> int:
    pkg = (package_label or "").strip().lower()
    if not pkg:
        return 0
    prov = _norm_provider(inventory_provider)
    return int(stock_map.get((int(product_id), pkg, prov), 0))


def list_screen_credit_packages_for_pricing(db: Session) -> list[FlujoPackageForPricing]:
    """Catálogo global: todos los paquetes activos de productos «crédito por pantalla»."""
    products = (
        db.query(Product)
        .options(selectinload(Product.package_catalog_lines))
        .filter(Product.is_active.is_(True))
        .order_by(Product.name.asc(), Product.id.asc())
        .all()
    )
    stock_map = _batch_free_screen_stock_counts(db)
    out: list[FlujoPackageForPricing] = []
    for product in products:
        if not _is_credito_pantalla_product(product):
            continue
        inv_prov = _inventory_provider_for_product(product)
        lines = sorted(
            list(product.package_catalog_lines or []),
            key=lambda ln: (int(getattr(ln, "sort_order", 0) or 0), int(getattr(ln, "id", 0) or 0)),
        )
        for line in lines:
            pkg_label = (line.package_label or "").strip()
            if not pkg_label:
                continue
            out.append(
                FlujoPackageForPricing(
                    package_catalog_id=int(line.id),
                    product_id=int(product.id),
                    product_name=str(product.name or ""),
                    package_label=pkg_label,
                    display_name=_package_display_name_for_product(product, pkg_label),
                    reference_cost_usd=_package_base_cost_usd(db, product=product, catalog_line=line),
                    free_stock=_free_stock_from_batch(
                        stock_map,
                        product_id=int(product.id),
                        package_label=pkg_label,
                        inventory_provider=inv_prov,
                    ),
                )
            )
    return out


def list_flujo_packages_for_pricing(db: Session) -> list[FlujoPackageForPricing]:
    """Subconjunto Flujo (retrocompatibilidad con flujos que exigen matriz Flujo)."""
    products = (
        db.query(Product)
        .options(selectinload(Product.package_catalog_lines))
        .filter(Product.is_active.is_(True))
        .order_by(Product.name.asc(), Product.id.asc())
        .all()
    )
    stock_map = _batch_free_screen_stock_counts(db)
    out: list[FlujoPackageForPricing] = []
    for product in products:
        if not _is_credito_pantalla_product(product):
            continue
        if not _is_flujo_matrix_product(product):
            continue
        inv_prov = _inventory_provider_for_product(product)
        lines = sorted(
            list(product.package_catalog_lines or []),
            key=lambda ln: (int(getattr(ln, "sort_order", 0) or 0), int(getattr(ln, "id", 0) or 0)),
        )
        for line in lines:
            pkg_label = (line.package_label or "").strip()
            if not pkg_label:
                continue
            out.append(
                FlujoPackageForPricing(
                    package_catalog_id=int(line.id),
                    product_id=int(product.id),
                    product_name=str(product.name or ""),
                    package_label=pkg_label,
                    display_name=_package_display_name(pkg_label),
                    reference_cost_usd=_package_base_cost_usd(db, product=product, catalog_line=line),
                    free_stock=_free_stock_from_batch(
                        stock_map,
                        product_id=int(product.id),
                        package_label=pkg_label,
                        inventory_provider=inv_prov,
                    ),
                )
            )
    return out


# Alias usado por distributors.py — catálogo completo de inventario (crédito por pantalla).
list_screen_catalog_products_for_pricing = list_screen_credit_packages_for_pricing


def _get_package_catalog_line(
    db: Session,
    package_catalog_id: int,
) -> tuple[ProductPackageCatalog, Product]:
    """Paquete de ``product_package_catalog`` con producto activo (sin restricción de proveedor)."""
    line = (
        db.query(ProductPackageCatalog)
        .options(selectinload(ProductPackageCatalog.product))
        .filter(ProductPackageCatalog.id == int(package_catalog_id))
        .first()
    )
    if line is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Paquete de catálogo con id {package_catalog_id} no encontrado.",
        )
    product = line.product if line.product else db.get(Product, int(line.product_id))
    if product is None or not product.is_active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Producto del paquete no encontrado o inactivo.",
        )
    return line, product


def _get_screen_credit_package_catalog_line(
    db: Session,
    package_catalog_id: int,
) -> tuple[ProductPackageCatalog, Product]:
    line, product = _get_package_catalog_line(db, package_catalog_id)
    if not _is_credito_pantalla_product(product):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El paquete no pertenece a un producto de crédito por pantalla.",
        )
    return line, product


def _get_flujo_package_catalog_line(
    db: Session,
    package_catalog_id: int,
) -> tuple[ProductPackageCatalog, Product]:
    """Retrocompatibilidad: ya no restringe a la matriz Flujo."""
    return _get_package_catalog_line(db, package_catalog_id)


def validate_custom_price_vs_package_cost(
    *,
    custom_price: float,
    cost_usd: float,
    display_name: str = "paquete",
) -> None:
    if float(custom_price) + 1e-9 < float(cost_usd):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=margin_below_cost_message(cost_usd),
        )


def upsert_client_product_prices(
    db: Session,
    *,
    client_id: int,
    items: list[ClientProductPriceItem],
    default_price_currency: Optional[str] = None,
) -> int:
    """Crea o actualiza precios personalizados por paquete de catálogo (cualquier proveedor)."""
    if not items:
        return 0
    from app.services.client_currency_service import get_client_currency

    client = db.get(Client, int(client_id))
    touched = 0
    for item in items:
        line, product = _get_package_catalog_line(db, int(item.package_catalog_id))
        if int(line.product_id) != int(item.product_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="product_id no coincide con el paquete de catálogo indicado.",
            )
        cost = _package_base_cost_usd(db, product=product, catalog_line=line)
        validate_custom_price_vs_package_cost(
            custom_price=float(item.custom_price),
            cost_usd=cost,
            display_name=_package_display_name_for_product(product, line.package_label or ""),
        )

        price_cur = normalize_currency_code(
            item.price_currency or default_price_currency or (get_client_currency(client) if client else "USD"),
            "USD",
        )
        local_price: Optional[float] = None
        if item.local_price is not None:
            try:
                lp = round(float(item.local_price), 4)
                if lp > 0:
                    local_price = lp
            except (TypeError, ValueError):
                local_price = None
        if local_price is None and price_cur != "USD":
            from app.services.currency_consolidation import get_last_exchange_rate

            xr, _ = get_last_exchange_rate(db, price_cur)
            if xr > 0:
                local_price = round(float(item.custom_price) * float(xr), 4)

        row = (
            db.query(ClientProductPrice)
            .filter(
                ClientProductPrice.client_id == int(client_id),
                ClientProductPrice.package_catalog_id == int(item.package_catalog_id),
            )
            .first()
        )
        price_f = round(float(item.custom_price), 4)
        if row is None:
            db.add(
                ClientProductPrice(
                    client_id=int(client_id),
                    product_id=int(product.id),
                    package_catalog_id=int(line.id),
                    custom_price=price_f,
                    sale_price_local=local_price,
                    price_currency=price_cur if local_price is not None else None,
                )
            )
        else:
            row.product_id = int(product.id)
            row.custom_price = price_f
            if local_price is not None:
                row.sale_price_local = local_price
                row.price_currency = price_cur
            db.add(row)
        touched += 1
    return touched


def _client_package_price_map(db: Session, client_id: int) -> dict[int, ClientProductPrice]:
    rows = (
        db.query(ClientProductPrice)
        .filter(ClientProductPrice.client_id == int(client_id))
        .all()
    )
    return {int(r.package_catalog_id): r for r in rows if r.package_catalog_id is not None}


def list_portal_auto_purchase_products(db: Session, client_id: int) -> list[PortalAutoPurchaseProduct]:
    """Catálogo Flujo completo (activo) con precio opcional según asignación del cliente."""
    client = db.get(Client, int(client_id))
    if client is None:
        return []

    from app.services.client_currency_service import get_client_currency

    client_cur = get_client_currency(client)
    price_map = _client_package_price_map(db, int(client_id))
    catalog = list_screen_credit_packages_for_pricing(db)
    out: list[PortalAutoPurchaseProduct] = []
    for pkg in catalog:
        cpp = price_map.get(int(pkg.package_catalog_id))
        sale_local: Optional[float] = None
        sale_usd: Optional[float] = None
        if cpp is not None:
            sale_price, sale_cur = resolve_client_package_sale_price(db, client=client, cpp=cpp)
            if sale_price > 0:
                sale_local = sale_price
                if sale_cur == "USD":
                    sale_usd = sale_price
                else:
                    try:
                        sale_usd = round(float(cpp.custom_price), 4)
                    except (TypeError, ValueError):
                        sale_usd = None
        out.append(
            PortalAutoPurchaseProduct(
                package_catalog_id=int(pkg.package_catalog_id),
                product_id=int(pkg.product_id),
                name=str(pkg.display_name),
                package_label=str(pkg.package_label),
                custom_price=sale_usd,
                precio_venta_local=sale_local,
                reference_cost_usd=float(pkg.reference_cost_usd),
                free_stock=int(pkg.free_stock),
                currency=client_cur,
            )
        )
    return out


def list_admin_client_package_price_matrix(
    db: Session,
    client_id: int,
) -> list[dict[str, object]]:
    """
    Matriz admin: catálogo global (crédito por pantalla) LEFT JOIN precios del cliente.
    Garantiza una fila por cada paquete activo del inventario, con o sin precio asignado.
    """
    client = db.get(Client, int(client_id))
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")

    rows = (
        db.query(ProductPackageCatalog, Product, ClientProductPrice)
        .join(Product, Product.id == ProductPackageCatalog.product_id)
        .outerjoin(
            ClientProductPrice,
            and_(
                ClientProductPrice.package_catalog_id == ProductPackageCatalog.id,
                ClientProductPrice.client_id == int(client_id),
            ),
        )
        .filter(Product.is_active.is_(True))
        .order_by(Product.name.asc(), ProductPackageCatalog.sort_order.asc(), ProductPackageCatalog.id.asc())
        .all()
    )

    out: list[dict[str, object]] = []
    for catalog_line, product, cpp in rows:
        if not _is_credito_pantalla_product(product):
            continue
        pkg_label = (catalog_line.package_label or "").strip()
        if not pkg_label:
            continue
        inv_prov = _inventory_provider_for_product(product)
        sale_local: Optional[float] = None
        if cpp is not None:
            sale_price, _ = resolve_client_package_sale_price(db, client=client, cpp=cpp)
            if sale_price > 0:
                sale_local = sale_price
        out.append(
            {
                "package_catalog_id": int(catalog_line.id),
                "product_id": int(product.id),
                "display_name": _package_display_name_for_product(product, pkg_label),
                "product_name": str(product.name or ""),
                "package_label": pkg_label,
                "reference_cost_usd": _package_base_cost_usd(
                    db,
                    product=product,
                    catalog_line=catalog_line,
                ),
                "free_stock": count_free_screen_stock_for_flujo_package(
                    db,
                    product_id=int(product.id),
                    package_label=pkg_label,
                    inventory_provider=inv_prov,
                ),
                "sale_price_local": sale_local,
            }
        )
    return out


def upsert_admin_client_package_prices_local(
    db: Session,
    *,
    client_id: int,
    items: list[AdminClientPackagePriceUpsertItem],
) -> int:
    """Upsert masivo desde admin: ``package_id`` + ``sale_price_local`` en moneda del cliente."""
    if not items:
        return 0

    from app.services.client_currency_service import get_client_currency
    from app.services.currency_consolidation import get_last_exchange_rate

    client = db.get(Client, int(client_id))
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")

    price_cur = get_client_currency(client)
    cpp_items: list[ClientProductPriceItem] = []
    for raw in items:
        pkg_id = int(raw.package_id)
        sale_local = float(raw.sale_price_local)
        line, product = _get_package_catalog_line(db, pkg_id)
        cost = _package_base_cost_usd(db, product=product, catalog_line=line)
        if price_cur == "USD":
            custom_usd = round(sale_local, 4)
        else:
            xr, _ = get_last_exchange_rate(db, price_cur)
            if xr <= 0:
                xr = 1.0
            custom_usd = round(sale_local / float(xr), 4)
        validate_custom_price_vs_package_cost(
            custom_price=custom_usd,
            cost_usd=cost,
            display_name=_package_display_name_for_product(product, line.package_label or ""),
        )
        cpp_items.append(
            ClientProductPriceItem(
                product_id=int(product.id),
                package_catalog_id=int(line.id),
                custom_price=custom_usd,
                local_price=round(sale_local, 4),
                price_currency=price_cur,
            )
        )
    return upsert_client_product_prices(
        db,
        client_id=int(client_id),
        items=cpp_items,
        default_price_currency=price_cur,
    )


def get_client_package_price_row(
    db: Session,
    *,
    client_id: int,
    package_catalog_id: int,
    product_id: Optional[int] = None,
) -> ClientProductPrice | None:
    """
    Precio asignado al cliente por ``package_catalog_id`` (y opcionalmente ``product_id``).

    La búsqueda es estrictamente por IDs de catálogo/producto; nunca por nombre de paquete.
    """
    q = db.query(ClientProductPrice).filter(
        ClientProductPrice.client_id == int(client_id),
        ClientProductPrice.package_catalog_id == int(package_catalog_id),
    )
    if product_id is not None:
        row = q.filter(ClientProductPrice.product_id == int(product_id)).first()
        if row is not None:
            return row
        logger.warning(
            "ClientProductPrice sin product_id=%s para client_id=%s package_catalog_id=%s; "
            "usando fila legacy por package_catalog_id.",
            product_id,
            client_id,
            package_catalog_id,
        )
    return q.first()


def resolve_client_assigned_package_price(
    db: Session,
    *,
    client: Client,
    package_catalog_id: int,
    product_id: Optional[int] = None,
    catalog_line: Optional[ProductPackageCatalog] = None,
    product: Optional[Product] = None,
) -> tuple[Optional[float], str, str]:
    """
    Resuelve precio asignado al cliente para un paquete.

    Returns:
        (amount, currency, source) donde source ∈ assigned|reference_cost|base_cost|missing
    """
    from app.services.client_currency_service import get_client_currency

    row = get_client_package_price_row(
        db,
        client_id=int(client.id),
        package_catalog_id=int(package_catalog_id),
        product_id=product_id,
    )
    if row is not None:
        local_price, price_cur = resolve_client_package_sale_price(db, client=client, cpp=row)
        if local_price > 0:
            return float(local_price), price_cur, "assigned"

    line = catalog_line
    prod = product
    if line is None or prod is None:
        line, prod = _get_package_catalog_line(db, int(package_catalog_id))
    if product_id is not None and int(line.product_id) != int(product_id):
        logger.warning(
            "package_catalog_id=%s pertenece a product_id=%s (esperado=%s)",
            package_catalog_id,
            line.product_id,
            product_id,
        )

    ref_cost = _package_base_cost_usd(db, product=prod, catalog_line=line)
    cur = get_client_currency(client)
    if ref_cost > 0:
        return float(ref_cost), cur, "reference_cost"
    return None, cur, "missing"
