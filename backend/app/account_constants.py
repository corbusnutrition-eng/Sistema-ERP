"""Constantes del plan de cuentas alineadas con la UI (QuickBooks-style)."""

from __future__ import annotations

from app.account_structure import LIQUID_DEPOSIT_DETAIL_TYPES, normalize_detail_type
from app.models.account import Account, LedgerAccountType


def is_liquid_deposit_account(acc: Account) -> bool:
    """
    Cuenta apta para depósitos / transferencias de liquidez (Efectivo y equivalentes).

    - Clásico: activo con ``detail_type`` «Fondos sin depositar».
    - Pasarela: activo con ``linked_payment_method`` o ``linked_wallet_id``.
    """
    if str(getattr(acc, "account_type", "") or "") != LedgerAccountType.asset.value:
        return False
    if getattr(acc, "linked_wallet_id", None) is not None:
        return True
    dt = normalize_detail_type(acc.detail_type) or (acc.detail_type or "").strip()
    if dt in LIQUID_DEPOSIT_DETAIL_TYPES:
        return True
    link = (getattr(acc, "linked_payment_method", None) or "").strip()
    return bool(link)
