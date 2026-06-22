"""Payload ERP → sistema externo Códigos de Retiro (cierre de deuda firme)."""

from __future__ import annotations

from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field, model_validator


class CodigosRetiroErpPagoAprobadoOut(BaseModel):
    """
    Cuerpo enviado al socio cuando el ERP aprueba un cobro que reduce CxC de una venta o recarga BaaS.

    El receptor debe localizar deudas firmes («No salió») por ``referencia_externa`` / ``sale_id``
    / ``wallet_recharge_id`` / ``referencia_rec`` y liquidarlas (p. ej. «Pagada por otro método»).
    """

    evento: str = Field(default="pago_aprobado_erp", description="Tipo de evento.")
    estado: str = Field(default="pago_aprobado_erp", description="Alias de evento para compatibilidad.")
    obligation_kind: str = Field(
        default="sale",
        description="Tipo de obligación: ``sale`` (venta) o ``wallet_recharge`` (recarga BaaS).",
    )
    referencia_externa: str = Field(
        ...,
        description="ID numérico ERP (venta o recarga BaaS; mismo criterio que webhook entrante).",
    )
    referencia_fac: Optional[str] = Field(
        default=None,
        description="Formato alternativo FAC-0001 para búsqueda de deuda firme (ventas).",
    )
    referencia_rec: Optional[str] = Field(
        default=None,
        description="Formato alternativo REC-00042 para búsqueda de deuda firme (recarga BaaS).",
    )
    sale_id: Optional[int] = Field(default=None, ge=1)
    meta_sale_id: Optional[int] = Field(default=None, ge=1, description="Mismo valor que sale_id (META_SALE_ID).")
    wallet_recharge_id: Optional[int] = Field(default=None, ge=1)
    meta_wallet_recharge_id: Optional[int] = Field(
        default=None,
        ge=1,
        description="Mismo valor que wallet_recharge_id (META_WALLET_RECHARGE_ID).",
    )
    monto: Decimal = Field(..., gt=0, description="Importe abonado a esta venta.")
    monto_abonado: Decimal = Field(..., gt=0, description="Alias de monto aplicado a la factura.")
    moneda: str = Field(default="USD", max_length=10)
    saldo_pendiente_restante: Decimal = Field(
        default=Decimal("0"),
        ge=0,
        description="Saldo CxC de la venta tras este abono.",
    )
    cliente: str = Field(..., min_length=1, max_length=255)
    payment_id: int = Field(..., ge=1)
    payment_number: Optional[str] = None
    metodo_pago: Optional[str] = Field(
        default=None,
        description="Etiqueta del método (transferencia, códigos de retiro, saldo a favor, etc.).",
    )
    es_prueba: bool = False

    @model_validator(mode="after")
    def _validate_obligation_kind(self) -> CodigosRetiroErpPagoAprobadoOut:
        kind = str(self.obligation_kind or "sale").strip().lower()
        if kind == "wallet_recharge":
            if self.wallet_recharge_id is None:
                raise ValueError("wallet_recharge_id es obligatorio para obligation_kind=wallet_recharge")
        elif self.sale_id is None:
            raise ValueError("sale_id es obligatorio para obligation_kind=sale")
        return self
