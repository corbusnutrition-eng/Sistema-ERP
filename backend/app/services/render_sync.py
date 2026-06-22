"""Puente HTTP hacia el portal externo Flask (catalogo VIP / Render).

Variables de entorno:
- ``VIP_CATALOG_BRIDGE_URL``: base URL sin barra final (default ``https://catalogo-vip.onrender.com``).
- ``VIP_CATALOG_WEBHOOK_SECRET``: valor de la cabecera ``X-Webhook-Secret`` (default ``301985`` si no se define).
- ``VIP_CATALOG_WEBHOOK_TIMEOUT``: timeout segundos (default ``15``).
"""

from __future__ import annotations

import hashlib
import logging
import os
from typing import Any, Optional

import httpx
import requests

logger = logging.getLogger(__name__)

# ── Configuración del puente ─────────────────────────────────────────────────

VIP_CATALOG_BRIDGE_URL: str = os.getenv(
    "VIP_CATALOG_BRIDGE_URL",
    "https://catalogo-vip.onrender.com",
).strip().rstrip("/")

VIP_CATALOG_WEBHOOK_SECRET: str = (os.getenv("VIP_CATALOG_WEBHOOK_SECRET") or "").strip() or "301985"

try:
    VIP_CATALOG_WEBHOOK_TIMEOUT: float = float(os.getenv("VIP_CATALOG_WEBHOOK_TIMEOUT", "15").strip() or "15")
except ValueError:
    VIP_CATALOG_WEBHOOK_TIMEOUT = 15.0

PATH_WEBHOOK_NUEVA_RECARGA = "/api/webhook/nueva-recarga"
# Portal Flask (cliente): comprobante de recarga / abono declarado (`monto_declarado`).
PATH_WEBHOOK_PAGAR_RECARGA = "/api/pagar-recarga"
PATH_WEBHOOK_RECARGAS_REVISION = "/api/webhook/recargas-en-revision"
# Catálogo Render: lista de ventas con comprobante pendiente / en revisión
PATH_WEBHOOK_VENTAS_EN_REVISION = "/api/webhook/ventas-en-revision"
PATH_WEBHOOK_LISTAR_CLIENTES = "/api/webhook/listar-clientes"
PATH_SUMAR_SALDO = "/api/sumar-saldo-billetera"

# Igual que ``Number.MAX_SAFE_INTEGER`` en JavaScript (opciones/comparaciones UI).
_JS_MAX_SAFE_INT = 9_007_199_254_740_991


def webhook_headers_json() -> dict[str, str]:
    """Cabeceras JSON para POST al portal Flask, incluye ``X-Webhook-Secret``."""
    h: dict[str, str] = {"Content-Type": "application/json", "X-Webhook-Secret": VIP_CATALOG_WEBHOOK_SECRET}
    return h


def webhook_headers_get() -> dict[str, str]:
    """GET al portal Flask con ``X-Webhook-Secret``."""
    return {"X-Webhook-Secret": VIP_CATALOG_WEBHOOK_SECRET}


def bridge_enabled() -> bool:
    """True si hay URL base y secreto configurado (requerido para no enviar llamadas incompletas)."""
    return bool(VIP_CATALOG_BRIDGE_URL) and bool(VIP_CATALOG_WEBHOOK_SECRET)


def pending_debts_master_list_for_client(db: Any, client_id: int) -> list[dict[str, Any]]:
    """
    Lista maestra de deudas abiertas (facturas + recargas BaaS en estados acordados) para webhooks
    hacia el portal en Render. Delega en ``client_payment_service.list_client_pending_debt_lines_for_webhook``.
    """
    from app.services.client_payment_service import list_client_pending_debt_lines_for_webhook

    return list_client_pending_debt_lines_for_webhook(db, int(client_id))


class PortalBridgeError(RuntimeError):
    """Error al hablar con el portal externo."""


def stable_catalog_email_row_id(email: str) -> int:
    """
    Identificador numérico estable por correo (<= ``Number.MAX_SAFE_INTEGER`` JS) para el combobox.
    """
    e = (email or "").strip().lower().encode()
    if not e:
        return 1
    digest = hashlib.sha256(e).digest()[:8]
    n = int.from_bytes(digest, "big")
    return int((n % (_JS_MAX_SAFE_INT - 1)) + 1)


def _listar_webhook_normalize_email(raw: object) -> Optional[str]:
    if isinstance(raw, str):
        s = raw.strip().lower()
        return s if s and "@" in s else None
    if isinstance(raw, dict):
        for key in ("email", "correo", "mail", "e_mail"):
            v = raw.get(key)
            if v is None:
                continue
            s = str(v).strip().lower()
            if s and "@" in s:
                return s
    return None


def fetch_listar_clientes_raw_rows() -> tuple[Optional[list[Any]], bool]:
    """
    POST ``/api/webhook/listar-clientes`` al catálogo (Render) con ``X-Webhook-Secret``.

    Returns:
        ``(filas_clientes, render_ok)``
        donde ``render_ok`` es ``True`` solo si HTTP 200, ``status == "ok"`` y ``clientes``
        existe y es lista (puede estar vacía). Cualquier otro caso devuelve ``(None, False)``
        para que el llamador aplique fallback local.
    """
    if not bridge_enabled():
        logger.info("Puente VIP: omitiendo listar-clientes (falta URL o VIP_CATALOG_WEBHOOK_SECRET).")
        return None, False

    url = f"{VIP_CATALOG_BRIDGE_URL}{PATH_WEBHOOK_LISTAR_CLIENTES}"
    try:
        r = requests.post(
            url,
            headers=webhook_headers_json(),
            json={"webhook_secret": VIP_CATALOG_WEBHOOK_SECRET},
            timeout=max(VIP_CATALOG_WEBHOOK_TIMEOUT, 20.0),
        )
        if r.status_code != 200:
            logger.warning(
                "listar-clientes HTTP %s: %s",
                r.status_code,
                (r.text or "")[:500],
            )
            return None, False
        data = r.json()
    except requests.RequestException as exc:
        logger.warning("listar-clientes: error de red %s", exc, exc_info=True)
        return None, False
    except ValueError as exc:
        logger.warning("listar-clientes: JSON inválido %s", exc, exc_info=True)
        return None, False

    if not isinstance(data, dict) or data.get("status") != "ok":
        return None, False
    rows = data.get("clientes")
    if not isinstance(rows, list):
        return None, False
    return rows, True


def emails_from_listar_clientes_rows(rows: list[Any]) -> list[str]:
    """Extrae correos únicos ordenados desde la lista ``clientes`` del webhook."""
    ordered: list[str] = []
    seen: set[str] = set()
    for item in rows:
        em = _listar_webhook_normalize_email(item)
        if em is None or em in seen:
            continue
        seen.add(em)
        ordered.append(em)
    return ordered


def fetch_listar_clientes_render() -> list[str]:
    """
    Lista de correos desde Render.

    Respuestas conocidas:
    ``{ "status": "ok", "clientes": [ "mail@...", { "email": … }, … ] }``
    Si falla: ``[]``.
    """
    rows, ok = fetch_listar_clientes_raw_rows()
    if not ok or rows is None:
        return []
    return emails_from_listar_clientes_rows(rows)


def flatten_recarga_payload(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        out: list[dict[str, Any]] = []
        for x in payload:
            if isinstance(x, dict):
                out.append(x)
        return out
    if isinstance(payload, dict):
        for key in ("items", "recargas", "data", "results", "records"):
            v = payload.get(key)
            if isinstance(v, list):
                return flatten_recarga_payload(v)
        rid = payload.get("request_id") or payload.get("recharge_id") or payload.get("id_erp") or payload.get("id")
        try:
            if rid is not None and int(rid) > 0:
                return [payload]
        except (TypeError, ValueError):
            pass
        return []
    return []


def remote_row_request_id(row: dict[str, Any]) -> Optional[int]:
    for key in ("id_erp", "request_id", "recharge_id", "solicitud_id", "wallet_recharge_id", "id"):
        raw = row.get(key)
        if raw is None:
            continue
        try:
            return int(str(raw).strip())
        except (TypeError, ValueError):
            continue
    return None


def remote_row_receipt_url(row: dict[str, Any]) -> Optional[str]:
    for key in ("receipt_url", "recibo_url", "comprobante_url", "receipt", "url_comprobante", "url"):
        v = row.get(key)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    return None


def notify_nueva_recarga(
    request_id: int,
    client_email: str,
    amount: float,
    payment_method_ids: list[int],
) -> None:
    """
    Notifica al portal Flask que existe una nueva solicitud ``pending``.
    POST ``{VIP_CATALOG_BRIDGE_URL}/api/webhook/nueva-recarga``.
    """
    if not bridge_enabled():
        logger.info(
            "Puente VIP: omitiendo POST nueva-recarga (configura VIP_CATALOG_BRIDGE_URL y VIP_CATALOG_WEBHOOK_SECRET).",
        )
        return

    url = f"{VIP_CATALOG_BRIDGE_URL}{PATH_WEBHOOK_NUEVA_RECARGA}"
    payload = {
        "id_erp": str(int(request_id)),
        "correo": (client_email or "").strip(),
        "monto": float(amount),
        "metodos": [int(x) for x in payment_method_ids],
    }
    try:
        with httpx.Client(timeout=VIP_CATALOG_WEBHOOK_TIMEOUT) as client:
            r = client.post(url, json=payload, headers=webhook_headers_json())
            r.raise_for_status()
    except Exception as exc:
        logger.warning("Puente VIP: falló nueva-recarga hacia %s: %s", url, exc, exc_info=True)


def notify_wallet_recharge_client_receipt(
    request_id: int,
    client_email: str,
    monto_declarado: float,
    receipt_url: str,
    *,
    from_partial_payment: bool = False,
    cxc_abono_only: bool = False,
) -> None:
    """
    Notifica al portal Flask cuando el cliente sube comprobante de una solicitud de recarga.

    POST ``{VIP_CATALOG_BRIDGE_URL}/api/pagar-recarga/{id}`` — solo activación inicial de producto.

    Con ``cxc_abono_only=True`` no se llama al bridge (evita doble acreditación en abonos CxC).
    """
    if cxc_abono_only:
        logger.info(
            "Puente VIP: omitiendo pagar-recarga id=%s (abono CxC en revisión admin, sin entrega de producto).",
            request_id,
        )
        return
    if not bridge_enabled():
        logger.info(
            "Puente VIP: omitiendo POST pagar-recarga id=%s (configura VIP_CATALOG_BRIDGE_URL y VIP_CATALOG_WEBHOOK_SECRET).",
            request_id,
        )
        return

    rid = int(request_id)
    url = f"{VIP_CATALOG_BRIDGE_URL}{PATH_WEBHOOK_PAGAR_RECARGA}/{rid}"
    status_erp = "in_review"
    legacy = "en_revision_abono" if from_partial_payment else status_erp
    payload = {
        "id_erp": str(rid),
        "wallet_recharge_request_id": rid,
        "correo": (client_email or "").strip(),
        "monto_declarado": float(monto_declarado),
        "paid_amount": float(monto_declarado),
        "receipt_url": str(receipt_url or "").strip(),
        "status": status_erp,
        "estado": legacy,
        "legacy_estado_abono": legacy,
    }
    try:
        with httpx.Client(timeout=VIP_CATALOG_WEBHOOK_TIMEOUT) as client:
            r = client.post(url, json=payload, headers=webhook_headers_json())
            r.raise_for_status()
    except Exception as exc:
        logger.warning(
            "Puente VIP: falló pagar-recarga hacia %s: %s",
            url,
            exc,
            exc_info=True,
        )


def remote_row_sale_erp_id(row: dict[str, Any]) -> Optional[int]:
    for key in (
        "venta_id",
        "sale_id",
        "id_erp",
        "id_pedido",
        "pedido_id",
        "erp_sale_id",
        "id",
    ):
        raw = row.get(key)
        if raw is None:
            continue
        try:
            n = int(str(raw).strip())
            if n >= 1:
                return n
        except (TypeError, ValueError):
            continue
    return None


def remote_row_sale_amount(row: dict[str, Any]) -> Optional[float]:
    for key in ("monto", "amount", "paid_amount", "importe", "pago_declarado", "monto_declarado"):
        raw = row.get(key)
        if raw is None:
            continue
        try:
            v = float(str(raw).replace(",", "."))
            if v > 0:
                return v
        except (TypeError, ValueError):
            continue
    return None


def flatten_vip_sales_payload(payload: Any) -> list[dict[str, Any]]:
    """Normaliza lista de ventas desde el portal (lista directa u objeto envolvente)."""
    keys = ("ventas", "sales", "pedidos", "orders", "items", "records", "data", "results", "recargas")
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        for key in keys:
            v = payload.get(key)
            if isinstance(v, list):
                return flatten_vip_sales_payload(v)
        rid = remote_row_sale_erp_id(payload)
        try:
            if rid is not None and int(rid) > 0:
                return [payload]
        except (TypeError, ValueError):
            pass
        return []
    return []


def fetch_ventas_creditos_en_revision() -> Any:
    """
    GET ``{VIP}/api/webhook/ventas-en-revision`` con ``X-Webhook-Secret``.

    En error HTTP, red o JSON inválido: imprime la respuesta en consola y devuelve ``[]``
    para no bloquear el poller ERP (equivalente a «sin pendientes desde Render»).

    Cuando ``bridge_enabled()`` es False, devuelve ``[]``.
    """
    if not bridge_enabled():
        logger.info("Puente VIP: omitiendo ventas-en-revision (falta URL o VIP_CATALOG_WEBHOOK_SECRET).")
        return []

    url = f"{VIP_CATALOG_BRIDGE_URL}{PATH_WEBHOOK_VENTAS_EN_REVISION}"
    try:
        with httpx.Client(timeout=max(VIP_CATALOG_WEBHOOK_TIMEOUT, 45.0)) as client:
            r = client.get(url, headers=webhook_headers_get())
            if r.status_code != 200:
                print(f"Error Render: status={r.status_code} url={url} body={r.text}")
                logger.warning(
                    "Puente VIP GET ventas-en-revision: HTTP %s %s ...",
                    r.status_code,
                    (r.text or "")[:500],
                )
                return []

            body = r.json()
            logger.debug(
                "Puente VIP GET ventas-en-revision OK: tipo=%s",
                type(body).__name__,
            )
            return body
    except httpx.RequestError as exc:
        print(f"Error Render (red): url={url} exc={exc!s}")
        logger.warning("Puente VIP GET ventas-en-revision request falló (%s)", exc, exc_info=True)
        return []
    except ValueError as exc:
        print(f"Error Render (JSON inválido): url={url} exc={exc!s}")
        logger.warning(
            "Puente VIP GET ventas-en-revision no es JSON: %s",
            exc,
            exc_info=True,
        )
        return []
    except Exception as exc:  # seguridad ante JSONDecodeError u otros errores httpx/cliente
        print(f"Error Render (inesperado): url={url} exc={exc!s}")
        logger.exception("Puente VIP GET ventas-en-revision falló")
        return []


def fetch_recargas_en_revision() -> list[dict[str, Any]]:
    if not bridge_enabled():
        raise PortalBridgeError("Puente VIP no configurado (falta URL o VIP_CATALOG_WEBHOOK_SECRET).")

    url = f"{VIP_CATALOG_BRIDGE_URL}{PATH_WEBHOOK_RECARGAS_REVISION}"
    try:
        with httpx.Client(timeout=VIP_CATALOG_WEBHOOK_TIMEOUT) as client:
            r = client.get(url, headers=webhook_headers_get())
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPError as exc:
        raise PortalBridgeError(f"El portal externo no respondió correctamente ({exc}).") from exc
    except ValueError as exc:
        raise PortalBridgeError(f"Respuesta del portal externo no es JSON válido: {exc}") from exc

    rows = flatten_recarga_payload(data)
    if not rows:
        logger.info("Puente VIP: lista recargas-en-revision vacía o formato no reconocido.")
    return rows


def notify_sumar_saldo_billetera(client_email: str, amount: float) -> None:
    """
    Informa al portal Flask que el ERP ya acreditó saldo en el CRM local.
    POST ``{VIP_CATALOG_BRIDGE_URL}/api/sumar-saldo-billetera``.

    Render espera el cuerpo exacto: ``{\"correo\": str, \"monto\": float}``.
    """
    if not bridge_enabled():
        logger.info(
            "Puente VIP: omitiendo POST sumar-saldo (configura VIP_CATALOG_BRIDGE_URL y VIP_CATALOG_WEBHOOK_SECRET).",
        )
        return

    correo = (client_email or "").strip()
    monto = float(amount)
    if not correo:
        logger.warning("Puente VIP: sumar-saldo omitido (correo vacío).")
        return

    url = f"{VIP_CATALOG_BRIDGE_URL}{PATH_SUMAR_SALDO}"
    payload = {"correo": correo, "monto": monto}
    headers = webhook_headers_json()
    print(f"[sumar-saldo-billetera] POST {url} payload={payload} headers=X-Webhook-Secret=<set>")
    try:
        r = requests.post(url, json=payload, headers=headers, timeout=VIP_CATALOG_WEBHOOK_TIMEOUT)
        if r.status_code >= 400:
            logger.warning(
                "Puente VIP: sumar-saldo HTTP %s: %s",
                r.status_code,
                (r.text or "")[:1000],
            )
    except Exception as exc:
        logger.warning("Puente VIP: falló sumar-saldo hacia %s: %s", url, exc, exc_info=True)
