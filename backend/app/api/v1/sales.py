from __future__ import annotations

import json
import logging
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Any, Literal, Optional
from urllib.parse import quote as url_quote, unquote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, nullslast
from sqlalchemy.orm import Session, joinedload
from starlette.datastructures import UploadFile

from app.api.v1.dependencies import require_permission
from app.permissions import SALES_INVOICES_EDIT, SALES_INVOICES_VIEW
from app.currency_utils import normalize_currency_code
from app.database import get_db
from app.models.account import Account
from app.models.client import Client
from app.models.client_payment import ClientPayment, ClientPaymentStatus, PaymentAllocation
from app.models.iptv_account import IPTVAccount
from app.models.iptv_screen import IPTVScreen
from app.models.payment_method import PaymentMethod
from app.models.product import Product, ProductPackageCatalog
from app.models.user import User, UserRole
from app.account_constants import is_liquid_deposit_account
from app.api.v1.inventory import (
    _available_full_credits_for_catalog_product,
    _available_full_credits_for_provider,
    _full_credit_pool_for_provider,
    _norm_prov_key,
    _screen_stock_fifo_ordered_query,
)
from app.models.inventory_screen_credit_drawdown import InventoryScreenCreditDrawdown
from app.models.screen_stock import ScreenStock
from app.models.sale import Sale, SaleStatus
from app.models.sale_transaction_tag import SaleTransactionTag
from app.models.transaction_class import TransactionClass
from app.schemas.portal_public import PortalInstantActivationResponse
from app.schemas.sales import (
    LinkedPaymentOut,
    PendingReviewPaymentOut,
    PendingBankPaymentBrief,
    PublicSaleReport,
    SaleCreate,
    SaleExtendTimerBody,
    SaleInvoiceLineItem,
    SaleOperationLine,
    SalePortalPaymentConsolidated,
    SaleResponse,
    SaleStatusPut,
    SaleWebCreditsSyncResponse,
    ScreenStockSaleCredential,
    SaleUpdate,
    ScreenCredential,
    WebhookSimulatePayload,
    WebhookSimulateResponse,
)
from app.services.client_payment_service import (
    approve_pending_linked_client_payments_for_sale,
    is_client_payment_credit_only,
    linked_payments_for_sale,
    parse_notes_meta_sale_id,
    portal_deposit_review_notes,
    void_sale_accounting_state,
)
from app.services.sale_accounting_sync import (
    commit_db_or_rollback,
    is_baas_wallet_auto_purchase_sale,
    sync_sale_accounting_ledgers,
)
from app.services.catalog_vip_sync import notify_catalog_vip_sale_pending_payment
from app.services.sale_web_credit_sync import sync_web_credit_sales_from_vip_catalog
from app.services.currency_consolidation import get_last_exchange_rate
from app.timezone_utils import ensure_aware, now_ecuador

router = APIRouter(prefix="/sales", tags=["sales"])


def _commit_db_or_rollback(db: Session) -> None:
    commit_db_or_rollback(db)


def _portal_pending_deposit_payments_for_sale(db: Session, sale: Sale) -> list[ClientPayment]:
    """
    Pagos pendientes de revisión ligados explícitamente a esta venta (``META_SALE_ID`` en notas).

    Incluye depósitos del portal con `portal_general_abono` siempre que declaren ``META_SALE_ID``
    coincidente con esta venta (el allocation pendiente asocia el comprobante a la factura).

    Filtra por cliente + META_SALE_ID + marca de depósito portal / recibo (compatibilidad legada).
    """
    sid_int = int(sale.id)
    pend_candidates = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == int(sale.client_id),
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
        .order_by(ClientPayment.created_at.desc())
        .all()
    )
    out: list[ClientPayment] = []
    for pdep in pend_candidates:
        if parse_notes_meta_sale_id(pdep.notes) != sid_int:
            continue
        flag_dep = portal_deposit_review_notes(pdep.notes)
        has_rcpt = bool(str(pdep.receipt_file_url or "").strip())
        if not flag_dep and not has_rcpt:
            continue
        pm_low = (pdep.payment_method or "").strip().lower()
        if pm_low == "saldo a favor" or "PARTE_SALDO_FAVOR=" in str(pdep.notes or ""):
            continue
        try:
            amt_dec = Decimal(str(pdep.amount or 0)).quantize(Decimal("0.01"))
        except Exception:
            amt_dec = Decimal("0")
        if amt_dec <= Decimal("0.005") and not has_rcpt:
            continue
        out.append(pdep)
    return out

logger = logging.getLogger(__name__)

DbDep = Annotated[Session, Depends(get_db)]
SalesInvoicesViewDep = Annotated[dict, Depends(require_permission(SALES_INVOICES_VIEW))]
SalesInvoicesEditDep = Annotated[dict, Depends(require_permission(SALES_INVOICES_EDIT))]


class LastExchangeRateResponse(BaseModel):
    currency: str
    exchange_rate: float = Field(..., gt=0, description="Unidades de moneda local por 1 USD.")


@router.get("/last-exchange-rate", response_model=LastExchangeRateResponse)
def sales_last_exchange_rate(
    db: DbDep,
    _: SalesInvoicesViewDep,
    currency: str = Query(..., min_length=3, max_length=10, description="Código de moneda (ej. BOB)."),
) -> LastExchangeRateResponse:
    """Último tipo de cambio registrado para la moneda (venta, pago o recarga BaaS); 1.0 si no hay historial."""
    cur = normalize_currency_code(currency)
    rate, _ = get_last_exchange_rate(db, cur)
    xr = float(rate) if rate and float(rate) > 0 else 1.0
    return LastExchangeRateResponse(currency=cur, exchange_rate=xr)


# --- Inventario ERP (ventas ``pending`` → ``approved``) -----------------------------------------
#
# Créditos normales (catálogo ``credito_normal``):
#   - Saldo vendible = carga IPTV − ventas aprobadas − ``Product.inventory_credit_reserved_qty``
#     (ver ``inventory._effective_available_full_credits_for_catalog_product``).
#   - Al crear ``pending``: ``inventory_credit_reserved_qty += cantidad`` (la disponibilidad
#     efectiva baja en la misma medida; no hay columna separada ``available_qty``).
#   - Al activar: ``reserved_qty -= cantidad``, ``inventory_credit_assigned_qty += cantidad``.
#
# Pantallas bodega (``ScreenStock``):
#   - Disponible = ``status == free`` (equivalente semántico a "available" en bodega).
#   - Al crear ``pending``: FIFO por ``product_id``, pasa a ``reserved``, ``sale_id``, ``client_id``;
#     credenciales van a ``invoice_lines`` para el ticket.
#   - Al activar: solo confirma filas ya con este ``sale_id`` en ``reserved``/``held`` → ``assigned``
#     (sin nuevo query FIFO).

SCREEN_STOCK_STATUS_FREE = "free"
SCREEN_STOCK_STATUS_RESERVED = "reserved"
SCREEN_STOCK_STATUS_ASSIGNED = "assigned"
# Estados legacy / compat: algunas filas pueden usar ``held`` como sinónimo de reservado.
SCREEN_STOCK_ACTIVATION_FROM_STATUSES: tuple[str, ...] = ("reserved", "held")

# Inventario / CRM: estos estados se comportan como preventa hasta activación staff.
SALE_HOLD_INVENTORY_STATUSES: tuple[SaleStatus, ...] = (
    SaleStatus.pending,
    SaleStatus.payment_submitted,
    SaleStatus.partially_paid,
)


def _verify_screen_stock_rows_eligible_for_pending_reserve(db: Session, rows: list[ScreenStock]) -> None:
    """
    Antes de pasar una fila a ``reserved``, comprueba que sigue ``free`` y sin ``sale_id``
    (evita estado obsoleto en sesión o condiciones de carrera entre peek y commit).
    """
    if not rows:
        return
    for r in rows:
        db.refresh(r)
        st = (r.status or "").strip().lower()
        if st != SCREEN_STOCK_STATUS_FREE:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Pantalla id {r.id} no está disponible en bodega (estado {r.status!r}). "
                    "Actualiza inventario o elige otro producto y vuelve a intentar."
                ),
            )
        if r.sale_id is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Pantalla id {r.id} ya está vinculada a otra venta.",
            )


def _maybe_with_for_update(query: Any, db: Session) -> Any:
    """``FOR UPDATE SKIP LOCKED`` solo en PostgreSQL; otros dialectos (p. ej. SQLite) fallan o no lo soportan."""
    bind = db.get_bind()
    if bind is not None and getattr(bind.dialect, "name", None) == "postgresql":
        return query.with_for_update(skip_locked=True)
    return query

UPLOAD_DIR = Path("uploads")
RECEIPT_MAX_BYTES = 20 * 1024 * 1024
RECEIPT_ALLOWED_CT = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
}


def _coerce_tag_ids_raw(raw: Any) -> list[int]:
    """Multipart/form: ``tag_ids`` como JSON ``[1,2]`` o valores separados por coma."""
    if raw is None or raw == "":
        return []
    if isinstance(raw, list):
        out: list[int] = []
        for item in raw:
            if item is None or item == "":
                continue
            out.append(int(str(item).strip()))
        return sorted(set(out))
    s = str(raw).strip()
    if not s:
        return []
    if s.startswith("["):
        arr = json.loads(s)
        return sorted({int(x) for x in arr})
    parts = [p.strip() for p in s.split(",") if p.strip()]
    return sorted({int(p) for p in parts})


def _sync_sale_tags(db: Session, sale: Sale, tag_ids: list[int]) -> None:
    ids = sorted(set(int(x) for x in tag_ids))
    if not ids:
        sale.tags = []
        return
    rows = db.query(SaleTransactionTag).filter(SaleTransactionTag.id.in_(ids)).all()
    found = {r.id for r in rows}
    if found != set(ids):
        missing = sorted(set(ids) - found)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Etiquetas no válidas (ids): {missing}",
        )
    sale.tags = rows


def _credentials_tail_from_invoice_lines(raw: Optional[list[Any]]) -> tuple[Optional[str], Optional[str]]:
    """Último usuario/contraseña no vacíos recorriendo las líneas en orden."""
    if not isinstance(raw, list):
        return None, None
    lu: Optional[str] = None
    lp: Optional[str] = None
    for x in raw[:100]:
        try:
            row = SaleInvoiceLineItem.model_validate(x)
        except Exception:
            continue
        if row.iptv_username:
            lu = row.iptv_username
        if row.iptv_password:
            lp = row.iptv_password
    return lu, lp


def _sale_allows_normal_credit_client_snapshot(db: Session, sale: Sale) -> bool:
    """Persistir memoria IPTV solo en recargas full_credits que no correspondan a producto «solo pantalla»."""
    if _effective_inventory_channel(sale) not in ("full_credits", "mixed"):
        return False
    pid = sale.product_id
    if pid is None:
        return True
    prod = db.get(Product, int(pid))
    if prod is None:
        return True
    pt = (getattr(prod, "product_type", None) or "").strip().lower()
    return pt != "credito_pantalla"


def _sync_client_last_iptv_from_full_credit_sale(db: Session, client: Client, sale: Sale) -> None:
    """Actualiza ``Client.last_iptv_*`` desde líneas de factura (venta pendiente o activada, crédito normal)."""
    if not _sale_allows_normal_credit_client_snapshot(db, sale):
        return
    u, p = _credentials_tail_from_invoice_lines(getattr(sale, "invoice_lines", None))
    touched = False
    if u and u.strip():
        client.last_iptv_username = u.strip()[:120]
        touched = True
    if p and p.strip():
        client.last_iptv_password = p.strip()[:255]
        touched = True
    if touched:
        db.add(client)


def _synthetic_operation_lines_from_invoice_lines(inv: Any) -> Optional[list[dict[str, Any]]]:
    """
    Si el cliente envía ``invoice_lines`` con ``inventory_option_key`` pero olvida ``lines``,
    reconstruye líneas operativas mínimas para el agregador (cn:/fc:/cp|/ss:).
    """
    if not isinstance(inv, list) or len(inv) == 0:
        return None
    out: list[dict[str, Any]] = []
    for x in inv:
        if not isinstance(x, dict):
            continue
        key = str(x.get("inventory_option_key") or "").strip()
        if not key:
            continue
        try:
            qf = float(x.get("qty"))
            rf = float(x.get("rate"))
        except (TypeError, ValueError):
            continue
        if qf <= 0 or rf < 0:
            continue
        row: dict[str, Any] = {
            "inventory_option_key": key,
            "qty": qf,
            "rate": rf,
        }
        desc = x.get("description")
        if isinstance(desc, str) and desc.strip():
            row["description"] = desc.strip()
        tc = x.get("transaction_class_id")
        if tc is None:
            tc = x.get("clase_id")
        if tc is not None:
            try:
                tc_i = int(tc)
                if tc_i >= 1:
                    row["clase_id"] = tc_i
            except (TypeError, ValueError):
                pass
        u = x.get("iptv_username") if x.get("iptv_username") is not None else x.get("iptv_usuario")
        p = x.get("iptv_password")
        if isinstance(u, str) and u.strip():
            row["iptv_username"] = u.strip()
        if isinstance(p, str) and p.strip():
            row["iptv_password"] = p.strip()
        out.append(row)
    return out if out else None


def _invoice_line_dict_is_screen_stock_row(d: dict[str, Any]) -> bool:
    lk = str(d.get("line_inventory_kind") or "").strip().lower()
    if lk == "screen_stock":
        return True
    k = str(d.get("inventory_option_key") or "").strip()
    return k.startswith("cp|") or k.startswith("ss:")


def _merge_reserved_screen_credentials_into_invoice_lines(
    inv: Optional[list[Any]],
    picked: list[ScreenStock],
) -> Optional[list[Any]]:
    """Copia credenciales de filas FIFO/reservadas al detalle JSON (preventa / recibo)."""
    if not isinstance(inv, list) or not picked:
        return inv
    pi = 0
    out: list[Any] = []
    for raw in inv:
        if not isinstance(raw, dict):
            out.append(raw)
            continue
        d = dict(raw)
        if not _invoice_line_dict_is_screen_stock_row(d):
            out.append(d)
            continue
        qty_raw = d.get("qty")
        try:
            fq = float(qty_raw) if qty_raw is not None else 1.0
        except (TypeError, ValueError):
            fq = 1.0
        n_take = max(1, min(200, int(round(fq))))
        us: list[str] = []
        ps: list[str] = []
        for _ in range(n_take):
            if pi >= len(picked):
                break
            row = picked[pi]
            pi += 1
            u_s = (row.iptv_username or "").strip()
            p_s = (row.iptv_password or "").strip()
            if u_s:
                us.append(u_s)
            if p_s:
                ps.append(p_s)
        if us:
            d["iptv_username"] = " · ".join(us)
        if ps:
            d["iptv_password"] = " · ".join(ps)
        out.append(d)
    return out


def _invoice_lines_prepare_for_storage(
    raw: Optional[list[Any]],
    *,
    inventory_channel: Optional[str],
) -> Optional[list[Any]]:
    """Quita iptv_* de líneas marcadas desde bodega (`line_inventory_kind=screen_stock`)."""
    ch = (inventory_channel or "").strip().lower()
    if not isinstance(raw, list):
        return raw
    out: list[Any] = []
    for x in raw:
        if not isinstance(x, dict):
            out.append(x)
            continue
        d = dict(x)
        lk = str(d.get("line_inventory_kind") or "").strip()
        strip = False
        if ch == "screen_stock":
            strip = True
        elif ch == "mixed" and lk == "screen_stock":
            strip = True
        if strip:
            d.pop("iptv_username", None)
            d.pop("iptv_password", None)
        out.append(d)
    return out


def _invoice_lines_strip_iptv_credentials(raw: Optional[list[Any]]) -> Optional[list[Any]]:
    """Compatibilidad — ventas sólo pantalla (strip en todas las líneas)."""
    return _invoice_lines_prepare_for_storage(raw, inventory_channel="screen_stock")


def _fifo_screen_stock_rows_bound_to_sale(db: Session, sale: Sale) -> list[ScreenStock]:
    """Filas de bodega de esta venta en orden FIFO (``created_at``, ``id``)."""
    rows = (
        db.query(ScreenStock)
        .filter(ScreenStock.sale_id == sale.id)
        .order_by(ScreenStock.created_at.asc(), ScreenStock.id.asc())
        .all()
    )
    if rows:
        return rows
    if sale.screen_stock_id:
        one = db.get(ScreenStock, sale.screen_stock_id)
        return [one] if one is not None else []
    return []


def _fifo_cp_inventory_option_key_for_ui(db: Session, sale: Sale) -> Optional[str]:
    """
    Reconstruye ``cp|{product}|{pkg}|{prov}`` a partir del primer vínculo bodega
    (fallback UI cuando falta ``inventory_option_key`` histórico en JSON).
    """
    if db is None:
        return None
    rows = _fifo_screen_stock_rows_bound_to_sale(db, sale)
    row0 = rows[0] if rows else None
    if row0 is None:
        return None
    pid = getattr(row0, "product_id", None)
    if pid is None or int(pid) < 1:
        return None
    pkg = (getattr(row0, "package", None) or sale.inventory_package or "").strip()
    prov = (getattr(row0, "provider", None) or "").strip()
    if not pkg or not prov:
        return None
    return f"cp|{int(pid)}|{url_quote(pkg, safe='')}|{url_quote(prov, safe='')}"


def _screen_stock_delivery_credentials(db: Session, sale: Sale) -> list[ScreenStockSaleCredential]:
    if _effective_inventory_channel(sale) not in ("screen_stock", "mixed"):
        return []
    out: list[ScreenStockSaleCredential] = []
    for row in _fifo_screen_stock_rows_bound_to_sale(db, sale):
        out.append(
            ScreenStockSaleCredential(
                screen_stock_id=int(row.id),
                iptv_username=(row.iptv_username or "").strip() or None,
                iptv_password=(row.iptv_password or "").strip() or None,
            )
        )
    return out


def _sale_invoice_lines_for_display(db: Optional[Session], sale: Sale) -> Optional[list[SaleInvoiceLineItem]]:
    raw = getattr(sale, "invoice_lines", None)
    if not isinstance(raw, list) or len(raw) == 0:
        return None
    try:
        parsed = [SaleInvoiceLineItem.model_validate(x) for x in raw[:100]]
    except Exception:
        return None
    if not parsed:
        return None
    eff = _effective_inventory_channel(sale)
    if db is None or eff not in ("screen_stock", "mixed"):
        return parsed
    stk_rows = _fifo_screen_stock_rows_bound_to_sale(db, sale)
    if not stk_rows:
        return parsed

    def _credential_merge_for_ln(ln: SaleInvoiceLineItem) -> SaleInvoiceLineItem:
        lk = ln.line_inventory_kind
        merge = eff == "screen_stock" or lk == "screen_stock"
        if not merge:
            return ln

        q_raw = ln.qty
        if q_raw is None:
            n_take = 1
        else:
            fq = float(q_raw)
            if fq <= 0:
                return ln
            n_take = max(1, min(200, int(round(fq))))
        nonlocal_idx = {"i": i_stk[0]}
        us: list[str] = []
        ps: list[str] = []
        for _ in range(n_take):
            if nonlocal_idx["i"] >= len(stk_rows):
                break
            sr = stk_rows[nonlocal_idx["i"]]
            nonlocal_idx["i"] += 1
            i_stk[0] = nonlocal_idx["i"]
            u_s = (sr.iptv_username or "").strip()
            p_s = (sr.iptv_password or "").strip()
            if u_s:
                us.append(u_s)
            if p_s:
                ps.append(p_s)
        joined_u = " · ".join(us) if us else None
        joined_p = " · ".join(ps) if ps else None
        return ln.model_copy(update={"iptv_username": joined_u, "iptv_password": joined_p})

    i_stk = [0]
    out: list[SaleInvoiceLineItem] = [_credential_merge_for_ln(ln) for ln in parsed]
    return out


_FP_EPS = 1e-9


def _approved_full_credit_sales_sum_for_catalog_product(db: Session, *, product_id: int) -> float:
    """Créditos ya consumidos del catálogo (activadas o con saldo pendiente)."""
    raw = (
        db.query(func.coalesce(func.sum(Sale.credits_quantity), 0.0))
        .filter(
            Sale.product_id == int(product_id),
            Sale.credits_quantity.isnot(None),
            Sale.status.in_((SaleStatus.approved, SaleStatus.partially_paid)),
        )
        .scalar()
    )
    return float(raw or 0.0)


def _fifo_full_credits_inventory_cost_usd(
    db: Session,
    *,
    provider: str,
    qty_need: float,
    catalog_product: Optional[Product],
) -> Optional[Decimal]:
    """
    PEPS sobre lotes IPTV ``service_type='full'``: consume capas ordenadas por
    ``recharge_date`` (los NULL al final), luego ``id``.
    El costo coincide con matemática de ejemplo (mezcla de cantidades × costos de lote).
    """
    if qty_need <= _FP_EPS:
        return None
    qty_take = Decimal(str(round(qty_need, 10)))
    q_base = db.query(IPTVAccount).filter(IPTVAccount.service_type == "full")
    if catalog_product is not None:
        q_base = q_base.filter(IPTVAccount.product_id == int(catalog_product.id))
        prior_consumed = _approved_full_credit_sales_sum_for_catalog_product(
            db, product_id=int(catalog_product.id)
        )
    else:
        want = _norm_prov_key(provider)
        q_base = q_base.filter(func.lower(func.trim(IPTVAccount.provider_name)) == want)
        pool = float(_full_credit_pool_for_provider(db, provider))
        avail = float(_available_full_credits_for_provider(db, provider))
        prior_consumed = max(0.0, pool - avail)

    lots = q_base.order_by(nullslast(IPTVAccount.recharge_date.asc()), IPTVAccount.id.asc()).all()
    consume_after_prior = prior_consumed
    total_cost = Decimal("0")
    qty_left = qty_take

    for acc in lots:
        cs = float(acc.credits_spent or 0.0)
        if cs <= _FP_EPS:
            continue
        cp = acc.cost_per_credit
        if cp is None or float(cp) <= _FP_EPS:
            return None

        if consume_after_prior >= cs - _FP_EPS:
            consume_after_prior -= cs
            continue

        usable = cs - consume_after_prior
        consume_after_prior = 0.0
        cpu = Decimal(str(cp))
        slice_u = Decimal(str(min(float(qty_left), usable)))

        total_cost += slice_u * cpu
        qty_left -= slice_u

        if qty_left <= Decimal(str(_FP_EPS)):
            total_cost_q = total_cost.quantize(Decimal("0.0001"))
            return total_cost_q if total_cost_q > 0 else None

    # Sin lotes o saldo teorético inconsistente → no aplicar chequeo margen
    return None


def _screen_stock_unit_cost_usd(
    stock_row: ScreenStock,
    *,
    db: Optional[Session] = None,
) -> Optional[Decimal]:
    """Costo unitario del paquete en bodega; si falta en la fila, usa catálogo de paquetes."""
    c = stock_row.cost_per_package
    if c is not None and float(c) > 0:
        return Decimal(str(c))
    if db is None:
        return None
    pid = stock_row.product_id
    pkg = (stock_row.package or "").strip().lower()
    if pid is not None and pkg:
        cat = (
            db.query(ProductPackageCatalog)
            .filter(
                ProductPackageCatalog.product_id == int(pid),
                func.lower(func.trim(ProductPackageCatalog.package_label)) == pkg,
            )
            .first()
        )
        if cat is not None and cat.reference_cost_usd is not None and float(cat.reference_cost_usd) > 0:
            return Decimal(str(cat.reference_cost_usd))
    return None


def _pick_free_screen_stock_for_pending_sale(
    db: Session,
    *,
    provider: str,
    package: str,
    qty: int,
    product_id: Optional[int] = None,
    batch_id: Optional[str] = None,
) -> list[ScreenStock]:
    """
    FIFO de bodega priorizando proveedor + paquete (costo unitario correcto).
    Solo si faltan proveedor/paquete usa FIFO estricto por ``product_id``.
    """
    prov = (provider or "").strip()
    pkg = (package or "").strip()
    if prov and pkg:
        return _fifo_pick_free_screen_stock_rows(
            db,
            prov,
            pkg,
            qty,
            batch_id=batch_id,
            catalog_product_id=product_id,
        )
    if product_id is not None and int(product_id) >= 1:
        return _pick_free_screen_stock_units_by_product_id_strict(
            db,
            product_id=int(product_id),
            qty=qty,
        )
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Proveedor y paquete de bodega obligatorios para asignar inventario.",
    )


def _full_credits_inventory_cost_usd(
    db: Session,
    provider: str,
    qty: float,
    *,
    catalog_product: Optional[Product] = None,
) -> Optional[Decimal]:
    return _fifo_full_credits_inventory_cost_usd(
        db, provider=provider, qty_need=qty, catalog_product=catalog_product
    )


def _validate_sale_amount_vs_inventory_cost(
    *,
    amount_usd: Decimal,
    inventory_cost_usd: Optional[Decimal],
) -> None:
    if inventory_cost_usd is None or inventory_cost_usd <= 0:
        return
    if amount_usd <= inventory_cost_usd:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El monto de venta no puede ser menor o igual al costo del inventario.",
        )


def _resolve_class_id(db: Session, class_id: Optional[int]) -> Optional[int]:
    if class_id is None:
        return None
    tc = db.get(TransactionClass, class_id)
    if tc is None or not tc.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Clase contable no válida o inactiva.",
        )
    return class_id


def _invoice_lines_json_and_primary_class(
    db: Session,
    lines: Optional[list[Any]],
) -> tuple[Optional[list[dict[str, Any]]], Optional[int]]:
    """Valida líneas de factura y devuelve JSON almacenable + primera clase válida."""
    if lines is None:
        return None, None
    if len(lines) == 0:
        return [], None
    out: list[dict[str, Any]] = []
    first_cls: Optional[int] = None
    for raw in lines[:100]:
        row = SaleInvoiceLineItem.model_validate(raw)
        d = row.model_dump(mode="json")
        iok = (row.inventory_option_key or "").strip()
        if iok:
            try:
                sp = _parse_inventory_option_key(iok)
                canon = _canonical_line_description_from_inventory_spec(db, sp)
                if canon:
                    d["description"] = canon
            except HTTPException:
                pass
        out.append(d)
        if first_cls is None and row.transaction_class_id is not None:
            first_cls = _resolve_class_id(db, row.transaction_class_id)
    return out, first_cls


def _resolve_payment_method_id(db: Session, payment_method_id: Optional[int]) -> Optional[int]:
    if payment_method_id is None:
        return None
    pm = db.get(PaymentMethod, payment_method_id)
    if pm is None or not pm.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Método de pago no válido o inactivo.",
        )
    return payment_method_id


def _resolve_deposit_account_id(db: Session, deposit_account_id: Optional[int]) -> Optional[int]:
    if deposit_account_id is None:
        return None
    acc = db.get(Account, deposit_account_id)
    if acc is None or not acc.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cuenta de depósito no válida o inactiva.",
        )
    if not is_liquid_deposit_account(acc):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cuenta de depósito debe ser de efectivo y equivalentes (p. ej. Banco).",
        )
    return deposit_account_id


def _normalize_allowed_payment_method_labels(db: Session, labels: Optional[list[Any]]) -> list[str]:
    if not labels:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in labels[:40]:
        if raw is None:
            continue
        s = str(raw).strip()
        if not s:
            continue
        pm = (
            db.query(PaymentMethod)
            .filter(
                PaymentMethod.is_active.is_(True),
                func.lower(func.trim(PaymentMethod.name)) == s.lower(),
            )
            .first()
        )
        if pm is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Método de pago no reconocido o inactivo: {s!r}.",
            )
        name = (pm.name or "").strip()
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def _normalize_allowed_deposit_account_ids(db: Session, ids: Optional[list[Any]]) -> list[int]:
    if not ids:
        return []
    out: list[int] = []
    seen: set[int] = set()
    for raw in ids[:40]:
        try:
            x = int(raw)
        except (TypeError, ValueError):
            continue
        if x < 1 or x in seen:
            continue
        _resolve_deposit_account_id(db, x)
        seen.add(x)
        out.append(x)
    return out


def _finalize_sale_payment_allowlists(
    db: Session,
    *,
    allowed_payment_methods: Optional[list[Any]],
    allowed_deposit_accounts: Optional[list[Any]],
    payment_method_id: Optional[int],
    deposit_account_id: Optional[int],
) -> tuple[list[str], list[int], Optional[int], Optional[int]]:
    apm = (
        _normalize_allowed_payment_method_labels(db, list(allowed_payment_methods))
        if allowed_payment_methods
        else []
    )
    ada = (
        _normalize_allowed_deposit_account_ids(db, list(allowed_deposit_accounts))
        if allowed_deposit_accounts
        else []
    )

    pm_fk: Optional[int] = payment_method_id
    dep_fk: Optional[int] = deposit_account_id

    if pm_fk is not None:
        prow = db.get(PaymentMethod, int(pm_fk))
        if prow is None or not bool(prow.is_active):
            pm_fk = None
        else:
            pn = (prow.name or "").strip()
            if pn and pn not in apm:
                apm.insert(0, pn)
    elif apm:
        m0 = (
            db.query(PaymentMethod)
            .filter(
                PaymentMethod.is_active.is_(True),
                func.lower(func.trim(PaymentMethod.name)) == str(apm[0]).strip().lower(),
            )
            .first()
        )
        pm_fk = int(m0.id) if m0 is not None else None

    if dep_fk is not None:
        dep_fk = _resolve_deposit_account_id(db, int(dep_fk))
        if int(dep_fk) not in ada:
            ada.insert(0, int(dep_fk))
    elif ada:
        dep_fk = _resolve_deposit_account_id(db, int(ada[0]))

    if pm_fk is None and apm:
        m1 = (
            db.query(PaymentMethod)
            .filter(
                PaymentMethod.is_active.is_(True),
                func.lower(func.trim(PaymentMethod.name)) == str(apm[0]).strip().lower(),
            )
            .first()
        )
        pm_fk = int(m1.id) if m1 is not None else None

    return apm, ada, pm_fk, dep_fk


def _sync_sale_allowlists_denormalized(db: Session, sale: Sale) -> None:
    pm_src = getattr(sale, "allowed_payment_methods", None)
    ada_src = getattr(sale, "allowed_deposit_accounts", None)
    ada_parsed: Optional[list[int]] = None
    if isinstance(ada_src, list):
        ada_parsed = []
        for x in ada_src:
            try:
                ada_parsed.append(int(x))
            except (TypeError, ValueError):
                continue
    apm, ada, pm_fk, dep_fk = _finalize_sale_payment_allowlists(
        db,
        allowed_payment_methods=list(pm_src) if isinstance(pm_src, list) else None,
        allowed_deposit_accounts=ada_parsed,
        payment_method_id=sale.payment_method_id,
        deposit_account_id=sale.deposit_account_id,
    )
    sale.allowed_payment_methods = apm or None
    sale.allowed_deposit_accounts = ada or None
    sale.payment_method_id = pm_fk
    sale.deposit_account_id = dep_fk


def _sale_allowlist_json_to_sequence(raw: Any) -> Optional[list[Any]]:
    """
    Normaliza valores JSON de ERP: ``None``, listas/tuplas, o texto JSON con lista.
    Objetos distintos de lista en DB (``{}``, número) ⇒ ``None``.
    """
    if raw is None:
        return None
    if isinstance(raw, (list, tuple)):
        return list(raw)
    if isinstance(raw, dict):
        return None
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return None
        try:
            decoded = json.loads(s)
        except json.JSONDecodeError:
            return None
        return list(decoded) if isinstance(decoded, list) else None
    return None


def _sale_response_allowlist_fields(sale: Sale, pm_label: Optional[str]) -> tuple[list[str], list[int]]:
    raw_apm = getattr(sale, "allowed_payment_methods", None)
    seq_apm = _sale_allowlist_json_to_sequence(raw_apm)
    apm_out: list[str] = []
    if seq_apm is not None:
        apm_out.extend(str(x).strip() for x in seq_apm if str(x).strip())
    pl = (pm_label or "").strip()
    if not apm_out and pl:
        apm_out.append(pl)
    raw_ada = getattr(sale, "allowed_deposit_accounts", None)
    seq_ada = _sale_allowlist_json_to_sequence(raw_ada)
    ada_out: list[int] = []
    if seq_ada is not None:
        for x in seq_ada:
            try:
                ada_out.append(int(x))
            except (TypeError, ValueError):
                continue
    if not ada_out and sale.deposit_account_id:
        ada_out.append(int(sale.deposit_account_id))
    return apm_out, ada_out


def _normalize_amount_paid(
    local_amount: Decimal,
    amount_paid: Optional[Any],
    *,
    force_zero: bool = False,
) -> Decimal:
    """
    Normaliza ``amount_paid`` respecto al total local.

    - ``force_zero=True``: ventas en estado *pending* al crearse — el cliente aún no ha
      pagado, por lo que el valor guardado siempre debe ser 0 independientemente de lo
      que venga en el payload.
    - Si ``amount_paid`` es ``None`` y no se fuerza cero, se devuelve ``Decimal("0")``
      (antes devolvía ``local_amount``, lo que marcaba la venta como cobrada en su
      totalidad al crearla en estado pendiente).
    """
    if force_zero:
        return Decimal("0")
    la = Decimal(str(local_amount))
    if amount_paid is None:
        return Decimal("0")
    ap = Decimal(str(amount_paid))
    if ap < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El importe pagado no puede ser negativo.",
        )
    if ap > la:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El importe pagado no puede superar el monto de cobro.",
        )
    return ap


def _assert_sale_deposit_currency(db: Session, sale: Sale) -> None:
    if sale.deposit_account_id is None:
        return
    acc = db.get(Account, sale.deposit_account_id)
    if acc is None:
        return
    sc = normalize_currency_code(sale.currency)
    ac = normalize_currency_code(acc.currency)
    if sc != ac:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La moneda de la venta y la cuenta bancaria deben coincidir.",
        )


def _sync_sale_accounting_after_panel_patch(
    db: Session,
    sale: Sale,
    *,
    strict: bool = True,
) -> None:
    """
    Devengo/COGS tras PATCH del panel.

    Ventas BaaS en revisión no requieren pasarela ni cuenta de depósito; el cobro BaaS
    ya descontó ``wallet_balance`` y el asiento de banco corresponde a otro flujo.
    """
    cogs_strict = strict
    if is_baas_wallet_auto_purchase_sale(sale) and sale.status in (
        SaleStatus.payment_submitted,
        SaleStatus.pending,
    ):
        cogs_strict = False
    sync_sale_accounting_ledgers(db, sale, strict=strict, strict_cogs=cogs_strict)


# ── CRM sync helper ───────────────────────────────────────────────────────────


def _sync_client_after_sale(client: Client, sale: Sale) -> None:
    """
    Actualiza el CRM del cliente cuando se activa una venta:
      - status  → 'Activo'
      - last_recharge → fecha de la venta
      - total_credits → acumula el monto USD de la venta (mínimo +1 si el monto es 0)
    """
    client.status = "Activo"
    client.last_recharge = sale.created_at
    increment = float(sale.amount) if float(sale.amount) > 0 else 1.0
    client.total_credits = (client.total_credits or 0.0) + increment


def _remaining_full_credits(db: Session, provider: str) -> float:
    """Saldo Recarga Total coherente con ``inventory._available_full_credits_for_provider``."""
    prov = (provider or "").strip()
    if not prov:
        return 0.0
    return float(_available_full_credits_for_provider(db, prov))


def _pending_full_credits_pooled_reserved_sum(
    db: Session,
    *,
    provider_norm: str,
    exclude_sale_id: Optional[int] = None,
) -> float:
    """Suma preventas pooled (sin ``product_id``) por proveedor — reduce saldo Recarga Total."""
    if not provider_norm:
        return 0.0
    q = db.query(func.coalesce(func.sum(Sale.credits_quantity), 0.0)).filter(
        Sale.status.in_((SaleStatus.pending, SaleStatus.payment_submitted)),
        Sale.inventory_channel.in_(("full_credits", "mixed")),
        Sale.credits_quantity.isnot(None),
        Sale.product_id.is_(None),
        func.lower(func.trim(func.coalesce(Sale.inventory_provider, ""))) == provider_norm,
    )
    if exclude_sale_id is not None:
        q = q.filter(Sale.id != int(exclude_sale_id))
    return float(q.scalar() or 0.0)


def _remaining_full_credits_for_payload(
    db: Session,
    *,
    provider: str,
    product: Optional[Product],
    exclude_sale_id: Optional[int] = None,
) -> float:
    """
    CAP de créditos al crear/actualizar preventa / activar.

    - Catálogo (``product``): ``products.inventory_credit_reserved_qty`` como fuente de reserva.
    - Pooled (sin producto): suma de ventas pendientes pooled por proveedor.
    """
    want = _norm_prov_key(provider) if provider else ""
    if product is not None:
        from app.services.catalog_inventory import catalog_credits_available_for_activation

        return catalog_credits_available_for_activation(
            db,
            product,
            exclude_sale_id=exclude_sale_id,
        )

    pending = _pending_full_credits_pooled_reserved_sum(db, provider_norm=want, exclude_sale_id=exclude_sale_id)
    base = float(_remaining_full_credits(db, provider))
    return round(max(0.0, base - pending), 4)


def _product_credit_reserved_adjust(db: Session, product_id: int, delta: float) -> None:
    if abs(delta) < 1e-15:
        return
    p = db.get(Product, int(product_id))
    if p is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Producto de catálogo no encontrado.",
        )
    cur = Decimal(str(p.inventory_credit_reserved_qty or 0))
    new_val = cur + Decimal(str(round(delta, 6)))
    if new_val < Decimal("-0.0001"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La reserva de créditos del producto quedaría negativa (datos inconsistentes).",
        )
    p.inventory_credit_reserved_qty = new_val.quantize(Decimal("0.0001"))


def _product_credit_assigned_adjust(db: Session, product_id: int, delta: float) -> None:
    if abs(delta) < 1e-15:
        return
    p = db.get(Product, int(product_id))
    if p is None:
        return
    cur = Decimal(str(p.inventory_credit_assigned_qty or 0))
    new_val = cur + Decimal(str(round(delta, 6)))
    if new_val < Decimal("0"):
        new_val = Decimal("0")
    p.inventory_credit_assigned_qty = new_val.quantize(Decimal("0.0001"))


def _release_pending_sale_catalog_credit_reservation(db: Session, sale: Sale) -> None:
    """Al cancelar/rechazar ``pending``: revierte ``inventory_credit_reserved_qty``."""
    pid = sale.product_id
    if pid is None:
        return
    if _effective_inventory_channel(sale) not in ("full_credits", "mixed"):
        return
    qty = float(sale.credits_quantity or 0)
    if qty <= 0:
        return
    _product_credit_reserved_adjust(db, int(pid), -qty)


def _apply_pending_sale_catalog_credit_reservation(db: Session, sale: Sale) -> None:
    """
    Preventa con créditos de catálogo: incrementa ``Product.inventory_credit_reserved_qty``.
    La disponibilidad efectiva para nuevas ventas baja en igual magnitud (no hay campo ``available_qty`` aparte).
    """
    if sale.product_id is None:
        return
    if _effective_inventory_channel(sale) not in ("full_credits", "mixed"):
        return
    qty = float(sale.credits_quantity or 0)
    if qty <= 0:
        return
    _product_credit_reserved_adjust(db, int(sale.product_id), qty)


def _pick_free_screen_stock_units_by_product_id_strict(
    db: Session,
    *,
    product_id: int,
    qty: int,
) -> list[ScreenStock]:
    """
    FIFO estricto por producto de catálogo: filas en bodega con status ``free`` (disponible / "available"),
    sin ``sale_id``, orden ``created_at`` + ``id``. Bloqueo ``FOR UPDATE`` en PostgreSQL.
    """
    if qty < 1 or qty > 200:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cantidad de pantallas debe estar entre 1 y 200.",
        )
    if product_id < 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="product_id de bodega inválido para reservar pantallas.",
        )
    q = (
        db.query(ScreenStock)
        .filter(
            ScreenStock.product_id == int(product_id),
            ScreenStock.status == SCREEN_STOCK_STATUS_FREE,
            ScreenStock.sale_id.is_(None),
        )
        .order_by(ScreenStock.created_at.asc(), ScreenStock.id.asc())
        .limit(qty)
    )
    rows = _maybe_with_for_update(q, db).all()
    if len(rows) < qty:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No hay pantallas disponibles en bodega.",
        )
    return rows


def _fifo_pick_free_screen_stock_rows(
    db: Session,
    provider: str,
    package: str,
    qty: int,
    *,
    batch_id: Optional[str] = None,
    catalog_product_id: Optional[int] = None,
) -> list[ScreenStock]:
    """FIFO: pantallas libres por proveedor/paquete (comparación normalizada); filtro opcional por lote."""
    q = _screen_stock_fifo_ordered_query(
        db,
        provider,
        package,
        batch_id=batch_id,
        catalog_product_id=catalog_product_id,
    ).limit(qty)
    rows = _maybe_with_for_update(q, db).all()
    if len(rows) < qty and catalog_product_id is not None:
        q_loose = _screen_stock_fifo_ordered_query(
            db,
            provider,
            package,
            batch_id=batch_id,
            catalog_product_id=None,
        ).limit(qty)
        rows = _maybe_with_for_update(q_loose, db).all()
    if len(rows) < qty:
        batch_hint = f" (lote {batch_id})" if (batch_id or "").strip() else ""
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Inventario insuficiente en bodega para este paquete ({provider} — {package}){batch_hint}. "
                f"Se necesitan {qty} pantalla(s) en estado disponible; hay {len(rows)}."
            ),
        )
    return rows


def _bind_screen_stock_rows_to_pending_sale(
    db: Session,
    sale: Sale,
    rows: list[ScreenStock],
) -> None:
    """Liga filas ``screen_stock`` a una preventa: ``reserved``, cliente y ``sale_id``."""
    if not rows:
        return
    _verify_screen_stock_rows_eligible_for_pending_reserve(db, rows)
    sid = int(sale.id)
    cid = int(sale.client_id)
    for r in rows:
        r.status = SCREEN_STOCK_STATUS_RESERVED
        r.client_id = cid
        r.sale_id = sid
        db.add(r)


def _explicit_screen_stock_id_from_sale(sale: Sale) -> Optional[int]:
    """Pantalla explícita en líneas de factura (``ss:`` / ``inventory_spec``)."""
    raw = sale.invoice_lines
    if isinstance(raw, list):
        for chunk in raw[:120]:
            if not isinstance(chunk, dict):
                continue
            lok = chunk.get("inventory_option_key")
            if isinstance(lok, str):
                ls = lok.strip()
                if ls.lower().startswith("ss:"):
                    try:
                        return int(ls.split(":", 1)[1].strip())
                    except ValueError:
                        pass
            spec = chunk.get("inventory_spec")
            if isinstance(spec, dict) and str(spec.get("kind") or "").strip().lower() == "ss":
                sid_raw = spec.get("screen_stock_id")
                if sid_raw is not None:
                    try:
                        return int(sid_raw)
                    except (TypeError, ValueError):
                        pass
    sel = getattr(sale, "selected_screen_id", None)
    if sel is not None:
        try:
            return int(sel)
        except (TypeError, ValueError):
            pass
    if sale.screen_stock_id is not None:
        try:
            return int(sale.screen_stock_id)
        except (TypeError, ValueError):
            pass
    return None


def _validate_and_pick_explicit_screen_row(
    db: Session,
    *,
    pick_explicit_id: int,
    units: int,
    prov_norm: str,
    pkg_norm: str,
    fifo_cat: Optional[int],
) -> list[ScreenStock]:
    if units != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Venta con pantalla explícita en bodega: solo puede haber 1 unidad.",
        )
    stock_row = _maybe_with_for_update(
        db.query(ScreenStock).filter(ScreenStock.id == int(pick_explicit_id)),
        db,
    ).first()
    if stock_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No existe pantalla de bodega con id {pick_explicit_id}.",
        )
    if stock_row.status != SCREEN_STOCK_STATUS_FREE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No hay pantallas disponibles en bodega.",
        )
    if stock_row.sale_id is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La pantalla ya está vinculada a otra venta.",
        )
    if prov_norm and (stock_row.provider or "").strip().lower() != prov_norm.lower():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La pantalla no corresponde al proveedor de la venta.",
        )
    if pkg_norm and (stock_row.package or "").strip().lower() != pkg_norm.lower():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La pantalla no corresponde al paquete de la venta.",
        )
    if (
        fifo_cat is not None
        and stock_row.product_id is not None
        and int(stock_row.product_id) != int(fifo_cat)
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La pantalla no corresponde al producto catálogo de la venta.",
        )
    return [stock_row]


def _pick_screen_stock_rows_for_sale(db: Session, sale: Sale) -> list[ScreenStock]:
    """
    Selecciona filas ``screen_stock`` libres (FIFO) o una pantalla explícita para vincular a la venta.
    Usado en reactivación y asignación just-in-time al activar backorders.
    """
    eff = _effective_inventory_channel(sale)
    if eff not in ("screen_stock", "mixed"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La venta no requiere asignación de pantallas en bodega.",
        )

    units = int(sale.inventory_screen_units or 1)
    if units < 1 or units > 200:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cantidad de pantallas inválida en la venta.",
        )

    prov_norm = (sale.inventory_provider or "").strip()
    pkg_norm = (sale.inventory_package or "").strip()
    fifo_cat: Optional[int] = None
    if sale.product_id is not None and int(sale.product_id) >= 1:
        fifo_cat = int(sale.product_id)

    explicit_sid = _explicit_screen_stock_id_from_sale(sale)

    if eff == "mixed":
        scr_prov, pkg_m, fifo_pid, explicit_mx = _mixed_screen_pick_context_from_sale(db, sale)
        if scr_prov:
            prov_norm = scr_prov
        if pkg_m:
            pkg_norm = pkg_m
        if fifo_pid is not None:
            fifo_cat = fifo_pid
        if explicit_mx is not None:
            explicit_sid = explicit_mx

    if explicit_sid is not None:
        return _validate_and_pick_explicit_screen_row(
            db,
            pick_explicit_id=int(explicit_sid),
            units=units,
            prov_norm=prov_norm,
            pkg_norm=pkg_norm,
            fifo_cat=fifo_cat,
        )

    batch_id = (getattr(sale, "screen_stock_batch_id", None) or "").strip() or None
    try:
        return _pick_free_screen_stock_for_pending_sale(
            db,
            provider=prov_norm,
            package=pkg_norm,
            qty=units,
            product_id=int(fifo_cat) if fifo_cat is not None and int(fifo_cat) >= 1 else None,
            batch_id=batch_id,
        )
    except HTTPException as exc:
        if exc.status_code == status.HTTP_400_BAD_REQUEST:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No hay pantallas disponibles en bodega.",
            ) from exc
        raise


def _jit_assign_screen_stock_for_activation(db: Session, sale: Sale) -> None:
    """
    Backorders sin reserva previa: al activar, asigna la siguiente unidad FIFO disponible,
    la reserva contra la venta y prepara credenciales en ``invoice_lines``.
    """
    if _fifo_screen_stock_rows_bound_to_sale(db, sale):
        return

    picked = _pick_screen_stock_rows_for_sale(db, sale)
    inv_json = sale.invoice_lines
    inv_merged = (
        _merge_reserved_screen_credentials_into_invoice_lines(inv_json, picked) if inv_json else inv_json
    )
    if inv_merged is not None:
        sale.invoice_lines = inv_merged
    _bind_screen_stock_rows_to_pending_sale(db, sale, picked)
    sale.screen_stock_id = int(picked[0].id)
    if not (sale.inventory_package or "").strip() and picked[0].package:
        sale.inventory_package = (picked[0].package or "").strip()
    if not (sale.inventory_provider or "").strip() and picked[0].provider:
        sale.inventory_provider = (picked[0].provider or "").strip()


def _confirm_screen_stock_reserved_rows_on_activation(db: Session, sale: Sale) -> None:
    """
    ``pending`` → ``approved``: confirma unidades de bodega **ya reservadas** al crear la preventa.
    Transición ``reserved``/``held`` → ``assigned``; no vuelve a correr FIFO.
    """
    rows = _fifo_screen_stock_rows_bound_to_sale(db, sale)
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No hay pantallas disponibles en bodega.",
        )
    exp = int(sale.inventory_screen_units or 0)
    if exp >= 1 and len(rows) != exp:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Se esperaban {exp} unidad(es) de bodega para esta venta; "
                f"hay {len(rows)} fila(s) vinculadas."
            ),
        )
    cid = int(sale.client_id)
    sid = int(sale.id)
    for r in rows:
        if r.status == SCREEN_STOCK_STATUS_ASSIGNED:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Una unidad de bodega ya está asignada.",
            )
        if r.status not in SCREEN_STOCK_ACTIVATION_FROM_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Unidad de bodega id {r.id} no está reservada para activación "
                    f"(estado: {r.status!r}). Debe existir una preventa que haya reservado esta fila."
                ),
            )
        r.status = SCREEN_STOCK_STATUS_ASSIGNED
        r.sale_id = sid
        r.client_id = cid
        db.add(r)


def _release_all_screen_stock_for_pending_sale(
    db: Session, sale: Sale, *, clear_credentials: bool = False
) -> None:
    """Libera filas ligadas a la venta (preventa cancelada/rechazada): vuelven a ``free``, sin cliente ni venta."""
    rows = list(db.query(ScreenStock).filter(ScreenStock.sale_id == sale.id))
    seen = {r.id for r in rows}
    leg = sale.screen_stock_id
    if leg and leg not in seen:
        extra = db.get(ScreenStock, leg)
        if extra is not None:
            rows.append(extra)
    sid = int(sale.id)
    leg_id = int(leg) if leg is not None else None
    for r in rows:
        rid = int(r.id)
        linked_sale = r.sale_id == sid
        linked_head = leg_id is not None and rid == leg_id
        if not linked_sale and not linked_head:
            continue
        if r.status in ("reserved", "held", "assigned"):
            r.status = SCREEN_STOCK_STATUS_FREE
        r.client_id = None
        if r.sale_id == sid:
            r.sale_id = None
        if clear_credentials:
            r.iptv_username = None
            r.iptv_password = None
    sale.screen_stock_id = None


def _safe_release_pending_sale_inventory(
    db: Session,
    sale: Sale,
    *,
    clear_credentials: bool = False,
    context: str = "operación",
) -> None:
    """
    Libera reserva de créditos y pantallas de una preventa.
    Si el inventario quedó inconsistente (p. ej. reserva ya liberada), no bloquea la operación admin.
    """
    try:
        _release_pending_sale_catalog_credit_reservation(db, sale)
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
        print(f"Ignorando error de inventario al forzar liberación ({context}): {detail}")
        logger.warning(
            "Ignorando error de reserva de créditos (%s, venta %s): %s",
            context,
            sale.id,
            detail,
        )
    except (ValueError, Exception) as exc:
        print(f"Ignorando error de inventario al forzar liberación ({context}): {exc}")
        logger.warning(
            "Ignorando excepción al liberar créditos (%s, venta %s): %s",
            context,
            sale.id,
            exc,
            exc_info=True,
        )

    try:
        _release_all_screen_stock_for_pending_sale(db, sale, clear_credentials=clear_credentials)
    except (HTTPException, ValueError, Exception) as exc:
        detail = getattr(exc, "detail", None) or str(exc)
        print(f"Ignorando error de inventario al forzar liberación ({context}): {detail}")
        logger.warning(
            "Ignorando error al liberar pantallas (%s, venta %s): %s",
            context,
            sale.id,
            detail,
            exc_info=not isinstance(exc, HTTPException),
        )


_PENDING_RESERVATION_TTL_MINUTES = 10


def pending_reservation_ttl_minutes() -> int:
    """TTL de la reserva temporal para ventas ``pending`` (panel + portal)."""
    return _PENDING_RESERVATION_TTL_MINUTES


def _pending_sale_expires_at() -> datetime:
    return now_ecuador() + timedelta(minutes=_PENDING_RESERVATION_TTL_MINUTES)


def expire_pending_sales_if_needed(db: Session) -> None:
    """Si ``pending`` superó ``expires_at``, pasa a ``expired`` y libera inventario."""
    now = now_ecuador()
    stale = (
        db.query(Sale)
        .filter(
            Sale.status == SaleStatus.pending,
            Sale.expires_at.isnot(None),
            Sale.expires_at < now,
        )
        .all()
    )
    if not stale:
        return
    for sale in stale:
        _safe_release_pending_sale_inventory(db, sale, context="caducidad reserva temporal (10 min)")
        sale.status = SaleStatus.expired
        sale.expires_at = None
        try:
            sync_sale_accounting_ledgers(db, sale, strict=False)
        except Exception as exc:
            logger.warning("journal sync en caducidad venta %s: %s", sale.id, exc)
    db.commit()


def _mixed_screen_pick_context_from_sale(db: Session, sale: Sale) -> tuple[str, str, Optional[int], Optional[int]]:
    """Para venta ``mixed`` caducada: proveedor/paquete FIFO y pantalla explícita opcional desde ``invoice_lines``."""
    pkg_norm = (sale.inventory_package or "").strip()
    fifo_catalog_pid: Optional[int] = None
    scr_prov = ""
    explicit_sid: Optional[int] = None
    raw = sale.invoice_lines
    if isinstance(raw, list):
        for chunk in raw[:200]:
            if not isinstance(chunk, dict):
                continue
            spec = chunk.get("inventory_spec")
            if isinstance(spec, dict):
                kind = str(spec.get("kind") or "").strip().lower()
                if kind == "cp":
                    pv = str(spec.get("provider") or "").strip()
                    if pv:
                        scr_prov = pv
                    pid_raw = spec.get("product_id")
                    if pid_raw is not None:
                        try:
                            fifo_catalog_pid = int(pid_raw)
                        except (TypeError, ValueError):
                            pass
                elif kind == "ss":
                    pv = str(spec.get("provider") or "").strip()
                    if pv:
                        scr_prov = pv
                    sid_raw = spec.get("screen_stock_id")
                    if sid_raw is not None:
                        try:
                            explicit_sid = int(sid_raw)
                        except (TypeError, ValueError):
                            pass
            lok = chunk.get("inventory_option_key")
            if isinstance(lok, str):
                ls = lok.strip()
                if ls.lower().startswith("ss:"):
                    tail = ls.split(":", 1)[1].strip()
                    try:
                        explicit_sid = int(tail)
                    except ValueError:
                        pass
    if fifo_catalog_pid is None and sale.product_id is not None:
        try:
            pid_fallback = int(sale.product_id)
            prod_fallback = db.get(Product, pid_fallback)
            if prod_fallback is not None:
                pt = (getattr(prod_fallback, "product_type", None) or "").strip().lower()
                st = (prod_fallback.service_type or "").strip().lower()
                if pt == "credito_pantalla" or "pantalla" in st:
                    fifo_catalog_pid = pid_fallback
        except (TypeError, ValueError):
            pass
    if not scr_prov:
        scr_prov = (sale.inventory_provider or "").strip()
    return scr_prov, pkg_norm, fifo_catalog_pid, explicit_sid


def _reserve_inventory_for_reactivated_sale(db: Session, sale: Sale) -> None:
    """Re-reserva créditos/pantallas para una venta ``expired`` que vuelve a ``pending``."""
    eff = _effective_inventory_channel(sale)
    if eff == "legacy":
        return

    product = db.get(Product, sale.product_id) if sale.product_id else None

    if eff == "full_credits":
        prov = (sale.inventory_provider or "").strip()
        need = float(sale.credits_quantity or 0)
        if need <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Venta sin cantidad de créditos válida para reactivar.",
            )
        remaining_fc = _remaining_full_credits_for_payload(
            db,
            provider=prov,
            product=product if product else None,
            exclude_sale_id=sale.id,
        )
        if need > remaining_fc + 1e-6:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Créditos insuficientes para reactivar: disponibles {remaining_fc:.4f}.",
            )
        _apply_pending_sale_catalog_credit_reservation(db, sale)
        return

    if eff == "screen_stock":
        pkg_norm = (sale.inventory_package or "").strip()
        prov_norm = (sale.inventory_provider or "").strip()
        units = int(sale.inventory_screen_units or 1)
        if units < 1 or units > 200:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cantidad de pantallas inválida en la venta.",
            )
        fifo_cat: Optional[int] = None
        if sale.product_id is not None and int(sale.product_id) >= 1:
            fifo_cat = int(sale.product_id)

        pick_explicit_id: Optional[int] = None
        raw_il = sale.invoice_lines
        if isinstance(raw_il, list):
            for chunk in raw_il[:120]:
                if not isinstance(chunk, dict):
                    continue
                lok = chunk.get("inventory_option_key")
                if isinstance(lok, str):
                    ls = lok.strip()
                    if ls.lower().startswith("ss:"):
                        try:
                            pick_explicit_id = int(ls.split(":", 1)[1].strip())
                        except ValueError:
                            pick_explicit_id = None
                        break

        picked: list[ScreenStock]
        if pick_explicit_id is not None:
            if units != 1:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Venta con pantalla explícita en bodega: solo puede haber 1 unidad.",
                )
            stock_row = _maybe_with_for_update(
                db.query(ScreenStock).filter(ScreenStock.id == pick_explicit_id),
                db,
            ).first()
            if stock_row is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"No existe pantalla de bodega con id {pick_explicit_id}.",
                )
            if stock_row.status != SCREEN_STOCK_STATUS_FREE:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla indicada ya no está disponible en bodega.",
                )
            if stock_row.sale_id is not None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla ya está vinculada a otra venta.",
                )
            if prov_norm and (stock_row.provider or "").strip().lower() != prov_norm.lower():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla no corresponde al proveedor de la venta.",
                )
            if pkg_norm and (stock_row.package or "").strip().lower() != pkg_norm.lower():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla no corresponde al paquete de la venta.",
                )
            if (
                fifo_cat is not None
                and stock_row.product_id is not None
                and int(stock_row.product_id) != int(fifo_cat)
            ):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla no corresponde al producto catálogo de la venta.",
                )
            picked = [stock_row]
        else:
            picked = _pick_free_screen_stock_for_pending_sale(
                db,
                provider=prov_norm,
                package=pkg_norm,
                qty=units,
                product_id=int(fifo_cat) if fifo_cat is not None and int(fifo_cat) >= 1 else None,
                batch_id=None,
            )

        inv_json = sale.invoice_lines
        inv_for_sale = (
            _merge_reserved_screen_credentials_into_invoice_lines(inv_json, picked) if inv_json else inv_json
        )

        _verify_screen_stock_rows_eligible_for_pending_reserve(db, picked)
        for r in picked:
            r.status = SCREEN_STOCK_STATUS_RESERVED
            r.sale_id = sale.id
            r.client_id = sale.client_id
            db.add(r)
        sale.screen_stock_id = picked[0].id
        if inv_for_sale is not None:
            sale.invoice_lines = inv_for_sale
        return

    if eff == "mixed":
        cred_prov = (sale.inventory_provider or "").strip()
        need = float(sale.credits_quantity or 0)
        if need <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Venta mixta sin cantidad de créditos válida para reactivar.",
            )
        remaining_m = _remaining_full_credits_for_payload(
            db,
            provider=cred_prov,
            product=product if product else None,
            exclude_sale_id=sale.id,
        )
        if need > remaining_m + 1e-6:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Créditos insuficientes para reactivar: disponibles {remaining_m:.4f}.",
            )

        scr_prov, pkg_norm, fifo_catalog_pid, explicit_sid = _mixed_screen_pick_context_from_sale(db, sale)
        units = int(sale.inventory_screen_units or 1)
        if units < 1 or units > 200:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La cantidad de pantallas debe estar entre 1 y 200.",
            )

        picked_mx: list[ScreenStock]
        if explicit_sid is not None:
            if units != 1:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Venta mixta con pantalla explícita: solo puede haber 1 unidad.",
                )
            stock_mx = _maybe_with_for_update(
                db.query(ScreenStock).filter(ScreenStock.id == explicit_sid),
                db,
            ).first()
            if stock_mx is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"No existe pantalla de bodega con id {explicit_sid}.",
                )
            if stock_mx.status != SCREEN_STOCK_STATUS_FREE:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla indicada ya no está disponible en bodega.",
                )
            if stock_mx.sale_id is not None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla ya está vinculada a otra venta.",
                )
            if scr_prov and (stock_mx.provider or "").strip().lower() != scr_prov.lower():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla no corresponde al proveedor FIFO de la línea.",
                )
            if pkg_norm and (stock_mx.package or "").strip().lower() != pkg_norm.lower():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla no corresponde al paquete seleccionado.",
                )
            if (
                fifo_catalog_pid is not None
                and stock_mx.product_id is not None
                and int(stock_mx.product_id) != int(fifo_catalog_pid)
            ):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla no corresponde al producto catálogo de la línea.",
                )
            picked_mx = [stock_mx]
        else:
            picked_mx = _pick_free_screen_stock_for_pending_sale(
                db,
                provider=scr_prov,
                package=pkg_norm,
                qty=units,
                product_id=int(fifo_catalog_pid) if fifo_catalog_pid is not None and fifo_catalog_pid >= 1 else None,
                batch_id=None,
            )

        inv_merge = sale.invoice_lines
        inv_for_sale = (
            _merge_reserved_screen_credentials_into_invoice_lines(inv_merge, picked_mx) if inv_merge else inv_merge
        )

        _verify_screen_stock_rows_eligible_for_pending_reserve(db, picked_mx)
        for r_mx in picked_mx:
            r_mx.status = SCREEN_STOCK_STATUS_RESERVED
            r_mx.sale_id = sale.id
            r_mx.client_id = sale.client_id
            db.add(r_mx)
        sale.screen_stock_id = picked_mx[0].id
        if inv_for_sale is not None:
            sale.invoice_lines = inv_for_sale

        _apply_pending_sale_catalog_credit_reservation(db, sale)
        return

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"No se puede reactivar inventario para el canal {eff!r}.",
    )


def _sync_screen_stock_client_ids_for_pending_sale(db: Session, sale: Sale) -> None:
    """Mantiene ``ScreenStock.client_id`` alineado con la venta pendiente (p. ej. cambio de cliente)."""
    if sale.status not in SALE_HOLD_INVENTORY_STATUSES:
        return
    if _effective_inventory_channel(sale) not in ("screen_stock", "mixed"):
        return
    rows = list(db.query(ScreenStock).filter(ScreenStock.sale_id == sale.id).all())
    if not rows and sale.screen_stock_id:
        one = db.get(ScreenStock, sale.screen_stock_id)
        if one is not None and (one.sale_id == sale.id or one.sale_id is None):
            rows.append(one)
    cid = sale.client_id
    for r in rows:
        r.client_id = cid


def _delete_sale_credit_drawdown(db: Session, sale_id: int) -> None:
    db.query(InventoryScreenCreditDrawdown).filter(
        InventoryScreenCreditDrawdown.sale_id == sale_id
    ).delete(synchronize_session=False)


def _reverse_client_sale_activation(client: Client, sale: Sale) -> None:
    increment = float(sale.amount) if float(sale.amount) > 0 else 1.0
    client.total_credits = max(0.0, (client.total_credits or 0.0) - increment)


def _reverse_screen_stock_assignment(db: Session, sale: Sale, *, release_completely: bool) -> None:
    rows = list(db.query(ScreenStock).filter(ScreenStock.sale_id == sale.id))
    if not rows and sale.screen_stock_id:
        one = db.get(ScreenStock, sale.screen_stock_id)
        if one is not None:
            rows.append(one)
    for r in rows:
        if release_completely:
            if r.status in ("assigned", "reserved", "held"):
                r.status = "free"
            r.sale_id = None
            r.client_id = None
        else:
            if r.status == "assigned":
                r.status = "reserved"
            r.sale_id = sale.id


def _reverse_approved_sale_inventory(db: Session, sale: Sale, *, target: SaleStatus) -> None:
    """Revierte deducción de inventario al pasar de ``approved`` a otro estado (p. ej. pending, annulled)."""
    eff = _effective_inventory_channel(sale)
    if eff == "full_credits":
        _delete_sale_credit_drawdown(db, sale.id)
        pid = sale.product_id
        if pid is not None:
            qty = float(sale.credits_quantity or 0)
            if qty > 0:
                _product_credit_assigned_adjust(db, int(pid), -qty)
                if target in (SaleStatus.pending, SaleStatus.payment_submitted):
                    _product_credit_reserved_adjust(db, int(pid), qty)
    elif eff == "mixed":
        _delete_sale_credit_drawdown(db, sale.id)
        pid_mx = sale.product_id
        if pid_mx is not None:
            qty_mx = float(sale.credits_quantity or 0)
            if qty_mx > 0:
                _product_credit_assigned_adjust(db, int(pid_mx), -qty_mx)
                if target in (SaleStatus.pending, SaleStatus.payment_submitted):
                    _product_credit_reserved_adjust(db, int(pid_mx), qty_mx)
        _reverse_screen_stock_assignment(
            db,
            sale,
            release_completely=(
                target in (SaleStatus.cancelled, SaleStatus.rejected, SaleStatus.annulled)
            ),
        )
    elif eff == "screen_stock":
        _reverse_screen_stock_assignment(
            db,
            sale,
            release_completely=(
                target in (SaleStatus.cancelled, SaleStatus.rejected, SaleStatus.annulled)
            ),
        )
    elif sale.iptv_screen_id:
        scr = db.get(IPTVScreen, sale.iptv_screen_id)
        if scr is not None:
            scr.is_available = True
            scr.client_id = None
        sale.iptv_screen_id = None


def _canonical_line_description_from_inventory_spec(db: Session, spec: dict[str, Any]) -> Optional[str]:
    """
    Nombre de línea de factura desde catálogo/inventario real (no texto libre del cliente).
    """
    kind = str(spec.get("kind") or "").strip().lower()
    try:
        if kind == "cn":
            pid_raw = spec.get("product_id")
            if pid_raw is None:
                return None
            prod = db.get(Product, int(pid_raw))
            nm = (prod.name or "").strip() if prod is not None else ""
            return nm or None
        if kind == "fc":
            prov = str(spec.get("provider") or "").strip()
            return f"Créditos completos — {prov}" if prov else None
        if kind == "cp":
            pid_raw = spec.get("product_id")
            pkg = str(spec.get("package") or "").strip()
            pv = str(spec.get("provider") or "").strip()
            pname = ""
            if pid_raw is not None:
                try:
                    prod = db.get(Product, int(pid_raw))
                    pname = (prod.name or "").strip() if prod is not None else ""
                except (TypeError, ValueError):
                    pname = ""
            if not pname:
                pname = pv or "Servicio"
            if pkg:
                return f"{pname} — {pkg}"
            return pname or None
        if kind == "ss":
            sid = spec.get("screen_stock_id")
            if sid is None:
                return None
            stock = db.get(ScreenStock, int(sid))
            if stock is None:
                return None
            prov = (stock.provider or "").strip() or "—"
            pkg = (stock.package or "").strip() or "Paquete"
            pid = getattr(stock, "product_id", None)
            pname = ""
            if pid is not None:
                try:
                    pr = db.get(Product, int(pid))
                    pname = (pr.name or "").strip() if pr is not None else ""
                except (TypeError, ValueError):
                    pname = ""
            base = pname or prov
            return f"{base} — {pkg}".strip()
    except (TypeError, ValueError):
        return None
    return None


def _parse_inventory_option_key(key: str) -> dict[str, Any]:
    k = (key or "").strip()
    if k.startswith("cn:"):
        tail = k[3:].strip()
        if not tail.isdigit():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Clave de inventario cn inválida: {key[:120]}",
            )
        return {"kind": "cn", "product_id": int(tail)}
    if k.startswith("fc:"):
        prov = k[3:].strip()
        if not prov:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Clave fc: requiere proveedor.",
            )
        return {"kind": "fc", "provider": prov}
    if k.startswith("ss:"):
        tail = k[3:].strip()
        if not tail.isdigit():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Clave ss inválida: {key[:120]}",
            )
        return {"kind": "ss", "screen_stock_id": int(tail)}
    if k.startswith("cp|"):
        parts = k[3:].split("|")
        if len(parts) < 3:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Clave cp| incompleta (se espera cp|productId|paquete|proveedor).",
            )
        try:
            product_id = int(parts[0].strip())
        except ValueError as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="cp|: product_id inválido.",
            ) from e
        pkg = unquote(parts[1] or "").strip()
        prov = unquote(parts[2] or "").strip()
        if not pkg or not prov:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="cp|: paquete y proveedor obligatorios.",
            )
        return {"kind": "cp", "product_id": product_id, "package": pkg, "provider": prov}
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"Línea de inventario no reconocida: {key[:120]}",
    )


def _invoice_line_payload_from_operation(
    db: Session, ln: SaleOperationLine, spec: dict[str, Any]
) -> dict[str, Any]:
    lik: Literal["full_credits", "screen_stock"] = (
        "screen_stock" if spec["kind"] in ("cp", "ss") else "full_credits"
    )
    key = (ln.inventory_option_key or "").strip()
    catalog_desc = _canonical_line_description_from_inventory_spec(db, spec)
    desc_final = catalog_desc if catalog_desc else ln.description
    row = SaleInvoiceLineItem(
        description=desc_final,
        qty=ln.qty,
        rate=ln.rate,
        transaction_class_id=ln.clase_id,
        iptv_username=ln.iptv_username,
        iptv_password=ln.iptv_password,
        line_inventory_kind=lik,
        inventory_option_key=key or None,
    )
    return row.model_dump(mode="json")


def _aggregate_credit_lines_inventory_fragment(db: Session, lines: list[SaleOperationLine]) -> dict[str, Any]:
    specs = [_parse_inventory_option_key(ln.inventory_option_key) for ln in lines]
    kinds = {s["kind"] for s in specs}
    if kinds - frozenset({"cn", "fc"}) or len(kinds) != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Las líneas de créditos deben ser solo cn: o solo fc: en la misma factura.",
        )
    kind = next(iter(kinds))

    if kind == "cn":
        pids = {int(s["product_id"]) for s in specs}
        if len(pids) != 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Varias líneas cn: deben ser el mismo producto de catálogo.",
            )
        pid = next(iter(pids))
        prod = db.get(Product, pid)
        if prod is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Producto de catálogo no encontrado.")
        prov = (prod.iptv_provider or "").strip()
        if not prov:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El producto no tiene proveedor IPTV configurado.",
            )
        cq = float(sum(Decimal(str(ln.qty)) for ln in lines))
        return {
            "provider": prov,
            "product_id": pid,
            "credits_quantity": cq,
        }

    provs = {(s["provider"] or "").strip() for s in specs}
    if len(provs) != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Líneas fc: deben compartir el mismo proveedor.",
        )
    prov = next(iter(provs))
    cq = float(sum(Decimal(str(ln.qty)) for ln in lines))
    return {"provider": prov, "product_id": None, "credits_quantity": cq}


def _aggregate_screen_lines_inventory_fragment(db: Session, lines: list[SaleOperationLine]) -> dict[str, Any]:
    specs = [_parse_inventory_option_key(ln.inventory_option_key) for ln in lines]
    kinds = {s["kind"] for s in specs}
    if kinds - frozenset({"cp", "ss"}) or len(kinds) != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No mezcles pantalla FIFO (cp|) con selección manual (ss:) en la misma factura.",
        )
    kind = next(iter(kinds))

    if kind == "cp":
        triples = {(s["product_id"], s["package"], s["provider"]) for s in specs}
        if len(triples) != 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Líneas cp|: deben ser el mismo paquete y proveedor.",
            )
        pid, pkg, prov = next(iter(triples))
        units = 0
        for ln in lines:
            q = float(ln.qty)
            if abs(q - round(q)) > 1e-6:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cantidad de pantallas por línea debe ser un número entero (FIFO por paquete).",
                )
            ui = int(round(q))
            if ui < 1:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cada línea de paquete debe tener cantidad ≥ 1.",
                )
            units += ui
        if units > 200:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Demasiadas pantallas en una venta (máx. 200).",
            )
        return {
            "screen_stock_inventory_provider": (prov or "").strip(),
            "package": pkg,
            "inventory_screen_units": units,
            "selected_screen_id": None,
            "screen_stock_batch_id": None,
            "cp_product_id": int(pid) if pid is not None else None,
        }

    # ss:
    if len(lines) != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Con selección explícita de pantalla (ss:) solo se permite una línea de pantalla.",
        )
    if float(lines[0].qty) != 1.0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Con pantalla explícita la cantidad debe ser 1.",
        )
    sid = int(specs[0]["screen_stock_id"])
    stock = db.get(ScreenStock, sid)
    if stock is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pantalla de bodega no encontrada.")
    prov = (stock.provider or "").strip()
    pkg = (stock.package or "").strip()
    return {
        "screen_stock_inventory_provider": prov,
        "package": pkg,
        "inventory_screen_units": 1,
        "selected_screen_id": sid,
        "screen_stock_batch_id": None,
        "cp_product_id": None,
    }


def _aggregate_sale_operation_lines(db: Session, lines: list[SaleOperationLine]) -> dict[str, Any]:
    """Consolida líneas ERP en una cabecera ``SaleCreate`` (homogénea o mixta)."""
    specs = [_parse_inventory_option_key(ln.inventory_option_key) for ln in lines]
    kinds = {s["kind"] for s in specs}
    inv_lines_ordered = [_invoice_line_payload_from_operation(db, ln, sp) for ln, sp in zip(lines, specs)]

    credit_idxs = [i for i, s in enumerate(specs) if s["kind"] in ("cn", "fc")]
    stock_idxs = [i for i, s in enumerate(specs) if s["kind"] in ("cp", "ss")]
    if kinds - frozenset({"cn", "fc", "cp", "ss"}):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Clave de inventario no admitida en multilinea: {kinds}.",
        )

    mixed = bool(credit_idxs and stock_idxs)
    if mixed:
        if not credit_idxs:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Factura ERP mixta sin líneas de créditos (cn:/fc:).",
            )
        if len({specs[i]["kind"] for i in credit_idxs}) != 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No mezcles crédito catálogo (cn:) y pooled (fc:) en la misma venta.",
            )
        cr_lines = [lines[i] for i in credit_idxs]
        st_lines = [lines[i] for i in stock_idxs]
        cf = _aggregate_credit_lines_inventory_fragment(db, cr_lines)
        sf = _aggregate_screen_lines_inventory_fragment(db, st_lines)
        cp_pid = sf.get("cp_product_id")
        fifo_pid: Optional[int] = None
        if cp_pid is not None and int(cp_pid) >= 1:
            fifo_pid = int(cp_pid)

        merged: dict[str, Any] = {
            "inventory_channel": "mixed",
            "provider": cf["provider"],
            "screen_stock_inventory_provider": sf["screen_stock_inventory_provider"],
            "product_id": cf["product_id"],
            "credits_quantity": cf["credits_quantity"],
            "package": sf["package"],
            "inventory_screen_units": sf["inventory_screen_units"],
            "selected_screen_id": sf.get("selected_screen_id"),
            "screen_stock_batch_id": sf.get("screen_stock_batch_id"),
            "invoice_lines": inv_lines_ordered,
            "screen_fifo_product_id": fifo_pid,
        }
        merged["selected_screen_id"] = sf.get("selected_screen_id") or merged.get("selected_screen_id")
        merged["screen_stock_id"] = None
        merged["inventory_screen_units"] = int(sf["inventory_screen_units"])
        return merged

    if len(kinds) != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Combina líneas coherentes por tipo de inventario (créditos o pantallas ERP).",
        )
    kind = next(iter(kinds))

    if kind == "cn":
        frag = _aggregate_credit_lines_inventory_fragment(db, lines)
        return {
            "inventory_channel": "full_credits",
            **frag,
            "inventory_screen_units": 1,
            "package": None,
            "screen_stock_id": None,
            "selected_screen_id": None,
            "screen_stock_batch_id": None,
            "screen_stock_inventory_provider": None,
            "invoice_lines": inv_lines_ordered,
        }

    if kind == "fc":
        frag = _aggregate_credit_lines_inventory_fragment(db, lines)
        return {
            "inventory_channel": "full_credits",
            **frag,
            "inventory_screen_units": 1,
            "package": None,
            "screen_stock_id": None,
            "selected_screen_id": None,
            "screen_stock_batch_id": None,
            "screen_stock_inventory_provider": None,
            "invoice_lines": inv_lines_ordered,
        }

    if kind == "cp":
        frag = _aggregate_screen_lines_inventory_fragment(db, lines)
        specs_cp = [_parse_inventory_option_key(ln.inventory_option_key) for ln in lines]
        triple = {(s["product_id"], s["package"], s["provider"]) for s in specs_cp}
        pid_cp, pkg_cp, prov_cp = next(iter(triple))
        return {
            "inventory_channel": "screen_stock",
            "provider": (prov_cp or "").strip(),
            "screen_stock_inventory_provider": None,
            "package": frag["package"],
            "product_id": int(pid_cp) if int(pid_cp or 0) >= 1 else None,
            "screen_fifo_product_id": int(pid_cp) if int(pid_cp or 0) >= 1 else None,
            "inventory_screen_units": int(frag["inventory_screen_units"]),
            "credits_quantity": None,
            "screen_stock_id": None,
            "selected_screen_id": None,
            "screen_stock_batch_id": None,
            "invoice_lines": inv_lines_ordered,
        }

    # ss (una línea pantalla manual)
    frag = _aggregate_screen_lines_inventory_fragment(db, lines)
    sid_ss = frag["selected_screen_id"]
    stock = db.get(ScreenStock, int(sid_ss)) if sid_ss else None
    pid_ss = int(stock.product_id) if stock is not None and stock.product_id else None
    return {
        "inventory_channel": "screen_stock",
        "provider": (frag["screen_stock_inventory_provider"] or "").strip(),
        "screen_stock_inventory_provider": None,
        "package": frag["package"],
        "product_id": pid_ss if pid_ss and pid_ss >= 1 else None,
        "inventory_screen_units": 1,
        "credits_quantity": None,
        "screen_stock_id": None,
        "selected_screen_id": int(sid_ss) if sid_ss else None,
        "screen_stock_batch_id": None,
        "invoice_lines": inv_lines_ordered,
    }


def _prepare_sale_create_payload(db: Session, raw: dict[str, Any]) -> dict[str, Any]:
    lines_raw = raw.get("lines")
    if lines_raw is None or (isinstance(lines_raw, list) and len(lines_raw) == 0):
        syn = _synthetic_operation_lines_from_invoice_lines(raw.get("invoice_lines"))
        if syn:
            raw = {**raw, "lines": syn}
            lines_raw = syn
    if lines_raw is None:
        return raw
    if isinstance(lines_raw, list) and len(lines_raw) == 0:
        return raw
    if not isinstance(lines_raw, list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El campo «lines» debe ser un array.",
        )
    lines = [SaleOperationLine.model_validate(x) for x in lines_raw]
    la = Decimal(str(raw.get("local_amount") or "0"))
    sum_ln = sum((Decimal(str(ln.qty)) * Decimal(str(ln.rate))).quantize(Decimal("0.0001")) for ln in lines)
    diff = abs(la - sum_ln)
    if diff > Decimal("0.15"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"El importe total ({la}) no coincide con la suma de líneas ({sum_ln}). "
                f"Ajusta cantidades/tarifas o el total."
            ),
        )
    agg = _aggregate_sale_operation_lines(db, lines)
    out = {**raw, **agg}
    return out


def _parse_sale_create_form(db: Session, form_data: Any) -> SaleCreate:
    flat: dict[str, Any] = {}
    for key in (
        "client_id",
        "user_id",
        "catalog_render_email",
        "inventory_channel",
        "provider",
        "screen_stock_inventory_provider",
        "currency",
        "exchange_rate",
        "local_amount",
        "amount_paid",
        "product_id",
        "package",
        "screen_stock_id",
        "selected_screen_id",
        "screen_stock_batch_id",
        "credits_quantity",
        "inventory_screen_units",
        "class_id",
        "payment_method_id",
        "deposit_account_id",
        "notes",
    ):
        v = form_data.get(key)
        if v is None or v == "":
            continue
        if key in (
            "client_id",
            "user_id",
            "product_id",
            "screen_stock_id",
            "selected_screen_id",
            "class_id",
            "payment_method_id",
            "deposit_account_id",
            "inventory_screen_units",
        ):
            flat[key] = int(v)
        elif key == "exchange_rate":
            flat[key] = float(v)
        elif key == "local_amount":
            flat[key] = Decimal(str(v))
        elif key == "amount_paid":
            flat[key] = Decimal(str(v))
        elif key == "credits_quantity":
            flat[key] = float(v)
        elif key == "provider":
            flat[key] = str(v).strip()
        elif key == "screen_stock_inventory_provider":
            t = str(v).strip()
            if t:
                flat[key] = t
        elif key == "package":
            flat[key] = str(v).strip() if str(v).strip() else None
        elif key == "screen_stock_batch_id":
            t = str(v).strip()
            if t:
                flat[key] = t
        elif key == "notes":
            t = str(v).strip()
            if t:
                flat[key] = t
        elif key == "catalog_render_email":
            s = str(v).strip().lower()
            if s:
                flat[key] = s
        else:
            flat[key] = str(v)

    tg = form_data.get("tag_ids")
    if tg is not None and tg != "":
        flat["tag_ids"] = _coerce_tag_ids_raw(tg)

    il_raw = form_data.get("invoice_lines")
    if il_raw is not None and il_raw != "":
        if isinstance(il_raw, str):
            flat["invoice_lines"] = json.loads(il_raw)
        else:
            flat["invoice_lines"] = il_raw

    ln_raw = form_data.get("lines")
    if ln_raw is not None and ln_raw != "":
        if isinstance(ln_raw, str):
            flat["lines"] = json.loads(ln_raw)
        else:
            flat["lines"] = ln_raw

    ap_allow = form_data.get("allowed_payment_methods")
    if ap_allow is not None and ap_allow != "":
        flat["allowed_payment_methods"] = json.loads(ap_allow) if isinstance(ap_allow, str) else ap_allow

    da_allow = form_data.get("allowed_deposit_accounts")
    if da_allow is not None and da_allow != "":
        flat["allowed_deposit_accounts"] = json.loads(da_allow) if isinstance(da_allow, str) else da_allow

    return SaleCreate.model_validate(_prepare_sale_create_payload(db, flat))


async def _persist_receipt_upload(file: UploadFile) -> str:
    ctype = file.content_type or ""
    if ctype not in RECEIPT_ALLOWED_CT:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Formato no permitido. Usa JPG, PNG, GIF, WEBP o PDF.",
        )
    raw = await file.read()
    if len(raw) > RECEIPT_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="El archivo supera el límite de 20 MB.",
        )

    suffix = Path(file.filename or "receipt").suffix.lower()
    if suffix not in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf"):
        suffix = ".pdf" if ctype == "application/pdf" else ".jpg"

    filename = f"{uuid.uuid4().hex}{suffix}"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / filename).write_bytes(raw)

    return f"/uploads/{filename}"


REJECTION_IMAGE_MAX_BYTES = 20 * 1024 * 1024
REJECTION_IMAGE_ALLOWED_CT = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
}


async def _persist_rejection_image_upload(file: UploadFile) -> str:
    """Guarda una imagen de evidencia de rechazo bajo ``uploads/rejections/``."""
    ctype = file.content_type or ""
    if ctype not in REJECTION_IMAGE_ALLOWED_CT:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Solo se aceptan imágenes (JPG, PNG, GIF, WEBP) como evidencia de rechazo.",
        )
    raw = await file.read()
    if len(raw) > REJECTION_IMAGE_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="La imagen supera el límite de 20 MB.",
        )

    suffix = Path(file.filename or "photo").suffix.lower()
    if suffix not in (".jpg", ".jpeg", ".png", ".gif", ".webp"):
        suffix = ".jpg" if ctype == "image/jpeg" else ".png"

    filename = f"{uuid.uuid4().hex}{suffix}"
    rej_dir = UPLOAD_DIR / "rejections"
    rej_dir.mkdir(parents=True, exist_ok=True)
    (rej_dir / filename).write_bytes(raw)

    return f"/uploads/rejections/{filename}"



def _unique_client_username_candidate(db: Session, base: str) -> str:
    slug = (base.strip()[:118]) if isinstance(base, str) and base.strip() else "usuario"
    slug = "".join(slug.split())
    if not slug:
        slug = "usuario"
    for i in range(0, 5000):
        cand = slug if i == 0 else f"{slug[:100]}_{i}"
        exists = db.query(Client.id).filter(Client.username == cand).first()
        if not exists:
            return cand
    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="No se pudo generar un usuario IPTV único para el cliente CRM.",
    )


def _ensure_client_for_portal_user(db: Session, portal_user: User) -> Client:
    email = (portal_user.email or "").strip().lower()
    if not email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El usuario portal debe tener correo para enlazar/cargar cliente en CRM.",
        )
    existing = db.query(Client).filter(func.lower(Client.email) == email).first()
    if existing:
        return existing

    iptv_pref = (portal_user.iptv_username or "").strip()
    slug = iptv_pref or (email.split("@", 1)[0] if "@" in email else f"u{portal_user.id}")
    username = _unique_client_username_candidate(db, slug)
    name = (portal_user.name or "").strip() or slug or email.split("@", 1)[0]
    row = Client(
        name=name,
        email=email,
        username=username,
        phone=(portal_user.phone or "").strip() or None,
        payment_token=uuid.uuid4(),
        custom_fields={},
    )
    db.add(row)
    db.flush()
    return row


def _ensure_client_for_render_catalog_email(db: Session, email: str) -> Client:
    """Enlaza o crea un ``Client`` local por correo (datos listados desde catálogo VIP en Render)."""
    email_norm = email.strip().lower()
    if not email_norm or "@" not in email_norm:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="catalog_render_email debe ser un correo electrónico válido.",
        )
    existing = db.query(Client).filter(func.lower(Client.email) == email_norm).first()
    if existing:
        return existing

    slug = email_norm.split("@", 1)[0].strip() or "cliente"
    username = _unique_client_username_candidate(db, slug)
    name = slug if slug else email_norm.split("@", 1)[0]
    row = Client(
        name=name[:150],
        email=email_norm,
        username=username,
        payment_token=uuid.uuid4(),
        custom_fields={},
        status="Activo",
    )
    db.add(row)
    db.flush()
    return row


def _resolve_sale_create_client_binding(db: Session, payload: SaleCreate) -> SaleCreate:
    """Convierte ``user_id`` o ``catalog_render_email`` en ``client_id`` CRM antes de persistir."""
    crt = getattr(payload, "catalog_render_email", None)
    if crt is not None:
        crt_s = str(crt).strip()
        if crt_s:
            c = _ensure_client_for_render_catalog_email(db, crt_s)
            return payload.model_copy(update={"client_id": c.id, "user_id": None, "catalog_render_email": None})

    if payload.client_id is not None and int(payload.client_id) >= 1:
        return payload.model_copy(update={"user_id": None})

    uid = payload.user_id
    if uid is None or int(uid) < 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Debe especificar client_id (CRM), user_id (portal) o catalog_render_email (lista Render).",
        )
    portal_user = db.get(User, int(uid))
    if portal_user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuario portal no encontrado.")
    if portal_user.role != UserRole.client:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La venta con user_id sólo está permitida para usuarios con rol «client».",
        )
    c = _ensure_client_for_portal_user(db, portal_user)
    return payload.model_copy(update={"client_id": c.id, "user_id": None})


def _create_pending_erp_sale(db: Session, payload: SaleCreate, receipt_url: Optional[str]) -> SaleResponse:
    """Registra venta desde el panel ERP en estado ``pending``. Reserva bodega (``reserved``) si aplica."""
    payload = SaleCreate.model_validate(
        _prepare_sale_create_payload(db, payload.model_dump()),
    )
    payload = _resolve_sale_create_client_binding(db, payload)

    client = db.get(Client, payload.client_id)
    if not client:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Cliente con id {payload.client_id} no encontrado.",
        )
    # ``Sale`` se persiste siempre con ``client_id`` del payload (portal del cliente vs checkout por venta).

    product: Optional[Product] = None
    if payload.product_id:
        product = db.get(Product, payload.product_id)
        if not product:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Producto con id {payload.product_id} no encontrado.",
            )

    resolved_provider = (payload.provider or "").strip()
    amount_usd = Decimal(str(round(float(payload.local_amount) / float(payload.exchange_rate), 4)))
    # Las ventas creadas desde el ERP quedan SIEMPRE en ``pending``: el cliente aún no ha
    # pagado nada aunque el payload traiga un valor en ``amount_paid``.
    amount_paid_norm = _normalize_amount_paid(payload.local_amount, payload.amount_paid, force_zero=True)
    inv_json, cls_from_lines = _invoice_lines_json_and_primary_class(db, payload.invoice_lines)
    inv_json = _invoice_lines_prepare_for_storage(
        inv_json,
        inventory_channel=payload.inventory_channel,
    )
    class_fk = cls_from_lines if cls_from_lines is not None else _resolve_class_id(db, payload.class_id)
    pm_try = _resolve_payment_method_id(db, payload.payment_method_id)
    dep_try = _resolve_deposit_account_id(db, payload.deposit_account_id)
    apm, ada, pm_fk, dep_fk = _finalize_sale_payment_allowlists(
        db,
        allowed_payment_methods=payload.allowed_payment_methods,
        allowed_deposit_accounts=payload.allowed_deposit_accounts,
        payment_method_id=pm_try,
        deposit_account_id=dep_try,
    )

    if payload.inventory_channel == "mixed":
        cred_prov = resolved_provider
        scr_prov = (payload.screen_stock_inventory_provider or "").strip()
        pkg_norm = (payload.package or "").strip()
        units = int(payload.inventory_screen_units or 1)
        need = float(payload.credits_quantity or 0)

        remaining_fc = _remaining_full_credits_for_payload(
            db,
            provider=cred_prov,
            product=product if product else None,
            exclude_sale_id=None,
        )
        if need > remaining_fc + 1e-6:
            if product is not None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Créditos insuficientes para este producto: disponibles {remaining_fc:.4f}.",
                )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Créditos insuficientes para {cred_prov}: disponibles {remaining_fc:.4f}.",
            )

        if units < 1 or units > 200:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La cantidad de pantallas debe estar entre 1 y 200.",
            )

        # --- Determinar product_id de catálogo para FIFO de bodega ----------------------------------
        # Prioridad: screen_fifo_product_id (lo rellena el agregador de líneas cp|) → product_id
        # si pertenece a un producto de pantalla → None (FIFO por proveedor/paquete como fallback).
        fifo_catalog_pid: Optional[int] = None
        sfp = getattr(payload, "screen_fifo_product_id", None)
        if sfp is not None:
            try:
                sfp_i = int(sfp)
                if sfp_i >= 1:
                    fifo_catalog_pid = sfp_i
            except (TypeError, ValueError):
                pass
        if fifo_catalog_pid is None and payload.product_id is not None:
            try:
                pid_fallback = int(payload.product_id)
                if pid_fallback >= 1:
                    prod_fallback = db.get(Product, pid_fallback)
                    if prod_fallback is not None:
                        pt = (getattr(prod_fallback, "product_type", None) or "").strip().lower()
                        st = (prod_fallback.service_type or "").strip().lower()
                        if pt == "credito_pantalla" or "pantalla" in st:
                            fifo_catalog_pid = pid_fallback
            except (TypeError, ValueError):
                pass

        print(
            f"[MIXED PENDING] cliente={payload.client_id} "
            f"proveedor_credito={cred_prov!r} proveedor_bodega={scr_prov!r} "
            f"paquete={pkg_norm!r} unidades={units} "
            f"screen_fifo_product_id={getattr(payload, 'screen_fifo_product_id', None)!r} "
            f"fifo_catalog_pid={fifo_catalog_pid!r}"
        )

        picked_mx: list[ScreenStock]
        pick_explicit_mx = (
            payload.selected_screen_id
            if payload.selected_screen_id is not None
            else payload.screen_stock_id
        )
        if pick_explicit_mx is not None:
            if units != 1:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Si eliges pantalla manual en venta mixta solo puede haber 1 unidad.",
                )
            print(f"[MIXED PENDING] Pantalla explícita solicitada: id={pick_explicit_mx}")
            stock_mx = _maybe_with_for_update(
                db.query(ScreenStock).filter(ScreenStock.id == pick_explicit_mx),
                db,
            ).first()
            if stock_mx is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"No existe pantalla de bodega con id {pick_explicit_mx}.",
                )
            if stock_mx.status != SCREEN_STOCK_STATUS_FREE:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla indicada ya no está disponible en bodega.",
                )
            if stock_mx.sale_id is not None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla ya está vinculada a otra venta.",
                )
            if scr_prov and (stock_mx.provider or "").strip().lower() != scr_prov.lower():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla no corresponde al proveedor FIFO de la línea.",
                )
            if pkg_norm and (stock_mx.package or "").strip().lower() != pkg_norm.lower():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla no corresponde al paquete seleccionado.",
                )
            if (
                fifo_catalog_pid is not None
                and stock_mx.product_id is not None
                and int(stock_mx.product_id) != int(fifo_catalog_pid)
            ):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla no corresponde al producto catálogo de la línea cp|.",
                )
            print(f"[MIXED PENDING] Pantalla encontrada: id={stock_mx.id}, cambiando estado a {SCREEN_STOCK_STATUS_RESERVED!r}")
            picked_mx = [stock_mx]
        else:
            print(
                f"[MIXED PENDING] Buscando {units} pantalla(s) FIFO "
                f"proveedor={scr_prov!r} paquete={pkg_norm!r} product_id={fifo_catalog_pid}"
            )
            picked_mx = _pick_free_screen_stock_for_pending_sale(
                db,
                provider=scr_prov,
                package=pkg_norm,
                qty=units,
                product_id=int(fifo_catalog_pid) if fifo_catalog_pid is not None and fifo_catalog_pid >= 1 else None,
                batch_id=(payload.screen_stock_batch_id or "").strip() or None,
            )
            print(
                f"[MIXED PENDING] Pantalla(s) encontrada(s): ids={[r.id for r in picked_mx]} "
                f"→ cambiando estado a {SCREEN_STOCK_STATUS_RESERVED!r}"
            )

        inv_cost_fc_mx = _full_credits_inventory_cost_usd(
            db, cred_prov, need, catalog_product=product if product else None
        )
        unit_costs_mx = [_screen_stock_unit_cost_usd(r, db=db) for r in picked_mx]
        inv_cost_scr_mx: Optional[Decimal] = None
        if picked_mx and all(uc is not None for uc in unit_costs_mx):
            inv_cost_scr_mx = sum(unit_costs_mx, Decimal("0"))

        parts_mx: list[Decimal] = []
        if inv_cost_fc_mx is not None and inv_cost_fc_mx > 0:
            parts_mx.append(inv_cost_fc_mx)
        if inv_cost_scr_mx is not None and inv_cost_scr_mx > 0:
            parts_mx.append(inv_cost_scr_mx)
        merged_inv_cost = sum(parts_mx, Decimal("0")) if parts_mx else None
        _validate_sale_amount_vs_inventory_cost(
            amount_usd=amount_usd,
            inventory_cost_usd=merged_inv_cost if merged_inv_cost and merged_inv_cost > 0 else None,
        )

        inv_for_sale = _merge_reserved_screen_credentials_into_invoice_lines(inv_json, picked_mx) or inv_json

        sale_mx = Sale(
            client_id=payload.client_id,
            product_id=payload.product_id if product else None,
            iptv_screen_id=None,
            screen_stock_id=picked_mx[0].id,
            amount=amount_usd,
            currency=payload.currency,
            exchange_rate=payload.exchange_rate,
            local_amount=payload.local_amount,
            amount_paid=amount_paid_norm,
            status=SaleStatus.pending,
            payment_token=uuid.uuid4(),
            receipt_url=receipt_url,
            expires_at=_pending_sale_expires_at(),
            credits_quantity=need,
            inventory_provider=cred_prov,
            inventory_channel="mixed",
            inventory_package=pkg_norm,
            inventory_screen_units=units,
            class_id=class_fk,
            payment_method_id=pm_fk,
            deposit_account_id=dep_fk,
            notes=payload.notes,
            invoice_lines=inv_for_sale,
            allowed_payment_methods=apm or None,
            allowed_deposit_accounts=ada or None,
        )
        db.add(sale_mx)
        db.flush()  # obtener sale_mx.id antes de vincular bodega

        _verify_screen_stock_rows_eligible_for_pending_reserve(db, picked_mx)

        # ── Reservar pantallas en bodega (pending) ──────────────────────────────
        # Estado: free → reserved; sale_id y client_id asignados.
        # NO se vuelve a ejecutar FIFO en la activación; solo se confirman estas filas.
        print(
            f"[MIXED PENDING] Vinculando {len(picked_mx)} pantalla(s) a sale_id={sale_mx.id} "
            f"(estado {SCREEN_STOCK_STATUS_RESERVED!r})"
        )
        for r_mx in picked_mx:
            r_mx.status = SCREEN_STOCK_STATUS_RESERVED
            r_mx.sale_id = sale_mx.id
            r_mx.client_id = sale_mx.client_id
            db.add(r_mx)
            print(
                f"[MIXED PENDING]   screen_stock id={r_mx.id} "
                f"iptv_user={r_mx.iptv_username!r} → status={r_mx.status!r}"
            )
        sale_mx.screen_stock_id = picked_mx[0].id

        _apply_pending_sale_catalog_credit_reservation(db, sale_mx)
        _sync_sale_tags(db, sale_mx, list(payload.tag_ids))
        _assert_sale_deposit_currency(db, sale_mx)
        sync_sale_accounting_ledgers(db, sale_mx, strict=True)
        _sync_client_last_iptv_from_full_credit_sale(db, client, sale_mx)
        db.commit()
        notify_catalog_vip_sale_pending_payment(db, sale_mx)
        print(f"[MIXED PENDING] db.commit() completado para sale_id={sale_mx.id}")
        db.refresh(sale_mx)
        for r_mx in picked_mx:
            db.refresh(r_mx)
            print(f"[MIXED PENDING] Post-commit screen_stock id={r_mx.id} status={r_mx.status!r} sale_id={r_mx.sale_id}")
        return _build_response(sale_mx, client, None, product, stock_row=picked_mx[0], db=db)

    if payload.inventory_channel == "screen_stock":
        pkg_norm = (payload.package or "").strip()
        prov_norm = resolved_provider
        units = int(payload.inventory_screen_units or 1)
        if units < 1 or units > 200:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La cantidad de pantallas debe estar entre 1 y 200.",
            )

        fifo_cat: Optional[int] = None
        sff = getattr(payload, "screen_fifo_product_id", None)
        if sff is not None and int(sff) >= 1:
            fifo_cat = int(sff)
        elif payload.product_id is not None and int(payload.product_id) >= 1:
            fifo_cat = int(payload.product_id)

        picked: list[ScreenStock]
        pick_explicit_id = (
            payload.selected_screen_id
            if payload.selected_screen_id is not None
            else payload.screen_stock_id
        )
        if pick_explicit_id is not None:
            if units != 1:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Si eliges una pantalla manualmente solo puede haber 1 unidad.",
                )
            stock_row = _maybe_with_for_update(
                db.query(ScreenStock).filter(ScreenStock.id == pick_explicit_id),
                db,
            ).first()
            if stock_row is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"No existe pantalla de bodega con id {pick_explicit_id}.",
                )
            if stock_row.status != SCREEN_STOCK_STATUS_FREE:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla indicada ya no está disponible en bodega.",
                )
            if stock_row.sale_id is not None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla ya está vinculada a otra venta.",
                )
            if (stock_row.provider or "").strip().lower() != prov_norm.lower():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla no corresponde al proveedor seleccionado.",
                )
            if (stock_row.package or "").strip().lower() != pkg_norm.lower():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla no corresponde al paquete seleccionado.",
                )
            if (
                fifo_cat is not None
                and stock_row.product_id is not None
                and int(stock_row.product_id) != int(fifo_cat)
            ):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="La pantalla no corresponde al producto catálogo de la venta.",
                )
            picked = [stock_row]
        else:
            picked = _pick_free_screen_stock_for_pending_sale(
                db,
                provider=prov_norm,
                package=pkg_norm,
                qty=units,
                product_id=int(fifo_cat) if fifo_cat is not None and int(fifo_cat) >= 1 else None,
                batch_id=(payload.screen_stock_batch_id or "").strip() or None,
            )

        unit_costs = [_screen_stock_unit_cost_usd(r, db=db) for r in picked]
        inv_cost_screen: Optional[Decimal] = None
        if picked and all(uc is not None for uc in unit_costs):
            inv_cost_screen = sum(unit_costs, Decimal("0"))

        _validate_sale_amount_vs_inventory_cost(
            amount_usd=amount_usd,
            inventory_cost_usd=inv_cost_screen,
        )

        inv_for_sale_ss = _merge_reserved_screen_credentials_into_invoice_lines(inv_json, picked) or inv_json

        sale = Sale(
            client_id=payload.client_id,
            product_id=payload.product_id if product else None,
            iptv_screen_id=None,
            screen_stock_id=picked[0].id,
            amount=amount_usd,
            currency=payload.currency,
            exchange_rate=payload.exchange_rate,
            local_amount=payload.local_amount,
            amount_paid=amount_paid_norm,
            status=SaleStatus.pending,
            payment_token=uuid.uuid4(),
            receipt_url=receipt_url,
            expires_at=_pending_sale_expires_at(),
            credits_quantity=None,
            inventory_provider=prov_norm,
            inventory_channel="screen_stock",
            inventory_package=pkg_norm,
            inventory_screen_units=units,
            class_id=class_fk,
            payment_method_id=pm_fk,
            deposit_account_id=dep_fk,
            notes=payload.notes,
            invoice_lines=inv_for_sale_ss,
            allowed_payment_methods=apm or None,
            allowed_deposit_accounts=ada or None,
        )
        db.add(sale)
        db.flush()  # obtener sale.id antes de vincular bodega

        _verify_screen_stock_rows_eligible_for_pending_reserve(db, picked)

        print(
            f"[SCREEN_STOCK PENDING] sale_id={sale.id} "
            f"Vinculando {len(picked)} pantalla(s) → status={SCREEN_STOCK_STATUS_RESERVED!r}"
        )
        for r in picked:
            r.status = SCREEN_STOCK_STATUS_RESERVED
            r.sale_id = sale.id
            r.client_id = sale.client_id
            db.add(r)
            print(
                f"[SCREEN_STOCK PENDING]   id={r.id} "
                f"iptv_user={r.iptv_username!r} status={r.status!r}"
            )
        sale.screen_stock_id = picked[0].id

        _sync_sale_tags(db, sale, list(payload.tag_ids))
        _assert_sale_deposit_currency(db, sale)
        sync_sale_accounting_ledgers(db, sale, strict=True)
        db.commit()
        notify_catalog_vip_sale_pending_payment(db, sale)
        print(f"[SCREEN_STOCK PENDING] db.commit() completado para sale_id={sale.id}")
        db.refresh(sale)
        for r in picked:
            db.refresh(r)
            print(f"[SCREEN_STOCK PENDING] Post-commit id={r.id} status={r.status!r} sale_id={r.sale_id}")
        return _build_response(sale, client, None, product, stock_row=picked[0], db=db)

    # ── Recarga total (créditos) ────────────────────────────────────────────
    need = float(payload.credits_quantity or 0)
    remaining_fc = _remaining_full_credits_for_payload(
        db,
        provider=resolved_provider,
        product=product if product else None,
        exclude_sale_id=None,
    )
    if need > remaining_fc + 1e-6:
        if product is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Créditos insuficientes para este producto: disponibles {remaining_fc:.4f}.",
            )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Créditos insuficientes para {resolved_provider}: disponibles {remaining_fc:.4f}.",
        )

    inv_cost_fc = _full_credits_inventory_cost_usd(
        db, resolved_provider, need, catalog_product=product if product else None
    )
    _validate_sale_amount_vs_inventory_cost(
        amount_usd=amount_usd,
        inventory_cost_usd=inv_cost_fc,
    )

    sale = Sale(
        client_id=payload.client_id,
        product_id=payload.product_id if product else None,
        iptv_screen_id=None,
        screen_stock_id=None,
        amount=amount_usd,
        currency=payload.currency,
        exchange_rate=payload.exchange_rate,
        local_amount=payload.local_amount,
        amount_paid=amount_paid_norm,
        status=SaleStatus.pending,
        payment_token=uuid.uuid4(),
        receipt_url=receipt_url,
        expires_at=_pending_sale_expires_at(),
        credits_quantity=need,
        inventory_provider=resolved_provider,
        inventory_channel="full_credits",
        inventory_package=None,
        inventory_screen_units=1,
        class_id=class_fk,
        payment_method_id=pm_fk,
        deposit_account_id=dep_fk,
        notes=payload.notes,
        invoice_lines=inv_json,
        allowed_payment_methods=apm or None,
        allowed_deposit_accounts=ada or None,
    )
    db.add(sale)
    db.flush()
    _apply_pending_sale_catalog_credit_reservation(db, sale)
    _sync_sale_tags(db, sale, list(payload.tag_ids))
    _assert_sale_deposit_currency(db, sale)
    sync_sale_accounting_ledgers(db, sale, strict=True)
    _sync_client_last_iptv_from_full_credit_sale(db, client, sale)
    db.commit()
    notify_catalog_vip_sale_pending_payment(db, sale)
    db.refresh(sale)
    db.refresh(client)

    return _build_response(sale, client, None, product, stock_row=None, db=db)


@router.post("/", response_model=SaleResponse, status_code=status.HTTP_201_CREATED)
async def create_sale(request: Request, db: DbDep) -> SaleResponse:
    """
    Venta desde el panel: siempre queda en ``pending`` hasta **Activar**.

    - ``application/json``: cuerpo ``SaleCreate``.
    - ``multipart/form-data``: mismos campos como campos de formulario + archivo opcional ``receipt``.
    """
    ct = (request.headers.get("content-type") or "").lower()
    receipt_url: Optional[str] = None

    if "multipart/form-data" in ct:
        form = await request.form()
        payload = _parse_sale_create_form(db, form)
        uf = form.get("receipt")
        if isinstance(uf, UploadFile) and uf.filename:
            receipt_url = await _persist_receipt_upload(uf)
    elif "application/json" in ct:
        body = await request.body()
        try:
            obj = json.loads(body)
        except json.JSONDecodeError as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"JSON inválido: {e}",
            ) from e
        payload = SaleCreate.model_validate(_prepare_sale_create_payload(db, obj))
    else:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Usa application/json o multipart/form-data.",
        )

    try:
        return _create_pending_erp_sale(db, payload, receipt_url)
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        logger.exception("POST /sales: error al crear venta pendiente (ERP)")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e) if str(e) else "Error interno al registrar la venta.",
        ) from e


@router.get(
    "/sync-web-credits",
    response_model=SaleWebCreditsSyncResponse,
    summary="Sincronizar comprobantes de ventas (web VIP / Render) hacia el ERP",
)
def sync_sales_web_credits_from_catalog(db: DbDep, _: SalesInvoicesEditDep) -> SaleWebCreditsSyncResponse:
    """
    Descarga desde catalogo-vip las ventas con comprobante subido por el cliente y crea/abre el flujo
    «En revisión» en el ERP (estado ``payment_submitted`` + ``ClientPayment`` pendiente donde aplica).

    Render expone ``GET /api/webhook/ventas-en-revision`` con ``X-Webhook-Secret``.
    Si Render falla, el puente devuelve lista vacía: este endpoint sigue siendo HTTP 200
    con ``updated_ids=[]`` para no frenar el poller del ERP.
    """
    raw = sync_web_credit_sales_from_vip_catalog(db)
    return SaleWebCreditsSyncResponse.model_validate(raw)


@router.get("/", response_model=list[SaleResponse])
def list_sales(
    db: DbDep,
    status_filter: Optional[str] = Query(default=None, alias="status"),
    client_id: Optional[int] = Query(default=None, ge=1),
) -> list[SaleResponse]:
    """Historial de ventas. Opcional: ?status=pending|payment_submitted|approved|… y ?client_id=."""
    expire_pending_sales_if_needed(db)
    q = db.query(Sale).options(
        joinedload(Sale.client),
        joinedload(Sale.product),
        joinedload(Sale.screen).joinedload(IPTVScreen.iptv_account),
        joinedload(Sale.screen_stock_row),
        joinedload(Sale.payment_method),
        joinedload(Sale.tags),
    )
    if client_id is not None:
        q = q.filter(Sale.client_id == client_id)
    if status_filter:
        sf = (status_filter or "").strip().lower()
        if sf == "cancelled":
            q = q.filter(Sale.status.in_((SaleStatus.cancelled, SaleStatus.annulled)))
        elif sf == "approved":
            q = q.filter(
                Sale.status.in_((SaleStatus.approved, SaleStatus.partially_paid)),
            )
        else:
            try:
                q = q.filter(Sale.status == SaleStatus(sf))
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=(
                        f"Estado inválido: '{status_filter}'. "
                        "Use 'pending', 'payment_submitted', 'approved', 'partially_paid', 'expired', "
                        "'rejected', 'cancelled' o 'annulled'."
                    ),
                )
    sales = q.order_by(Sale.created_at.desc()).all()
    return [
        _build_response(s, s.client, s.screen, s.product, stock_row=s.screen_stock_row, db=db)
        for s in sales
    ]


router.add_api_route(
    "",
    list_sales,
    methods=["GET"],
    response_model=list[SaleResponse],
    tags=["sales"],
    include_in_schema=False,
)


@router.get("/{sale_id}", response_model=SaleResponse)
def get_sale(sale_id: int, db: DbDep) -> SaleResponse:
    """Detalle de una venta/factura, incluyendo pagos CxC aplicados."""
    expire_pending_sales_if_needed(db)
    sale = (
        db.query(Sale)
        .options(
            joinedload(Sale.client),
            joinedload(Sale.product),
            joinedload(Sale.screen).joinedload(IPTVScreen.iptv_account),
            joinedload(Sale.screen_stock_row),
            joinedload(Sale.payment_method),
            joinedload(Sale.tags),
        )
        .filter(Sale.id == sale_id)
        .first()
    )
    if sale is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Venta no encontrada.")
    return _build_response(
        sale,
        sale.client,
        sale.screen,
        sale.product,
        stock_row=sale.screen_stock_row,
        db=db,
    )


@router.patch(
    "/{sale_id}/reactivate",
    response_model=SaleResponse,
    summary="Reactivar venta caducada (re-reserva inventario + nuevo TTL)",
)
def reactivate_expired_sale(sale_id: int, db: DbDep) -> SaleResponse:
    expire_pending_sales_if_needed(db)
    sale = (
        db.query(Sale)
        .options(
            joinedload(Sale.client),
            joinedload(Sale.product),
            joinedload(Sale.screen).joinedload(IPTVScreen.iptv_account),
            joinedload(Sale.screen_stock_row),
            joinedload(Sale.payment_method),
            joinedload(Sale.tags),
        )
        .filter(Sale.id == sale_id)
        .first()
    )
    if sale is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Venta no encontrada.")
    if sale.status != SaleStatus.expired:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Solo se pueden reactivar ventas caducadas.",
        )

    client = sale.client if sale.client else db.get(Client, sale.client_id)
    if client is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Cliente inconsistente.")

    product = db.get(Product, sale.product_id) if sale.product_id else None

    try:
        _reserve_inventory_for_reactivated_sale(db, sale)
        sale.status = SaleStatus.pending
        sale.expires_at = _pending_sale_expires_at()
        sync_sale_accounting_ledgers(db, sale, strict=True)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception("PATCH /sales/%s/reactivate failed", sale_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc) if str(exc) else "No se pudo reactivar la venta.",
        ) from exc

    db.refresh(sale)

    stock = sale.screen_stock_row
    if stock is None and sale.screen_stock_id:
        stock = db.get(ScreenStock, sale.screen_stock_id)

    screen_resp = sale.screen
    return _build_response(sale, client, screen_resp, product, stock_row=stock, db=db)


@router.patch(
    "/{sale_id}/extend-timer",
    response_model=SaleResponse,
    summary="Extender temporizador de reserva (solo administrador)",
)
def extend_sale_reservation_timer(
    sale_id: int,
    body: SaleExtendTimerBody,
    db: DbDep,
    _: SalesInvoicesEditDep,
) -> SaleResponse:
    expire_pending_sales_if_needed(db)
    sale = (
        db.query(Sale)
        .options(
            joinedload(Sale.client),
            joinedload(Sale.product),
            joinedload(Sale.screen).joinedload(IPTVScreen.iptv_account),
            joinedload(Sale.screen_stock_row),
            joinedload(Sale.payment_method),
            joinedload(Sale.tags),
        )
        .filter(Sale.id == sale_id)
        .first()
    )
    if sale is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Venta no encontrada.")
    if sale.status != SaleStatus.pending:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Solo se puede extender el temporizador en ventas pendientes.",
        )

    extra = int(body.extra_minutes)
    now = now_ecuador()

    if sale.expires_at is not None:
        base = sale.expires_at
        if getattr(base, "tzinfo", None) is None:
            base = ensure_aware(base)
        sale.expires_at = base + timedelta(minutes=extra)
    else:
        sale.expires_at = now + timedelta(minutes=extra)

    db.commit()
    db.refresh(sale)

    client = sale.client if sale.client else db.get(Client, sale.client_id)
    if client is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Cliente inconsistente.")
    product = db.get(Product, sale.product_id) if sale.product_id else None
    stock = sale.screen_stock_row
    if stock is None and sale.screen_stock_id:
        stock = db.get(ScreenStock, sale.screen_stock_id)
    screen_resp = sale.screen

    return _build_response(sale, client, screen_resp, product, stock_row=stock, db=db)


@router.get(
    "/{sale_id}/portal-payment-consolidated",
    response_model=SalePortalPaymentConsolidated,
    summary="Saldo portal aplicado + comprobante en revisión antes de activar",
)
def get_sale_portal_payment_consolidated(sale_id: int, db: DbDep, _: SalesInvoicesViewDep) -> SalePortalPaymentConsolidated:
    expire_pending_sales_if_needed(db)
    sale = (
        db.query(Sale)
        .options(joinedload(Sale.product), joinedload(Sale.screen_stock_row))
        .filter(Sale.id == sale_id)
        .first()
    )
    if sale is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Venta no encontrada.")

    from app.api.v1.portal import _compute_portal_balance

    real_total, balance = _compute_portal_balance(db, sale)
    cur = normalize_currency_code(str(sale.currency or "USD"))

    credit_sum_dec = Decimal("0")
    ap_rows = (
        db.query(PaymentAllocation, ClientPayment)
        .join(ClientPayment, PaymentAllocation.payment_id == ClientPayment.id)
        .filter(
            PaymentAllocation.sale_id == int(sale.id),
            ClientPayment.status == ClientPaymentStatus.approved,
        )
        .all()
    )
    for alloc, cp in ap_rows:
        notes_l = str(cp.notes or "")
        pm_low = (cp.payment_method or "").strip().lower()
        applied = Decimal(str(alloc.amount_applied or 0)).quantize(Decimal("0.01"))
        if "credit_auto_portal" in notes_l or pm_low == "saldo a favor":
            credit_sum_dec += applied
        elif not is_client_payment_credit_only(cp):
            from app.services.client_payment_service import parse_notes_meta_sale_id

            meta_sid = parse_notes_meta_sale_id(cp.notes)
            is_encapsulated = "IS_INITIAL_SALE_PAYMENT" in notes_l or meta_sid == int(sale.id)
            if not is_encapsulated and applied > _FP_EPS:
                credit_sum_dec += applied

    pending_bank: Optional[PendingBankPaymentBrief] = None
    pend_dep_list = _portal_pending_deposit_payments_for_sale(db, sale)
    if pend_dep_list:
        pdep = pend_dep_list[0]
        try:
            amt_dec = Decimal(str(pdep.amount or 0)).quantize(Decimal("0.01"))
        except Exception:
            amt_dec = Decimal("0")
        pending_bank = PendingBankPaymentBrief(
            payment_id=int(pdep.id),
            payment_number=str(pdep.payment_number) if pdep.payment_number else None,
            amount=float(amt_dec),
            currency=normalize_currency_code(str(pdep.currency or cur)),
            receipt_url=str(pdep.receipt_file_url).strip() if pdep.receipt_file_url else None,
        )

    bal_out = balance if balance > Decimal("0.005") else Decimal("0")

    return SalePortalPaymentConsolidated(
        sale_id=int(sale.id),
        currency=cur,
        staff_review_action=_sale_staff_review_action(db, sale),
        invoice_total=float(real_total.quantize(Decimal("0.01"))),
        balance_due=float(bal_out.quantize(Decimal("0.01"))),
        amount_paid_registered=float(Decimal(str(sale.amount_paid or 0)).quantize(Decimal("0.01"))),
        auto_credit_applied=float(credit_sum_dec.quantize(Decimal("0.01"))),
        pending_bank_review=pending_bank,
    )


@router.post(
    "/{referencia_externa}/instant-activation-cxc",
    response_model=PortalInstantActivationResponse,
    tags=["public"],
    summary="Activación inmediata con CxC total (Códigos de Retiro)",
)
def post_sale_instant_activation_cxc(
    referencia_externa: str,
    db: DbDep,
    portal_token: Annotated[uuid.UUID, Query(description="Token permanente del portal del cliente")],
    payment_method_id: Annotated[
        Optional[int],
        Query(description="ID del método de pago seleccionado (debe ser Códigos de Retiro)"),
    ] = None,
) -> PortalInstantActivationResponse:
    """Regla 1/2: activa venta y CxC al 100% sin registrar pagos (portal autenticado por token)."""
    from app.api.v1.portal import portal_instant_activation_cxc

    return portal_instant_activation_cxc(portal_token, referencia_externa, db, payment_method_id)


@router.patch(
    "/{referencia_externa}/instant-activation",
    response_model=PortalInstantActivationResponse,
    tags=["public"],
    summary="[Legacy] Alias PATCH instant-activation",
    include_in_schema=False,
)
def patch_sale_instant_activation_by_ref(
    referencia_externa: str,
    db: DbDep,
    portal_token: Annotated[uuid.UUID, Query(description="Token permanente del portal del cliente")],
) -> PortalInstantActivationResponse:
    return post_sale_instant_activation_cxc(referencia_externa, db, portal_token)


@router.patch(
    "/{sale_id}/activate",
    response_model=SaleResponse,
    summary="Activar venta o aprobar cobro CxC (según inventario ya entregado)",
)
def patch_activate_sale(sale_id: int, db: DbDep) -> SaleResponse:
    return _activate_sale_record(db, sale_id)


@router.post(
    "/{sale_id}/approve",
    response_model=SaleResponse,
    summary="Alias de activación (compatibilidad)",
)
def approve_sale(sale_id: int, db: DbDep) -> SaleResponse:
    return _activate_sale_record(db, sale_id)


@router.put(
    "/{sale_id}/status",
    response_model=SaleResponse,
    summary="Activar, rechazar (JSON o multipart con foto) o anular venta activada",
)
async def put_sale_status(request: Request, sale_id: int, db: DbDep) -> SaleResponse:
    ct = (request.headers.get("content-type") or "").lower()

    if "multipart/form-data" in ct:
        form = await request.form()
        status_raw = form.get("status")
        status_l = str(status_raw or "").strip().lower()
        if status_l == "approved":
            return _activate_sale_record(db, sale_id)
        if status_l == "annulled":
            return _annul_approved_sale_record(db, sale_id)
        if status_l != "rejected":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="En multipart use status=approved|rejected|annulled.",
            )
        reason_raw = form.get("rejection_reason")
        reason = str(reason_raw or "").strip()
        uf = form.get("rejection_image")
        img_url: Optional[str] = None
        if isinstance(uf, UploadFile) and uf.filename:
            img_url = await _persist_rejection_image_upload(uf)
        return _reject_pending_sale_record(db, sale_id, reason, rejection_image_url=img_url)

    if "application/json" in ct:
        try:
            raw_body = await request.body()
            obj = json.loads(raw_body)
        except json.JSONDecodeError as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"JSON inválido: {e}",
            ) from e
        body = SaleStatusPut.model_validate(obj)
        if body.status == "approved":
            return _activate_sale_record(db, sale_id)
        if body.status == "annulled":
            return _annul_approved_sale_record(db, sale_id)
        reason = (body.rejection_reason or "").strip()
        return _reject_pending_sale_record(db, sale_id, reason, rejection_image_url=None)

    raise HTTPException(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        detail="Usa application/json o multipart/form-data.",
    )


@router.patch("/{sale_id}", response_model=SaleResponse)
async def patch_pending_sale(request: Request, sale_id: int, db: DbDep) -> SaleResponse:
    """Actualiza venta pendiente. JSON o multipart con campo ``payload`` (JSON) y archivo opcional ``receipt``."""
    try:
        return await _patch_pending_sale_handler(request, sale_id, db)
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        print(f"Error actualizando venta: {e}")
        logger.exception("Error actualizando venta id=%s", sale_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        ) from e


async def _patch_pending_sale_handler(request: Request, sale_id: int, db: DbDep) -> SaleResponse:
    """Lógica de PATCH de venta (separada para capturar excepciones no controladas)."""
    expire_pending_sales_if_needed(db)
    ct = (request.headers.get("content-type") or "").lower()
    receipt_uploaded_url: Optional[str] = None

    if "multipart/form-data" in ct:
        form = await request.form()
        raw_payload = form.get("payload")
        if raw_payload is None or (isinstance(raw_payload, str) and not str(raw_payload).strip()):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="En multipart debe enviarse el campo payload con el JSON de actualización.",
            )
        if isinstance(raw_payload, bytes):
            raw_payload = raw_payload.decode("utf-8")
        try:
            obj = json.loads(raw_payload)
        except json.JSONDecodeError as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"payload JSON inválido: {e}",
            ) from e
        body = SaleUpdate.model_validate(obj)
        uf = form.get("receipt")
        if isinstance(uf, UploadFile) and uf.filename:
            receipt_uploaded_url = await _persist_receipt_upload(uf)
    elif "application/json" in ct:
        raw_body = await request.body()
        try:
            obj = json.loads(raw_body)
        except json.JSONDecodeError as e:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"JSON inválido: {e}",
            ) from e
        body = SaleUpdate.model_validate(obj)
    else:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Usa application/json o multipart/form-data (con payload JSON).",
        )

    sale = (
        db.query(Sale)
        .options(
            joinedload(Sale.client),
            joinedload(Sale.product),
            joinedload(Sale.screen).joinedload(IPTVScreen.iptv_account),
            joinedload(Sale.screen_stock_row),
        )
        .filter(Sale.id == sale_id)
        .first()
    )
    if sale is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Venta no encontrada.")

    raw_preview = body.model_dump(exclude_unset=True)

    if sale.status in (SaleStatus.approved, SaleStatus.partially_paid):
        if receipt_uploaded_url is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No se adjunta comprobante en ventas ya activadas.",
            )
        keys_preview = set(raw_preview.keys())
        allowed = frozenset({
            "status",
            "tag_ids",
            "notes",
            "client_id",
            "currency",
            "exchange_rate",
            "local_amount",
            "amount_paid",
            "payment_method_id",
            "deposit_account_id",
            "allowed_payment_methods",
            "allowed_deposit_accounts",
            "created_at",
            "class_id",
            "product_id",
            "inventory_channel",
            "provider",
            "package",
            "credits_quantity",
            "screen_stock_id",
            "selected_screen_id",
            "screen_stock_batch_id",
            "inventory_screen_units",
            "invoice_lines",
        })
        extra = keys_preview - allowed
        if extra:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Hay campos no permitidos en la actualización de esta venta: "
                    f"{sorted(extra)}."
                ),
            )
        if not raw_preview:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Indica al menos un campo a actualizar.",
            )

        if "client_id" in raw_preview:
            cid = raw_preview["client_id"]
            c = db.get(Client, cid)
            if not c:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")
            sale.client_id = cid

        if "notes" in raw_preview:
            sale.notes = raw_preview["notes"]

        if "payment_method_id" in raw_preview:
            sale.payment_method_id = _resolve_payment_method_id(db, raw_preview["payment_method_id"])

        if "deposit_account_id" in raw_preview:
            sale.deposit_account_id = _resolve_deposit_account_id(db, raw_preview["deposit_account_id"])

        if "allowed_payment_methods" in raw_preview:
            vals_pm = raw_preview["allowed_payment_methods"]
            sale.allowed_payment_methods = (
                (_normalize_allowed_payment_method_labels(db, list(vals_pm)) if vals_pm else []) or None
            )
        if "allowed_deposit_accounts" in raw_preview:
            vals_da = raw_preview["allowed_deposit_accounts"]
            sale.allowed_deposit_accounts = (
                (_normalize_allowed_deposit_account_ids(db, list(vals_da)) if vals_da else []) or None
            )

        if keys_preview & {
            "payment_method_id",
            "deposit_account_id",
            "allowed_payment_methods",
            "allowed_deposit_accounts",
        }:
            _sync_sale_allowlists_denormalized(db, sale)

        if "currency" in raw_preview:
            sale.currency = (raw_preview["currency"] or "USD").upper()

        if "exchange_rate" in raw_preview:
            sale.exchange_rate = float(raw_preview["exchange_rate"])

        if "local_amount" in raw_preview:
            sale.local_amount = raw_preview["local_amount"]

        if {"currency", "exchange_rate", "local_amount"} & raw_preview.keys():
            la = sale.local_amount
            er = sale.exchange_rate
            if la is None or er is None or float(er) <= 0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Monto local y tasa inválidos.",
                )
            sale.amount = Decimal(str(round(float(la) / float(er), 4)))

        if "amount_paid" in raw_preview:
            la_ap = sale.local_amount
            if la_ap is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Monto local inválido para importe pagado.",
                )
            sale.amount_paid = _normalize_amount_paid(la_ap, raw_preview["amount_paid"])
        # Al cambiar local_amount sin proveer amount_paid explícito NO se reinicia
        # el cobro — se preserva el valor actual para no borrar pagos parciales ya registrados.

        if "class_id" in raw_preview:
            sale.class_id = _resolve_class_id(db, raw_preview["class_id"])

        if "invoice_lines" in raw_preview:
            inv_ap_json, cls_from_il_ap = _invoice_lines_json_and_primary_class(
                db, raw_preview["invoice_lines"],
            )
            sale.invoice_lines = inv_ap_json
            if cls_from_il_ap is not None:
                sale.class_id = cls_from_il_ap
        if "product_id" in raw_preview:
            pid_ap = raw_preview["product_id"]
            if (sale.inventory_channel or "").strip() == "mixed":
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="No se puede cambiar el producto de catálogo en ventas mixtas desde este formulario.",
                )
            if pid_ap is None:
                sale.product_id = None
            else:
                p_row = db.get(Product, pid_ap)
                if not p_row:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Producto/servicio no encontrado.",
                    )
                sale.product_id = pid_ap

        inv_patch_keys_ap = {
            "inventory_channel",
            "provider",
            "screen_stock_inventory_provider",
            "package",
            "credits_quantity",
            "screen_stock_id",
            "selected_screen_id",
            "screen_stock_batch_id",
            "inventory_screen_units",
            "product_id",
        }
        if keys_preview & inv_patch_keys_ap:
            _apply_pending_sale_inventory_update(db, sale, dict(raw_preview), keys_preview)

        inv_cost_ap = _inventory_cost_usd_for_pending_sale(db, sale)
        _validate_sale_amount_vs_inventory_cost(
            amount_usd=sale.amount,
            inventory_cost_usd=inv_cost_ap,
        )

        if "created_at" in raw_preview:
            dt = raw_preview["created_at"]
            if dt.tzinfo is None:
                dt = ensure_aware(dt)
            sale.created_at = dt

        if "tag_ids" in raw_preview:
            _sync_sale_tags(db, sale, list(raw_preview["tag_ids"] or []))
        if "status" in raw_preview:
            try:
                new_st = SaleStatus(str(raw_preview["status"]))
            except ValueError as e:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"Estado inválido: {e!s}",
                ) from e
            if new_st == SaleStatus.cancelled:
                new_st = SaleStatus.annulled
            if new_st not in (SaleStatus.pending, SaleStatus.annulled):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Solo se puede revertir a «pending» o anular con «annulled» (o «cancelled», equivalente).",
                )
            cli = sale.client if sale.client else db.get(Client, sale.client_id)
            _reverse_approved_sale_inventory(db, sale, target=new_st)
            if cli is not None:
                _reverse_client_sale_activation(cli, sale)
            sale.status = new_st
        # Re-evaluar CxC: si amount_paid cambia, sincronizar approved ↔ partially_paid.
        if "amount_paid" in raw_preview:
            _maybe_set_partially_paid(sale)

        _assert_sale_deposit_currency(db, sale)
        _sync_sale_accounting_after_panel_patch(db, sale, strict=True)
        ich = (sale.inventory_channel or "").strip() or _effective_inventory_channel(sale)
        if ich in ("screen_stock", "mixed") and sale.invoice_lines:
            sale.invoice_lines = _invoice_lines_prepare_for_storage(
                list(sale.invoice_lines),
                inventory_channel=ich,
            )
        _sync_screen_stock_client_ids_for_pending_sale(db, sale)
        cli_prev = db.get(Client, sale.client_id)
        if cli_prev is not None and _effective_inventory_channel(sale) in ("full_credits", "mixed"):
            _sync_client_last_iptv_from_full_credit_sale(db, cli_prev, sale)
        db.commit()
        db.refresh(sale)

        client = db.get(Client, sale.client_id)
        if client is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado.")
        product = db.get(Product, sale.product_id) if sale.product_id else None
        screen = (
            db.query(IPTVScreen)
            .options(joinedload(IPTVScreen.iptv_account))
            .filter(IPTVScreen.id == sale.iptv_screen_id)
            .first()
            if sale.iptv_screen_id
            else None
        )
        stock = db.get(ScreenStock, sale.screen_stock_id) if sale.screen_stock_id else None
        return _build_response(sale, client, screen, product, stock_row=stock, db=db)

    if sale.status in (SaleStatus.cancelled, SaleStatus.rejected, SaleStatus.annulled):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Esta venta está anulada y no admite cambios.",
        )

    if sale.status not in SALE_HOLD_INVENTORY_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Solo se pueden editar ventas pendientes o en espera de aprobación (comprobante recibido).",
        )

    raw = raw_preview
    receipt_clear_requested = bool(raw.pop("receipt_clear", None))
    tag_ids_explicit = "tag_ids" in raw
    tag_ids_val: Optional[list[int]] = None
    if tag_ids_explicit:
        tag_ids_val = raw.pop("tag_ids") or []
    explicit_keys = set(raw.keys())

    if explicit_keys <= frozenset({"status"}) and raw.get("status") == "cancelled":
        _release_pending_sale_catalog_credit_reservation(db, sale)
        _release_all_screen_stock_for_pending_sale(db, sale)
        void_sale_accounting_state(
            db,
            sale,
            reason=f"Cancelación venta FAC-{int(sale.id):04d}",
        )
        sale.status = SaleStatus.cancelled
        db.commit()
        db.refresh(sale)

        client = db.get(Client, sale.client_id)
        if client is None:
            raise HTTPException(status_code=404, detail="Cliente no encontrado.")
        product = db.get(Product, sale.product_id) if sale.product_id else None
        screen = (
            db.query(IPTVScreen)
            .options(joinedload(IPTVScreen.iptv_account))
            .filter(IPTVScreen.id == sale.iptv_screen_id)
            .first()
            if sale.iptv_screen_id
            else None
        )
        stock = db.get(ScreenStock, sale.screen_stock_id) if sale.screen_stock_id else None
        return _build_response(sale, client, screen, product, stock_row=stock, db=db)

    if "client_id" in explicit_keys:
        cid = raw["client_id"]
        c = db.get(Client, cid)
        if not c:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")
        sale.client_id = cid

    if "product_id" in explicit_keys:
        pid = raw["product_id"]
        if (sale.inventory_channel or "").strip() == "mixed":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No se puede cambiar el producto de catálogo en ventas mixtas desde este formulario.",
            )
        if pid is None:
            sale.product_id = None
        else:
            p = db.get(Product, pid)
            if not p:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Producto/servicio no encontrado.")
            sale.product_id = pid

    if "class_id" in explicit_keys:
        sale.class_id = _resolve_class_id(db, raw["class_id"])

    if "invoice_lines" in explicit_keys:
        inv_pd_json, cls_from_il_pd = _invoice_lines_json_and_primary_class(db, raw["invoice_lines"])
        sale.invoice_lines = inv_pd_json
        if cls_from_il_pd is not None:
            sale.class_id = cls_from_il_pd

    if "payment_method_id" in explicit_keys:
        sale.payment_method_id = _resolve_payment_method_id(db, raw["payment_method_id"])
    if "deposit_account_id" in explicit_keys:
        sale.deposit_account_id = _resolve_deposit_account_id(db, raw["deposit_account_id"])

    if "allowed_payment_methods" in explicit_keys:
        vals_pm = raw.get("allowed_payment_methods")
        sale.allowed_payment_methods = (
            (_normalize_allowed_payment_method_labels(db, list(vals_pm)) if vals_pm else []) or None
        )
    if "allowed_deposit_accounts" in explicit_keys:
        vals_da = raw.get("allowed_deposit_accounts")
        sale.allowed_deposit_accounts = (
            (_normalize_allowed_deposit_account_ids(db, list(vals_da)) if vals_da else []) or None
        )

    if explicit_keys & {
        "payment_method_id",
        "deposit_account_id",
        "allowed_payment_methods",
        "allowed_deposit_accounts",
    }:
        _sync_sale_allowlists_denormalized(db, sale)

    if "notes" in explicit_keys:
        sale.notes = raw["notes"]

    if "currency" in explicit_keys:
        sale.currency = (raw["currency"] or "USD").upper()
    if "exchange_rate" in explicit_keys:
        sale.exchange_rate = float(raw["exchange_rate"])
    if "local_amount" in explicit_keys:
        sale.local_amount = raw["local_amount"]

    if "local_amount" in explicit_keys or "exchange_rate" in explicit_keys:
        la = sale.local_amount
        er = sale.exchange_rate
        if la is None or er is None or float(er) <= 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Monto local y tasa inválidos.")
        sale.amount = Decimal(str(round(float(la) / float(er), 4)))

    if "amount_paid" in explicit_keys:
        la_pd = sale.local_amount
        if la_pd is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Monto local inválido para importe pagado.",
            )
        sale.amount_paid = _normalize_amount_paid(la_pd, raw["amount_paid"])
    # Al cambiar local_amount sin proveer amount_paid explícito NO se reinicia el cobro.

    inv_patch_keys = {
        "inventory_channel",
        "provider",
        "screen_stock_inventory_provider",
        "package",
        "credits_quantity",
        "screen_stock_id",
        "selected_screen_id",
        "screen_stock_batch_id",
        "inventory_screen_units",
        "product_id",
    }
    if explicit_keys & inv_patch_keys:
        _apply_pending_sale_inventory_update(db, sale, raw, explicit_keys)

    inv_cost = _inventory_cost_usd_for_pending_sale(db, sale)
    _validate_sale_amount_vs_inventory_cost(
        amount_usd=sale.amount,
        inventory_cost_usd=inv_cost,
    )

    if receipt_uploaded_url is not None:
        sale.receipt_url = receipt_uploaded_url
    elif receipt_clear_requested:
        sale.receipt_url = None

    if tag_ids_explicit:
        _sync_sale_tags(db, sale, list(tag_ids_val or []))

    _assert_sale_deposit_currency(db, sale)
    _sync_sale_accounting_after_panel_patch(db, sale, strict=True)

    ich_pd = (sale.inventory_channel or "").strip() or _effective_inventory_channel(sale)
    if ich_pd in ("screen_stock", "mixed") and sale.invoice_lines:
        sale.invoice_lines = _invoice_lines_prepare_for_storage(
            list(sale.invoice_lines),
            inventory_channel=ich_pd,
        )
    _sync_screen_stock_client_ids_for_pending_sale(db, sale)
    cli_fc = db.get(Client, sale.client_id)
    if cli_fc is not None and _effective_inventory_channel(sale) in ("full_credits", "mixed"):
        _sync_client_last_iptv_from_full_credit_sale(db, cli_fc, sale)

    db.commit()
    db.refresh(sale)

    client = db.get(Client, sale.client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="Cliente no encontrado.")
    product = db.get(Product, sale.product_id) if sale.product_id else None

    screen = (
        db.query(IPTVScreen)
        .options(joinedload(IPTVScreen.iptv_account))
        .filter(IPTVScreen.id == sale.iptv_screen_id)
        .first()
        if sale.iptv_screen_id
        else None
    )

    stock = db.get(ScreenStock, sale.screen_stock_id) if sale.screen_stock_id else None

    return _build_response(sale, client, screen, product, stock_row=stock, db=db)


@router.delete("/{sale_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_pending_sale(sale_id: int, db: DbDep) -> None:
    """Elimina una venta pendiente y libera pantallas ``reserved`` ligadas a la venta."""
    expire_pending_sales_if_needed(db)
    sale = db.get(Sale, sale_id)
    if sale is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Venta no encontrada.")
    if sale.status not in (SaleStatus.pending, SaleStatus.payment_submitted, SaleStatus.expired):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Solo se pueden eliminar ventas pendientes, en revisión o caducadas.",
        )

    _safe_release_pending_sale_inventory(db, sale, context="eliminar venta")

    sync_sale_accounting_ledgers(db, sale, strict=False)
    db.delete(sale)
    db.commit()


def _effective_inventory_channel(sale: Sale) -> str:
    """
    Canal ERP guardado o inferido (filas antiguas sin ``inventory_channel``).

    - ``legacy``: link público u otras ventas sin bodega/créditos ERP.
    """
    ch = (sale.inventory_channel or "").strip()
    if ch == "mixed":
        return "mixed"
    if ch in ("full_credits", "screen_stock"):
        return ch
    if sale.screen_stock_id is not None:
        return "screen_stock"
    try:
        cq = float(sale.credits_quantity or 0)
    except (TypeError, ValueError):
        cq = 0.0
    if cq > 1e-12:
        if sale.product_id is not None:
            return "full_credits"
        if (sale.inventory_provider or "").strip():
            return "full_credits"
    return "legacy"




def _release_screen_stock_if_held(db: Session, stock_id: Optional[int]) -> None:
    if stock_id is None:
        return
    row = db.get(ScreenStock, stock_id)
    if row is not None and row.status in ("held", "reserved"):
        row.status = "free"


def _inventory_cost_usd_for_pending_sale(db: Session, sale: Sale) -> Optional[Decimal]:
    eff = _effective_inventory_channel(sale)
    totals: list[Decimal] = []

    if eff in ("full_credits", "mixed"):
        prov_fc = (sale.inventory_provider or "").strip()
        qty_fc = float(sale.credits_quantity or 0)
        if qty_fc > 1e-12 and prov_fc:
            prod_fc = db.get(Product, sale.product_id) if sale.product_id else None
            c_fc = _full_credits_inventory_cost_usd(db, prov_fc, qty_fc, catalog_product=prod_fc)
            if c_fc is not None and c_fc > 0:
                totals.append(c_fc)

    if eff in ("screen_stock", "mixed"):
        rows_sg = list(
            db.query(ScreenStock)
            .filter(ScreenStock.sale_id == sale.id)
            .order_by(ScreenStock.created_at.asc(), ScreenStock.id.asc())
            .all()
        )
        if not rows_sg and sale.screen_stock_id:
            single_sg = db.get(ScreenStock, sale.screen_stock_id)
            if single_sg is not None:
                rows_sg.append(single_sg)
        if rows_sg:
            sg_parts: list[Decimal] = []
            for row in rows_sg:
                u = _screen_stock_unit_cost_usd(row, db=db)
                if u is None:
                    return None
                sg_parts.append(u)
            totals.append(sum(sg_parts, Decimal("0")))

    if not totals:
        return None
    return sum(totals, Decimal("0"))


def _pick_free_screen_stock_row(db: Session, provider: str, package: str) -> ScreenStock:
    return _fifo_pick_free_screen_stock_rows(db, provider, package, 1)[0]


def _apply_pending_sale_inventory_update(db: Session, sale: Sale, raw: dict[str, Any], explicit: set[str]) -> None:
    """Actualiza canal ERP / bodega / créditos cuando el PATCH incluye algún campo de inventario."""
    eff = _effective_inventory_channel(sale)
    if eff == "legacy":
        inv_any = {
            "inventory_channel",
            "provider",
            "package",
            "credits_quantity",
            "screen_stock_id",
            "selected_screen_id",
            "screen_stock_batch_id",
        }
        if explicit & inv_any:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Esta venta no permite cambiar inventario desde el panel.",
            )
        return

    if eff == "mixed":
        inv_blocked = {
            "inventory_channel",
            "provider",
            "screen_stock_inventory_provider",
            "package",
            "credits_quantity",
            "screen_stock_id",
            "selected_screen_id",
            "screen_stock_batch_id",
            "inventory_screen_units",
            "product_id",
        }
        if explicit & inv_blocked:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Las ventas con inventario mixto (créditos + bodega) no permiten cambiar "
                    "inventario ni proveedor/paquete desde este formulario."
                ),
            )
        return

    want_ch = raw["inventory_channel"] if "inventory_channel" in explicit else eff
    if want_ch not in ("full_credits", "screen_stock"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Canal de inventario inválido.")

    prov_src = raw["provider"] if "provider" in explicit else sale.inventory_provider
    pkg_src = raw["package"] if "package" in explicit else sale.inventory_package
    cq_src = raw["credits_quantity"] if "credits_quantity" in explicit else sale.credits_quantity

    prov = (prov_src or "").strip()
    pkg = (pkg_src or "").strip()

    if want_ch == "full_credits":
        cq = float(cq_src or 0)
        if cq <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Indica cantidad de créditos válida (> 0).",
            )
        if not prov:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Proveedor IPTV obligatorio.")
        pid_cap_opt: Optional[int] = None
        if "product_id" in explicit:
            praw = raw.get("product_id")
            if praw is not None and str(praw).strip() != "":
                try:
                    v = int(praw)
                except (TypeError, ValueError):
                    v = 0
                if v >= 1:
                    pid_cap_opt = v
        elif sale.product_id is not None:
            pid_cap_opt = int(sale.product_id)

        prod_cap: Optional[Product] = db.get(Product, pid_cap_opt) if pid_cap_opt else None
        remaining = _remaining_full_credits_for_payload(
            db,
            provider=prov,
            product=prod_cap,
            exclude_sale_id=sale.id,
        )
        if cq > remaining + 1e-6:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Créditos insuficientes para este producto: disponibles {remaining:.4f}."
                    if prod_cap is not None
                    else f"Créditos insuficientes para {prov}: disponibles {remaining:.4f}."
                ),
            )
        _release_all_screen_stock_for_pending_sale(db, sale)
        sale.inventory_package = None
        sale.inventory_channel = "full_credits"
        sale.inventory_provider = prov
        if prod_cap is not None:
            prev_cq = float(sale.credits_quantity or 0) if eff == "full_credits" else 0.0
            delta_cq = cq - prev_cq
            if abs(delta_cq) > 1e-9:
                _product_credit_reserved_adjust(db, int(prod_cap.id), delta_cq)
        sale.credits_quantity = cq
        return

    if not pkg:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Paquete de bodega obligatorio.")
    if not prov:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Proveedor IPTV obligatorio.")

    if eff == "full_credits" and sale.product_id:
        _release_pending_sale_catalog_credit_reservation(db, sale)

    units = int(sale.inventory_screen_units or 1)
    if "inventory_screen_units" in explicit:
        units = max(1, min(200, int(raw["inventory_screen_units"])))
        sale.inventory_screen_units = units

    sid_explicit = None
    if "screen_stock_id" in explicit:
        sid_explicit = raw.get("screen_stock_id")
    elif "selected_screen_id" in explicit:
        sid_explicit = raw.get("selected_screen_id")

    if sid_explicit is not None:
        row = _maybe_with_for_update(
            db.query(ScreenStock).filter(ScreenStock.id == sid_explicit),
            db,
        ).first()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pantalla de bodega no encontrada.")
        if (row.provider or "").strip().lower() != prov.lower() or (row.package or "").strip().lower() != pkg.lower():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La pantalla no coincide con proveedor/paquete.",
            )
        if row.status not in ("free", "reserved", "held"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Pantalla no disponible (estado {row.status!r}).",
            )
        if row.status == "free" and row.sale_id is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La pantalla libre tiene una venta asociada inconsistente; revisa inventario.",
            )
        if row.status in ("reserved", "held") and row.sale_id is not None and row.sale_id != sale.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La pantalla está reservada por otra venta.",
            )
        if row.status in ("reserved", "held") and row.sale_id is None and sale.screen_stock_id != row.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La pantalla está reservada por otra venta.",
            )
        _release_all_screen_stock_for_pending_sale(db, sale)
        if row.status == "free":
            row.status = "reserved"
        row.sale_id = sale.id
        row.client_id = sale.client_id
        sale.screen_stock_id = row.id
        sale.inventory_screen_units = 1
        sale.inventory_channel = "screen_stock"
        sale.inventory_provider = prov
        sale.inventory_package = pkg
        sale.credits_quantity = None
        return

    cur_id = sale.screen_stock_id
    cur_row = db.get(ScreenStock, cur_id) if cur_id else None
    if (
        units == 1
        and cur_row is not None
        and cur_row.status in ("reserved", "held")
        and (cur_row.sale_id == sale.id or cur_row.sale_id is None)
        and (cur_row.provider or "").strip() == prov
        and (cur_row.package or "").strip() == pkg
    ):
        cur_row.client_id = sale.client_id
        sale.inventory_channel = "screen_stock"
        sale.inventory_provider = prov
        sale.inventory_package = pkg
        sale.credits_quantity = None
        return

    _release_all_screen_stock_for_pending_sale(db, sale)
    batch_for_fifo: Optional[str] = None
    if "screen_stock_batch_id" in explicit:
        b = raw.get("screen_stock_batch_id")
        if isinstance(b, str) and b.strip():
            batch_for_fifo = b.strip()
    fifo_patch_pid: Optional[int] = None
    if sale.product_id is not None and int(sale.product_id) >= 1:
        fifo_patch_pid = int(sale.product_id)
    picked = _pick_free_screen_stock_for_pending_sale(
        db,
        provider=prov,
        package=pkg,
        qty=units,
        product_id=fifo_patch_pid,
        batch_id=batch_for_fifo,
    )
    _bind_screen_stock_rows_to_pending_sale(db, sale, picked)
    sale.screen_stock_id = picked[0].id
    sale.inventory_channel = "screen_stock"
    sale.inventory_provider = prov
    sale.inventory_package = pkg
    sale.credits_quantity = None


def _reject_pending_sale_record(
    db: Session,
    sale_id: int,
    rejection_reason: str,
    *,
    rejection_image_url: Optional[str] = None,
) -> SaleResponse:
    sale = (
        db.query(Sale)
        .options(
            joinedload(Sale.client),
            joinedload(Sale.product),
            joinedload(Sale.screen).joinedload(IPTVScreen.iptv_account),
            joinedload(Sale.screen_stock_row),
            joinedload(Sale.payment_method),
            joinedload(Sale.tags),
        )
        .filter(Sale.id == sale_id)
        .first()
    )
    if sale is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Venta con id {sale_id} no encontrada.",
        )
    if sale.status not in SALE_HOLD_INVENTORY_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Solo se pueden rechazar ventas pendientes o con comprobante enviado (en revisión).",
        )
    reason = (rejection_reason or "").strip()
    if not reason:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El motivo del rechazo es obligatorio.",
        )
    sale.rejection_reason = reason[:2000]
    url = (rejection_image_url or "").strip()
    sale.rejection_image_url = url[:512] if url else None

    _safe_release_pending_sale_inventory(
        db, sale, clear_credentials=True, context="rechazar venta"
    )

    try:
        void_sale_accounting_state(
            db,
            sale,
            reason=(reason[:500] if reason else f"Rechazo venta FAC-{int(sale.id):04d}"),
        )
    except (HTTPException, ValueError) as exc:
        raise
    except Exception as exc:
        logger.warning(
            "Error contable al rechazar venta %s: %s",
            sale_id,
            exc,
            exc_info=True,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="No se pudo revertir la contabilidad de la venta.",
        ) from exc

    sale.status = SaleStatus.rejected

    db.commit()
    db.refresh(sale)

    client = db.get(Client, sale.client_id)
    if client is None:
        raise HTTPException(status_code=500, detail="Cliente inconsistente.")
    product = db.get(Product, sale.product_id) if sale.product_id else None
    screen = (
        db.query(IPTVScreen)
        .options(joinedload(IPTVScreen.iptv_account))
        .filter(IPTVScreen.id == sale.iptv_screen_id)
        .first()
        if sale.iptv_screen_id
        else None
    )
    stock = db.get(ScreenStock, sale.screen_stock_id) if sale.screen_stock_id else None
    return _build_response(sale, client, screen, product, stock_row=stock, db=db)


def _annul_approved_sale_record(db: Session, sale_id: int) -> SaleResponse:
    """Cancela una venta ya activada: inventario vuelve a disponible y asiento contable eliminado."""
    sale = (
        db.query(Sale)
        .options(
            joinedload(Sale.client),
            joinedload(Sale.product),
            joinedload(Sale.screen).joinedload(IPTVScreen.iptv_account),
            joinedload(Sale.screen_stock_row),
            joinedload(Sale.payment_method),
            joinedload(Sale.tags),
        )
        .filter(Sale.id == sale_id)
        .first()
    )
    if sale is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Venta con id {sale_id} no encontrada.",
        )
    if sale.status != SaleStatus.approved:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Solo se pueden cancelar ventas activadas.",
        )
    cli = sale.client if sale.client else db.get(Client, sale.client_id)
    _reverse_approved_sale_inventory(db, sale, target=SaleStatus.annulled)
    if cli is not None:
        _reverse_client_sale_activation(cli, sale)

    void_sale_accounting_state(
        db,
        sale,
        reason=f"Anulación venta FAC-{int(sale.id):04d}",
    )

    sale.status = SaleStatus.annulled
    db.commit()
    db.refresh(sale)

    client = db.get(Client, sale.client_id)
    if client is None:
        raise HTTPException(status_code=500, detail="Cliente inconsistente.")
    product = db.get(Product, sale.product_id) if sale.product_id else None
    screen = (
        db.query(IPTVScreen)
        .options(joinedload(IPTVScreen.iptv_account))
        .filter(IPTVScreen.id == sale.iptv_screen_id)
        .first()
        if sale.iptv_screen_id
        else None
    )
    stock = db.get(ScreenStock, sale.screen_stock_id) if sale.screen_stock_id else None
    return _build_response(sale, client, screen, product, stock_row=stock, db=db)


def _approve_pending_payment_events(sale: Sale) -> None:
    """Marca como 'Aprobado' todos los eventos de pago que estén 'En revisión'."""
    if not isinstance(sale.payment_events, list):
        return
    updated = []
    changed = False
    for ev in sale.payment_events:
        if isinstance(ev, dict) and ev.get("status") == "En revisión":
            ev = dict(ev, status="Aprobado")
            changed = True
        updated.append(ev)
    if changed:
        sale.payment_events = updated


def _sale_inventory_already_fulfilled(db: Session, sale: Sale) -> bool:
    """
    True si el inventario/créditos ya se entregaron en una activación previa.
    En ese caso un comprobante posterior es solo cobro CxC (sin reservas ni drawdown nuevo).
    """
    if sale.iptv_screen_id is not None:
        return True
    dd = (
        db.query(InventoryScreenCreditDrawdown)
        .filter(InventoryScreenCreditDrawdown.sale_id == int(sale.id))
        .first()
    )
    if dd is not None:
        return True
    assigned = (
        db.query(ScreenStock)
        .filter(
            ScreenStock.sale_id == int(sale.id),
            ScreenStock.status == SCREEN_STOCK_STATUS_ASSIGNED,
        )
        .first()
    )
    return assigned is not None


def _sale_staff_review_action(db: Session, sale: Sale) -> str:
    """``activate`` = aprovisionar inventario; ``approve_payment`` = solo aprobar cobro."""
    if sale.status == SaleStatus.pending:
        return "activate"
    if sale.status in (SaleStatus.payment_submitted, SaleStatus.partially_paid):
        if _sale_inventory_already_fulfilled(db, sale):
            return "approve_payment"
        return "activate"
    return "activate"


def _finalize_sale_payment_approval_only(
    db: Session,
    sale: Sale,
    client: Client,
) -> SaleResponse:
    """
    Aprueba comprobantes CxC vinculados sin tocar inventario ni reservas de catálogo.
    Usado cuando la venta ya fue activada y el cliente envía un abono adicional.
    """
    if sale.status not in (SaleStatus.payment_submitted, SaleStatus.partially_paid):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Esta venta no tiene un comprobante de abono pendiente de revisión.",
        )

    approve_pending_linked_client_payments_for_sale(db, sale, strict_accounting=True)
    db.refresh(sale)
    _approve_pending_payment_events(sale)
    _maybe_set_partially_paid(sale)

    try:
        sync_sale_accounting_ledgers(db, sale, strict=False, strict_cogs=False)
        db.commit()
    except HTTPException as exc:
        db.rollback()
        traceback.print_exc()
        logger.error("Aprobar pago venta id=%s HTTP %s: %s", sale.id, exc.status_code, exc.detail)
        raise
    except Exception as exc:
        db.rollback()
        traceback.print_exc()
        logger.exception("Error al aprobar pago venta id=%s: %s", sale.id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    db.refresh(sale)
    db.refresh(client)

    product = sale.product if sale.product_id else None
    if product is None and sale.product_id:
        product = db.get(Product, sale.product_id)
    stock = sale.screen_stock_row
    if stock is None and sale.screen_stock_id:
        stock = db.get(ScreenStock, sale.screen_stock_id)
    screen_resp = sale.screen
    if screen_resp is None and sale.iptv_screen_id:
        screen_resp = (
            db.query(IPTVScreen)
            .options(joinedload(IPTVScreen.iptv_account))
            .filter(IPTVScreen.id == sale.iptv_screen_id)
            .first()
        )
    return _build_response(sale, client, screen_resp, product, stock_row=stock, db=db)


def _maybe_set_partially_paid(sale: Sale) -> None:
    """
    Sincroniza el estado de pago para ventas ya activadas:
    - Si amount_paid < total → partially_paid (CxC pendiente).
    - Si amount_paid >= total (y era partially_paid) → approved (saldado).
    Llamar después de cambiar amount_paid o al activar por primera vez.
    """
    try:
        paid = Decimal(str(sale.amount_paid or 0))
        raw_lines = sale.invoice_lines if isinstance(sale.invoice_lines, list) else []
        if raw_lines:
            total = sum(
                Decimal(str(ln.get("qty") or ln.get("quantity") or 1))
                * Decimal(str(ln.get("rate") or ln.get("price") or ln.get("unit_price") or 0))
                for ln in raw_lines
            )
        else:
            total = Decimal(str(sale.local_amount or sale.amount or 0))
        if total <= Decimal("0.01"):
            return  # sin total conocido, no tocar el estado
        if paid >= total - Decimal("0.005"):
            if sale.status in (SaleStatus.partially_paid, SaleStatus.payment_submitted, SaleStatus.pending):
                sale.status = SaleStatus.approved
        elif paid < total - Decimal("0.005"):
            if sale.status in (SaleStatus.pending, SaleStatus.payment_submitted):
                sale.status = SaleStatus.partially_paid
            elif sale.status == SaleStatus.approved:
                sale.status = SaleStatus.partially_paid
    except Exception:
        pass


def _activate_sale_record(db: Session, sale_id: int) -> SaleResponse:
    expire_pending_sales_if_needed(db)
    sale = (
        db.query(Sale)
        .options(
            joinedload(Sale.client),
            joinedload(Sale.product),
            joinedload(Sale.screen).joinedload(IPTVScreen.iptv_account),
            joinedload(Sale.screen_stock_row),
        )
        .filter(Sale.id == sale_id)
        .first()
    )
    if sale is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Venta con id {sale_id} no encontrada.",
        )
    if sale.status == SaleStatus.approved:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="La venta ya está activada.",
        )
    if sale.status not in SALE_HOLD_INVENTORY_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Solo se pueden activar ventas pendientes o aquellas donde el cliente "
                "ya envió el comprobante («en revisión»)."
            ),
        )

    client = sale.client if sale.client else db.get(Client, sale.client_id)
    if client is None:
        raise HTTPException(status_code=500, detail="Cliente inconsistente.")

    # Venta ya activada: comprobante adicional → solo cobro CxC (sin inventario).
    if sale.status != SaleStatus.pending and _sale_inventory_already_fulfilled(db, sale):
        if sale.status in (SaleStatus.payment_submitted, SaleStatus.partially_paid):
            return _finalize_sale_payment_approval_only(db, sale, client)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="La venta ya está activada; no requiere aprovisionamiento de inventario.",
        )

    product = sale.product if sale.product_id else None
    if product is None and sale.product_id:
        product = db.get(Product, sale.product_id)
    activated_screen: Optional[IPTVScreen] = None
    status_before_activation = sale.status

    try:
        eff = _effective_inventory_channel(sale)
        logger.info(
            "Activando venta id=%s status=%s canal=%s product_id=%s credits=%s",
            sale_id,
            sale.status,
            eff,
            sale.product_id,
            sale.credits_quantity,
        )

        if eff == "full_credits":
            prov = (sale.inventory_provider or "").strip()
            if not prov and product is not None:
                prov = (product.iptv_provider or "").strip()
            need = float(sale.credits_quantity or 0)
            if need <= 0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Esta venta no tiene cantidad de créditos válida.",
                )
            remaining_fc = _remaining_full_credits_for_payload(
                db,
                provider=prov,
                product=product if product else None,
                exclude_sale_id=sale.id,
            )
            if need > remaining_fc + 1e-6:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"Créditos insuficientes para este producto: disponibles {remaining_fc:.4f}."
                        if product is not None
                        else f"Créditos insuficientes para {prov}: disponibles {remaining_fc:.4f}."
                    ),
                )
            dd_existing = (
                db.query(InventoryScreenCreditDrawdown)
                .filter(InventoryScreenCreditDrawdown.sale_id == sale.id)
                .first()
            )
            if dd_existing is None:
                db.add(
                    InventoryScreenCreditDrawdown(
                        provider=prov or "catalog",
                        credits_units=float(need),
                        batch_id=str(uuid.uuid4()),
                        sale_id=sale.id,
                    )
                )
            if product is not None:
                _product_credit_reserved_adjust(db, int(product.id), -need)
                _product_credit_assigned_adjust(db, int(product.id), need)
            sale.status = SaleStatus.approved
            _sync_client_after_sale(client, sale)
            _sync_client_last_iptv_from_full_credit_sale(db, client, sale)

        elif eff == "mixed":
            cred_prov_mx = (sale.inventory_provider or "").strip()
            need_mx = float(sale.credits_quantity or 0)
            if need_mx <= 0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Venta mixta sin cantidad de créditos válida.",
                )
            remaining_m = _remaining_full_credits_for_payload(
                db,
                provider=cred_prov_mx,
                product=product if product else None,
                exclude_sale_id=sale.id,
            )
            if need_mx > remaining_m + 1e-6:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"Créditos insuficientes para este producto: disponibles {remaining_m:.4f}."
                        if product is not None
                        else f"Créditos insuficientes para {cred_prov_mx}: disponibles {remaining_m:.4f}."
                    ),
                )
            dd_mix = (
                db.query(InventoryScreenCreditDrawdown)
                .filter(InventoryScreenCreditDrawdown.sale_id == sale.id)
                .first()
            )
            if dd_mix is None:
                db.add(
                    InventoryScreenCreditDrawdown(
                        provider=cred_prov_mx,
                        credits_units=float(need_mx),
                        batch_id=str(uuid.uuid4()),
                        sale_id=sale.id,
                    )
                )
            if product is not None:
                _product_credit_reserved_adjust(db, int(product.id), -need_mx)
                _product_credit_assigned_adjust(db, int(product.id), need_mx)

            _jit_assign_screen_stock_for_activation(db, sale)
            _confirm_screen_stock_reserved_rows_on_activation(db, sale)

            sale.status = SaleStatus.approved
            _sync_client_after_sale(client, sale)
            _sync_client_last_iptv_from_full_credit_sale(db, client, sale)

        elif eff == "screen_stock":
            _jit_assign_screen_stock_for_activation(db, sale)
            bound = _fifo_screen_stock_rows_bound_to_sale(db, sale)
            if not bound:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="No hay pantallas disponibles en bodega.",
                )
            head = bound[0]
            if not (sale.inventory_package or "").strip():
                sale.inventory_package = (head.package or "").strip()
            if not (sale.inventory_provider or "").strip():
                sale.inventory_provider = (head.provider or "").strip()
            if not sale.screen_stock_id:
                sale.screen_stock_id = int(head.id)

            _confirm_screen_stock_reserved_rows_on_activation(db, sale)

            sale.status = SaleStatus.approved
            _sync_client_after_sale(client, sale)

        else:
            screen: Optional[IPTVScreen] = _maybe_with_for_update(
                db.query(IPTVScreen)
                .join(IPTVAccount, IPTVScreen.iptv_account_id == IPTVAccount.id)
                .filter(IPTVScreen.is_available == True),  # noqa: E712
                db,
            ).first()
            if screen is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="No hay pantallas IPTV disponibles. Activa la venta cuando haya stock.",
                )

            screen.is_available = False
            screen.client_id = sale.client_id
            sale.iptv_screen_id = screen.id
            sale.status = SaleStatus.approved
            _sync_client_after_sale(client, sale)
            activated_screen = screen

        # Inventario y estado persistidos en sesión antes de contabilidad.
        db.flush()
        logger.info(
            "Inventario aplicado venta id=%s → status=%s (antes=%s)",
            sale_id,
            sale.status,
            status_before_activation,
        )

        if status_before_activation in (
            SaleStatus.pending,
            SaleStatus.payment_submitted,
            SaleStatus.partially_paid,
        ):
            approve_pending_linked_client_payments_for_sale(db, sale, strict_accounting=True)
            db.flush()
            db.refresh(sale)

        _approve_pending_payment_events(sale)
        if sale.status in (SaleStatus.approved, SaleStatus.partially_paid):
            _maybe_set_partially_paid(sale)

        sync_sale_accounting_ledgers(db, sale, strict=True, strict_cogs=False)
        from app.services.client_payment_service import try_sweep_client_credit_on_new_cxc

        try_sweep_client_credit_on_new_cxc(
            db,
            client,
            currency=str(sale.currency or "USD"),
            strict_accounting=False,
        )
        db.commit()
    except HTTPException as exc:
        db.rollback()
        traceback.print_exc()
        logger.error("Activación venta id=%s HTTP %s: %s", sale_id, exc.status_code, exc.detail)
        raise
    except Exception as exc:
        db.rollback()
        traceback.print_exc()
        logger.exception("Error al activar venta id=%s: %s", sale_id, exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    db.refresh(sale)
    db.refresh(client)
    if sale.screen_stock_id:
        r = db.get(ScreenStock, sale.screen_stock_id)
        if r:
            db.refresh(r)
    elif activated_screen:
        db.refresh(activated_screen)
        iptv_loaded = (
            db.query(IPTVScreen)
            .options(joinedload(IPTVScreen.iptv_account))
            .filter(IPTVScreen.id == activated_screen.id)
            .first()
        )
        return _build_response(sale, client, iptv_loaded, product, stock_row=sale.screen_stock_row, db=db)

    screen_resp = sale.screen
    if screen_resp is None and sale.iptv_screen_id:
        screen_resp = (
            db.query(IPTVScreen)
            .options(joinedload(IPTVScreen.iptv_account))
            .filter(IPTVScreen.id == sale.iptv_screen_id)
            .first()
        )

    stock = sale.screen_stock_row
    if stock is None and sale.screen_stock_id:
        stock = db.get(ScreenStock, sale.screen_stock_id)

    return _build_response(sale, client, screen_resp, product, stock_row=stock, db=db)


@router.post(
    "/webhook/simulate",
    response_model=WebhookSimulateResponse,
    tags=["public"],
    summary="Webhook simulado: procesa un pago automático por link único del cliente",
)
def webhook_simulate(payload: WebhookSimulatePayload, db: DbDep) -> WebhookSimulateResponse:
    """
    Endpoint público (sin token JWT).  Simula la notificación de un gateway de pago:
    busca al cliente por su payment_token, asigna la primera pantalla disponible
    (cualquier proveedor) y registra la venta.
    """
    client: Optional[Client] = (
        db.query(Client)
        .filter(Client.payment_token == payload.payment_link_id)
        .first()
    )
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Link de pago no válido.",
        )

    screen: Optional[IPTVScreen] = _maybe_with_for_update(
        db.query(IPTVScreen)
        .join(IPTVAccount, IPTVScreen.iptv_account_id == IPTVAccount.id)
        .filter(IPTVScreen.is_available == True),  # noqa: E712
        db,
    ).first()

    if screen is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No hay pantallas disponibles en este momento. Contacta con soporte.",
        )

    screen.is_available = False
    screen.client_id = client.id

    sale = Sale(
        client_id=client.id,
        iptv_screen_id=screen.id,
        amount=payload.amount,
        currency=payload.currency,
        exchange_rate=1.0,
        local_amount=payload.amount,
        amount_paid=payload.amount,
        status=SaleStatus.approved,
        payment_token=uuid.uuid4(),
        inventory_screen_units=1,
    )
    db.add(sale)
    db.flush()
    _sync_client_after_sale(client, sale)
    sync_sale_accounting_ledgers(db, sale)
    db.commit()
    db.refresh(sale)
    db.refresh(screen)

    provider = screen.iptv_account.provider_name if screen.iptv_account else "Desconocido"

    return WebhookSimulateResponse(
        success=True,
        message=f"¡Pago procesado! Se asignó una pantalla de {provider} a {client.display_name()}.",
        sale_id=sale.id,
        provider=provider,
    )


@router.post(
    "/public/{payment_link_id}/report",
    response_model=SaleResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["public"],
    summary="Reportar pago manual con comprobante (endpoint público)",
)
def public_report_payment(
    payment_link_id: str,
    payload: PublicSaleReport,
    db: DbDep,
) -> SaleResponse:
    """
    Endpoint público.  El cliente reporta un pago manual adjuntando la URL del
    comprobante.  La venta se crea con status='pending' y NO se asigna pantalla
    todavía; el administrador deberá activarla manualmente.
    """
    import uuid as _uuid

    try:
        token = _uuid.UUID(payment_link_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El link de pago no tiene un formato válido.",
        )

    client: Optional[Client] = (
        db.query(Client).filter(Client.payment_token == token).first()
    )
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Link de pago no válido.",
        )

    sale = Sale(
        client_id=client.id,
        amount=payload.amount,
        currency=payload.currency,
        exchange_rate=1.0,
        local_amount=payload.amount,
        amount_paid=payload.amount,
        status=SaleStatus.pending,
        payment_token=uuid.uuid4(),
        receipt_url=payload.receipt_url,
        expires_at=_pending_sale_expires_at(),
        inventory_screen_units=1,
    )
    db.add(sale)
    db.flush()
    sync_sale_accounting_ledgers(db, sale)
    db.commit()
    notify_catalog_vip_sale_pending_payment(db, sale)
    db.refresh(sale)

    return _build_response(sale, client, None, None, stock_row=None, db=db)


# ── helper ────────────────────────────────────────────────────────────────────


def _resolve_iptv_username(client: Client, screen: Optional[IPTVScreen]) -> Optional[str]:
    """Usuario IPTV visible: preferir cuenta de la pantalla vendida; si no, usuario panel del cliente."""
    if screen is not None and screen.iptv_account is not None:
        u = (screen.iptv_account.username or "").strip()
        if u:
            return u
    u = (client.username or "").strip()
    return u or None


def _build_response(
    sale: Sale,
    client: Client,
    screen: Optional[IPTVScreen],
    product: Optional[Product] = None,
    *,
    stock_row: Optional[ScreenStock] = None,
    db: Optional[Session] = None,
) -> SaleResponse:
    credential = None
    if screen and screen.iptv_account:
        credential = ScreenCredential(
            screen_id=screen.id,
            screen_number=screen.screen_number,
            account_username=screen.iptv_account.username,
            account_password=screen.iptv_account.password,
            provider=screen.iptv_account.provider_name,
        )

    product_display: Optional[str] = None
    if product:
        product_display = product.name
    elif stock_row:
        product_display = f"{stock_row.provider} — {stock_row.package}"
    elif sale.inventory_channel == "screen_stock" and sale.inventory_package:
        prov = sale.inventory_provider or "—"
        product_display = f"{prov} — {sale.inventory_package}"
    elif sale.credits_quantity is not None and sale.inventory_provider:
        cq = sale.credits_quantity
        cq_fmt = cq if cq == int(cq) else round(cq, 4)
        product_display = f"{sale.inventory_provider} — Recarga total ({cq_fmt} créditos)"

    tags_linked = sale.tags or []
    tag_ids_list = sorted(t.id for t in tags_linked)
    tag_names_list = sorted((t.name or "").strip() for t in tags_linked if (t.name or "").strip())

    iptv_username = _resolve_iptv_username(client, screen)
    iptv_password_out: Optional[str] = None
    screen_delivery: Optional[list[ScreenStockSaleCredential]] = None
    if db is not None:
        d = _screen_stock_delivery_credentials(db, sale)
        if d:
            screen_delivery = d
            fst = d[0]
            if fst.iptv_username and (fst.iptv_username or "").strip():
                iptv_username = (fst.iptv_username or "").strip()
            fp = (fst.iptv_password or "").strip()
            iptv_password_out = fp if fp else None

    inv_lines_disp = _sale_invoice_lines_for_display(db, sale)
    fifo_cp_key_ui: Optional[str] = None
    if db is not None and getattr(sale, "inventory_channel", None) == "mixed":
        fifo_cp_key_ui = _fifo_cp_inventory_option_key_for_ui(db, sale)

    pm_label = None
    pm_rel = getattr(sale, "payment_method", None)
    if pm_rel is not None:
        pm_label = (pm_rel.name or "").strip() or None

    la_dec = sale.local_amount
    ap_raw = getattr(sale, "amount_paid", None)

    apm_r, ada_r = _sale_response_allowlist_fields(sale, pm_label)

    linked_raw = linked_payments_for_sale(db, sale.id) if db is not None else []
    linked_out = [LinkedPaymentOut(**row) for row in linked_raw]

    pending_review_raw: list[PendingReviewPaymentOut] = []
    pending_alloc_total = Decimal("0")
    # Pagos pending_review vinculados a esta factura (META_SALE_ID + depósito / recibo).
    if db is not None:
        sid_int = int(sale.id)
        for pr in _portal_pending_deposit_payments_for_sale(db, sale):
            allo = (
                db.query(PaymentAllocation)
                .filter(
                    PaymentAllocation.payment_id == int(pr.id),
                    PaymentAllocation.sale_id == sid_int,
                )
                .first()
            )
            amt_pay = Decimal(str(pr.amount or 0)).quantize(Decimal("0.0001"))
            if allo is not None:
                appl = Decimal(str(allo.amount_applied or 0)).quantize(Decimal("0.0001"))
            else:
                appl = amt_pay
            if appl > Decimal("0"):
                pending_alloc_total += appl
            pending_review_raw.append(
                PendingReviewPaymentOut(
                    payment_id=int(pr.id),
                    payment_number=pr.payment_number or "",
                    amount=float(Decimal(str(pr.amount or 0)).quantize(Decimal("0.01"))),
                    currency=str(pr.currency or "USD"),
                    payment_method=str(pr.payment_method or "").strip() or None,
                    receipt_file_url=str(pr.receipt_file_url or "").strip() or None,
                    created_at=pr.created_at,
                    amount_applied_to_sale=float(appl.quantize(Decimal("0.01"))),
                )
            )

    # ``balance_due``: total factura menos pagos ya aprobados y menos allocations pendientes en esta venta.
    # ``amount_paid_out`` sigue siendo solo lo aprobado (no «efectivo» del cliente hasta aprobar).
    if la_dec is None:
        amount_paid_out = Decimal(str(ap_raw)) if ap_raw is not None else Decimal("0")
        balance_due_out = Decimal("0")
    else:
        la_d = Decimal(str(la_dec))
        if linked_raw:
            effective_paid = sum(
                Decimal(str(row.get("amount_applied", 0))) for row in linked_raw
            ).quantize(Decimal("0.0001"))
        else:
            effective_paid = Decimal(str(ap_raw)).quantize(Decimal("0.0001")) if ap_raw is not None else Decimal("0")
        amount_paid_out = effective_paid
        balance_due_out = max(Decimal("0"), la_d - effective_paid - pending_alloc_total).quantize(
            Decimal("0.0001")
        )

    return SaleResponse(
        id=sale.id,
        payment_token=getattr(sale, "payment_token", None),
        client_id=sale.client_id,
        client_name=client.display_name(),
        client_email=str(client.email or ""),
        client_portal_token=str(client.payment_token),
        product_id=sale.product_id,
        product_name=product_display,
        amount=sale.amount,
        currency=sale.currency,
        exchange_rate=sale.exchange_rate,
        local_amount=sale.local_amount,
        amount_paid=amount_paid_out,
        balance_due=balance_due_out,
        status=sale.status.value,
        rejection_reason=(sale.rejection_reason or "").strip() or None,
        rejection_image_url=(getattr(sale, "rejection_image_url", None) or "").strip() or None,
        receipt_url=sale.receipt_url,
        created_at=sale.created_at,
        expires_at=getattr(sale, "expires_at", None),
        credential=credential,
        class_id=sale.class_id,
        payment_method_id=sale.payment_method_id,
        payment_method=pm_label,
        deposit_account_id=sale.deposit_account_id,
        allowed_payment_methods=apm_r,
        allowed_deposit_accounts=ada_r,
        inventory_channel=sale.inventory_channel,
        inventory_provider=sale.inventory_provider,
        inventory_package=sale.inventory_package,
        credits_quantity=sale.credits_quantity,
        screen_stock_id=sale.screen_stock_id,
        inventory_screen_units=int(getattr(sale, "inventory_screen_units", None) or 1),
        notes=sale.notes,
        tag_ids=tag_ids_list,
        tags=tag_names_list,
        iptv_username=iptv_username,
        iptv_password=iptv_password_out,
        screen_stock_delivery=screen_delivery,
        invoice_lines=inv_lines_disp,
        fifo_cp_inventory_key=fifo_cp_key_ui,
        linked_payments=linked_out,
        pending_review_payments=pending_review_raw,
        staff_review_action=_sale_staff_review_action(db, sale) if db is not None else "activate",
    )
