from __future__ import annotations

import json
import math
import uuid
from datetime import datetime
from typing import Any, List, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, EmailStr, Field, computed_field, field_validator, model_validator

from app.currency_utils import normalize_currency_code
from app.models.user import UserRole
from app.schemas.client_product_prices import ClientProductPriceItem


def _coerce_optional_id_list(v: object) -> Optional[list[int]]:
    """Normaliza listas guardadas en JSON/SQLite (p. ej. ``[1,2]`` o cadena JSON)."""
    if v is None:
        return None
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except (json.JSONDecodeError, TypeError):
            return None
    if isinstance(v, dict):
        v = list(v.values())
    if not isinstance(v, list):
        return None
    out: list[int] = []
    for x in v:
        try:
            out.append(int(x))
        except (TypeError, ValueError):
            continue
    return out or None


class CatalogClientsPickerResponse(BaseModel):
    """
    Opciones de «distribuidor / cliente» para solicitud de recarga BaaS.
    Origen: webhook ``listar-clientes`` en Render o fallback tabla ``clients`` del ERP.
    """

    status: str = Field(default="ok")
    clientes: List[Any] = Field(default_factory=list)
    source: str = Field(
        ...,
        description="render | local_fallback | local_only",
    )
    warning: Optional[str] = Field(
        default=None,
        description="Aviso no bloqueante para la UI cuando se usa lista local.",
    )


class DistributorUserRead(BaseModel):
    """Usuario interno con campos de jerarquía y saldo virtual."""

    id: int
    name: str
    email: str
    role: UserRole
    is_active: bool
    parent_id: Optional[int] = None
    wallet_balance: float = 0.0
    referral_code: Optional[str] = None

    model_config = {"from_attributes": True}


class DistributorWalletClientRead(BaseModel):
    """Cliente CRM con billetera BaaS (pestaña «Clientes y Distribuidores»)."""

    id: int
    parent_id: Optional[int] = Field(
        default=None,
        description="Distribuidor padre; null = cliente de primera línea (raíz ERP).",
    )
    name: Optional[str] = None
    email: str
    username: str
    wallet_balance: float = 0.0
    credit_balance: float = 0.0
    currency: str = Field(default="USD", max_length=10, description="Moneda base BaaS del cliente.")
    status: Optional[str] = None
    payment_token: uuid.UUID = Field(description="UUID permanente del cliente (enlace árbol BaaS).")

    model_config = {"from_attributes": True}


class DistributorTreeNode(BaseModel):
    """Nodo del árbol genealógico BaaS (sub-distribuidores recursivos)."""

    id: str
    name: str
    username: str
    email: str
    status: str = Field(default="Activo", description="Activo | Inactivo")
    wallet_balance: float = Field(default=0.0, ge=0)
    currency: str = Field(default="USD", max_length=10, description="Moneda base BaaS del nodo.")
    payment_token: str
    nivel: int = Field(default=1, ge=1, description="Profundidad en el árbol BaaS (raíz = 1).")
    children: list["DistributorTreeNode"] = Field(default_factory=list)


class DistributorUserUpdate(BaseModel):
    """Actualización opcional de jerarquía / código (uso administrativo)."""

    parent_id: Optional[int] = None
    referral_code: Optional[str] = Field(default=None, max_length=64)


# ── WalletTransaction ───────────────────────────────────────────────────────────


class WalletTransactionCreate(BaseModel):
    amount: float
    transaction_type: str = Field(..., max_length=32)
    description: Optional[str] = Field(default=None, max_length=500)


class WalletTransactionRead(BaseModel):
    id: int
    user_id: Optional[int] = None
    client_id: Optional[int] = None
    amount: float
    transaction_type: str
    description: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class WalletTransactionUpdate(BaseModel):
    """Actualización limitada (p. ej. descripción administrativa)."""

    description: Optional[str] = Field(default=None, max_length=500)


# ── CustomPrice (precio por par vendedor-comprador-paquete) ─────────────────────


class CustomPriceCreate(BaseModel):
    seller_id: int
    buyer_id: int
    package_id: int
    price: float = Field(..., gt=0)


class CustomPriceRead(BaseModel):
    id: int
    seller_id: int
    buyer_id: int
    package_id: int
    price: float

    model_config = {"from_attributes": True}


class CustomPriceUpdate(BaseModel):
    price: float = Field(..., gt=0)


# ── Cuerpos de endpoints del motor ────────────────────────────────────────────────


class RechargeRequest(BaseModel):
    user_id: int = Field(..., gt=0)
    amount: float = Field(..., gt=0)
    description: Optional[str] = Field(default=None, max_length=500)


class TransferRequest(BaseModel):
    buyer_user_id: int = Field(..., gt=0, description="Subdistribuidor (hijo directo)")
    amount: float = Field(..., gt=0)


class SetPriceRequest(BaseModel):
    buyer_user_id: int = Field(..., gt=0)
    package_id: int = Field(..., gt=0)
    price: float = Field(..., gt=0)


class AssignParentRequest(BaseModel):
    """Asigna o quita padre en la jerarquía (solo administrador)."""

    child_user_id: int = Field(..., gt=0)
    parent_user_id: Optional[int] = Field(
        default=None,
        description="Usuario padre; null para quitar jerarquía",
    )


class RechargeResponse(BaseModel):
    user: DistributorUserRead
    transaction: WalletTransactionRead


class TransferResponse(BaseModel):
    sender: DistributorUserRead
    receiver: DistributorUserRead
    transactions: List[WalletTransactionRead]


class SetPriceResponse(BaseModel):
    custom_price: CustomPriceRead


# ── Solicitudes de recarga con recibo (BaaS) ────────────────────────────────────


class WalletRechargeLineItemPayload(BaseModel):
    """Línea de recarga BaaS: saldo virtual a acreditar + importe cobrado (puede venir legado qty×tarifa)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    product_name: Optional[str] = Field(
        default=None,
        max_length=500,
        validation_alias=AliasChoices("product_name", "producto", "product", "servicio"),
    )
    tipo_moneda: str = Field(
        default="USD",
        max_length=10,
        validation_alias=AliasChoices("tipo_moneda", "balance_currency", "moneda_saldo"),
        description="Moneda en la que se expresa el saldo virtual a recargar (informativa por línea).",
    )
    saldo_recargar: Optional[float] = Field(
        default=None,
        gt=0,
        validation_alias=AliasChoices("saldo_recargar", "balance_to_recharge", "virtual_balance"),
    )
    importe: Optional[float] = Field(
        default=None,
        gt=0,
        validation_alias=AliasChoices("importe", "line_amount", "monto_linea"),
        description="Importe monetario cobrado en esta línea (moneda de la solicitud / portal).",
    )
    #: Campos legados (modal tipo ventas); si hay ``qty`` y ``rate``, se derivan ``importe`` y opc. ``saldo_recargar``.
    description: Optional[str] = Field(default=None, max_length=2000)
    qty: Optional[float] = Field(default=None, gt=0)
    rate: Optional[float] = Field(default=None, gt=0)
    transaction_class_id: Optional[int] = Field(
        default=None,
        validation_alias=AliasChoices("transaction_class_id", "clase_id"),
    )

    @field_validator("tipo_moneda", mode="before")
    @classmethod
    def _norm_tm(cls, v: object) -> object:
        if v is None or str(v).strip() == "":
            return "USD"
        return normalize_currency_code(v, "USD")

    @field_validator("saldo_recargar", "importe", "qty", "rate", mode="before")
    @classmethod
    def _coerce_opt_float_li(cls, v: object) -> object:
        if v is None or v == "":
            return None
        if isinstance(v, str):
            s = v.strip().replace(",", ".")
            if s == "":
                return None
            return float(s)
        return v

    @field_validator("transaction_class_id", mode="before")
    @classmethod
    def _tc_opt_li(cls, v: object) -> object:
        if v is None or v == "":
            return None
        return int(v)

    @model_validator(mode="after")
    def _legacy_and_defaults(self) -> "WalletRechargeLineItemPayload":
        imp_raw = self.importe
        qty_raw = self.qty
        rate_raw = self.rate

        imp = float(imp_raw) if imp_raw is not None and float(imp_raw) > 0 else None
        qty_ok = qty_raw is not None and float(qty_raw) > 0
        rate_ok = rate_raw is not None and float(rate_raw) > 0

        if imp is None and qty_ok and rate_ok:
            imp = round(float(qty_raw) * float(rate_raw), 2)
            object.__setattr__(self, "importe", imp)

        if self.saldo_recargar is None and qty_ok:
            object.__setattr__(self, "saldo_recargar", float(qty_raw))
        elif self.saldo_recargar is None and imp is not None:
            object.__setattr__(self, "saldo_recargar", float(imp))

        if self.importe is None or float(self.importe) <= 0:
            raise ValueError("Cada línea debe tener importe (>0), o bien cantidad y tarifa válidos.")

        pn = self.product_name
        if pn is None or str(pn).strip() == "":
            object.__setattr__(self, "product_name", "Saldo BaaS")

        return self

    def line_charge_amount(self) -> float:
        return float(self.importe or 0.0)


class WalletRechargeRequestCreate(BaseModel):
    amount_requested: float = Field(..., gt=0)
    receipt_url: str = Field(..., min_length=1, max_length=2048)


class WalletRechargeRequestRead(BaseModel):
    id: int
    client_id: int
    amount_requested: float
    amount_paid: float = Field(default=0.0, description="Acumulado aplicado contra el objetivo de la recarga.")
    balance_pending: float = Field(
        default=0.0,
        description="Resto pendiente de cubrir contra amount_requested antes de cerrar la solicitud.",
    )
    surplus_credited: float = Field(default=0.0, description="Excedente acumulado enviado a saldo a favor CxC del cliente.")
    receipt_url: Optional[str] = None
    status: str
    created_at: datetime
    link_hash: Optional[str] = None
    allowed_payment_methods: Optional[list[int]] = None
    allowed_deposit_account_ids: Optional[list[int]] = None
    recharge_currency: str = "USD"
    recharge_exchange_rate: float = 1.0
    admin_precheck_receipt_url: Optional[str] = None
    portal_submitted_deposit_account_id: Optional[int] = None
    portal_declared_payment_amount: Optional[float] = None
    recharge_detail_lines: Optional[list[dict[str, Any]]] = Field(
        default=None,
        description="Líneas de detalle (producto/cantidad/tarifa) guardadas desde el modal multilinea.",
    )
    declared_deposit_usd: Optional[float] = Field(default=None, description="Depósito declarado en USD al crear/editar desde ERP.")
    is_manually_edited: bool = Field(default=False)
    ai_confidence_score: Optional[int] = Field(default=None, ge=0, le=100)

    model_config = {"from_attributes": True}

    @field_validator("allowed_payment_methods", mode="before")
    @classmethod
    def _coerce_pm_ids(cls, v: object) -> Optional[list[int]]:
        return _coerce_optional_id_list(v)

    @field_validator("allowed_deposit_account_ids", mode="before")
    @classmethod
    def _coerce_dep_ids(cls, v: object) -> Optional[list[int]]:
        return _coerce_optional_id_list(v)


class WalletRechargeLinkedPaymentAdmin(BaseModel):
    """Abono aplicado contra una solicitud (acreditación) o comprobante en revisión (portal).

    Compatible con el desglose financiero de ventas (``linked_payments`` / revisión).
    """

    kind: str = Field(
        default="credit_applied",
        description="credit_applied | receipt_under_review",
    )
    occurred_at: Optional[datetime] = None
    amount: float
    currency: str = Field(default="USD")
    status_label: str
    receipt_url: Optional[str] = None
    wallet_transaction_id: Optional[int] = Field(
        default=None,
        description="Presente sólo cuando el movimiento viene de ledger de billetera.",
    )
    payment_id: Optional[int] = Field(
        default=None,
        description="``ClientPayment.id`` cuando el abono proviene del motor CxC.",
    )
    payment_number: Optional[str] = Field(
        default=None,
        description="Número legible del pago (ej. PAG-00042).",
    )
    amount_applied: Optional[float] = Field(
        default=None,
        description="Importe aplicado a la solicitud (sin excedente a favor).",
    )
    receipt_file_url: Optional[str] = Field(
        default=None,
        description="URL del comprobante (alias de ``receipt_url`` para el frontend de ventas).",
    )
    credit_portion: Optional[float] = Field(
        default=None,
        description="Importe declarado como cruce de saldo a favor (pendiente de aprobación).",
    )
    cash_portion: Optional[float] = Field(
        default=None,
        description="Importe declarado como depósito bancario (pendiente de aprobación).",
    )
    is_manually_edited: bool = Field(default=False)
    ai_confidence_score: Optional[int] = Field(default=None, ge=0, le=100)


class WalletRechargeRequestAdminRow(BaseModel):
    """Fila para el panel admin con datos del cliente/distribuidor CRM."""

    id: int
    client_id: int
    client_name: Optional[str] = None
    client_email: str = ""
    client_username: str = ""
    amount_requested: float
    receipt_url: Optional[str] = None
    payment_methods_display: Optional[str] = Field(
        default=None,
        description="Nombres de métodos permitidos para esta solicitud (catálogo).",
    )
    status: str
    created_at: datetime
    recharge_currency: str = "USD"
    recharge_exchange_rate: float = 1.0
    allowed_payment_methods: Optional[list[int]] = None
    allowed_deposit_account_ids: Optional[list[int]] = None
    link_hash: Optional[str] = None
    admin_precheck_receipt_url: Optional[str] = None
    #: Token permanente del portal del cliente (``/portal/{uuid}``).
    client_payment_token: Optional[str] = Field(
        default=None,
        description="UUID del cliente para armar el enlace permanente del portal.",
    )
    #: Texto editable por admin; tiene prioridad en ``notes_preview`` sobre sugerencias automáticas.
    admin_note: Optional[str] = Field(
        default=None,
        description="Nota interna del administrador; vacío → se muestran pistas automáticas en NOTA.",
    )
    #: Comentario tipo nota rápida (portal / precheck admin), para columna «Nota» al estilo Ventas.
    notes_preview: Optional[str] = Field(default=None)
    amount_paid: float = 0.0
    balance_pending: float = 0.0
    surplus_credited: float = 0.0
    recharge_detail_lines: Optional[list[dict[str, Any]]] = Field(default=None)
    declared_deposit_usd: Optional[float] = Field(default=None)
    portal_declared_payment_amount: Optional[float] = Field(
        default=None,
        description="Importe que el cliente declaró en el portal al subir el comprobante.",
    )
    is_manually_edited: bool = Field(default=False)
    ai_confidence_score: Optional[int] = Field(default=None, ge=0, le=100)
    linked_payments: list[WalletRechargeLinkedPaymentAdmin] = Field(
        default_factory=list,
        description="Historial de abonos reconocidos y comprobante en revisión vinculados a esta recarga.",
    )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_amount(self) -> float:
        """Alias alineado con ventas (``local_amount`` / total facturado)."""
        return float(self.amount_requested)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def paid_amount(self) -> float:
        """Alias alineado con ventas (``amount_paid``)."""
        return float(self.amount_paid)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def pending_amount(self) -> float:
        """Alias alineado con ventas (saldo pendiente CxC)."""
        return float(self.balance_pending)

    @field_validator("allowed_payment_methods", mode="before")
    @classmethod
    def _coerce_pm_ids_admin(cls, v: object) -> Optional[list[int]]:
        return _coerce_optional_id_list(v)

    @field_validator("allowed_deposit_account_ids", mode="before")
    @classmethod
    def _coerce_dep_ids_admin(cls, v: object) -> Optional[list[int]]:
        return _coerce_optional_id_list(v)


class ClientWalletBrief(BaseModel):
    """Cliente CRM tras acreditación de recarga BaaS."""

    id: int
    name: Optional[str] = None
    email: str
    username: str
    wallet_balance: float = 0.0
    credit_balance: float = Field(
        default=0.0,
        description="Saldo a favor CxC después de registrar excedentes de la recarga (si aplicó).",
    )

    model_config = {"from_attributes": True}


class ApproveWalletRechargePayload(BaseModel):
    """Monto efectivamente percibido al aprobar (abono parcial o total + excedente)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    received_amount: Optional[float] = Field(
        default=None,
        gt=0,
        validation_alias=AliasChoices(
            "received_amount",
            "monto_real_recibido",
            "monto_real",
            "amount_received",
        ),
        description=(
            "Importe entrado en banco/equivalente por este comprobante. "
            "Si se omite, se asume igual al saldo pendiente de la solicitud (compatibilidad)."
        ),
    )

    @field_validator("received_amount", mode="before")
    @classmethod
    def _coerce_ra(cls, v: object) -> object:
        if v is None or v == "":
            return None
        if isinstance(v, str):
            s = v.strip().replace(",", ".")
            return float(s) if s else None
        return v


class ApproveWalletRechargeResponse(BaseModel):
    request: WalletRechargeRequestRead
    client: ClientWalletBrief
    transaction: WalletTransactionRead


class WalletRechargeRequestsMetrics(BaseModel):
    """Conteos por estado para insignias tipo Ventas."""

    pending: int = 0
    in_review: int = 0
    partially_paid: int = 0
    approved: int = 0
    rejected: int = 0
    canceled: int = 0


class WalletRechargeRequestPendingUpdate(BaseModel):
    """Actualización parcial cuando la solicitud está ``pending`` o ``in_review`` (admin)."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    amount: Optional[float] = Field(default=None, gt=0, validation_alias=AliasChoices("amount", "amount_requested", "monto"))
    allowed_payment_methods: Optional[list[int]] = Field(
        default=None,
        validation_alias=AliasChoices(
            "allowed_payment_methods",
            "payment_method_ids",
            "metodos_pago",
        ),
    )
    allowed_deposit_account_ids: Optional[list[int]] = Field(
        default=None,
        validation_alias=AliasChoices(
            "allowed_deposit_account_ids",
            "deposit_account_ids",
            "cuenta_ids",
            "accounts",
        ),
    )
    currency: Optional[str] = Field(
        default=None,
        max_length=10,
        validation_alias=AliasChoices("currency", "recharge_currency", "moneda"),
    )
    exchange_rate: Optional[float] = Field(
        default=None,
        gt=0,
        validation_alias=AliasChoices("exchange_rate", "recharge_exchange_rate", "tasa"),
    )
    admin_precheck_receipt_url: Optional[str] = Field(
        default=None,
        max_length=2048,
        validation_alias=AliasChoices("admin_precheck_receipt_url", "precheck_receipt_url"),
    )
    line_items: Optional[list[WalletRechargeLineItemPayload]] = Field(
        default=None,
        validation_alias=AliasChoices("line_items", "items", "articulos"),
    )
    declared_deposit_usd: Optional[float] = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices(
            "declared_deposit_usd",
            "deposit_amount_usd",
            "monto_pagado",
            "importe_deposito_usd",
        ),
    )
    portal_declared_payment_amount: Optional[float] = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices(
            "portal_declared_payment_amount",
            "declared_amount",
            "declared_payment_amount",
            "monto_declarado",
        ),
        description="Depósito declarado en moneda de la solicitud (corrección admin).",
    )
    admin_note: Optional[str] = Field(
        default=None,
        max_length=2048,
        validation_alias=AliasChoices("admin_note", "creation_note", "note", "comentario"),
        description="Nota interna (columna NOTA).",
    )

    @field_validator("admin_note", mode="before")
    @classmethod
    def _admin_note_opt(cls, v: object) -> object:
        if v is None:
            return None
        s = str(v).strip()
        return s[:2048] if s else None

    @field_validator("declared_deposit_usd", mode="before")
    @classmethod
    def _coerce_decl_dep(cls, v: object) -> object:
        if v is None or v == "":
            return None
        if isinstance(v, str):
            s = v.strip().replace(",", ".")
            return float(s) if s else None
        return v

    @field_validator("amount", "exchange_rate", mode="before")
    @classmethod
    def _coerce_opt_float(cls, v: object) -> object:
        if v is None or v == "":
            return None
        if isinstance(v, str):
            s = v.strip().replace(",", ".")
            if s == "":
                return None
            return float(s)
        return v

    @field_validator("allowed_payment_methods", mode="before")
    @classmethod
    def _normalize_pm(cls, v: object) -> Optional[list[int]]:
        if v is None or v == "":
            return None
        if isinstance(v, (int, float, str)):
            v = [v]
        if not isinstance(v, list):
            raise ValueError("Lista de métodos inválida.")
        return [int(str(x).strip()) for x in v]

    @field_validator("allowed_deposit_account_ids", mode="before")
    @classmethod
    def _normalize_dep(cls, v: object) -> Optional[list[int]]:
        if v is None or v == "":
            return None
        if isinstance(v, (int, float, str)):
            v = [v]
        if not isinstance(v, list):
            return None
        return [int(str(x).strip()) for x in v]

    @field_validator("currency", mode="before")
    @classmethod
    def _norm_cur(cls, v: object) -> object:
        if v is None or v == "":
            return None
        return normalize_currency_code(v, "USD")

    @model_validator(mode="after")
    def _lines_amount_coherence(self) -> "WalletRechargeRequestPendingUpdate":
        lis = self.line_items
        if lis is None:
            return self
        if len(lis) < 1:
            raise ValueError("Si envías líneas, incluye al menos una fila.")
        total = round(sum(li.line_charge_amount() for li in lis), 2)
        if self.amount is not None and abs(total - round(float(self.amount), 2)) > 0.02:
            raise ValueError("El monto solicitado no coincide con la suma de importes de las líneas.")
        return self

    @model_validator(mode="after")
    def _any_field_set(self) -> "WalletRechargeRequestPendingUpdate":
        if (
            self.amount is None
            and self.allowed_payment_methods is None
            and self.allowed_deposit_account_ids is None
            and self.currency is None
            and self.exchange_rate is None
            and self.admin_precheck_receipt_url is None
            and self.line_items is None
            and self.declared_deposit_usd is None
            and self.portal_declared_payment_amount is None
            and self.admin_note is None
        ):
            raise ValueError("Indica al menos un campo a actualizar.")
        return self


class WalletRechargeRequestAdminNoteUpdate(BaseModel):
    """Sobrescribe o borra la nota administrativa sobre una solicitud en curso."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    note: str = Field(
        default="",
        max_length=2048,
        validation_alias=AliasChoices("note", "nota", "mensaje", "admin_note"),
        description='Cadena guardada como NOTA visible. Vacío borra la nota y recupera sugerencias automáticas.',
    )

    @field_validator("note", mode="before")
    @classmethod
    def _coerce_note(cls, v: object) -> str:
        if v is None:
            return ""
        return str(v)


class GenerateRechargeLinkPayload(BaseModel):
    """Admin crea una solicitud + enlace público para que el distribuidor pague y suba recibo."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    distributor_email: EmailStr = Field(
        ...,
        validation_alias=AliasChoices("distributor_email", "email", "correo"),
        description="Correo del distribuidor (catálogo VIP / Render).",
    )
    amount: Optional[float] = Field(
        default=None,
        validation_alias=AliasChoices("amount", "amount_requested", "monto", "total"),
        description="Total a recargar. Opcional si se envían line_items; en ese caso se toma Σ importe por línea.",
    )
    allowed_payment_methods: list[int] = Field(
        ...,
        min_length=1,
        validation_alias=AliasChoices(
            "allowed_payment_methods",
            "payment_method_ids",
            "metodos_pago",
            "payment_methods",
        ),
    )
    allowed_deposit_account_ids: Optional[list[int]] = Field(
        default=None,
        validation_alias=AliasChoices(
            "allowed_deposit_account_ids",
            "deposit_account_ids",
            "cuenta_ids",
            "cuentas_deposito",
            "accounts",
        ),
        description="Si se envía lista no vacía, el portal solo muestra esas cuentas (subconjunto válido).",
    )
    currency: str = Field(
        default="USD",
        max_length=10,
        validation_alias=AliasChoices("currency", "recharge_currency", "billing_currency", "moneda"),
        description="Moneda de cobro (ISO o extendida, ej. USDT).",
    )
    exchange_rate: Optional[float] = Field(
        default=None,
        validation_alias=AliasChoices(
            "exchange_rate",
            "recharge_exchange_rate",
            "tasa",
            "fx_rate",
            "tipo_cambio",
        ),
        description="Unidades de moneda de cobro por 1 USD (misma convención que ventas). Omisión o null ⇒ 1.0.",
    )
    admin_precheck_receipt_url: Optional[str] = Field(
        default=None,
        max_length=2048,
        validation_alias=AliasChoices(
            "admin_precheck_receipt_url",
            "precheck_receipt_url",
            "comprobante_admin_url",
        ),
        description="URL opcional de comprobante previo (ej. subido vía /uploads/receipt).",
    )
    line_items: Optional[list[WalletRechargeLineItemPayload]] = Field(
        default=None,
        validation_alias=AliasChoices("line_items", "items", "articulos"),
        description="Líneas opcionales; si se envían, amount debe igualar la suma de importe por línea.",
    )
    deposit_amount_usd: Optional[float] = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices(
            "deposit_amount_usd",
            "monto_pagado",
            "declared_deposit_usd",
            "importe_deposito_usd",
        ),
        description="Importe declarado del depósito en USD (referencia en portal; no acredita billetera).",
    )
    credit_applied_amount: Optional[float] = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices(
            "credit_applied_amount",
            "credit_applied",
            "saldo_favor_aplicado",
            "apply_credit_amount",
        ),
        description="Saldo a favor del cliente a aplicar al crear la solicitud (mismo patrón que portal/ventas).",
    )
    creation_note: Optional[str] = Field(
        default=None,
        max_length=2048,
        validation_alias=AliasChoices("creation_note", "note", "comentario", "notes"),
        description="Nota interna al crear la solicitud (visible como NOTA en admin).",
    )
    client_product_prices: Optional[list[ClientProductPriceItem]] = Field(
        default=None,
        validation_alias=AliasChoices(
            "client_product_prices",
            "product_prices",
            "precios_personalizados",
            "sale_prices",
        ),
        description="Precios de venta personalizados (solo productos crédito por pantalla) para el distribuidor.",
    )

    @field_validator("deposit_amount_usd", mode="before")
    @classmethod
    def _coerce_dep_usd_gen(cls, v: object) -> object:
        if v is None or v == "":
            return None
        if isinstance(v, str):
            s = v.strip().replace(",", ".")
            return float(s) if s else None
        return v

    @field_validator("creation_note", mode="before")
    @classmethod
    def _creation_note_strip(cls, v: object) -> object:
        if v is None:
            return None
        s = str(v).strip()
        return s[:2048] if s else None

    @model_validator(mode="after")
    def _resolve_amount_and_exchange_rate(self) -> "GenerateRechargeLinkPayload":
        items = self.line_items

        xr_raw = self.exchange_rate
        if xr_raw is None or (isinstance(xr_raw, float) and math.isnan(xr_raw)):
            xr_f = 1.0
        else:
            try:
                xr_f = float(xr_raw)
            except (TypeError, ValueError) as e:
                raise ValueError("La tasa de cambio debe ser un número válido.") from e
            if math.isnan(xr_f) or xr_f <= 0:
                raise ValueError("La tasa de cambio debe ser un número mayor que cero.")
        object.__setattr__(self, "exchange_rate", xr_f)

        if items:
            total = round(sum(li.line_charge_amount() for li in items), 2)
            if total <= 0:
                raise ValueError("La suma de importes por línea debe ser mayor que cero.")
            if self.amount is None:
                object.__setattr__(self, "amount", total)
            else:
                try:
                    target = round(float(self.amount), 2)
                except (TypeError, ValueError) as e:
                    raise ValueError("El monto principal debe ser un número válido.") from e
                if abs(target - total) > 0.06:
                    raise ValueError(
                        f"El monto total ({target}) no coincide con la suma de líneas ({total}); "
                        "ajusta líneas o el total."
                    )
                object.__setattr__(self, "amount", total)
        elif self.amount is None:
            raise ValueError("Indica el monto a recargar ('amount') o envía líneas con importes válidos.")
        else:
            try:
                amt_f = round(float(self.amount), 2)
            except (TypeError, ValueError) as e:
                raise ValueError("El monto a recargar debe ser un número válido.") from e
            if math.isnan(amt_f) or amt_f <= 0:
                raise ValueError("El monto a recargar debe ser mayor que cero.")
            object.__setattr__(self, "amount", amt_f)

        return self

    @field_validator("distributor_email", mode="before")
    @classmethod
    def _strip_email_in(cls, v: object) -> object:
        if isinstance(v, str):
            return v.strip()
        return v

    @field_validator("amount", mode="before")
    @classmethod
    def _coerce_amount_opt(cls, v: object) -> object:
        if v is None or v == "":
            return None
        if isinstance(v, str):
            s = v.strip().replace(",", ".")
            if s == "":
                return None
            try:
                return float(s)
            except ValueError as e:
                raise ValueError("Monto principal inválido.") from e
        return v

    @field_validator("exchange_rate", mode="before")
    @classmethod
    def _coerce_exchange_rate_opt(cls, v: object) -> object:
        if v is None or v == "":
            return None
        if isinstance(v, str):
            s = v.strip().replace(",", ".")
            if s == "":
                return None
            try:
                return float(s)
            except ValueError as e:
                raise ValueError("Tasa de cambio inválida.") from e
        return v

    @field_validator("allowed_payment_methods", mode="before")
    @classmethod
    def _normalize_payment_method_ids(cls, v: object) -> list[int]:
        if v is None:
            raise ValueError("Indica al menos un método de pago.")
        if isinstance(v, (int, float, str)):
            v = [v]
        if not isinstance(v, list) or len(v) < 1:
            raise ValueError("Lista de métodos de pago inválida.")
        out: list[int] = []
        for x in v:
            try:
                i = int(str(x).strip())
            except (TypeError, ValueError) as e:
                raise ValueError("IDs de método de pago inválidos.") from e
            out.append(i)
        return out

    @field_validator("allowed_deposit_account_ids", mode="before")
    @classmethod
    def _normalize_deposit_account_ids(cls, v: object) -> Optional[list[int]]:
        if v is None or v == "":
            return None
        if isinstance(v, (int, float, str)):
            v = [v]
        if not isinstance(v, list) or len(v) == 0:
            return None
        out: list[int] = []
        for x in v:
            try:
                out.append(int(str(x).strip()))
            except (TypeError, ValueError) as e:
                raise ValueError("IDs de cuenta de depósito inválidos.") from e
        return out

    @field_validator("currency", mode="before")
    @classmethod
    def _norm_currency(cls, v: object) -> str:
        if v is None or v == "":
            return normalize_currency_code("USD", "USD")
        return normalize_currency_code(v, "USD")


class GenerateRechargeLinkResponse(BaseModel):
    request_id: int
    client_payment_token: str = Field(description="UUID del portal permanente del cliente (`/portal/{token}`).")
    portal_path: str
    link_hash: Optional[str] = Field(
        default=None,
        description="Solo enlaces legados por hash; las solicitudes nuevas usan portal permanente.",
    )
    amount_requested: float
    allowed_payment_methods: list[int]
    currency: str = "USD"
    exchange_rate: float = 1.0


class WalletBridgeSyncResponse(BaseModel):
    """Resultado de traer comprobantes desde el portal Flask externo (catálogo VIP)."""

    updated_ids: list[int] = Field(default_factory=list, description="IDs de solicitudes actualizadas a in_review.")
    skipped_ids: list[int] = Field(default_factory=list, description="IDs omitidos (estado incompatible o sin URL).")
    not_found_ids: list[int] = Field(default_factory=list, description="IDs que no existen en la base local.")
    errors: list[str] = Field(default_factory=list, description="Mensajes de filas inválidas o fallos por ítem.")

class WalletRechargePublicAccount(BaseModel):
    id: int
    label: str
    currency: str


class WalletRechargePublicMethodGroup(BaseModel):
    payment_method_id: int
    payment_method_name: str
    accounts: list[WalletRechargePublicAccount]


class WalletRechargePublicDetail(BaseModel):
    amount_requested: float
    balance_pending: float = 0.0
    amount_paid: float = 0.0
    recharge_currency: str = "USD"
    recharge_exchange_rate: float = 1.0
    admin_precheck_receipt_url: Optional[str] = None
    status: str
    distributor_display_name: str
    can_submit_receipt: bool
    status_message: str
    method_groups: list[WalletRechargePublicMethodGroup]
