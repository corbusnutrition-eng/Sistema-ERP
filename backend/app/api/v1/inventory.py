from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Annotated, Literal, Optional, Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload, selectinload

from app.api.v1.dependencies import AdminDep, UserDep
from app.currency_utils import normalize_currency_code
from app.database import get_db
from app.models.account import Account
from app.models.inventory_screen_credit_drawdown import InventoryScreenCreditDrawdown
from app.models.iptv_account import IPTVAccount
from app.models.iptv_screen import IPTVScreen
from app.models.product import Product, ProductPackageCatalog
from app.models.screen_stock import SCREEN_STATUSES, ScreenStock
from app.models.sale import Sale, SaleStatus
from app.models.vendor import Vendor, VendorBill, VendorBillLine
from app.services.vendor_ap_journal import post_vendor_bill_journal, validate_bill_line_account
from app.timezone_utils import now_ecuador

from app.schemas.inventory import (
    AccountCreate,
    AccountResponse,
    CatalogFullCreditsRow,
    InventoryAvailableResponse,
    InventoryStatsResponse,
    ProviderStats,
    SalesInventoryOptionsResponse,
    SalesInvNormalCreditOption,
    SalesInvScreenPackageOption,
    SalesInvScreenPickOption,
    ScreenAvailabilityRow,
    ScreenFifoCredentialsPeek,
    ScreenLineItem,
    ScreenStockBulkCreate,
    ScreenStockNextForSale,
    ScreenStockResponse,
    ScreenSummary,
)

router = APIRouter(prefix="/inventory", tags=["inventory"])

DbDep = Annotated[Session, Depends(get_db)]

logger = logging.getLogger(__name__)

# Pantalla disponible en BD (`free`); equivalente semántico a "available".
SCREEN_STOCK_AVAILABLE_STATUS = SCREEN_STATUSES[0]

SCREENS_PER_ACCOUNT = 3

_PACKAGE_REMOVE_BLOCKED_DETAIL = (
    "No se puede eliminar un paquete con pantallas activas. "
    "Solo puedes eliminar paquetes sin uso."
)

_SCREEN_DELETE_BLOCKED_DETAIL = (
    "No se puede eliminar esta pantalla: está reservada o asignada a un cliente. "
    "Solo puedes eliminar pantallas disponibles en bodega."
)


def _catalog_product_kind(p: Product) -> str:
    if p.product_type:
        return str(p.product_type)
    st = (p.service_type or "").strip().lower()
    return "credito_pantalla" if st == "paquete pantalla" else "credito_normal"


def _provider_from_product_or_raise(
    db: Session,
    *,
    product_id: int,
    expected_kind: Literal["credito_normal", "credito_pantalla"],
) -> str:
    prod = db.get(Product, product_id)
    if prod is None or not prod.is_active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Producto no encontrado o inactivo.",
        )
    if _catalog_product_kind(prod) != expected_kind:
        detail = (
            "El producto seleccionado no es de tipo «crédito normal»."
            if expected_kind == "credito_normal"
            else "El producto seleccionado no es de tipo «crédito por pantalla»."
        )
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)
    pn = (prod.iptv_provider or "").strip()
    if not pn:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="El producto no tiene proveedor IPTV configurado.",
        )
    return pn


def _strip_opt(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip()
    return s if s else None


def _generate_rec_vendor_bill_number() -> str:
    now = now_ecuador()
    return f"REC-{now.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4].upper()}"


def _attach_vendor_bill_for_full_recharge(
    db: Session,
    *,
    payload: AccountCreate,
    total_cost_q: Decimal,
) -> None:
    vendor = db.get(Vendor, payload.vendor_id)
    if vendor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Proveedor no encontrado.")
    inv_acc = db.get(Account, payload.inventory_asset_account_id)
    validate_bill_line_account(inv_acc)

    vcur = normalize_currency_code(vendor.currency)
    acur = normalize_currency_code(inv_acc.currency)
    if acur != vcur:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cuenta de inventario debe estar en la misma moneda que el proveedor.",
        )

    bn = _strip_opt(payload.vendor_bill_number) or _generate_rec_vendor_bill_number()
    bill_date = payload.vendor_bill_date or payload.recharge_date or date.today()
    memo_raw = f"Recarga inventario servicio completo — {payload.provider}"
    bill = VendorBill(
        vendor_id=int(payload.vendor_id),
        bill_number=bn,
        bill_date=bill_date,
        due_date=payload.vendor_bill_due_date,
        terms=_strip_opt(payload.vendor_bill_terms),
        memo=memo_raw[:2000],
        total_amount=total_cost_q,
        balance_due=total_cost_q,
        status="Abierta",
    )
    db.add(bill)
    try:
        db.flush()
    except IntegrityError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ya existe una factura con ese número para este proveedor.",
        ) from e

    db.add(
        VendorBillLine(
            bill_id=bill.id,
            account_id=int(payload.inventory_asset_account_id),
            description=f"Recarga créditos — {payload.provider}"[:500],
            amount=total_cost_q,
            line_no=1,
        ),
    )
    db.flush()

    bill_loaded = (
        db.query(VendorBill)
        .options(
            joinedload(VendorBill.vendor),
            joinedload(VendorBill.lines).joinedload(VendorBillLine.account),
        )
        .filter(VendorBill.id == bill.id)
        .first()
    )
    if bill_loaded is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Factura inconsistente tras creación.",
        )
    post_vendor_bill_journal(db, bill_loaded)


def _client_display_name_for_inventory(client: Optional[Any]) -> Optional[str]:
    """Nombre corto para tabla inventario (prioriza nombre comercial, luego usuario IPTV)."""
    if client is None:
        return None
    nm = getattr(client, "name", None)
    if isinstance(nm, str) and nm.strip():
        return nm.strip()
    un = getattr(client, "username", None)
    if isinstance(un, str) and un.strip():
        return un.strip()
    return None


def _assigned_client_name_from_screen_stock(row: ScreenStock) -> Optional[str]:
    """
    Cliente ligado a la pantalla para la tabla «Créditos por pantalla».

    Incluye ventas **pending** (reserva) y **approved** (asignada). Si hay ``client_id``
    en la fila con estado reservado/asignado, usa también ``assigned_client``.
    """
    sale = getattr(row, "sale", None)
    if sale is not None:
        st = getattr(sale, "status", None)
        if st in (SaleStatus.approved, SaleStatus.pending, SaleStatus.payment_submitted):
            name = _client_display_name_for_inventory(getattr(sale, "client", None))
            if name:
                return name
    row_status = (getattr(row, "status", None) or "").strip().lower()
    if row_status in ("reserved", "held", "assigned") and getattr(row, "client_id", None):
        name = _client_display_name_for_inventory(getattr(row, "assigned_client", None))
        if name:
            return name
    return None


def _product_public_fields(prod: Optional[Product]) -> tuple[Optional[str], Optional[str]]:
    """Nombre y color hex del producto para la UI de inventario."""
    if prod is None:
        return None, None
    nm = getattr(prod, "name", None)
    name = nm.strip() if isinstance(nm, str) and nm.strip() else None
    col = getattr(prod, "color", None)
    color = col.strip() if isinstance(col, str) and col.strip() else None
    return name, color


def _screen_stock_to_response(row: ScreenStock) -> ScreenStockResponse:
    """DTO explícito: garantiza iptv_username / iptv_password en JSON (sin depender solo del ORM)."""
    prod = getattr(row, "catalog_product", None)
    pname, pcolor = _product_public_fields(prod)
    return ScreenStockResponse(
        id=row.id,
        provider=row.provider,
        package=row.package,
        status=row.status,
        expiration_date=row.expiration_date,
        cost_per_package=row.cost_per_package,
        batch_id=row.batch_id,
        batch_size=row.batch_size,
        sale_id=row.sale_id,
        product_id=getattr(row, "product_id", None),
        product_name=pname,
        product_color=pcolor,
        iptv_username=row.iptv_username,
        iptv_password=row.iptv_password,
        assigned_client_name=_assigned_client_name_from_screen_stock(row),
        created_at=row.created_at,
    )


def _norm_prov_key(prov: str) -> str:
    """Clave estable para comparar proveedores (trim + minúsculas)."""
    return (prov or "").strip().lower()


def _norm_pkg_key(label: str) -> str:
    return (label or "").strip().lower()


def _insert_product_package_catalog_if_absent(
    db: Session,
    *,
    product_id: int,
    package_label: str,
    screens_per_package: int,
    reference_cost_usd: Optional[float],
    listing_price_usd: float,
) -> None:
    """
    Inserta en ``product_package_catalog`` si no hay fila para ese producto y etiqueta
    (comparación insensible a mayúsculas). Rellena ``listing_price_usd`` (p. ej. costo o 0).
    """
    lbl = " ".join(str(package_label or "").strip().split())
    if not lbl:
        raise ValueError("Nombre de paquete vacío.")
    sp = int(screens_per_package)
    if sp < 1 or sp > 20:
        raise ValueError("screens_count debe estar entre 1 y 20.")
    want = _norm_pkg_key(lbl)
    exists = (
        db.query(ProductPackageCatalog.id)
        .filter(
            ProductPackageCatalog.product_id == int(product_id),
            func.lower(func.trim(ProductPackageCatalog.package_label)) == want,
        )
        .first()
    )
    if exists:
        return
    max_so = (
        db.query(func.coalesce(func.max(ProductPackageCatalog.sort_order), -1))
        .filter(ProductPackageCatalog.product_id == int(product_id))
        .scalar()
    )
    next_order = int(max_so if max_so is not None else -1) + 1
    db.add(
        ProductPackageCatalog(
            product_id=int(product_id),
            package_label=lbl[:120],
            screens_per_package=sp,
            reference_cost_usd=reference_cost_usd,
            listing_price_usd=float(listing_price_usd),
            opening_inventory_qty=None,
            sort_order=next_order,
        )
    )
    db.flush()


def _sync_product_package_catalog_for_screen_line(
    db: Session,
    *,
    product_id: int,
    line: ScreenLineItem,
) -> None:
    """
    Línea de recarga a bodega: si trae ``package_catalog_id`` válido para el producto y el
    nombre coincide, no inserta. Si es manual (sin id, id erróneo o nombre distinto),
    asegura fila en catálogo por nombre (INSERT si no existía).
    """
    pkg_display = " ".join(str(line.package or "").strip().split())
    if not pkg_display:
        raise ValueError("Nombre de paquete vacío.")
    sp = int(line.screens_count)
    if sp < 1 or sp > 20:
        raise ValueError("screens_count debe estar entre 1 y 20.")

    cid = line.package_catalog_id
    if cid is not None:
        row = db.get(ProductPackageCatalog, int(cid))
        if row is not None and int(row.product_id) == int(product_id):
            if _norm_pkg_key(row.package_label) != _norm_pkg_key(pkg_display):
                raise ValueError(
                    "El paquete del catálogo seleccionado no coincide con el nombre enviado."
                )
            return

    cost = line.cost_per_package
    listing = float(cost) if cost is not None else 0.0
    _insert_product_package_catalog_if_absent(
        db,
        product_id=int(product_id),
        package_label=pkg_display,
        screens_per_package=sp,
        reference_cost_usd=cost,
        listing_price_usd=listing,
    )


def _count_active_screenstock_for_package_catalog(
    db: Session,
    *,
    provider: str,
    package_label: str,
) -> int:
    """Pantallas «reserved»/«assigned» para proveedor + paquete (catálogo local)."""
    pv = _norm_prov_key(provider)
    pkg_norm = (package_label or "").strip().lower()
    q = db.query(func.count(ScreenStock.id)).filter(
        func.lower(func.trim(func.coalesce(ScreenStock.provider, ""))) == pv,
        func.lower(func.trim(func.coalesce(ScreenStock.package, ""))) == pkg_norm,
        ScreenStock.status.in_(("reserved", "held", "assigned")),
    )
    return int(q.scalar() or 0)


def _screen_stock_fifo_ordered_query(
    db: Session,
    provider: str,
    package: str,
    *,
    batch_id: Optional[str] = None,
    catalog_product_id: Optional[int] = None,
):
    """
    Pantallas ``free`` sin venta: orden FIFO; filtro opcional por ``batch_id`` (UUID lote)
    y por ``product_id`` de catálogo (sin JOIN — compatible con ``FOR UPDATE``).

    Sin ``joinedload`` ni joins externos: esta consulta se encadena con
    ``FOR UPDATE SKIP LOCKED`` en ventas; PostgreSQL rechaza el bloqueo si hay LEFT JOIN
    al lado nullable (p. ej. catálogo por ``product_id`` opcional).
    """
    pv = _norm_prov_key(provider)
    pk = (package or "").strip().lower()
    q = (
        db.query(ScreenStock)
        .filter(
            ScreenStock.status == SCREEN_STOCK_AVAILABLE_STATUS,
            ScreenStock.sale_id.is_(None),
            func.lower(func.trim(func.coalesce(ScreenStock.provider, ""))) == pv,
            func.lower(func.trim(func.coalesce(ScreenStock.package, ""))) == pk,
        )
    )
    bid = (batch_id or "").strip()
    if bid:
        q = q.filter(func.trim(ScreenStock.batch_id) == bid)
    if catalog_product_id is not None and int(catalog_product_id) >= 1:
        q = q.filter(ScreenStock.product_id == int(catalog_product_id))
    return q.order_by(ScreenStock.created_at.asc(), ScreenStock.id.asc())


def _full_credit_pool_for_provider(db: Session, prov: str) -> float:
    want = _norm_prov_key(prov)
    q = (
        db.query(func.coalesce(func.sum(IPTVAccount.credits_spent), 0.0))
        .filter(
            IPTVAccount.service_type == "full",
            func.lower(func.trim(IPTVAccount.provider_name)) == want,
        )
        .scalar()
    )
    return float(q or 0.0)


def _sold_credits_for_provider(db: Session, prov: str) -> float:
    """Ventas aprobadas por créditos que aún no tienen movimiento en el ledger de despiece."""
    want = _norm_prov_key(prov)
    linked_ids = [
        int(r[0])
        for r in db.query(InventoryScreenCreditDrawdown.sale_id)
        .filter(InventoryScreenCreditDrawdown.sale_id.isnot(None))
        .distinct()
        .all()
        if r[0] is not None
    ]
    q = (
        db.query(func.coalesce(func.sum(Sale.credits_quantity), 0.0))
        .filter(
            Sale.credits_quantity.isnot(None),
            Sale.status == SaleStatus.approved,
            func.lower(func.trim(func.coalesce(Sale.inventory_provider, ""))) == want,
        )
    )
    if linked_ids:
        q = q.filter(~Sale.id.in_(linked_ids))
    return float(q.scalar() or 0.0)


def _ledger_packages_consumed(db: Session, prov: str) -> float:
    want = _norm_prov_key(prov)
    q = (
        db.query(func.coalesce(func.sum(InventoryScreenCreditDrawdown.credits_units), 0.0))
        .filter(
            func.lower(func.trim(func.coalesce(InventoryScreenCreditDrawdown.provider, ""))) == want,
        )
        .scalar()
    )
    return float(q or 0.0)


def _available_full_credits_for_provider(db: Session, prov: str) -> float:
    """Pool Recarga Total − ventas aprobadas − paquetes consumidos al crear bodega por pantallas."""
    total_pool = _full_credit_pool_for_provider(db, prov)
    sold = _sold_credits_for_provider(db, prov)
    ledger = _ledger_packages_consumed(db, prov)
    return round(max(0.0, total_pool - sold - ledger), 4)


def _free_screens_grouped(db: Session, prov: str) -> list[ScreenAvailabilityRow]:
    """Libres para venta: agrupadas por paquete + lote (orden global FIFO entre grupos)."""
    want = _norm_prov_key(prov)
    rows_sorted = (
        db.query(ScreenStock)
        .filter(
            ScreenStock.status == SCREEN_STOCK_AVAILABLE_STATUS,
            ScreenStock.sale_id.is_(None),
            func.lower(func.trim(func.coalesce(ScreenStock.provider, ""))) == want,
        )
        .order_by(ScreenStock.created_at.asc(), ScreenStock.id.asc())
        .all()
    )
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows_sorted:
        pk = (r.package or "").strip()
        bid = (r.batch_id or "").strip()
        if not pk or not bid:
            continue
        key = (pk.lower(), bid)
        if key not in groups:
            groups[key] = {"package": pk, "batch_id": bid, "count": 0, "head": r}
        groups[key]["count"] += 1
    rows_out: list[ScreenAvailabilityRow] = []
    for _k, g in sorted(groups.items(), key=lambda kv: (kv[1]["head"].created_at, kv[1]["head"].id)):
        head = g["head"]
        rows_out.append(
            ScreenAvailabilityRow(
                package=g["package"],
                batch_id=g["batch_id"],
                count=g["count"],
                status="Disponible",
                next_screen=ScreenStockNextForSale(
                    id=head.id,
                    iptv_username=head.iptv_username,
                    iptv_password=head.iptv_password,
                ),
            )
        )
    return rows_out


@router.get(
    "/next-screen/{product_id}",
    response_model=ScreenFifoCredentialsPeek,
    summary="Vista previa FIFO por catálogo (credenciales, sin reserva)",
)
def peek_next_fifo_screen_credentials_by_product_id(
    product_id: int,
    db: DbDep,
    _: UserDep,
) -> ScreenFifoCredentialsPeek:
    """
    Siguiente unidad disponible para el ``product_id`` (solo ``screen_stock.status`` = disponible en BD,
    hoy ``free`` — equivalente a "available"; excluye ``reserved``/``assigned``).
    Orden FIFO por ``created_at`` / ``id``. No bloquea ni reserva stock.
    """
    if product_id < 1:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="product_id inválido.",
        )
    prod = db.get(Product, int(product_id))
    if prod is None or not bool(getattr(prod, "is_active", True)):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Producto no encontrado o inactivo.",
        )

    try:
        row = (
            db.query(ScreenStock)
            .filter(
                ScreenStock.product_id == int(product_id),
                ScreenStock.status == SCREEN_STOCK_AVAILABLE_STATUS,
                ScreenStock.sale_id.is_(None),
            )
            .order_by(ScreenStock.created_at.asc(), ScreenStock.id.asc())
            .first()
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("peek_next_fifo_screen_credentials_by_product_id: fallo al consultar bodega")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No se pudo consultar la bodega. Intenta de nuevo en unos segundos.",
        ) from exc
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No hay pantallas disponibles en bodega para este producto.",
        )

    return ScreenFifoCredentialsPeek(
        screen_stock_id=int(row.id),
        iptv_username=_strip_opt(row.iptv_username),
        iptv_password=_strip_opt(row.iptv_password),
    )


@router.get("/screen-stock/peek-fifo", response_model=list[ScreenStockResponse])
def peek_fifo_screen_stock(
    db: DbDep,
    _: UserDep,
    provider: str = Query(..., min_length=1, max_length=64),
    package: str = Query(..., min_length=1, max_length=120),
    batch_id: Optional[str] = Query(None, max_length=36),
    limit: int = Query(1, ge=1, le=50),
) -> list[ScreenStockResponse]:
    """Siguiente(s) fila(s) FIFO en bodega (solo lectura; no reserva). Opcional ``batch_id`` acota el lote."""
    lim = max(1, min(limit, 50))
    rows = (
        _screen_stock_fifo_ordered_query(db, provider, package, batch_id=batch_id)
        .options(selectinload(ScreenStock.catalog_product))
        .limit(lim)
        .all()
    )
    return [_screen_stock_to_response(r) for r in rows]


@router.get("/available", response_model=InventoryAvailableResponse)
def get_inventory_available_for_sale(
    db: DbDep,
    _: UserDep,
    provider: str = Query(..., min_length=1, max_length=64, description="Proveedor IPTV (ej. Flujo, Stella)"),
) -> InventoryAvailableResponse:
    """
    Datos de inventario para registrar una venta: créditos disponibles y pantallas en bodega.
    Requiere usuario autenticado (no solo admin), alineado con POST /sales/.
    """
    prov = provider.strip()
    if not prov:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Proveedor inválido.")

    total = _available_full_credits_for_provider(db, prov)
    screens = _free_screens_grouped(db, prov)

    return InventoryAvailableResponse(
        provider=prov,
        total_credits=total,
        screens=screens,
    )


def _available_full_credits_for_catalog_product(db: Session, product: Product) -> float:
    """Saldo disponible real = recargas − vendido − reservado (misma fórmula que activación)."""
    from app.services.catalog_inventory import catalog_credits_available

    return catalog_credits_available(db, product)


def _pending_full_credits_catalog_reservations(db: Session, product_id: int) -> float:
    """Créditos en reserva ledger por producto de catálogo (campo ``inventory_credit_reserved_qty``)."""
    p = db.get(Product, int(product_id))
    if p is None:
        return 0.0
    return float(p.inventory_credit_reserved_qty or 0)


def _pending_full_credits_for_provider_pool(db: Session, provider_norm: str) -> float:
    """Misma suma que en ventas: preventas pendientes full_credits con ese proveedor (vista pooled)."""
    if not provider_norm:
        return 0.0
    raw = (
        db.query(func.coalesce(func.sum(Sale.credits_quantity), 0.0))
        .filter(
            Sale.status.in_((SaleStatus.pending, SaleStatus.payment_submitted)),
            Sale.inventory_channel.in_(("full_credits", "mixed")),
            Sale.credits_quantity.isnot(None),
            func.lower(func.trim(func.coalesce(Sale.inventory_provider, ""))) == provider_norm,
        )
        .scalar()
    )
    return float(raw or 0.0)


def _effective_available_full_credits_for_catalog_product(db: Session, product: Product) -> float:
    """Saldo mostrado en tarjetas de inventario y selector de ventas (misma fórmula)."""
    return _available_full_credits_for_catalog_product(db, product)


@router.get("/catalog-full-credits", response_model=list[CatalogFullCreditsRow])
def list_catalog_full_credits(db: DbDep, _: UserDep) -> list[CatalogFullCreditsRow]:
    """Saldo disponible por producto de catálogo (solo ``credito_normal`` activos)."""
    rows: list[CatalogFullCreditsRow] = []
    for p in db.query(Product).filter(Product.is_active.is_(True)).order_by(Product.name.asc()).all():
        if _catalog_product_kind(p) != "credito_normal":
            continue
        rows.append(
            CatalogFullCreditsRow(
                product_id=int(p.id),
                available_credits=_effective_available_full_credits_for_catalog_product(db, p),
            )
        )
    return rows


def _mk_sales_cp_option_key(product_id: Optional[int], package: str, provider: str) -> str:
    pid = int(product_id or 0)
    pkg = (package or "").strip()
    prov = (provider or "").strip()
    return f"cp|{pid}|{quote(pkg, safe='')}|{quote(prov, safe='')}"


def _reference_unit_cost_for_screen_package(
    db: Session,
    *,
    product_id: Optional[int],
    package_label: str,
    provider: str,
) -> Optional[float]:
    """Costo unitario de referencia: catálogo de paquetes o promedio en bodega libre."""
    pkg = (package_label or "").strip()
    if not pkg:
        return None
    want = _norm_pkg_key(pkg)
    if product_id is not None and int(product_id) >= 1:
        cat = (
            db.query(ProductPackageCatalog)
            .filter(
                ProductPackageCatalog.product_id == int(product_id),
                func.lower(func.trim(ProductPackageCatalog.package_label)) == want,
            )
            .first()
        )
        if cat is not None and cat.reference_cost_usd is not None:
            try:
                val = float(cat.reference_cost_usd)
                if val > 0:
                    return val
            except (TypeError, ValueError):
                pass
    pv = _norm_prov_key(provider)
    q_avg = db.query(func.avg(ScreenStock.cost_per_package)).filter(
        ScreenStock.cost_per_package.isnot(None),
        func.lower(func.trim(func.coalesce(ScreenStock.package, ""))) == want,
        func.lower(func.trim(func.coalesce(ScreenStock.provider, ""))) == pv,
    )
    if product_id is not None and int(product_id) >= 1:
        q_avg = q_avg.filter(ScreenStock.product_id == int(product_id))
    avg = q_avg.scalar()
    if avg is not None:
        try:
            val = float(avg)
            if val > 0:
                return val
        except (TypeError, ValueError):
            pass
    return None


def _screen_pick_rows_for_sale_edit(db: Session, sale_id: Optional[int]) -> list[SalesInvScreenPickOption]:
    """Incluye la pantalla de bodega ya vinculada a la venta (edición), aunque no esté «free»."""
    if sale_id is None:
        return []
    sale = db.get(Sale, int(sale_id))
    if sale is None or not sale.screen_stock_id:
        return []
    stk = db.get(ScreenStock, int(sale.screen_stock_id))
    if stk is None:
        return []
    pkg = (stk.package or "").strip()
    prov = (stk.provider or "").strip()
    uname = (stk.iptv_username or "").strip() or "sin usuario"
    pid = stk.product_id
    if pid:
        pr = db.get(Product, int(pid))
        pname = (pr.name or "").strip() if pr else ""
        if not pname:
            pname = prov or "Producto"
    else:
        pname = f"{prov} (sin catálogo)" if prov else "Inventario legado"
    lab = f"{pname} - {pkg} · {uname} (Stock: 1)" if pkg else f"{pname} · {uname} (Stock: 1)"
    ref_cost: Optional[float] = None
    if stk.cost_per_package is not None:
        try:
            cstk = float(stk.cost_per_package)
            if cstk > 0:
                ref_cost = cstk
        except (TypeError, ValueError):
            ref_cost = None
    if ref_cost is None:
        ref_cost = _reference_unit_cost_for_screen_package(
            db,
            product_id=int(pid) if pid else None,
            package_label=pkg,
            provider=prov,
        )
    return [
        SalesInvScreenPickOption(
            option_key=f"ss:{int(stk.id)}",
            screen_stock_id=int(stk.id),
            package_label=pkg,
            iptv_provider=prov or "—",
            product_id=int(pid) if pid else None,
            label=lab,
            disabled=False,
            reference_cost_usd=ref_cost,
        )
    ]


def _inventory_sales_options(db: Session, sale_id: Optional[int]) -> SalesInventoryOptionsResponse:
    normals: list[SalesInvNormalCreditOption] = []
    for p in db.query(Product).filter(Product.is_active.is_(True)).order_by(Product.name.asc()).all():
        if _catalog_product_kind(p) != "credito_normal":
            continue
        qty = round(float(_effective_available_full_credits_for_catalog_product(db, p)), 4)
        pname = (p.name or "").strip() or "Producto"
        prov = (p.iptv_provider or "").strip() or "—"
        normals.append(
            SalesInvNormalCreditOption(
                option_key=f"cn:{int(p.id)}",
                product_id=int(p.id),
                product_name=pname,
                iptv_provider=prov,
                available_credits=qty,
                disabled=qty <= 0,
                label=f"{pname} (Disponible: {qty:g})",
                reference_price=float(p.listing_price) if p.listing_price is not None else None,
                reference_currency=normalize_currency_code(p.listing_currency)
                if p.listing_currency
                else None,
            )
        )

    pkgs_rows: list[SalesInvScreenPackageOption] = []
    grp_q = (
        db.query(
            ScreenStock.product_id,
            ScreenStock.package,
            ScreenStock.provider,
            func.count(ScreenStock.id),
        )
        .filter(
            ScreenStock.status == SCREEN_STOCK_AVAILABLE_STATUS,
            ScreenStock.sale_id.is_(None),
        )
        .group_by(ScreenStock.product_id, ScreenStock.package, ScreenStock.provider)
    )
    for prod_id_raw, pkg_raw, prov_raw, cnt in grp_q.all():
        cnt_i = int(cnt or 0)
        pkg_s = (pkg_raw or "").strip()
        pv_s = (prov_raw or "").strip()
        if not pkg_s or not pv_s:
            continue
        pid_opt = int(prod_id_raw) if prod_id_raw is not None else None
        if pid_opt:
            pr = db.get(Product, pid_opt)
            pname = (pr.name or "").strip() if pr else ""
            if not pname:
                pname = pv_s
        else:
            pname = f"{pv_s} (sin catálogo)"
        key = _mk_sales_cp_option_key(pid_opt, pkg_s, pv_s)
        lbl = f"{pname} - {pkg_s} (Stock: {cnt_i})"
        ref_cost = _reference_unit_cost_for_screen_package(
            db,
            product_id=pid_opt,
            package_label=pkg_s,
            provider=pv_s,
        )
        pkgs_rows.append(
            SalesInvScreenPackageOption(
                option_key=key,
                product_id=pid_opt,
                product_name=pname,
                package_label=pkg_s,
                iptv_provider=pv_s,
                available_screens=cnt_i,
                disabled=cnt_i <= 0,
                label=lbl,
                reference_cost_usd=ref_cost,
            )
        )
    pkgs_rows.sort(key=lambda r: (r.iptv_provider.lower(), r.product_name.lower(), r.package_label.lower()))

    picks = _screen_pick_rows_for_sale_edit(db, sale_id)

    return SalesInventoryOptionsResponse(
        normal_credit_options=normals,
        screen_package_options=pkgs_rows,
        screen_pick_options=picks,
    )


@router.get("/sales-options", response_model=SalesInventoryOptionsResponse)
def inventory_sales_options(
    db: DbDep,
    _: UserDep,
    sale_id: Optional[int] = Query(None, ge=1, description="Venta en edición: incluye pantalla vinculada."),
) -> SalesInventoryOptionsResponse:
    """Opciones de inventario para Nueva venta (créditos normales + paquetes pantalla, con bloqueo por stock)."""
    return _inventory_sales_options(db, sale_id)


@router.post(
    "/accounts/",
    response_model=AccountResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_account(payload: AccountCreate, db: DbDep, _: AdminDep) -> AccountResponse:
    """
    Crea una entrada de inventario IPTV (servicio completo).

    Si envías ``vendor_id`` y ``inventory_asset_account_id``, en la misma transacción se crea
    una factura de proveedor por el total de la recarga y el asiento Débito inventario / Crédito CxP.
    """
    if payload.product_id is not None:
        pn = _provider_from_product_or_raise(
            db,
            product_id=int(payload.product_id),
            expected_kind="credito_normal",
        )
        payload = payload.model_copy(update={"provider": pn})

    if payload.service_type == "full":
        short_id = str(uuid.uuid4())[:8]
        panel_code = f"{payload.provider}:full:{short_id}"
        username = None
    else:
        panel_code = f"{payload.provider}:{payload.username}"
        username = payload.username

    total_cost = payload.total_cost
    if total_cost is None and payload.credits_spent and payload.cost_per_credit:
        total_cost = round(payload.credits_spent * payload.cost_per_credit, 4)

    account = IPTVAccount(
        provider_name=payload.provider,
        panel_account_code=panel_code,
        username=username,
        password=payload.password,
        expiration_date=payload.expiration_date,
        service_type=payload.service_type,
        credits_spent=payload.credits_spent,
        cost_per_credit=payload.cost_per_credit,
        total_cost=total_cost,
        recharge_date=payload.recharge_date,
        product_id=(int(payload.product_id) if payload.product_id is not None else None),
    )
    db.add(account)

    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Ya existe una cuenta '{panel_code}' en el sistema.",
        )

    if payload.service_type == "screens":
        for screen_number in range(1, SCREENS_PER_ACCOUNT + 1):
            db.add(
                IPTVScreen(
                    iptv_account_id=account.id,
                    screen_number=screen_number,
                    is_available=True,
                ),
            )

    try:
        if payload.service_type == "full" and payload.vendor_id is not None:
            total_q = Decimal(str(total_cost or 0)).quantize(Decimal("0.0001"))
            if total_q <= 0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="El total a pagar debe ser mayor que cero para generar la factura de proveedor.",
                )
            _attach_vendor_bill_for_full_recharge(db, payload=payload, total_cost_q=total_q)
        if payload.service_type == "full" and payload.product_id is not None:
            from app.services.catalog_inventory import apply_full_recharge_to_product

            apply_full_recharge_to_product(
                db,
                int(payload.product_id),
                float(payload.credits_spent or 0),
            )
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No se pudo registrar la factura de proveedor (datos duplicados o inválidos).",
        )

    db.refresh(account)
    return _build_response(account)


@router.get("/providers/", response_model=list[str])
def list_inventory_providers(db: DbDep, _: UserDep) -> list[str]:
    """Nombres de proveedor registrados en cuentas IPTV y bodega por pantalla."""
    acc = [r[0] for r in db.query(IPTVAccount.provider_name).distinct().all()]
    stk = [r[0] for r in db.query(ScreenStock.provider).distinct().all()]
    names: set[str] = set()
    for x in acc + stk:
        if x and isinstance(x, str):
            s = x.strip()
            if s:
                names.add(s)
    return sorted(names, key=lambda s: s.lower())


@router.get("/accounts/", response_model=list[AccountResponse])
def list_accounts(
    db: DbDep,
    _: UserDep,
    service_type: Optional[Literal["full", "screens"]] = Query(default=None),
) -> list[AccountResponse]:
    """Devuelve cuentas máster. Filtra opcionalmente por service_type."""
    q = db.query(IPTVAccount).options(joinedload(IPTVAccount.catalog_product))
    if service_type:
        q = q.filter(IPTVAccount.service_type == service_type)
    return [_build_response(acc) for acc in q.all()]


@router.patch("/accounts/{account_id}", response_model=AccountResponse)
def update_account(
    account_id: int,
    payload: dict,
    db: DbDep,
    _: AdminDep,
) -> AccountResponse:
    """Actualiza campos de una cuenta de servicio completo."""
    acc = db.get(IPTVAccount, account_id)
    if not acc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta no encontrada.")
    EDITABLE = {"provider_name", "credits_spent", "cost_per_credit", "recharge_date", "expiration_date"}
    for k, v in payload.items():
        if k in EDITABLE:
            setattr(acc, k, v)
    # Recalculate total_cost if both inputs are available
    if acc.credits_spent and acc.cost_per_credit:
        acc.total_cost = round(acc.credits_spent * acc.cost_per_credit, 4)
    db.commit()
    db.refresh(acc)
    return _build_response(acc)


@router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_account(account_id: int, db: DbDep, _: AdminDep) -> None:
    """Elimina una cuenta de inventario y sus pantallas asociadas."""
    acc = db.get(IPTVAccount, account_id)
    if not acc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta no encontrada.")
    db.delete(acc)
    db.commit()


# ── helpers ───────────────────────────────────────────────────────────────────

def _build_response(account: IPTVAccount) -> AccountResponse:
    screens = account.screens
    prod = getattr(account, "catalog_product", None)
    pname, pcolor = _product_public_fields(prod)
    return AccountResponse(
        id=account.id,
        provider_name=account.provider_name,
        service_type=account.service_type,
        product_id=getattr(account, "product_id", None),
        product_name=pname,
        product_color=pcolor,
        username=account.username,
        expiration_date=account.expiration_date,
        credits_spent=account.credits_spent,
        cost_per_credit=account.cost_per_credit,
        total_cost=account.total_cost,
        recharge_date=account.recharge_date,
        total_screens=len(screens),
        available_screens=sum(1 for s in screens if s.is_available),
        screens=[
            ScreenSummary(
                id=s.id,
                screen_number=s.screen_number,
                is_available=s.is_available,
            )
            for s in sorted(screens, key=lambda s: s.screen_number)
        ],
    )


# ── Inventory stats ───────────────────────────────────────────────────────────

@router.get("/stats", response_model=InventoryStatsResponse)
def get_inventory_stats(db: DbDep, _: UserDep) -> InventoryStatsResponse:
    """
    Métricas por proveedor: créditos comprados vs vendidos (Recarga total),
    pantallas en bodega, costo invertido.
    """
    import datetime

    today = datetime.date.today()
    month_start = datetime.date(today.year, today.month, 1)

    base: set[str] = set()
    for row in db.query(IPTVAccount.provider_name).distinct().all():
        if row[0] and str(row[0]).strip():
            base.add(str(row[0]).strip())
    for row in db.query(Product.iptv_provider).filter(Product.is_active.is_(True)).distinct().all():
        if row[0] and str(row[0]).strip():
            base.add(str(row[0]).strip())
    for row in db.query(ScreenStock.provider).distinct().all():
        if row[0] and str(row[0]).strip():
            base.add(str(row[0]).strip())

    provider_names = sorted(base, key=lambda s: s.lower())
    provider_map: dict[str, ProviderStats] = {}

    for prov in provider_names:
        want = _norm_prov_key(prov)
        full_accounts = (
            db.query(IPTVAccount)
            .filter(
                IPTVAccount.service_type == "full",
                func.lower(func.trim(IPTVAccount.provider_name)) == want,
            )
            .all()
        )
        total_pool = sum(float(a.credits_spent or 0.0) for a in full_accounts)
        monthly_credits = sum(
            float(a.credits_spent or 0.0)
            for a in full_accounts
            if a.recharge_date and a.recharge_date >= month_start
        )
        total_cost_full = sum(float(a.total_cost or 0.0) for a in full_accounts)

        sold_credits = _sold_credits_for_provider(db, prov)
        ledger_consumed = _ledger_packages_consumed(db, prov)

        screen_rows = (
            db.query(ScreenStock)
            .filter(func.lower(func.trim(func.coalesce(ScreenStock.provider, ""))) == want)
            .all()
        )
        screens_free = sum(1 for s in screen_rows if s.status == "free")
        screens_assigned = sum(1 for s in screen_rows if s.status == "assigned")
        cost_screens = sum(float(s.cost_per_package or 0.0) for s in screen_rows)

        pending_pool_res = float(_pending_full_credits_for_provider_pool(db, want))
        available_credits = round(
            max(0.0, total_pool - sold_credits - ledger_consumed - pending_pool_res),
            4,
        )

        provider_map[prov] = ProviderStats(
            total_recharged_month=round(monthly_credits, 2),
            total_available=available_credits,
            total_consumed=round(sold_credits + ledger_consumed, 2),
            total_cost=round(total_cost_full + cost_screens, 2),
            screens_free=screens_free,
            screens_assigned=screens_assigned,
        )

    global_cost = sum(float(v.total_cost) for v in provider_map.values())
    return InventoryStatsResponse(
        providers=provider_map,
        global_total_cost=round(global_cost, 2),
    )


# ── ScreenStock — Bodega por Pantallas ───────────────────────────────────────

@router.post(
    "/screens/",
    response_model=list[ScreenStockResponse],
    status_code=status.HTTP_201_CREATED,
)
def create_screen_stock(payload: ScreenStockBulkCreate, db: DbDep, _: AdminDep):
    """
    Crea pantallas en bodega desde múltiples líneas de compra (carrito).

    Por cada línea: si viene ``product_id``, sincroniza ``product_package_catalog``
    (paquete existente vía ``package_catalog_id`` o INSERT por nombre para manual / nuevo).
    ``listing_price_usd`` en inserción usa el costo de la línea o ``0``. Luego, por cada unidad
    de ``quantity`` se crea **un lote** (UUID) con ``batch_size == screens_count``.

    Credenciales: lista opcional ``credentials`` por línea (uno por cada unidad de cantidad).
    Índice ``i`` aplica al lote ``i``; valores vacíos se guardan como nulos en ``screen_stock``.
    Compatibilidad: si no hay ``credentials`` pero sí ``iptv_username`` / ``iptv_password``, se
    aplican a todos los lotes de esa línea.

    Descuenta la cantidad total de paquetes del pool Recarga Total del proveedor.
    Todo en una única transacción.
    """
    if payload.product_id is not None:
        pn = _provider_from_product_or_raise(
            db,
            product_id=int(payload.product_id),
            expected_kind="credito_pantalla",
        )
        payload = payload.model_copy(update={"provider": pn})

    prov = payload.provider.strip()

    try:
        packages_needed = float(sum(line.quantity for line in payload.lines))
        total_pool = _full_credit_pool_for_provider(db, prov)
        sold_credits = _sold_credits_for_provider(db, prov)
        ledger_existing = _ledger_packages_consumed(db, prov)
    except Exception as e:
        logger.exception(
            "create_screen_stock: error consultando pool Recarga Total / ledger (%s)", prov
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                f"No se pudo consultar el saldo de créditos para «{prov}». "
                f"¿Existe la tabla de despiece en la BD? Detalle: {e!s}"
            ),
        ) from e

    available = round(max(0.0, total_pool - sold_credits - ledger_existing), 4)

    if packages_needed > available + 1e-6:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Créditos insuficientes para {prov}: se requieren {packages_needed:g} paquete(s) "
                f"del pool Recarga Total y solo hay {available:g} disponible(s). "
                f"(Cargados en recargas «full»: {total_pool:g}; "
                f"consumidos por ventas aprobadas: {sold_credits:g}; "
                f"ya despiezados en bodega por pantallas: {ledger_existing:g})."
            ),
        )

    all_items: list[ScreenStock] = []
    try:
        pid_opt = int(payload.product_id) if payload.product_id is not None else None
        for line in payload.lines:
            pkg = (line.package or "").strip()
            n_pkg = int(line.quantity)
            screens_per = int(line.screens_count)
            if pid_opt is not None:
                try:
                    _sync_product_package_catalog_for_screen_line(
                        db,
                        product_id=pid_opt,
                        line=line,
                    )
                except ValueError as ve:
                    db.rollback()
                    raise HTTPException(
                        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                        detail=str(ve),
                    ) from ve
            for pkg_i in range(n_pkg):
                batch = str(uuid.uuid4())
                db.add(
                    InventoryScreenCreditDrawdown(
                        provider=prov,
                        credits_units=1.0,
                        batch_id=batch,
                    )
                )
                cred_seq = list(line.credentials) if line.credentials else []
                legacy_u = line.iptv_username
                legacy_p = line.iptv_password
                u_set: Optional[str] = None
                p_set: Optional[str] = None
                if pkg_i < len(cred_seq):
                    ci = cred_seq[pkg_i]
                    u_set = ci.username if ci.username else None
                    p_set = ci.password if ci.password else None
                elif legacy_u or legacy_p:
                    u_set = legacy_u if legacy_u else None
                    p_set = legacy_p if legacy_p else None
                for _ in range(screens_per):
                    item = ScreenStock(
                        provider=prov,
                        package=pkg,
                        expiration_date=payload.expiration_date,
                        cost_per_package=line.cost_per_package,
                        status="free",
                        batch_id=batch,
                        batch_size=screens_per,
                        iptv_username=u_set,
                        iptv_password=p_set,
                        product_id=pid_opt,
                    )
                    db.add(item)
                    all_items.append(item)
        db.commit()
    except IntegrityError as e:
        db.rollback()
        logger.warning("create_screen_stock IntegrityError: %s", e)
        orig = getattr(e, "orig", None)
        hint = str(orig) if orig is not None else str(e)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Conflicto de integridad al guardar la bodega; no se aplicaron cambios. {hint}",
        ) from e
    except Exception as e:
        db.rollback()
        logger.exception("create_screen_stock: error al persistir lotes")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"No se pudo registrar la bodega; los créditos no se descontaron. Detalle: {e!s}",
        ) from e

    for item in all_items:
        db.refresh(item)
    return [_screen_stock_to_response(r) for r in all_items]


@router.get("/screens/", response_model=list[ScreenStockResponse])
def list_screen_stock(
    db: DbDep,
    _: UserDep,
    screen_status: Optional[Literal["free", "reserved", "assigned"]] = Query(default=None, alias="status"),
    provider: Optional[str] = Query(default=None, max_length=64),
    package: Optional[str] = Query(default=None, max_length=120),
    product_id: Optional[int] = Query(default=None, ge=1),
) -> list[ScreenStockResponse]:
    """Pantallas en bodega; filtros opcionales por estado, proveedor, paquete y producto catálogo."""
    q = db.query(ScreenStock).options(
        joinedload(ScreenStock.sale).joinedload(Sale.client),
        joinedload(ScreenStock.assigned_client),
        joinedload(ScreenStock.catalog_product),
    )
    if screen_status == "reserved":
        q = q.filter(ScreenStock.status.in_(("reserved", "held")))
    elif screen_status:
        q = q.filter(ScreenStock.status == screen_status)
    if provider and provider.strip():
        pv = _norm_prov_key(provider)
        q = q.filter(func.lower(func.trim(func.coalesce(ScreenStock.provider, ""))) == pv)
    if product_id is not None:
        q = q.filter(ScreenStock.product_id == int(product_id))
    if package and package.strip():
        pk = package.strip().lower()
        q = q.filter(func.lower(func.trim(func.coalesce(ScreenStock.package, ""))) == pk)
    if screen_status == "free":
        q = q.order_by(ScreenStock.created_at.asc(), ScreenStock.id.asc())
    else:
        q = q.order_by(ScreenStock.created_at.desc(), ScreenStock.id.desc())
    raw_rows = q.all()
    return [_screen_stock_to_response(r) for r in raw_rows]


@router.patch("/screens/{screen_id}", response_model=ScreenStockResponse)
def update_screen_stock(
    screen_id: int,
    payload: dict,
    db: DbDep,
    _: AdminDep,
) -> ScreenStockResponse:
    """Actualiza campos de una pantalla (ej. status, expiration_date, cost_per_package, credenciales)."""
    item = db.get(ScreenStock, screen_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pantalla no encontrada.")
    EDITABLE = {"status", "expiration_date", "cost_per_package", "iptv_username", "iptv_password"}
    for k, v in payload.items():
        if k not in EDITABLE:
            continue
        if k in ("iptv_username", "iptv_password"):
            if v is None or (isinstance(v, str) and not str(v).strip()):
                setattr(item, k, None)
            else:
                setattr(item, k, str(v).strip())
        else:
            setattr(item, k, v)
    db.commit()
    db.refresh(item)
    return _screen_stock_to_response(item)


@router.delete("/catalog-packages", status_code=status.HTTP_204_NO_CONTENT)
def validate_catalog_package_removable(
    db: DbDep,
    _: AdminDep,
    provider: str = Query(..., min_length=1, max_length=80),
    package: str = Query(..., min_length=1, max_length=120),
) -> None:
    """
    No persiste cambios.

    Confirma que la UI puede eliminar una etiqueta de paquete del catálogo local (p. ej. localStorage).
    Responde 400 si existe stock en bodega con ese paquete en estado ``reserved`` o ``assigned``.
    """
    if _count_active_screenstock_for_package_catalog(
        db, provider=provider, package_label=package
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_PACKAGE_REMOVE_BLOCKED_DETAIL,
        )


@router.delete("/screens/{screen_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_screen_stock(screen_id: int, db: DbDep, _: AdminDep) -> None:
    """Elimina una pantalla individual de la bodega (solo si está disponible)."""
    item = db.get(ScreenStock, screen_id)
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pantalla no encontrada.")
    if item.status in ("reserved", "held", "assigned"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=_SCREEN_DELETE_BLOCKED_DETAIL,
        )
    db.delete(item)
    db.commit()
