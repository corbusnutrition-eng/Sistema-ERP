from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from app.account_structure import all_detail_types, validate_chart_account_classification
from app.currency_utils import normalize_currency_code
from app.ledger_verification import normalize_ledger_verification_status

LedgerDisplayMode = Literal["cash_register", "ar_register"]

LedgerAccountTypeLiteral = Literal[
    "asset",
    "liability",
    "equity",
    "income",
    "expense",
    "cost_of_sales",
]

CANONICAL_DETAIL_TYPES = sorted(all_detail_types())


class ChartAccountCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    account_number: Optional[str] = Field(default=None, max_length=40)
    account_type: LedgerAccountTypeLiteral
    detail_type: Optional[str] = Field(default=None, max_length=64)
    linked_payment_method: Optional[str] = Field(
        default=None,
        max_length=120,
        description="Nombre del método de pago (catálogo) vinculado a esta cuenta de efectivo/equivalente.",
    )
    description: Optional[str] = Field(default=None, max_length=4000)
    is_subaccount: bool = False
    parent_id: Optional[int] = Field(default=None, ge=1)
    currency: str = Field(default="USD", min_length=3, max_length=10)
    opening_balance: Optional[Decimal] = Field(default=None, ge=0)
    opening_balance_date: Optional[date] = None

    @field_validator("detail_type", "account_number", "linked_payment_method", mode="before")
    @classmethod
    def _empty_str_none(cls, v):
        if v == "":
            return None
        return v

    @field_validator("linked_payment_method", mode="after")
    @classmethod
    def _strip_linked_pm(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        s = str(v).strip()
        return s if s else None

    @field_validator("opening_balance", mode="before")
    @classmethod
    def _opening_empty_none(cls, v):
        if v == "" or v is None:
            return None
        return v

    @field_validator("currency", mode="before")
    @classmethod
    def _normalize_currency(cls, v):
        if v is None or v == "":
            return "USD"
        return normalize_currency_code(v)

    @model_validator(mode="after")
    def _subaccount_parent(self) -> "ChartAccountCreate":
        if self.is_subaccount and not self.parent_id:
            raise ValueError("Selecciona la cuenta padre para una subcuenta.")
        if not self.is_subaccount and self.parent_id:
            self.parent_id = None
        return self

    @model_validator(mode="after")
    def _validate_detail_taxonomy(self) -> "ChartAccountCreate":
        # Taxonomía estática; métodos de pago (Efectivo y equivalentes) se validan en la API con BD.
        validate_chart_account_classification(
            account_type=self.account_type,
            detail_type=self.detail_type,
            linked_payment_method=self.linked_payment_method,
        )
        return self


class ChartAccountUpdate(ChartAccountCreate):
    """Misma forma que alta; usado en PATCH para editar cuenta existente."""

    pass


class ChartAccountResponse(BaseModel):
    id: int
    code: str
    name: str
    account_number: Optional[str] = None
    account_type: str
    detail_type: Optional[str] = None
    linked_payment_method: Optional[str] = None
    description: Optional[str] = None
    parent_id: Optional[int] = None
    parent_name: Optional[str] = None
    currency: str
    opening_balance: Optional[Decimal] = None
    opening_balance_date: Optional[date] = None
    current_balance: Decimal
    system_balance: Decimal
    is_active: bool

    model_config = {"from_attributes": True}


class DepositAccountOption(BaseModel):
    """Cuentas aptas para «Depositar en» (efectivo y equivalentes de alta liquidez)."""

    id: int
    name: str
    currency: str
    parent_id: Optional[int] = Field(default=None, description="Si es subcuenta, id del padre.")
    linked_payment_method: Optional[str] = Field(
        default=None,
        description="Método de pago enlazado (plan de cuentas), mismo nombre que en catálogo.",
    )

    model_config = {"from_attributes": True}


class AccountTransferCreate(BaseModel):
    source_account_id: int = Field(..., ge=1)
    destination_account_id: int = Field(..., ge=1)
    amount: Decimal = Field(..., gt=0)
    date: date
    notes: Optional[str] = Field(default=None, max_length=4000)
    #: Si origen y destino tienen distinta ``moneda_original``: unidades destino por 1 unidad origen (p. ej. COP→USD → USD por 1 COP).
    exchange_rate: Optional[Decimal] = Field(default=None, gt=0)
    #: Estado de verificación bancaria en la línea de ingreso (destino), p. ej. ``interbank`` para acreditación pendiente.
    destination_verification_status: Optional[str] = Field(default=None, max_length=32)

    @field_validator("notes", mode="before")
    @classmethod
    def _notes_strip(cls, v):
        if v is None:
            return None
        s = str(v).strip()
        return s if s else None

    @field_validator("destination_verification_status", mode="before")
    @classmethod
    def _normalize_destination_verification(cls, v):
        if v is None:
            return None
        return normalize_ledger_verification_status(v)

    @model_validator(mode="after")
    def _distinct_accounts(self) -> "AccountTransferCreate":
        if self.source_account_id == self.destination_account_id:
            raise ValueError("La cuenta origen y destino deben ser distintas.")
        return self


class AccountTransferResponse(BaseModel):
    transfer_reference: str
    journal_entry_id: int
    source_journal_line_id: int
    destination_journal_line_id: int
    source_transaction_id: int = Field(
        ...,
        description="Compatibilidad: id de la línea débito/crédito origen en journal_entry_lines.",
    )
    destination_transaction_id: int = Field(
        ...,
        description="Compatibilidad: id de la línea destino en journal_entry_lines.",
    )


class AccountHistoryEntry(BaseModel):
    """Línea del libro mayor desde ``journal_entry_lines``, enriquecida con venta/cliente cuando aplica."""

    sale_id: Optional[int] = Field(default=None, description="Venta origen si reference_type=venta.")
    ledger_transaction_id: Optional[int] = Field(
        default=None,
        description="Id de la línea en ``journal_entry_lines``.",
    )
    occurred_at: datetime
    reference_number: str = Field(
        ...,
        description="Nº referencia visible (venta con padding 4 o código TRX-… para transferencias).",
    )
    reference: str = Field(..., description="Igual que reference_number (compatibilidad).")
    client_id: Optional[int] = None
    client_name: str
    notes: Optional[str] = None
    #: Efecto en el saldo de la cuenta (= ``monto_convertido_a_base``: débito +, crédito −).
    balance_effect: Decimal = Field(
        ...,
        description="Suma algebraica para saldo acumulado; coincide con la convención del libro.",
    )
    #: Cargo / aumento lado débito en presentación (importe positivo).
    charge_amount: Optional[Decimal] = Field(
        default=None,
        description="Cargo (p. ej. factura en CxC, cobro en banco).",
    )
    #: Abono / lado crédito en presentación (importe positivo).
    payment_amount: Optional[Decimal] = Field(
        default=None,
        description="Abono o pago (importe positivo).",
    )
    line_kind: Optional[str] = Field(
        default=None,
        description="Tipo de línea para UI: Factura, Pago, Transferencia, etc.",
    )
    deposit: Optional[Decimal] = None
    payment: Optional[Decimal] = None
    deposit_account_id: Optional[int] = Field(
        default=None,
        description="Cuenta de depósito real de la venta (subcuenta si aplica).",
    )
    amount_paid: Optional[Decimal] = Field(
        default=None,
        description="Abono real en moneda de la venta (mismo eje que local_amount).",
    )
    amount_currency: str
    transaction_currency: str
    exchange_rate: float
    local_amount: Optional[Decimal] = None
    amount_usd: Decimal
    status: str
    running_balance: Decimal
    iptv_username: Optional[str] = Field(default=None, description="Usuario IPTV del cliente.")
    receipt_url: Optional[str] = Field(default=None, description="Ruta del comprobante adjunto a la venta (relativa al API).")
    transaction_reason: str = Field(
        ...,
        description="Descripción contable del movimiento (ej. ingreso por venta vs. abono parcial).",
    )
    verification_status: Optional[str] = Field(
        default=None,
        description="Verificación bancaria: confirmed | not_found | interbank | wrong_account.",
    )
    verified_at: Optional[datetime] = Field(
        default=None,
        description="Fecha/hora UTC en que se marcó como confirmada; null si no aplica.",
    )
    credits_qty: Optional[int] = Field(
        default=None,
        description="Créditos/unidades de inventario activados en la venta (cuenta inventario).",
    )
    service_name: Optional[str] = Field(
        default=None,
        description="Nombre del producto o servicio de inventario asociado (p. ej. STELLA TV).",
    )


class AccountHistoryResponse(BaseModel):
    account_id: int
    account_name: str
    account_type: str = Field(..., description="Tipo ledger (ej. asset, income).")
    detail_type: Optional[str] = Field(default=None, description="Detalle QuickBooks-style.")
    currency: str
    ledger_display_mode: LedgerDisplayMode = Field(
        default="cash_register",
        description="cash_register: columnas depósito/pago; ar_register: cargo/abono estilo CxC.",
    )
    show_bank_verification: bool = Field(
        default=False,
        description="True si la cuenta es Efectivo y equivalentes (UI de verificación bancaria).",
    )
    show_inventory_credits: bool = Field(
        default=False,
        description="True si la cuenta es Inventario (UI columna créditos activados).",
    )
    opening_balance: Decimal
    closing_balance: Decimal
    confirmed_balance: Decimal = Field(
        default=Decimal("0"),
        description="Saldo neto (apertura + movimientos) solo con verification_status=confirmed.",
    )
    lines: list[AccountHistoryEntry]


class LedgerVerificationUpdate(BaseModel):
    verification_status: Optional[str] = Field(
        default=None,
        description="confirmed | not_found | interbank | wrong_account; null limpia el estado.",
    )


class LedgerVerificationResponse(BaseModel):
    line_id: int
    verification_status: Optional[str] = None
    verified_at: Optional[datetime] = None


class LedgerJournalLineDetail(BaseModel):
    """Línea débito/crédito del asiento contable origen."""

    account_id: int
    account_name: str
    account_code: Optional[str] = None
    debit: Decimal
    credit: Decimal
    currency: str = "USD"


class LedgerTransactionDetailResponse(BaseModel):
    """Detalle enriquecido del movimiento contable (origen + asiento completo)."""

    ledger_line_id: int
    journal_entry_id: int
    viewed_account_id: int
    reference_type: str
    reference_id: Optional[int] = None
    reference_number: str
    occurred_at: datetime
    origin_label: str
    line_kind: Optional[str] = None
    description: Optional[str] = None
    client_id: Optional[int] = None
    client_name: Optional[str] = None
    iptv_username: Optional[str] = None
    amount: Optional[Decimal] = None
    currency: Optional[str] = None
    exchange_rate: Optional[float] = None
    payment_method: Optional[str] = None
    receipt_url: Optional[str] = None
    status: Optional[str] = None
    approved_at: Optional[datetime] = None
    notes: Optional[str] = None
    sale_id: Optional[int] = None
    wallet_recharge_id: Optional[int] = None
    client_payment_id: Optional[int] = None
    debit: Decimal
    credit: Decimal
    journal_lines: list[LedgerJournalLineDetail]


class ReconciliationSummary(BaseModel):
    account_id: int
    account_name: str
    currency: str
    start_date: date
    end_date: date
    total_deposits: Decimal = Field(default=Decimal("0"), description="Suma de ingresos/depósitos en el rango.")
    total_payments: Decimal = Field(default=Decimal("0"), description="Suma de egresos/pagos en el rango.")
    total_confirmed: Decimal = Field(default=Decimal("0"), description="Depósitos con verification_status=confirmed.")
    total_interbank: Decimal = Field(default=Decimal("0"), description="Depósitos con verification_status=interbank.")
    total_no_effective: Decimal = Field(
        default=Decimal("0"),
        description="Depósitos con verification_status=not_found.",
    )
    total_to_reconcile: Decimal = Field(
        default=Decimal("0"),
        description="Confirmado + interbancario pendiente − pagos (cuadre con el banco).",
    )


class ReconciliationTransaction(BaseModel):
    ledger_transaction_id: int
    occurred_at: datetime
    reference_number: Optional[str] = None
    client_name: str
    transaction_reason: Optional[str] = None
    deposit: Optional[Decimal] = None
    payment: Optional[Decimal] = None
    verification_status: Optional[str] = None
    verified_at: Optional[datetime] = None


class AccountReconciliationResponse(BaseModel):
    summary: ReconciliationSummary
    transactions: list[ReconciliationTransaction]


class InventoryReconciliationCreditRow(BaseModel):
    username: str
    credits: int
    credits_platform: Optional[int] = None
    credits_erp: Optional[int] = None


class InventoryReconciliationAuditResponse(BaseModel):
    account_id: int
    account_name: str
    service_name: str
    start_date: date
    end_date: date
    platform_rows_extracted: int = 0
    matched: list[InventoryReconciliationCreditRow] = Field(default_factory=list)
    missing_in_erp: list[InventoryReconciliationCreditRow] = Field(default_factory=list)
    missing_in_platform: list[InventoryReconciliationCreditRow] = Field(default_factory=list)
    ai_read_success: bool = True
    ai_error: Optional[str] = None


class InventoryAuditReportCreate(BaseModel):
    account_id: int
    service_name: str
    start_date: date
    end_date: date
    matched_data: list[InventoryReconciliationCreditRow] = Field(default_factory=list)
    missing_erp_data: list[InventoryReconciliationCreditRow] = Field(default_factory=list)
    missing_platform_data: list[InventoryReconciliationCreditRow] = Field(default_factory=list)


class InventoryAuditReportResponse(BaseModel):
    id: int
    account_id: int
    account_name: Optional[str] = None
    service_name: str
    start_date: date
    end_date: date
    matched_data: list[InventoryReconciliationCreditRow] = Field(default_factory=list)
    missing_erp_data: list[InventoryReconciliationCreditRow] = Field(default_factory=list)
    missing_platform_data: list[InventoryReconciliationCreditRow] = Field(default_factory=list)
    created_at: datetime

    model_config = {"from_attributes": True}


class InventoryAuditBulkDeleteRequest(BaseModel):
    ids: list[int] = Field(..., min_length=1)


class InventoryAuditBulkDeleteResponse(BaseModel):
    deleted_count: int
