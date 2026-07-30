"""
Notificaciones push al equipo vía Telegram Bot API.

Los envíos son no bloqueantes (BackgroundTasks) y nunca deben interrumpir el flujo ERP.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Optional

import httpx

from app.config import settings

if TYPE_CHECKING:
    from fastapi import BackgroundTasks
    from sqlalchemy.orm import Session

    from app.models.client import Client
    from app.models.wallet_recharge_request import WalletRechargeRequest

logger = logging.getLogger(__name__)

TELEGRAM_API_BASE = "https://api.telegram.org"


def _escape_html(text: object) -> str:
    return (
        str(text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def format_client_display_name(*, client_name: str = "", client_email: str = "") -> str:
    name = str(client_name or "").strip()
    email = str(client_email or "").strip()
    if name and email:
        return f"{name} ({email})"
    return name or email or "Cliente"


def format_money_amount(amount: float, currency: str = "USD") -> str:
    cur = str(currency or "USD").strip().upper() or "USD"
    try:
        val = float(amount)
    except (TypeError, ValueError):
        val = 0.0
    return f"{val:,.2f} {cur}"


async def send_telegram_notification(message: str) -> bool:
    """POST asíncrono a Telegram. Devuelve False si falla o no hay credenciales."""
    token = settings.TELEGRAM_BOT_TOKEN
    chat_id = settings.TELEGRAM_CHAT_ID
    text = str(message or "").strip()
    if not token or not chat_id:
        logger.debug("Telegram omitido: TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados.")
        return False
    if not text:
        return False

    url = f"{TELEGRAM_API_BASE}/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
    }
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            response = await client.post(url, json=payload)
        if response.status_code >= 400:
            logger.warning(
                "Telegram API respondió status=%s body=%s",
                response.status_code,
                (response.text or "")[:500],
            )
            return False
        return True
    except Exception:
        logger.exception("No se pudo enviar notificación Telegram.")
        return False


def send_telegram_alert(message: str) -> bool:
    """Envío síncrono de alerta vía Telegram Bot API (requests + variables de entorno)."""
    import os

    import requests

    token = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
    chat_id = (os.getenv("TELEGRAM_CHAT_ID") or "").strip()
    text = str(message or "").strip()
    if not token or not chat_id or not text:
        logger.debug("Telegram alert omitida: credenciales o mensaje vacío.")
        return False

    url = f"{TELEGRAM_API_BASE}/bot{token}/sendMessage"
    try:
        response = requests.post(
            url,
            json={"chat_id": chat_id, "text": text},
            timeout=12,
        )
        if response.status_code >= 400:
            logger.warning(
                "Telegram alert respondió status=%s body=%s",
                response.status_code,
                (response.text or "")[:500],
            )
            return False
        return True
    except Exception:
        logger.exception("No se pudo enviar alerta Telegram.")
        return False


def schedule_telegram_notification(
    background_tasks: Optional["BackgroundTasks"],
    message: str,
) -> None:
    if background_tasks is None or not settings.telegram_enabled:
        return
    background_tasks.add_task(send_telegram_notification, message)


def build_baas_new_request_message(
    *,
    client_name: str,
    client_email: str,
    amount: float,
    currency: str,
    payment_method: str,
) -> str:
    user = _escape_html(format_client_display_name(client_name=client_name, client_email=client_email))
    amt = _escape_html(format_money_amount(amount, currency))
    method = _escape_html(payment_method or "—")
    return (
        "🚨 <b>NUEVA SOLICITUD BaaS</b> 🚨\n"
        f"Usuario: {user}\n"
        f"Importe: {amt}\n"
        f"Método: {method}"
    )


def build_receipt_received_message(
    *,
    client_name: str,
    client_email: str,
    amount: float,
    currency: str = "USD",
) -> str:
    user = _escape_html(format_client_display_name(client_name=client_name, client_email=client_email))
    amt = _escape_html(format_money_amount(amount, currency))
    return (
        "💰 <b>COMPROBANTE RECIBIDO</b> 💰\n"
        f"El usuario {user} ha subido un pago por {amt}.\n"
        "Por favor, revisa la pestaña 'En revisión'."
    )


def resolve_wallet_recharge_payment_method_label(db: "Session", req: "WalletRechargeRequest") -> str:
    from app.models.payment_method import PaymentMethod

    pm_id = getattr(req, "payment_method_id", None)
    if pm_id is not None:
        pm = db.get(PaymentMethod, int(pm_id))
        name = str(getattr(pm, "name", "") or "").strip() if pm is not None else ""
        if name:
            return name

    allowed = req.allowed_payment_methods if isinstance(req.allowed_payment_methods, list) else []
    for raw_id in allowed:
        try:
            pm = db.get(PaymentMethod, int(raw_id))
        except (TypeError, ValueError):
            continue
        name = str(getattr(pm, "name", "") or "").strip() if pm is not None else ""
        if name:
            return name
    return "—"


def schedule_baas_new_request_notification(
    background_tasks: Optional["BackgroundTasks"],
    *,
    client: "Client",
    amount: float,
    currency: str,
    payment_method: str,
) -> None:
    message = build_baas_new_request_message(
        client_name=str(getattr(client, "name", "") or ""),
        client_email=str(getattr(client, "email", "") or ""),
        amount=float(amount),
        currency=str(currency or "USD"),
        payment_method=payment_method,
    )
    schedule_telegram_notification(background_tasks, message)


def schedule_receipt_received_notification(
    background_tasks: Optional["BackgroundTasks"],
    *,
    client: "Client",
    amount: float,
    currency: str = "USD",
) -> None:
    message = build_receipt_received_message(
        client_name=str(getattr(client, "name", "") or ""),
        client_email=str(getattr(client, "email", "") or ""),
        amount=float(amount),
        currency=str(currency or "USD"),
    )
    schedule_telegram_notification(background_tasks, message)
