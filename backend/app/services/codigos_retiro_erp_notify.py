"""
Notificaciones ERP → sistema externo Códigos de Retiro.

Cuando un cobro CxC se aprueba y reduce el saldo de una venta, avisa al socio para que
cierre deudas firmes («No salió») vinculadas a la misma ``referencia_externa``.

Los envíos son en segundo plano (hilo daemon) y nunca interrumpen el flujo principal del ERP.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from decimal import Decimal
from typing import Any, Optional

import requests
from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client import Client
from app.models.client_payment import ClientPayment, PaymentAllocation
from app.models.sale import Sale
from app.models.wallet_recharge_request import WalletRechargeRequest
from app.schemas.codigos_retiro_erp_notify import CodigosRetiroErpPagoAprobadoOut

logger = logging.getLogger(__name__)

DEFAULT_CODIGOS_RETIRO_BASE = "https://codigos-retiro.onrender.com"
DEFAULT_NOTIFY_PATH = "/api/webhook/erp/pago-aprobado"
_FP_EPS = Decimal("0.00005")


def codigos_retiro_base_url() -> str:
    return (os.getenv("CODIGOS_RETIRO_BASE_URL") or DEFAULT_CODIGOS_RETIRO_BASE).rstrip("/")


def codigos_retiro_erp_notify_url() -> str:
    override = (os.getenv("CODIGOS_RETIRO_ERP_NOTIFY_URL") or "").strip()
    if override:
        return override.rstrip("/")
    path = (os.getenv("CODIGOS_RETIRO_ERP_NOTIFY_PATH") or DEFAULT_NOTIFY_PATH).strip()
    if not path.startswith("/"):
        path = f"/{path}"
    return f"{codigos_retiro_base_url()}{path}"


def codigos_retiro_erp_notify_api_key() -> str:
    return (
        os.getenv("CODIGOS_RETIRO_ERP_NOTIFY_API_KEY")
        or os.getenv("CODIGOS_RETIRO_WEBHOOK_API_KEY")
        or ""
    ).strip()


def codigos_retiro_erp_notify_enabled() -> bool:
    raw = (os.getenv("CODIGOS_RETIRO_ERP_NOTIFY_ENABLED") or "true").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return False
    return bool(codigos_retiro_erp_notify_api_key())


def codigos_retiro_es_prueba_default() -> bool:
    raw = (os.getenv("CODIGOS_RETIRO_ES_PRUEBA") or "").strip().lower()
    return raw in ("1", "true", "yes", "si", "sí", "on")


def format_sale_referencia_externa(sale_id: int) -> str:
    return f"FAC-{int(sale_id):04d}"


def format_wallet_recharge_referencia_rec(wallet_recharge_id: int) -> str:
    return f"REC-{int(wallet_recharge_id):05d}"


def _obligation_log_label(payload: CodigosRetiroErpPagoAprobadoOut) -> str:
    if payload.wallet_recharge_id is not None:
        return f"wallet_recharge_id={payload.wallet_recharge_id}"
    if payload.sale_id is not None:
        return f"sale_id={payload.sale_id}"
    return f"referencia_externa={payload.referencia_externa}"


def _client_retiro_label(client: Optional[Client]) -> str:
    if client is None:
        return "Cliente"
    name = str(getattr(client, "name", None) or "").strip()
    if name:
        return name
    username = str(getattr(client, "username", None) or "").strip()
    if username:
        return username
    email = str(getattr(client, "email", None) or "").strip()
    if email:
        return email
    return "Cliente"


def _notify_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    key = codigos_retiro_erp_notify_api_key()
    if key:
        headers["X-API-Key"] = key
    return headers


def post_codigos_retiro_erp_pago_aprobado(payload: CodigosRetiroErpPagoAprobadoOut) -> None:
    """POST síncrono al socio (uso interno / pruebas). Errores solo en logs."""
    if not codigos_retiro_erp_notify_enabled():
        logger.warning(
            "codigos-retiro ERP notify OMITIDO (deshabilitado o sin API key). "
            "Configure CODIGOS_RETIRO_ERP_NOTIFY_API_KEY o CODIGOS_RETIRO_WEBHOOK_API_KEY. "
            "%s payment_id=%s",
            _obligation_log_label(payload),
            payload.payment_id,
        )
        return

    url = codigos_retiro_erp_notify_url()
    body = payload.model_dump(mode="json")
    headers = _notify_headers()
    timeout = float(os.getenv("CODIGOS_RETIRO_ERP_NOTIFY_TIMEOUT") or "12")
    payload_json = json.dumps(body, ensure_ascii=False, default=str)

    logger.info(
        "codigos-retiro ERP pago-aprobado → POST %s | timeout=%ss | headers=%s | payload=%s",
        url,
        timeout,
        {k: ("***" if k.lower() == "x-api-key" else v) for k, v in headers.items()},
        payload_json,
    )

    try:
        response = requests.post(url, json=body, headers=headers, timeout=timeout)
        response_text = (response.text or "").strip()
        if response.status_code >= 400:
            logger.error(
                "codigos-retiro ERP pago-aprobado RESPUESTA ERROR HTTP %s | url=%s | "
                "%s payment_id=%s | body=%s",
                response.status_code,
                url,
                _obligation_log_label(payload),
                payload.payment_id,
                response_text[:2000],
            )
        else:
            logger.info(
                "codigos-retiro ERP pago-aprobado RESPUESTA OK HTTP %s | url=%s | "
                "%s payment_id=%s monto=%s %s | body=%s",
                response.status_code,
                url,
                _obligation_log_label(payload),
                payload.payment_id,
                payload.monto_abonado,
                payload.moneda,
                response_text[:2000],
            )
    except requests.RequestException as exc:
        logger.error(
            "codigos-retiro ERP pago-aprobado FALLO DE RED | url=%s | %s payment_id=%s | error=%s",
            url,
            _obligation_log_label(payload),
            payload.payment_id,
            exc,
        )
        logger.exception(
            "codigos-retiro ERP pago-aprobado traceback %s payment_id=%s",
            _obligation_log_label(payload),
            payload.payment_id,
        )


def _send_payloads_batch(payloads: list[dict[str, Any]]) -> None:
    for raw in payloads:
        try:
            event = CodigosRetiroErpPagoAprobadoOut.model_validate(raw)
            post_codigos_retiro_erp_pago_aprobado(event)
        except Exception:
            logger.exception(
                "codigos-retiro ERP notify: payload inválido %r",
                raw,
            )


def schedule_codigos_retiro_erp_pago_aprobado(payloads: list[CodigosRetiroErpPagoAprobadoOut]) -> None:
    """Encola envío HTTP en un hilo daemon (no bloquea commit del ERP)."""
    if not payloads:
        return
    if not codigos_retiro_erp_notify_enabled():
        logger.warning(
            "codigos-retiro ERP notify NO encolado (%s eventos): deshabilitado o sin API key. url=%s",
            len(payloads),
            codigos_retiro_erp_notify_url(),
        )
        return
    snapshot = [p.model_dump(mode="json") for p in payloads]
    logger.info(
        "codigos-retiro ERP notify encolando %s evento(s) → %s",
        len(snapshot),
        codigos_retiro_erp_notify_url(),
    )
    threading.Thread(
        target=_send_payloads_batch,
        args=(snapshot,),
        daemon=True,
        name="codigos-retiro-erp-notify",
    ).start()


def build_codigos_retiro_erp_pago_aprobado_events(
    db: Session,
    payment: ClientPayment,
    allocations: list[PaymentAllocation],
) -> list[CodigosRetiroErpPagoAprobadoOut]:
    """Construye un evento por venta o recarga BaaS con importe aplicado > 0."""
    from app.services.client_payment_service import _sale_cxc_open_balance
    from app.wallet_recharge_helpers import wallet_recharge_open_balance

    if not allocations:
        return []

    client = db.get(Client, int(payment.client_id))
    cliente_label = _client_retiro_label(client)
    pay_method = str(getattr(payment, "payment_method", None) or "").strip() or None
    pay_num = (getattr(payment, "payment_number", None) or "").strip() or None
    es_prueba = codigos_retiro_es_prueba_default()

    by_sale: dict[int, Decimal] = {}
    by_wr: dict[int, Decimal] = {}
    for alloc in allocations:
        try:
            applied = Decimal(str(alloc.amount_applied or 0)).quantize(Decimal("0.01"))
        except Exception:
            applied = Decimal("0")
        if applied <= _FP_EPS:
            continue
        if alloc.wallet_recharge_id is not None:
            wr_id = int(alloc.wallet_recharge_id)
            by_wr[wr_id] = by_wr.get(wr_id, Decimal("0")) + applied
        elif alloc.sale_id is not None:
            sid = int(alloc.sale_id)
            by_sale[sid] = by_sale.get(sid, Decimal("0")) + applied

    events: list[CodigosRetiroErpPagoAprobadoOut] = []
    for sid, applied_total in sorted(by_sale.items()):
        sale = db.get(Sale, sid)
        if sale is None:
            continue
        cur = normalize_currency_code(str(getattr(sale, "currency", None) or payment.currency or "USD"))
        open_after = _sale_cxc_open_balance(db, sale, payment=None)
        if open_after < Decimal("0"):
            open_after = Decimal("0")
        ref = str(sid)
        events.append(
            CodigosRetiroErpPagoAprobadoOut(
                obligation_kind="sale",
                referencia_externa=ref,
                referencia_fac=format_sale_referencia_externa(sid),
                sale_id=sid,
                meta_sale_id=sid,
                monto=applied_total,
                monto_abonado=applied_total,
                moneda=cur,
                saldo_pendiente_restante=open_after.quantize(Decimal("0.01")),
                cliente=cliente_label,
                payment_id=int(payment.id),
                payment_number=pay_num,
                metodo_pago=pay_method,
                es_prueba=es_prueba,
            )
        )

    for wr_id, applied_total in sorted(by_wr.items()):
        req = db.get(WalletRechargeRequest, wr_id)
        if req is None:
            continue
        cur = normalize_currency_code(
            str(getattr(req, "recharge_currency", None) or payment.currency or "USD")
        )
        open_after = Decimal(str(wallet_recharge_open_balance(req))).quantize(Decimal("0.01"))
        if open_after < Decimal("0"):
            open_after = Decimal("0")
        ref = str(wr_id)
        events.append(
            CodigosRetiroErpPagoAprobadoOut(
                obligation_kind="wallet_recharge",
                referencia_externa=ref,
                referencia_rec=format_wallet_recharge_referencia_rec(wr_id),
                wallet_recharge_id=wr_id,
                meta_wallet_recharge_id=wr_id,
                monto=applied_total,
                monto_abonado=applied_total,
                moneda=cur,
                saldo_pendiente_restante=open_after,
                cliente=cliente_label,
                payment_id=int(payment.id),
                payment_number=pay_num,
                metodo_pago=pay_method,
                es_prueba=es_prueba,
            )
        )

    return events


def _payment_originated_from_codigos_retiro_webhook(payment: ClientPayment) -> bool:
    """Evita ping-pong: no avisar al socio por cobros que él mismo confirmó vía webhook entrante."""
    notes = str(getattr(payment, "notes", None) or "").lower()
    return "codigos_retiro_webhook=1" in notes or "webhook_abono=1" in notes


def schedule_codigos_retiro_erp_notify_from_payment_approval(
    db: Session,
    payment: ClientPayment,
    allocations: list[PaymentAllocation],
) -> None:
    """
    Punto de integración: tras aprobar un cobro que aplica a facturas o recargas BaaS, avisa al socio.

    Debe invocarse cuando las allocations ya están persistidas (``flush``) y el pago está aprobado.
    """
    if _payment_originated_from_codigos_retiro_webhook(payment):
        logger.info(
            "codigos-retiro ERP notify omitido (pago originado en webhook del socio): payment_id=%s",
            getattr(payment, "id", None),
        )
        return
    try:
        events = build_codigos_retiro_erp_pago_aprobado_events(db, payment, allocations)
        if not events:
            logger.info(
                "codigos-retiro ERP notify sin eventos (allocations vacías o monto 0): payment_id=%s",
                getattr(payment, "id", None),
            )
            return
        logger.info(
            "codigos-retiro ERP notify preparado: payment_id=%s payment_number=%s eventos=%s",
            getattr(payment, "id", None),
            getattr(payment, "payment_number", None),
            len(events),
        )
        schedule_codigos_retiro_erp_pago_aprobado(events)
    except Exception:
        logger.exception(
            "codigos-retiro ERP notify: error preparando eventos payment_id=%s",
            getattr(payment, "id", None),
        )


def schedule_codigos_retiro_erp_notify_for_allocations_batch(
    db: Session,
    allocations: list[PaymentAllocation],
) -> None:
    """Avisa al socio por allocations FIFO (p. ej. barrido de saldo a favor), agrupadas por cobro."""
    if not allocations:
        return
    from collections import defaultdict

    by_payment: dict[int, list[PaymentAllocation]] = defaultdict(list)
    for alloc in allocations:
        pid = getattr(alloc, "payment_id", None)
        if pid is not None:
            by_payment[int(pid)].append(alloc)

    for pid in sorted(by_payment):
        pay = db.get(ClientPayment, pid)
        if pay is not None:
            schedule_codigos_retiro_erp_notify_from_payment_approval(db, pay, by_payment[pid])
