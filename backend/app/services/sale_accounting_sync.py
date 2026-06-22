"""
Sincronización contable de ventas — motor ``journal_entries`` (partida doble).

Devengo (DR CxC / CR ingresos) al crear o actualizar la venta.
Cobros en banco (DR banco / CR CxC) exclusivamente vía ``ClientPayment``.

Autocompras portal BaaS: omiten devengo admin (ingreso ya registrado en recarga de billetera).
"""

from __future__ import annotations

import logging

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.sale import Sale
from app.services.accounting_engine import (
    delete_sale_engine_journals,
    sync_sale_accrual_journal,
    sync_sale_cogs_journal,
)

logger = logging.getLogger(__name__)


def is_baas_wallet_auto_purchase_sale(sale: Sale) -> bool:
    """Autocompra portal: cobrada con saldo BaaS, sin comprobante ni depósito bancario."""
    return "autocompra portal baas" in (sale.notes or "").lower()


def sync_sale_accounting_ledgers(
    db: Session,
    sale: Sale,
    *,
    strict: bool = False,
    strict_cogs: bool | None = None,
) -> None:
    """
    Regenera asientos de la venta: devengo (DR CxC / CR ingresos) y COGS (DR costo / CR inventario).

    Autocompras portal BaaS omiten el devengo de ingresos admin (ya contabilizado en la recarga
    de billetera); el COGS e inventario se registran con normalidad.

    No registra depósitos bancarios aunque ``amount_paid > 0``; eso corresponde a
    ``sync_client_payment_accounting_ledgers`` en cobros CxC.

    ``strict_cogs``: si es ``None``, usa el mismo valor que ``strict``. En activación de ventas
    conviene ``strict_cogs=False`` para no revertir inventario cuando falta costo de compra.
    """
    cogs_strict = strict if strict_cogs is None else strict_cogs

    if is_baas_wallet_auto_purchase_sale(sale):
        # Ingreso admin ya devengado al aprobar la recarga BaaS; evitar doble contabilidad.
        delete_sale_engine_journals(db, int(sale.id))
        logger.info(
            "Devengo venta id=%s omitido: autocompra portal BaaS (ingreso en recarga de billetera).",
            sale.id,
        )
    else:
        sync_sale_accrual_journal(db, sale, strict=strict)

    sync_sale_cogs_journal(db, sale, strict=cogs_strict)


def commit_db_or_rollback(db: Session) -> None:
    """Confirma la transacción actual o revierte ante cualquier error."""
    try:
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except Exception:
        db.rollback()
        raise
