"""
Sincroniza comprobantes de ventas pendientes («crédito normal» / pantallas) desde catalogo VIP (Render).

El portal público registra pagos contra ``venta_id`` local; el ERP trae URLs de comprobante y alinea estado
``payment_submitted`` + ``ClientPayment`` en revisión (mismo modelo que portal ERP).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.currency_utils import normalize_currency_code
from app.models.client_payment import ClientPayment, ClientPaymentStatus, PaymentAllocation
from app.models.sale import Sale, SaleStatus
from app.timezone_utils import now_ecuador
from app.services.client_payment_service import (
    dedupe_notes_portal_general_abono_chunks,
    next_payment_number,
    parse_notes_meta_sale_id,
)
from app.services.render_sync import (
    flatten_vip_sales_payload,
    fetch_ventas_creditos_en_revision,
    remote_row_receipt_url,
    remote_row_sale_amount,
    remote_row_sale_erp_id,
)
from app.services.sale_accounting_sync import sync_sale_accounting_ledgers

logger = logging.getLogger(__name__)


def _norm_rcpt(url: Optional[str]) -> str:
    return (url or "").strip()


def _has_web_sync_stub_payment(db: Session, sale_id: int, client_id: int, receipt_norm: str) -> bool:
    """True si ya existe un abono pendiente vinculado a esta venta con el mismo comprobante."""
    cand = (
        db.query(ClientPayment)
        .filter(
            ClientPayment.client_id == int(client_id),
            ClientPayment.status == ClientPaymentStatus.pending_review,
        )
        .order_by(ClientPayment.created_at.desc())
        .limit(80)
        .all()
    )
    rid = int(sale_id)
    for cp in cand:
        notes = str(cp.notes or "")
        if parse_notes_meta_sale_id(notes) != rid:
            continue
        if "web_vip_receipt_sync" not in notes:
            continue
        if _norm_rcpt(cp.receipt_file_url) == receipt_norm:
            return True
    return False


def apply_vip_catalog_row_to_sale(db: Session, sale: Sale, row: dict[str, Any]) -> bool:
    """
    Aplica un renglón remoto a la venta local (pending → payment_submitted + abono pendiente si aplica).

    Returns:
        True si hubo cambios persistibles (caller hace ``db.flush`` dentro del bucle masivo).
    """
    rec_raw = remote_row_receipt_url(row)
    receipt = _norm_rcpt(rec_raw)
    if not receipt:
        logger.debug("sync-web-credits: venta #%s omitida — sin receipt_url.", sale.id)
        return False

    amt_opt = remote_row_sale_amount(row)
    cur_norm = normalize_currency_code(str(sale.currency or "USD"))
    total_open = Decimal(str(sale.local_amount or sale.amount or 0)).quantize(Decimal("0.01"))
    if amt_opt is None or amt_opt <= 0:
        try:
            amt_dec = (
                Decimal(str(sale.local_amount or sale.amount or 0)).quantize(Decimal("0.01"))
                if total_open > Decimal("0.005")
                else Decimal("0.01")
            )
        except Exception:
            amt_dec = Decimal("0.01")
    else:
        try:
            amt_dec = Decimal(str(amt_opt)).quantize(Decimal("0.01"))
        except Exception:
            amt_dec = total_open if total_open > Decimal("0.005") else Decimal("0.01")

    if sale.status == SaleStatus.pending:
        already = _has_web_sync_stub_payment(db, sale.id, sale.client_id, receipt)

        canonical = dedupe_notes_portal_general_abono_chunks(
            "\n".join(
                [
                    "portal_general_abono",
                    f"META_SALE_ID={int(sale.id)}",
                    f"ORIGIN_SALE_REF={int(sale.id)}",
                    "IS_INITIAL_SALE_PAYMENT=1",
                    f"PARTE_EFECTIVO={float(amt_dec):.2f} {cur_norm}",
                    "web_vip_receipt_sync=1",
                ]
            )
        )

        sale.receipt_url = receipt

        now_ts = now_ecuador()
        events: list[dict] = list(sale.payment_events or [])
        now_iso = now_ts.isoformat()

        if already:
            # Misma evidencia ya importada antes: sólo consolidar estado.
            sale.payment_events = events
            sale.status = SaleStatus.payment_submitted
            sale.expires_at = None
            sync_sale_accounting_ledgers(db, sale, strict=False)
            return True

        pay = ClientPayment(
            payment_number=next_payment_number(db),
            client_id=int(sale.client_id),
            amount=amt_dec,
            currency=cur_norm,
            receipt_file_url=receipt,
            payment_method_id=None,
            payment_method="Comprobante (web VIP)",
            deposit_account_id=None,
            status=ClientPaymentStatus.pending_review,
            notes=canonical,
            created_at=now_ts,
        )
        db.add(pay)
        db.flush()
        db.add(
            PaymentAllocation(
                payment_id=int(pay.id),
                sale_id=int(sale.id),
                amount_applied=amt_dec.quantize(Decimal("0.0001")),
            ),
        )
        events.append(
            {
                "occurred_at": now_iso,
                "amount": float(amt_dec),
                "currency": cur_norm,
                "status": "Comprobante (web VIP) — En revisión",
                "receipt_url": receipt,
                "deposit_portion": float(amt_dec),
                "pending_payment_number": pay.payment_number,
                "pending_payment_id": int(pay.id),
                "composite_method": "Comprobante (web VIP)",
                "general_abono": True,
                "web_vip_catalog": True,
            },
        )

        sale.payment_events = events
        sale.status = SaleStatus.payment_submitted
        sale.expires_at = None
        sync_sale_accounting_ledgers(db, sale, strict=False)
        return True

    if sale.status == SaleStatus.payment_submitted:
        if not getattr(sale, "receipt_url", None):
            sale.receipt_url = receipt
            sync_sale_accounting_ledgers(db, sale, strict=False)
            return True
        prev = _norm_rcpt(str(sale.receipt_url or "").strip())
        if (
            prev
            and receipt != prev
            and not _has_web_sync_stub_payment(db, sale.id, sale.client_id, receipt)
        ):
            canonical = dedupe_notes_portal_general_abono_chunks(
                "\n".join(
                    [
                        "portal_general_abono",
                        f"META_SALE_ID={int(sale.id)}",
                        f"ORIGIN_SALE_REF={int(sale.id)}",
                        "IS_INITIAL_SALE_PAYMENT=1",
                        f"PARTE_EFECTIVO={float(amt_dec):.2f} {cur_norm}",
                        "web_vip_receipt_sync=1",
                        "web_vip_receipt_addon=1",
                    ]
                )
            )
            np = now_ecuador()
            pay = ClientPayment(
                payment_number=next_payment_number(db),
                client_id=int(sale.client_id),
                amount=amt_dec,
                currency=cur_norm,
                receipt_file_url=receipt,
                payment_method_id=None,
                payment_method="Comprobante (web VIP)",
                deposit_account_id=None,
                status=ClientPaymentStatus.pending_review,
                notes=canonical,
                created_at=np,
            )
            db.add(pay)
            db.flush()
            db.add(
                PaymentAllocation(
                    payment_id=int(pay.id),
                    sale_id=int(sale.id),
                    amount_applied=amt_dec.quantize(Decimal("0.0001")),
                ),
            )
            sync_sale_accounting_ledgers(db, sale, strict=False)
            return True

    if sale.status == SaleStatus.partially_paid and not getattr(sale, "receipt_url", None):
        sale.receipt_url = receipt
        sync_sale_accounting_ledgers(db, sale, strict=False)
        return True

    logger.debug(
        "sync-web-credits: venta #%s estado %s omitida (sin cambios).",
        sale.id,
        sale.status,
    )
    return False


def sync_web_credit_sales_from_vip_catalog(db: Session) -> dict[str, Any]:
    """
    GET desde Render + merge local. Caller expone resultado como JSON (``SaleWebCreditsSyncResponse``).
    Fallos HTTP/red del puente se traducen en payload vacío (sin errores desde ``fetch_*``).
    """
    payload = fetch_ventas_creditos_en_revision()
    rows = flatten_vip_sales_payload(payload)

    updated_ids: list[int] = []
    skipped_ids: list[int] = []
    not_found_ids: list[int] = []
    errors: list[str] = []

    try:
        for idx, raw in enumerate(rows):
            if not isinstance(raw, dict):
                errors.append(f"Fila {idx}: formato inválido (objeto esperado).")
                continue
            sid = remote_row_sale_erp_id(raw)
            if sid is None:
                errors.append(f"Fila {idx}: no se pudo resolver venta ERP (venta_id / sale_id / id_erp).")
                continue
            sale = db.get(Sale, sid)
            if sale is None:
                not_found_ids.append(sid)
                continue
            if sale.status not in (
                SaleStatus.pending,
                SaleStatus.payment_submitted,
                SaleStatus.partially_paid,
            ):
                skipped_ids.append(sid)
                continue
            receipt = remote_row_receipt_url(raw)
            if not receipt or not str(receipt).strip():
                skipped_ids.append(sid)
                errors.append(f"Venta #{sid}: sin receipt_url desde el portal.")
                continue

            ok = False
            try:
                ok = apply_vip_catalog_row_to_sale(db, sale, raw)
            except Exception as ex_item:
                logger.exception("sync-web-credits: venta #%s fallo al aplicar fila.", sid)
                errors.append(f"Venta #{sid}: {ex_item!s}")
                continue

            if ok:
                updated_ids.append(sid)
                db.flush()
            else:
                skipped_ids.append(sid)

        db.commit()

        # refresh orden estable
        for sid in sorted(set(updated_ids)):
            s = db.get(Sale, sid)
            if s is not None:
                db.refresh(s)

    except Exception:
        db.rollback()
        raise

    return {
        "updated_ids": sorted(set(updated_ids)),
        "skipped_ids": sorted(set(skipped_ids)),
        "not_found_ids": sorted(set(not_found_ids)),
        "errors": errors,
    }

