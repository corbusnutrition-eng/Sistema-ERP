"""
Sincronización con la plataforma web (Render) — catalogo-vip.

Usa cabecera ``X-Webhook-Secret`` compartida. Errores de red no bloquean el ERP;
solo se registran en logs.
"""
from __future__ import annotations

import logging
import os
from decimal import Decimal
from typing import Any, Literal, Optional

import requests
from sqlalchemy.orm import Session

from app.models.client import Client
from app.models.sale import Sale

logger = logging.getLogger(__name__)

DEFAULT_WEBHOOK_SECRET = "301985"
DEFAULT_CATALOGO_BASE = "https://catalogo-vip.onrender.com"

WebhookTipoCredito = Literal["normal", "pantalla", "billetera"]


def catalog_vip_webhook_secret() -> str:
    return (os.getenv("CATALOGO_VIP_WEBHOOK_SECRET") or DEFAULT_WEBHOOK_SECRET).strip()


def catalog_vip_base_url() -> str:
    return (os.getenv("CATALOGO_VIP_BASE_URL") or DEFAULT_CATALOGO_BASE).rstrip("/")


def default_temp_password_new_customer() -> str:
    return (os.getenv("CATALOGO_VIP_DEFAULT_TEMP_PASSWORD") or "123456").strip() or "123456"


def header_webhook_secret() -> dict[str, str]:
    return {"X-Webhook-Secret": catalog_vip_webhook_secret(), "Content-Type": "application/json"}


def verify_inbound_webhook_secret(raw: Optional[str]) -> bool:
    got = (raw or "").strip()
    return bool(got) and got == catalog_vip_webhook_secret()


def post_crear_cuenta_vip_remota(email: str, password_plain: str) -> None:
    url = f"{catalog_vip_base_url()}/api/crear-cuenta-vip-remota"
    em = email.strip().lower()
    payload: dict[str, Any] = {
        "email": em,
        "correo": em,
        "password": password_plain,
    }
    try:
        r = requests.post(url, json=payload, headers=header_webhook_secret(), timeout=12)
        if r.status_code >= 400:
            logger.warning(
                "catalogo-vip crear-cuenta-vip-remota HTTP %s: %s",
                r.status_code,
                (r.text or "")[:500],
            )
    except requests.RequestException:
        logger.exception("catalogo-vip crear-cuenta-vip-remota falló de red (email=%s)", email)


def post_nueva_venta_webhook(
    *,
    tipo_credito: WebhookTipoCredito,
    monto: Decimal | float,
    venta_id: int,
    client_email: Optional[str] = None,
    cliente_saldo_total_pendiente: Optional[float] = None,
    cliente_saldo_moneda: Optional[str] = None,
    deudas_pendientes: Optional[list[dict[str, Any]]] = None,
) -> None:
    url = f"{catalog_vip_base_url()}/api/webhook/nueva-venta"
    try:
        m = float(monto)
    except (TypeError, ValueError):
        m = 0.0
    payload: dict[str, Any] = {
        "tipo_credito": tipo_credito,
        "monto": m,
        "venta_id": venta_id,
        "sale_id": venta_id,
    }
    if client_email:
        payload["email_cliente"] = client_email.strip().lower()
        payload["correo"] = client_email.strip().lower()
    if cliente_saldo_total_pendiente is not None:
        payload["cliente_saldo_total_pendiente"] = round(float(cliente_saldo_total_pendiente), 2)
        payload["saldo_total_pendiente"] = payload["cliente_saldo_total_pendiente"]
    if cliente_saldo_moneda:
        cm = str(cliente_saldo_moneda).strip().upper()[:10]
        payload["cliente_saldo_moneda"] = cm
        payload["saldo_moneda"] = cm
    if deudas_pendientes is not None:
        payload["deudas_pendientes"] = deudas_pendientes
        payload["lista_maestra_deudas"] = deudas_pendientes
    try:
        r = requests.post(url, json=payload, headers=header_webhook_secret(), timeout=12)
        if r.status_code >= 400:
            logger.warning(
                "catalogo-vip nueva-venta HTTP %s: %s",
                r.status_code,
                (r.text or "")[:500],
            )
    except requests.RequestException:
        logger.exception("catalogo-vip nueva-venta falló de red (venta_id=%s)", venta_id)


def sale_tipo_credito_catalogo(sale: Sale) -> WebhookTipoCredito:
    ch = (sale.inventory_channel or "").strip().lower()
    if ch in ("full_credits",):
        return "normal"
    if ch in ("screen_stock", "mixed"):
        return "pantalla"
    return "billetera"


def notify_catalog_vip_sale_pending_payment(db: Session, sale: Sale) -> None:
    """Tras persistir venta pendiente donde el cliente debe pagar."""
    from app.services import render_sync
    from app.services.client_payment_service import compute_client_pending_balance

    tipo = sale_tipo_credito_catalogo(sale)
    monto_raw = sale.local_amount if sale.local_amount is not None else sale.amount
    c = db.get(Client, sale.client_id)
    email = (c.email or "").strip() if c else None
    cid = int(sale.client_id)
    bal = compute_client_pending_balance(db, cid)
    lines = render_sync.pending_debts_master_list_for_client(db, cid)
    post_nueva_venta_webhook(
        tipo_credito=tipo,
        monto=monto_raw or 0,
        venta_id=sale.id,
        client_email=email or None,
        cliente_saldo_total_pendiente=bal.get("total_pending_balance"),
        cliente_saldo_moneda=bal.get("pending_balance_currency"),
        deudas_pendientes=lines,
    )


def notify_catalog_vip_new_manual_customer(email: str) -> None:
    pw = default_temp_password_new_customer()
    post_crear_cuenta_vip_remota(email, pw)
