"""Constantes del plan de cuentas alineadas con la UI (QuickBooks-style)."""

from __future__ import annotations

from app.account_structure import LIQUID_DEPOSIT_DETAIL_TYPES, normalize_detail_type
from app.models.account import Account


def is_liquid_deposit_account(acc: Account) -> bool:
    """
    Cuenta apta para depósitos / transferencias de liquidez.

    - Clásico: activo con ``detail_type`` en la lista QuickBooks (Banco, billeteras, etc.).
    - Nuevo: activo con ``linked_payment_method`` (nombre de método de pago del catálogo).
    """
    if acc.account_type != "asset":
        return False
    dt = normalize_detail_type(acc.detail_type) or (acc.detail_type or "").strip()
    if dt in LIQUID_DEPOSIT_DETAIL_TYPES:
        return True
    link = (getattr(acc, "linked_payment_method", None) or "").strip()
    return bool(link)
