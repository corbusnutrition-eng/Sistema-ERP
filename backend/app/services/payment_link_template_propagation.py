"""Propaga links de plantillas a transacciones pendientes (recargas BaaS y ventas)."""

from __future__ import annotations

import logging
import re
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.payment_link_template import PaymentLinkTemplate
from app.models.payment_method import PaymentMethod
from app.models.sale import Sale, SaleStatus
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.wallet_recharge_helpers import REQ_STATUS_PENDING

logger = logging.getLogger(__name__)

_CN_KEY_RE = re.compile(r"^cn:(\d+)$", re.I)
_BALANCE_EPS = Decimal("0.0001")


def _invoice_line_dicts(sale: Sale) -> list[dict[str, Any]]:
    raw = sale.invoice_lines
    if not isinstance(raw, list):
        return []
    return [x for x in raw if isinstance(x, dict)]


def _recharge_has_payment_method(req: WalletRechargeRequest, payment_method_id: int) -> bool:
    raw = getattr(req, "allowed_payment_methods", None)
    if not isinstance(raw, list):
        return False
    target = int(payment_method_id)
    for item in raw:
        if item is None:
            continue
        try:
            if int(item) == target:
                return True
        except (TypeError, ValueError):
            continue
    return False


def _sale_has_payment_method(sale: Sale, payment_method_id: int, payment_method_name: str) -> bool:
    if sale.payment_method_id is not None and int(sale.payment_method_id) == int(payment_method_id):
        return True
    name_norm = str(payment_method_name or "").strip().lower()
    if not name_norm:
        return False
    raw = getattr(sale, "allowed_payment_methods", None)
    if not isinstance(raw, list):
        return False
    for item in raw:
        if item is None:
            continue
        if str(item).strip().lower() == name_norm:
            return True
    return False


def _sale_has_product_id(sale: Sale, product_id: int) -> bool:
    pid = int(product_id)
    if sale.product_id is not None and int(sale.product_id) == pid:
        return True
    for chunk in _invoice_line_dicts(sale):
        raw_pid = chunk.get("product_id")
        if raw_pid is not None:
            try:
                if int(raw_pid) == pid:
                    return True
            except (TypeError, ValueError):
                pass
        key = str(chunk.get("inventory_option_key") or "").strip()
        m = _CN_KEY_RE.match(key)
        if m and int(m.group(1)) == pid:
            return True
        if key.startswith("cp|"):
            head = key[3:].split("|", 1)[0].strip()
            if head.isdigit() and int(head) == pid:
                return True
    return False


def _sale_balance_due(sale: Sale) -> Decimal:
    la = sale.local_amount
    ap = sale.amount_paid
    try:
        la_d = Decimal(str(la)) if la is not None else Decimal("0")
    except Exception:
        la_d = Decimal("0")
    try:
        ap_d = Decimal(str(ap)) if ap is not None else Decimal("0")
    except Exception:
        ap_d = Decimal("0")
    return max(Decimal("0"), la_d - ap_d)


def _sale_eligible_for_link_propagation(sale: Sale) -> bool:
    """Ventas abiertas al portal con saldo por cubrir."""
    if sale.status == SaleStatus.pending:
        return True
    if sale.status == SaleStatus.partially_paid:
        return _sale_balance_due(sale) > _BALANCE_EPS
    return False


def _links_copy(links: Any) -> list[Any]:
    if not isinstance(links, list) or not links:
        return []
    return [dict(x) if isinstance(x, dict) else x for x in links]


def propagate_baas_pending_recharges(
    db: Session,
    payment_method_id: int,
    links: list[Any],
) -> int:
    """
    Sobrescribe ``hotmart_links`` en recargas BaaS con status ``pending`` que incluyan
    el método de pago (IDs en JSON ``allowed_payment_methods``).
    """
    links_out = _links_copy(links)
    if not links_out:
        return 0

    candidates = (
        db.query(WalletRechargeRequest)
        .filter(WalletRechargeRequest.status == REQ_STATUS_PENDING)
        .all()
    )
    updated = 0
    pm_id = int(payment_method_id)
    for req in candidates:
        if not _recharge_has_payment_method(req, pm_id):
            continue
        req.hotmart_links = links_out
        updated += 1

    if updated:
        db.commit()
        logger.info(
            "payment_link_template propagate BAAS pm_id=%s updated=%s",
            pm_id,
            updated,
        )
    return updated


def propagate_ventas_pending_sales(
    db: Session,
    payment_method_id: int,
    product_id: int,
    links: list[Any],
) -> int:
    """
    Sobrescribe ``hotmart_links`` en ventas pendientes / parcialmente pagadas con saldo,
    que tengan el método de pago en allowlist y el product_id en cabecera o líneas.
    """
    links_out = _links_copy(links)
    if not links_out:
        return 0

    pm = db.get(PaymentMethod, int(payment_method_id))
    pm_name = str(pm.name or "").strip() if pm is not None else ""
    pm_id = int(payment_method_id)
    pid = int(product_id)

    candidates = (
        db.query(Sale)
        .filter(Sale.status.in_([SaleStatus.pending, SaleStatus.partially_paid]))
        .all()
    )
    updated = 0
    for sale in candidates:
        if not _sale_eligible_for_link_propagation(sale):
            continue
        if not _sale_has_payment_method(sale, pm_id, pm_name):
            continue
        if not _sale_has_product_id(sale, pid):
            continue
        sale.hotmart_links = links_out
        updated += 1

    if updated:
        db.commit()
        logger.info(
            "payment_link_template propagate VENTAS pm_id=%s product_id=%s updated=%s",
            pm_id,
            pid,
            updated,
        )
    return updated


def propagate_payment_link_template(db: Session, template: PaymentLinkTemplate) -> dict[str, int]:
    """Ejecuta propagación según ``module_type`` de la plantilla guardada."""
    links = getattr(template, "links", None)
    if not isinstance(links, list) or not links:
        return {"baas_updated": 0, "sales_updated": 0}

    mod = str(getattr(template, "module_type", "") or "").strip().upper()
    pm_id = int(template.payment_method_id)

    if mod == "BAAS":
        n = propagate_baas_pending_recharges(db, pm_id, links)
        return {"baas_updated": n, "sales_updated": 0}

    if mod == "VENTAS" and template.product_id is not None:
        n = propagate_ventas_pending_sales(db, pm_id, int(template.product_id), links)
        return {"baas_updated": 0, "sales_updated": n}

    return {"baas_updated": 0, "sales_updated": 0}
