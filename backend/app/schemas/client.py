from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, EmailStr, Field, computed_field, field_validator

ClientStatus = Literal["Activo", "Inactivo"]


class ClientCreate(BaseModel):
    username: str = Field(..., min_length=1, max_length=120, description="Usuario IPTV (obligatorio)")
    name: Optional[str] = Field(default=None, max_length=150, description="Nombre completo (opcional)")
    email: EmailStr
    phone: Optional[str] = Field(default=None, max_length=30)
    country: Optional[str] = Field(default=None, max_length=100, description="País del cliente")
    lead_source: Optional[str] = Field(default=None, max_length=120, description="Origen web del lead")
    status: ClientStatus = Field(default="Activo")
    total_credits: float = Field(default=0.0, ge=0)
    last_recharge: Optional[datetime] = None
    parent_id: Optional[int] = Field(
        default=None,
        description="Distribuidor padre (sub-cliente). Hereda moneda base del padre.",
    )
    custom_fields: Dict[str, Any] = Field(default_factory=dict)
    note: Optional[str] = Field(default=None, description="Nota interna de seguimiento")
    tags: Optional[List[str]] = Field(default=None, description="Etiquetas del cliente")

    @field_validator("name", mode="before")
    @classmethod
    def empty_name_to_none(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v

    @field_validator("username")
    @classmethod
    def strip_username(cls, v: str) -> str:
        s = (v or "").strip()
        if not s:
            raise ValueError("Usuario IPTV obligatorio.")
        return s


class ClientUpdate(BaseModel):
    username: Optional[str] = Field(default=None, min_length=1, max_length=120)
    name: Optional[str] = Field(default=None, max_length=150)
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(default=None, max_length=30)
    country: Optional[str] = Field(default=None, max_length=100)
    lead_source: Optional[str] = Field(default=None, max_length=120)
    status: Optional[ClientStatus] = None
    total_credits: Optional[float] = Field(default=None, ge=0)
    last_recharge: Optional[datetime] = None
    custom_fields: Optional[Dict[str, Any]] = None
    note: Optional[str] = None
    tags: Optional[List[str]] = None
    last_iptv_username: Optional[str] = Field(
        default=None,
        max_length=120,
        description="Usuario del panel IPTV activo (crédito normal).",
    )
    last_iptv_password: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Contraseña del panel IPTV activo (crédito normal).",
    )

    @field_validator("name", mode="before")
    @classmethod
    def empty_name_patch(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v

    @field_validator("username")
    @classmethod
    def username_patch_strip(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        s = v.strip()
        if not s:
            raise ValueError("Usuario IPTV no puede estar vacío.")
        return s


class ClientSubClientBrief(BaseModel):
    id: int
    name: Optional[str]
    username: str
    email: EmailStr
    wallet_balance: float = Field(default=0.0, ge=0)
    portal_token: uuid.UUID
    status: str

    model_config = {"from_attributes": True}


class ClientResponse(BaseModel):
    id: int
    parent_id: Optional[int] = Field(default=None, description="ID del distribuidor padre (reseller).")
    parent_username: Optional[str] = Field(
        default=None,
        description="Usuario IPTV del distribuidor padre (si es sub-cliente).",
    )
    parent_name: Optional[str] = Field(
        default=None,
        description="Nombre del distribuidor padre (si es sub-cliente).",
    )
    name: Optional[str]
    email: EmailStr
    phone: Optional[str]
    username: str
    country: Optional[str]
    lead_source: Optional[str]
    status: str
    total_credits: float
    #: Pagos aplicados sin facturas que los absorban (CxC): se cruza contra la siguiente compra.
    credit_balance: float = Field(default=0.0, ge=0)
    wallet_balance: float = Field(default=0.0, ge=0, description="Saldo virtual BaaS (recargas con comprobante).")
    currency: str = Field(default="USD", max_length=10, description="Moneda base BaaS del distribuidor.")
    last_recharge: Optional[datetime]
    payment_token: uuid.UUID
    custom_fields: Dict[str, Any]
    note: Optional[str]
    tags: Optional[List[str]]
    last_iptv_username: Optional[str] = Field(default=None, max_length=120)
    last_iptv_password: Optional[str] = Field(default=None, max_length=255)
    last_normal_credit_username: Optional[str] = Field(
        default=None,
        max_length=120,
        description="Último usuario IPTV registrado desde ventas de «crédito normal».",
    )
    last_normal_credit_password: Optional[str] = Field(
        default=None,
        max_length=255,
        description="Última contraseña IPTV registrada desde ventas de «crédito normal».",
    )
    total_pending_balance: float = Field(
        default=0.0,
        ge=0,
        description="Saldo pendiente unificado: facturas (CxC abierto) + recargas BaaS con saldo pendiente.",
    )
    pending_balance_currency: str = Field(
        default="USD",
        max_length=10,
        description="Moneda del total de saldo pendiente mostrado (si hay varias, la de mayor deuda).",
    )
    pending_balances_by_currency: list[dict[str, object]] = Field(
        default_factory=list,
        description="Saldos pendientes agrupados por moneda (facturas CxC + recargas BaaS abiertas).",
    )
    credit_balance_currency: str = Field(
        default="USD",
        max_length=10,
        description="Moneda del saldo a favor principal (mayor crédito disponible).",
    )
    credit_balances_by_currency: list[dict[str, object]] = Field(
        default_factory=list,
        description="Saldos a favor CxC por moneda (anticipos / sobrepagos).",
    )
    available_credit_by_currency: list[dict[str, object]] = Field(
        default_factory=list,
        description="Crédito utilizable por moneda (igual que credit_balances_by_currency).",
    )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def portal_token(self) -> uuid.UUID:
        """Mismo UUID permanente que ``payment_token`` (enlace SPA ``/portal/{token}``)."""
        return self.payment_token

    model_config = {"from_attributes": True}


class ClientPublicResponse(BaseModel):
    """Datos seguros que se exponen en el portal público de pago (sin datos sensibles)."""

    name: str
    email: str
    active_screens: int
    providers: list[str]
    payment_token: uuid.UUID

    model_config = {"from_attributes": True}
