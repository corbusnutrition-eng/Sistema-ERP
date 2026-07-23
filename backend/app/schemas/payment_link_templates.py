from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.hotmart_links import HotmartLinkItem, normalize_hotmart_links_list

ModuleTypeLiteral = Literal["VENTAS", "BAAS"]


class PaymentLinkTemplateBase(BaseModel):
    payment_method_id: int = Field(..., ge=1)
    module_type: ModuleTypeLiteral
    product_id: Optional[int] = Field(default=None, ge=1)
    links: list[HotmartLinkItem] = Field(default_factory=list)

    @field_validator("module_type", mode="before")
    @classmethod
    def _norm_module(cls, v: object) -> str:
        s = str(v or "").strip().upper()
        if s in ("VENTAS", "SALES", "VENTA"):
            return "VENTAS"
        if s in ("BAAS", "BILLETERAS", "BILLETERAS BAAS", "RECARGA", "RECARGAS"):
            return "BAAS"
        raise ValueError("module_type debe ser VENTAS o BAAS.")

    @model_validator(mode="after")
    def _module_product_rules(self) -> "PaymentLinkTemplateBase":
        if self.module_type == "VENTAS" and self.product_id is None:
            raise ValueError("product_id es obligatorio cuando module_type es VENTAS.")
        if self.module_type == "BAAS" and self.product_id is not None:
            raise ValueError("product_id debe ser nulo cuando module_type es BAAS.")
        return self


class PaymentLinkTemplateCreate(PaymentLinkTemplateBase):
    pass


class PaymentLinkTemplateUpdate(BaseModel):
    payment_method_id: Optional[int] = Field(default=None, ge=1)
    module_type: Optional[ModuleTypeLiteral] = None
    product_id: Optional[int] = Field(default=None, ge=1)
    links: Optional[list[HotmartLinkItem]] = None

    @field_validator("module_type", mode="before")
    @classmethod
    def _norm_module_patch(cls, v: object) -> object:
        if v is None:
            return None
        s = str(v).strip().upper()
        if s in ("VENTAS", "SALES", "VENTA"):
            return "VENTAS"
        if s in ("BAAS", "BILLETERAS", "BILLETERAS BAAS", "RECARGA", "RECARGAS"):
            return "BAAS"
        raise ValueError("module_type debe ser VENTAS o BAAS.")


class PaymentLinkTemplateRead(BaseModel):
    id: int
    payment_method_id: int
    payment_method_name: Optional[str] = None
    module_type: str
    product_id: Optional[int] = None
    product_name: Optional[str] = None
    links: list[HotmartLinkItem] = Field(default_factory=list)

    model_config = {"from_attributes": True}


def links_storage_from_payload(raw: list[HotmartLinkItem] | None) -> list | None:
    return normalize_hotmart_links_list(raw)
