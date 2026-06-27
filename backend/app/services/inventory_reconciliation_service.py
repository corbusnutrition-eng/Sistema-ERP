"""Auditoría de inventario IPTV: extracción con visión (OpenAI) y cruce con libro mayor."""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from datetime import date
from typing import Any, Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.api.v1.accounts import _build_account_journal_ledger, _is_inventory_ledger_account
from app.models.account import Account
from app.schemas.chart_accounts import (
    AccountHistoryEntry,
    InventoryReconciliationAuditResponse,
    InventoryReconciliationCreditRow,
)

logger = logging.getLogger(__name__)

_INVENTORY_VISION_PROMPT = (
    "Actúa como un extractor de datos. Analiza esta imagen de una tabla de consumos. "
    "Extrae las filas y devuelve ÚNICAMENTE un arreglo JSON válido donde cada objeto tenga "
    "'username' (columna Nombre) y 'credits' (columna Comprar créditos, como entero). "
    "No incluyas markdown ni texto extra."
)

_ALLOWED_IMAGE_TYPES = frozenset(
    {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"}
)
_MAX_IMAGE_BYTES = 12 * 1024 * 1024


def _norm_username(raw: Optional[str]) -> str:
    return " ".join(str(raw or "").strip().lower().split())


def _service_name_matches(line_service: Optional[str], filter_service: str) -> bool:
    a = (line_service or "").strip().lower()
    b = (filter_service or "").strip().lower()
    if not a or not b:
        return False
    if a == b:
        return True
    if a in b or b in a:
        return True
    a_compact = re.sub(r"[^a-z0-9]", "", a)
    b_compact = re.sub(r"[^a-z0-9]", "", b)
    return bool(a_compact and b_compact and (a_compact in b_compact or b_compact in a_compact))


def _username_key_from_ledger_row(row: AccountHistoryEntry) -> Optional[str]:
    iptv = (row.iptv_username or "").strip()
    if iptv:
        return _norm_username(iptv)
    client = (row.client_name or "").strip()
    if client and not client.lower().startswith("transferencia"):
        return _norm_username(client)
    return None


def build_erp_inventory_credits_by_username(
    db: Session,
    account_id: int,
    *,
    start_date: date,
    end_date: date,
    service_name: str,
) -> dict[str, int]:
    """Suma créditos activados en el ERP agrupados por usuario/cliente."""
    history = _build_account_journal_ledger(db, account_id, date_from=start_date, date_to=end_date)
    out: dict[str, int] = {}
    svc_filter = (service_name or "").strip()
    if not svc_filter:
        return out

    for row in history.lines:
        qty = row.credits_qty
        if qty is None or int(qty) <= 0:
            continue
        if not _service_name_matches(row.service_name, svc_filter):
            continue
        user_key = _username_key_from_ledger_row(row)
        if not user_key:
            continue
        out[user_key] = out.get(user_key, 0) + int(qty)
    return out


def _parse_platform_rows(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise ValueError("La IA no devolvió un arreglo JSON.")
    rows: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        username = str(item.get("username") or item.get("nombre") or "").strip()
        credits_raw = item.get("credits")
        if credits_raw is None:
            credits_raw = item.get("creditos") or item.get("comprar_creditos")
        try:
            credits = int(float(credits_raw))
        except (TypeError, ValueError):
            continue
        if not username or credits < 0:
            continue
        rows.append({"username": username, "credits": credits})
    if not rows:
        raise ValueError("No se encontraron filas válidas en la respuesta de la IA.")
    return rows


def _aggregate_platform_rows(rows: list[dict[str, Any]]) -> tuple[dict[str, int], dict[str, str]]:
    out: dict[str, int] = {}
    display: dict[str, str] = {}
    for row in rows:
        key = _norm_username(row["username"])
        if not key:
            continue
        out[key] = out.get(key, 0) + int(row["credits"])
        display.setdefault(key, str(row["username"]).strip())
    return out, display


def compare_inventory_credits(
    platform: dict[str, int],
    erp: dict[str, int],
    *,
    display_names: dict[str, str],
) -> tuple[list[InventoryReconciliationCreditRow], list[InventoryReconciliationCreditRow], list[InventoryReconciliationCreditRow]]:
    matched: list[InventoryReconciliationCreditRow] = []
    missing_in_erp: list[InventoryReconciliationCreditRow] = []
    missing_in_platform: list[InventoryReconciliationCreditRow] = []

    for key in sorted(set(platform.keys()) | set(erp.keys())):
        label = display_names.get(key, key)
        p = platform.get(key)
        e = erp.get(key)

        if p is not None and e is not None and p == e:
            matched.append(
                InventoryReconciliationCreditRow(
                    username=label,
                    credits=p,
                    credits_platform=p,
                    credits_erp=e,
                )
            )
            continue

        if p is not None and (e is None or e != p):
            missing_in_erp.append(
                InventoryReconciliationCreditRow(
                    username=label,
                    credits=p,
                    credits_platform=p,
                    credits_erp=e,
                )
            )
        if e is not None and (p is None or p != e):
            missing_in_platform.append(
                InventoryReconciliationCreditRow(
                    username=label,
                    credits=e,
                    credits_platform=p,
                    credits_erp=e,
                )
            )
    return matched, missing_in_erp, missing_in_platform


async def extract_platform_credits_from_image(image_bytes: bytes, media_type: str) -> list[dict[str, Any]]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OPENAI_API_KEY no está configurada en el servidor.",
        )

    try:
        from openai import AsyncOpenAI
    except ImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="La librería openai no está instalada en el servidor.",
        ) from exc

    b64 = base64.b64encode(image_bytes).decode()
    data_url = f"data:{media_type};base64,{b64}"

    client = AsyncOpenAI(api_key=api_key)
    try:
        resp = await client.chat.completions.create(
            model=os.getenv("OPENAI_INVENTORY_VISION_MODEL", "gpt-4o"),
            max_tokens=4096,
            messages=[
                {"role": "system", "content": _INVENTORY_VISION_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
                        {"type": "text", "text": "Extrae todas las filas visibles de la tabla."},
                    ],
                },
            ],
        )
    except Exception as exc:
        logger.exception("OpenAI inventory vision failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"No se pudo analizar la imagen con IA: {exc}",
        ) from exc

    raw = (resp.choices[0].message.content or "").strip()
    if "```" in raw:
        parts = raw.split("```")
        raw = parts[1].lstrip("json").strip() if len(parts) > 1 else raw

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        logger.warning("OpenAI inventory vision returned non-JSON: %r", raw[:500])
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="La IA no pudo devolver un JSON válido. Intenta con una captura más nítida.",
        ) from exc

    return _parse_platform_rows(parsed)


async def run_inventory_reconciliation_audit(
    db: Session,
    account_id: int,
    *,
    start_date: date,
    end_date: date,
    service_name: str,
    image_bytes: bytes,
    media_type: str,
) -> InventoryReconciliationAuditResponse:
    if start_date > end_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La fecha inicio debe ser anterior o igual a la fecha fin.",
        )

    acc = db.get(Account, account_id)
    if acc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta no encontrada.")
    if not _is_inventory_ledger_account(acc):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="La auditoría con IA solo aplica a cuentas de Inventario.",
        )

    svc = (service_name or "").strip()
    if not svc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Indica el servicio a conciliar.")

    if len(image_bytes) > _MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="La imagen supera el tamaño máximo permitido (12 MB).",
        )

    ct = (media_type or "image/png").split(";")[0].strip().lower()
    if ct not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Formato de imagen no soportado. Usa JPG, PNG o WebP.",
        )

    ai_error: Optional[str] = None
    platform_rows: list[dict[str, Any]] = []
    try:
        platform_rows = await extract_platform_credits_from_image(image_bytes, ct)
    except HTTPException:
        raise
    except ValueError as exc:
        ai_error = str(exc)
    except Exception as exc:
        logger.exception("Unexpected inventory vision error")
        ai_error = str(exc)

    if ai_error:
        return InventoryReconciliationAuditResponse(
            account_id=acc.id,
            account_name=acc.name,
            service_name=svc,
            start_date=start_date,
            end_date=end_date,
            platform_rows_extracted=0,
            matched=[],
            missing_in_erp=[],
            missing_in_platform=[],
            ai_read_success=False,
            ai_error=ai_error,
        )

    platform_map, display_names = _aggregate_platform_rows(platform_rows)
    erp_map = build_erp_inventory_credits_by_username(
        db,
        account_id,
        start_date=start_date,
        end_date=end_date,
        service_name=svc,
    )
    # Preserve ERP display labels where platform didn't have them
    for key in erp_map:
        if key not in display_names:
            display_names[key] = key

    matched, missing_in_erp, missing_in_platform = compare_inventory_credits(
        platform_map,
        erp_map,
        display_names=display_names,
    )

    return InventoryReconciliationAuditResponse(
        account_id=acc.id,
        account_name=acc.name,
        service_name=svc,
        start_date=start_date,
        end_date=end_date,
        platform_rows_extracted=len(platform_rows),
        matched=matched,
        missing_in_erp=missing_in_erp,
        missing_in_platform=missing_in_platform,
        ai_read_success=True,
        ai_error=None,
    )
