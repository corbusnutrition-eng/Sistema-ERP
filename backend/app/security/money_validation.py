"""Validación estricta de montos monetarios (Form / API)."""
from __future__ import annotations

import math
from decimal import Decimal, InvalidOperation
from typing import Optional, Union

from fastapi import HTTPException, status

MAX_FORM_MONEY = Decimal("999999")


def parse_strict_positive_money(
    raw: Union[str, float, int, Decimal, None],
    *,
    field_name: str = "amount",
    allow_zero: bool = False,
    max_amount: Decimal = MAX_FORM_MONEY,
) -> Decimal:
    """
    Convierte a ``Decimal`` finito, positivo (o cero si ``allow_zero``) y acotado.

    Rechaza NaN, Infinity y valores fuera de rango lógico.
    """
    if raw is None:
        raise ValueError(f"El campo {field_name} es obligatorio.")

    try:
        if isinstance(raw, Decimal):
            val = float(raw)
        elif isinstance(raw, str):
            s = raw.strip().replace(",", ".")
            if not s:
                raise ValueError(f"El campo {field_name} es obligatorio.")
            val = float(s)
        else:
            val = float(raw)
    except (TypeError, ValueError, InvalidOperation) as exc:
        raise ValueError(f"El campo {field_name} no es un monto válido.") from exc

    if not math.isfinite(val):
        raise ValueError(f"El campo {field_name} debe ser un número finito.")

    try:
        dec = Decimal(str(val)).quantize(Decimal("0.0001"))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError(f"El campo {field_name} no es un monto válido.") from exc

    if allow_zero:
        if dec < 0:
            raise ValueError(f"El campo {field_name} no puede ser negativo.")
    elif dec <= 0:
        raise ValueError(f"El campo {field_name} debe ser mayor a 0.")

    if dec > max_amount:
        raise ValueError(f"El campo {field_name} no puede superar {max_amount}.")

    return dec


def validate_form_money(
    raw: Union[str, float, int, Decimal, None],
    *,
    field_name: str = "amount",
    allow_zero: bool = False,
    max_amount: Decimal = MAX_FORM_MONEY,
) -> Decimal:
    """Wrapper HTTP: convierte ``ValueError`` en 400."""
    try:
        return parse_strict_positive_money(
            raw,
            field_name=field_name,
            allow_zero=allow_zero,
            max_amount=max_amount,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
