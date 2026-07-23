"""Schemas for the anonymous client checkout portal (sale-scoped ``payment_token``)."""

from __future__ import annotations

import datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field


class HotmartLinkPublic(BaseModel):
    type: str = Field(default="standard")
    url: Optional[str] = None
    amount: Optional[float] = Field(default=None, ge=0)
    text: Optional[str] = None
    image_url: Optional[str] = None


class CheckoutPaymentMethodOption(BaseModel):
    id: int
    name: str


class CheckoutDepositAccountPublic(BaseModel):
    """Cuenta de depósito permitida para el portal (solo IDs en ``allowed_deposit_accounts``)."""

    id: int
    bank_name: str = Field(description="Nombre / entidad visible (plan de cuentas)")
    account_holder_hint: Optional[str] = Field(
        default=None, description="Texto opcional del ERP (p. ej. titular / notas)."
    )
    account_number: Optional[str] = None
    currency: str
    crypto_network: Optional[str] = Field(
        default=None,
        description="Red blockchain (TRC20, ERC20, …) para cuentas cripto.",
    )
    linked_payment_method: str = Field(
        default="",
        description="Nombre del método de cobro enlazado (minúsculas), para filtrar en el cliente.",
    )


class CheckoutLinePublic(BaseModel):
    description: Optional[str] = None
    qty: Optional[float] = Field(default=None)
    rate: Optional[float] = Field(default=None)
    #: Subtotal línea (``qty × rate``) cuando aplique.
    amount: Optional[float] = Field(default=None)


class CheckoutDetailResponse(BaseModel):
    sale_id: int
    status: str
    expires_at: Optional[datetime.datetime] = None
    currency: str
    exchange_rate: float = 1.0
    #: Total en la moneda de la venta (si existe ``local_amount``).
    local_amount: Optional[Decimal] = None
    amount_usd: Decimal
    amount_paid: Decimal
    balance_due: Decimal
    lines: list[CheckoutLinePublic] = Field(default_factory=list)
    payment_methods: list[CheckoutPaymentMethodOption] = Field(default_factory=list)
    #: Cuentas de depósito permitidas (filtro por método según ``linked_payment_method`` / padre).
    deposit_accounts: list[CheckoutDepositAccountPublic] = Field(default_factory=list)
    #: Espejo ERP (solo informativo / cliente avanzado).
    allowed_payment_methods: list[str] = Field(default_factory=list)
    allowed_deposit_accounts: list[int] = Field(default_factory=list)
    hotmart_links: list[HotmartLinkPublic] = Field(default_factory=list)

class CheckoutPayResponse(BaseModel):
    status: str
    message: str
    receipt_url: Optional[str] = Field(
        default=None,
        description="Ruta pública del comprobante guardado (`/uploads/…`).",
    )
