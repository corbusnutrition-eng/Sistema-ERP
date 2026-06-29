from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field, field_validator

from app.currency_utils import normalize_currency_code
class ArInvoicePaymentOut(BaseModel):
    """Cobro aplicado a una factura (desde ``payment_allocations``)."""

    payment_id: int
    payment_number: Optional[str] = Field(
        default=None,
        description="Número de recibo del pago.",
    )
    date: Optional[datetime] = Field(
        default=None,
        description="Fecha de aprobación o registro del pago.",
    )
    amount_applied: float = Field(description="Monto aplicado a esta factura.")


class ArOpenInvoiceOut(BaseModel):
    """Obligación CxC abierta (venta o recarga BaaS) con cobros aplicados."""

    obligation_kind: str = Field(
        default="sale",
        description="``sale`` (factura IPTV) o ``wallet_recharge`` (recarga BaaS).",
    )
    sale_id: Optional[int] = Field(default=None, description="ID de venta cuando ``obligation_kind=sale``.")
    wallet_recharge_id: Optional[int] = Field(
        default=None,
        description="ID de solicitud BaaS cuando ``obligation_kind=wallet_recharge``.",
    )
    reference: str
    date: Optional[datetime] = None
    total_amount: float
    open_balance: float
    currency: str = "USD"
    payments: list[ArInvoicePaymentOut] = Field(
        default_factory=list,
        description="Cobros aprobados aplicados a esta obligación.",
    )


class PnlLine(BaseModel):
    account_id: int
    name: str
    detail_type: Optional[str] = None
    amount: Decimal


class PnlSection(BaseModel):
    key: str
    label: str
    lines: list[PnlLine]
    subtotal: Decimal


class PnlResponse(BaseModel):
    start_date: date
    end_date: date
    currency_filter: Optional[str] = None
    sections: list[PnlSection]
    total_ingresos: Decimal
    total_otros_ingresos: Decimal
    total_costo_ventas: Decimal
    beneficio_bruto: Decimal
    total_gastos: Decimal
    total_otros_gastos: Decimal
    ganancia_neta: Decimal


class ExpenseJournalCreate(BaseModel):
    expense_account_id: int = Field(..., ge=1)
    source_account_id: int = Field(..., ge=1)
    amount: Decimal = Field(..., gt=0)
    currency: str = Field(default="USD", min_length=3, max_length=10)
    occurred_at: Optional[datetime] = None
    notes: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("currency", mode="before")
    @classmethod
    def _norm_currency_exp_je(cls, v: object) -> str:
        return normalize_currency_code(v) if v not in (None, "") else "USD"


class ExpenseJournalResponse(BaseModel):
    journal_entry_id: int
    debit_journal_line_id: int
    credit_journal_line_id: int
    debit_transaction_id: int = Field(
        ...,
        description="Compatibilidad: id de línea débito en journal_entry_lines.",
    )
    credit_transaction_id: int = Field(
        ...,
        description="Compatibilidad: id de línea crédito en journal_entry_lines.",
    )


class PnlAccountRow(BaseModel):
    """Cuenta o subárbol en el P&L (estilo QuickBooks)."""

    cuenta: str
    account_id: int
    monto: Decimal
    subcuentas: list["PnlAccountRow"] = Field(default_factory=list)


class ProfitAndLossResponse(BaseModel):
    """Estado de resultados (P&L) jerárquico desde ``journal_entry_lines``."""

    model_config = {"populate_by_name": True}

    start_date: date
    end_date: date
    ingresos: list[PnlAccountRow] = Field(default_factory=list, serialization_alias="Ingresos")
    costo_de_ventas: list[PnlAccountRow] = Field(
        default_factory=list,
        serialization_alias="Costo de Ventas",
    )
    gastos: list[PnlAccountRow] = Field(default_factory=list, serialization_alias="Gastos")
    otros_ingresos: list[PnlAccountRow] = Field(
        default_factory=list,
        serialization_alias="Otros ingresos",
    )
    cuentas_otros_gastos_financieros: list[PnlAccountRow] = Field(
        default_factory=list,
        serialization_alias="Otros gastos financieros",
    )
    ingresos_operativos: Decimal
    costos_ventas: Decimal
    utilidad_bruta: Decimal
    gastos_operativos: Decimal
    otros_gastos_financieros: Decimal
    utilidad_neta: Decimal


class ArCurrencyTotal(BaseModel):
    """Totales agregados por moneda en el informe CxC."""

    currency: str
    total_amount_due: Decimal = Field(default=Decimal("0"))
    total_credit_balance: Decimal = Field(default=Decimal("0"))


class ClientArBalanceRow(BaseModel):
    """Saldo CxC de un cliente (deuda o saldo a favor)."""

    client_id: int
    client_name: str
    client_username: Optional[str] = Field(
        default=None,
        description="Usuario IPTV / identificador corto del cliente.",
    )
    currency: str = Field(default="USD", description="Moneda del saldo mostrado.")
    amount_due: Decimal = Field(
        default=Decimal("0"),
        description="Deuda pendiente (facturas + recargas BaaS con saldo CxC).",
    )
    credit_balance: Decimal = Field(default=Decimal("0"), description="Saldo a favor acumulado del cliente.")
    open_invoices: list[ArOpenInvoiceOut] = Field(
        default_factory=list,
        description="Facturas pendientes que componen la deuda (solo filas de deudores).",
    )


class ListClassificationRow(BaseModel):
    """Fila agrupada por ítem de lista (clase, método de pago, moneda o etiqueta)."""

    item_id: Optional[int] = Field(default=None, description="ID del ítem en catálogo (null si no aplica).")
    item_key: Optional[str] = Field(default=None, description="Clave alternativa (p. ej. código ISO de moneda).")
    item_name: str
    transaction_count: int = Field(ge=0)
    total_amount_usd: Decimal


class ListClassificationReportResponse(BaseModel):
    """Totales de transacciones agrupados por dimensión de lista."""

    start_date: date
    end_date: date
    list_type: str
    list_type_label: str
    rows: list[ListClassificationRow] = Field(default_factory=list)
    grand_total_count: int = Field(ge=0)
    grand_total_amount_usd: Decimal


class AccountsReceivableReportResponse(BaseModel):
    """Resumen de cuentas por cobrar agrupado por cliente."""

    generated_at: datetime
    currency_filter: Optional[str] = None
    debtors: list[ClientArBalanceRow] = Field(
        default_factory=list,
        description="Clientes con deuda pendiente > 0.",
    )
    credit_balances: list[ClientArBalanceRow] = Field(
        default_factory=list,
        description="Clientes con saldo a favor > 0 (una fila por cliente y moneda).",
    )
    total_amount_due: Decimal = Field(default=Decimal("0"))
    total_credit_balance: Decimal = Field(default=Decimal("0"))
    totals_by_currency: list[ArCurrencyTotal] = Field(
        default_factory=list,
        description="Totales de deuda y saldo a favor agrupados por moneda.",
    )
