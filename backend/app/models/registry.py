"""
Registro único de modelos ORM para Alembic autogenerate y herramientas que necesitan
``Base.metadata`` completo sin importar toda la aplicación FastAPI.
"""

from __future__ import annotations

import importlib
from typing import Final

# Módulos con tablas mapeadas (importar cada uno registra modelos en Base.metadata).
_MODEL_MODULES: Final[tuple[str, ...]] = (
    "app.models.account",
    "app.models.client",
    "app.models.client_payment_method",
    "app.models.client_payment_method_account",
    "app.models.client_product_price",
    "app.models.client_note",
    "app.models.client_notification",
    "app.models.client_debt_payment",
    "app.models.client_payment",
    "app.models.distributor_custom_price",
    "app.models.expense",
    "app.models.inventory_audit_report",
    "app.models.inventory_screen_credit_drawdown",
    "app.models.iptv_account",
    "app.models.iptv_screen",
    "app.models.journal_entry",
    "app.models.payment_method",
    "app.models.product",
    "app.models.sale",
    "app.models.sale_transaction_tag",
    "app.models.screen_stock",
    "app.models.tag",
    "app.models.transaction",
    "app.models.transaction_class",
    "app.models.user",
    "app.models.vendor",
    "app.models.wallet_recharge_request",
    "app.models.wallet_transaction",
)

_loaded = False


def import_all_models() -> None:
    """Importa todos los módulos de modelos (idempotente)."""
    global _loaded
    if _loaded:
        return
    for name in _MODEL_MODULES:
        importlib.import_module(name)
    _loaded = True
