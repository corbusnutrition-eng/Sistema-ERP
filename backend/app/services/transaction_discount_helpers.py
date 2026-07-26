"""Normalización de descuentos en ventas y recargas BaaS."""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Optional, Sequence, Tuple, Union

from fastapi import HTTPException, status

from app.schemas.sales import SaleInvoiceLineItem


def _round2(value: Union[float, Decimal, int, str]) -> float:
    return round(float(value), 2)


def normalize_discount_triplet(
    *,
    subtotal: Union[float, Decimal],
    discount: Optional[Union[float, Decimal]] = None,
    net_total: Optional[Union[float, Decimal]] = None,
) -> Tuple[float, float, float]:
    """
    Devuelve (subtotal_bruto, descuento, total_neto).

    ``net_total`` es el importe a cobrar (local_amount / amount_requested).
    """
    gross = _round2(subtotal)
    if gross <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El subtotal debe ser mayor que cero.",
        )
    disc = _round2(discount or 0)
    if disc < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El descuento no puede ser negativo.",
        )
    if disc > gross + 1e-9:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El descuento no puede superar el subtotal.",
        )
    net = _round2(gross - disc)
    if net <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El total neto tras descuento debe ser mayor que cero.",
        )
    if net_total is not None:
        net_provided = _round2(net_total)
        if abs(net_provided - net) > 0.02:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El total neto no coincide con subtotal − descuento.",
            )
    return gross, disc, net


def validate_sale_discount_coherence(
    *,
    local_amount: Union[float, Decimal],
    discount: Optional[Union[float, Decimal]] = None,
    invoice_lines: Optional[Sequence[Any]] = None,
) -> Tuple[float, float, float]:
    """
    Valida subtotal − descuento = total neto (``local_amount``) en ventas.

    Con líneas de factura, el subtotal bruto es la suma de importes de línea.
    Sin líneas, subtotal = neto + descuento.
    """
    net = _round2(local_amount)
    disc = _round2(discount or 0)
    if invoice_lines:
        subtotal = round(
            sum(
                (
                    li.line_charge_amount()
                    if isinstance(li, SaleInvoiceLineItem)
                    else SaleInvoiceLineItem.model_validate(li).line_charge_amount()
                )
                for li in invoice_lines
            ),
            2,
        )
    else:
        subtotal = round(net + disc, 2)
    return normalize_discount_triplet(subtotal=subtotal, discount=disc, net_total=net)
