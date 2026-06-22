"""Payload ERP → sistema externo Códigos de Retiro (cierre de deuda firme)."""

from __future__ import annotations

from decimal import Decimal
from typing import Optional

from pydantic import BaseModel, Field


class CodigosRetiroErpPagoAprobadoOut(BaseModel):
    """
    Cuerpo enviado al socio cuando el ERP aprueba un cobro que reduce CxC de una venta.

    El receptor debe localizar deudas firmes («No salió») por ``referencia_externa`` / ``sale_id``
    y liquidarlas (p. ej. «Pagada por otro método»).
    """

    evento: str = Field(default="pago_aprobado_erp", description="Tipo de evento.")
    estado: str = Field(default="pago_aprobado_erp", description="Alias de evento para compatibilidad.")
    referencia_externa: str = Field(..., description="ID de venta (numérico; mismo criterio que webhook entrante).")
    referencia_fac: Optional[str] = Field(
        default=None,
        description="Formato alternativo FAC-0001 para búsqueda de deuda firme.",
    )
    sale_id: int = Field(..., ge=1)
    meta_sale_id: int = Field(..., ge=1, description="Mismo valor que sale_id (META_SALE_ID).")
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
