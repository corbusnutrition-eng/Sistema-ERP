from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class PaymentMethodAccountOption(BaseModel):
    id: int
    name: str
    account_number: Optional[str] = None
    currency: str


class PaymentMethodWithAccountsOption(BaseModel):
    id: int
    name: str
    currency: str = Field(description="Moneda de referencia del catálogo para este cliente.")
    is_active: bool = True
    accounts: list[PaymentMethodAccountOption] = Field(default_factory=list)


class ClientPaymentMethodSelection(BaseModel):
    payment_method_id: int = Field(..., ge=1)
    account_ids: list[int] = Field(default_factory=list)


class ClientPaymentMethodsConfigResponse(BaseModel):
    client_id: int
    client_currency: str
    assigned_selections: list[ClientPaymentMethodSelection] = Field(default_factory=list)
    available_payment_methods: list[PaymentMethodWithAccountsOption] = Field(
        default_factory=list,
        description="Métodos globales con cuentas de depósito en la moneda del cliente.",
    )
    #: Compatibilidad con UI anterior (métodos con al menos una cuenta asignada).
    assigned_payment_method_ids: list[int] = Field(default_factory=list)
    assigned_account_ids: list[int] = Field(
        default_factory=list,
        description="IDs planos de cuentas de depósito habilitadas para el portal del cliente.",
    )
    has_custom_payment_accounts: bool = Field(
        default=False,
        description="True si el admin definió cuentas específicas (tabla granular); False = portal usa config global.",
    )


class ClientPaymentMethodsUpsertBody(BaseModel):
    selections: list[ClientPaymentMethodSelection] = Field(default_factory=list)


class ClientPaymentMethodsUpsertResponse(BaseModel):
    ok: bool = True
    updated: int = 0
    message: str = ""


class ClientPaymentAccountsConfigResponse(BaseModel):
    client_id: int
    client_currency: str
    account_ids: list[int] = Field(default_factory=list)
    has_custom_payment_accounts: bool = False


class ClientPaymentAccountsUpsertBody(BaseModel):
    account_ids: list[int] = Field(
        default_factory=list,
        description="Reemplaza las preferencias del cliente. Array vacío = usar configuración global en portal.",
    )


class ClientPaymentAccountsUpsertResponse(BaseModel):
    ok: bool = True
    updated: int = 0
    message: str = ""
