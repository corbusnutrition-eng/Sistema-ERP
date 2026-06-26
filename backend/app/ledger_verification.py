"""Estados de verificación bancaria en líneas del libro mayor."""
from __future__ import annotations

from typing import Literal, Optional

LedgerVerificationStatus = Literal["confirmed", "not_found", "interbank", "wrong_account"]

VALID_LEDGER_VERIFICATION_STATUSES: frozenset[str] = frozenset(
    {"confirmed", "not_found", "interbank", "wrong_account"},
)


def normalize_ledger_verification_status(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if not s:
        return None
    if s not in VALID_LEDGER_VERIFICATION_STATUSES:
        allowed = ", ".join(sorted(VALID_LEDGER_VERIFICATION_STATUSES))
        raise ValueError(f"Estado de verificación inválido: {raw!r}. Valores: {allowed}.")
    return s
