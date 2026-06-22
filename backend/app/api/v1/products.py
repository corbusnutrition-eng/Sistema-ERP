from __future__ import annotations

import re
import uuid
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Annotated, Any, Literal, Optional

import logging

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import JSONResponse
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, selectinload

from app.api.v1.dependencies import AdminDep
from app.currency_utils import MAX_CURRENCY_CODE_LEN, normalize_currency_code
from app.database import get_db
from app.models.iptv_account import IPTVAccount
from app.models.product import CatalogPackageType, Product, ProductPackageCatalog, TargetAudience
from app.models.sale import Sale, SaleStatus
from app.models.screen_stock import ScreenStock

DbDep = Annotated[Session, Depends(get_db)]

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/products", tags=["products"])

_LOGO_UPLOAD_ROOT = Path("uploads") / "logos"
_LOGO_ALLOWED_TYPES = frozenset({"image/jpeg", "image/png", "image/gif", "image/webp"})
_MAX_LOGO_BYTES = 10 * 1024 * 1024

_CURRENCY_RE = re.compile(rf"^[A-Z]{{3,{MAX_CURRENCY_CODE_LEN}}}$")

_MAX_BULK_ITEMS = 50

BUILTIN_PACKAGE_TYPE_LABELS: tuple[str, ...] = (
    "Paquete público",
    "Paquete mayorista",
    "Paquete saldo",
    "Paquete pantalla",
)

ProductTypeLiteral = Literal["credito_normal", "credito_pantalla"]


def _norm_type(s: str) -> str:
    return " ".join(s.strip().split())


# ── Schemas ───────────────────────────────────────────────────────────────────


class ProductWriteBase(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    name: str = Field(..., min_length=1, max_length=200)
    product_type: Optional[ProductTypeLiteral] = Field(
        default=None,
        description="Crédito normal (pool servicio completo) vs crédito por pantalla (bodega). Si se omite, usar service_type legado.",
    )
    service_type: Optional[str] = Field(
        default=None,
        min_length=1,
        max_length=120,
        description='Se deriva de product_type («Paquete saldo» / «Paquete pantalla») o se envía en APIs legadas.',
    )
    iptv_provider: str = Field(default="General", min_length=1, max_length=64)
    target_audience: TargetAudience
    currency: str = Field(
        ...,
        min_length=3,
        max_length=MAX_CURRENCY_CODE_LEN,
        description="Código de moneda ISO 4217 o extendido (ej. USD, PEN, USDT).",
    )
    price: float = Field(..., gt=0)
    description: Optional[str] = Field(default=None, max_length=5000)
    is_active: bool = True
    screens_count: Optional[int] = Field(default=None)

    sku: Optional[str] = Field(default=None, max_length=80)
    transaction_class_id: Optional[int] = Field(default=None, ge=1)
    inventory_opening_qty: Optional[Decimal] = Field(
        default=None,
        ge=0,
        validation_alias=AliasChoices("inventory_opening_qty", "cantidad_inicial"),
    )
    inventory_as_of_date: Optional[date] = None
    reorder_point: Optional[Decimal] = Field(default=None, ge=0)
    inventory_asset_account_id: Optional[int] = Field(default=None, ge=1)
    income_account_id: Optional[int] = Field(default=None, ge=1)
    purchase_description: Optional[str] = Field(default=None, max_length=5000)
    purchase_cost_usd: Optional[float] = Field(default=None, ge=0)
    purchase_expense_account_id: Optional[int] = Field(default=None, ge=1)
    preferred_vendor_id: Optional[int] = Field(default=None, ge=1)
    color: str = Field(default="#6366f1", max_length=16)
    logo_url: Optional[str] = Field(default=None, max_length=512)

    @field_validator("logo_url", mode="before")
    @classmethod
    def _logo_url_strip(cls, v: object) -> Optional[str]:
        if v is None or (isinstance(v, str) and not str(v).strip()):
            return None
        return str(v).strip()

    @field_validator("color", mode="before")
    @classmethod
    def _color_strip_default(cls, v: object) -> str:
        if v is None or (isinstance(v, str) and not str(v).strip()):
            return "#6366f1"
        return str(v).strip()

    @field_validator("sku", mode="before")
    @classmethod
    def _sku_strip(cls, v: object) -> object:
        if v is None or v == "":
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v

    @field_validator("screens_count")
    @classmethod
    def _screens_ge_create(cls, v: Optional[int]) -> Optional[int]:
        if v is None:
            return None
        if v < 1:
            raise ValueError("screens_count debe ser ≥ 1.")
        return v

    @field_validator("service_type", mode="before")
    @classmethod
    def _strip_service_opt(cls, v: object) -> object:
        if v is None or v == "":
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v

    @field_validator("iptv_provider", mode="before")
    @classmethod
    def _iptv_normalize(cls, v: object) -> str:
        if v is None or (isinstance(v, str) and not str(v).strip()):
            return "General"
        return str(v).strip()

    @field_validator("currency")
    @classmethod
    def _upper_currency(cls, v: str) -> str:
        c = normalize_currency_code(v)
        if not _CURRENCY_RE.match(c):
            raise ValueError(
                "Moneda debe ser 3–10 letras mayúsculas (ej. USD, PEN, USDT).",
            )
        return c

    @model_validator(mode="after")
    def _iptv_derive_service_and_screens(self) -> ProductWriteBase:
        pt = self.product_type
        st_in = (self.service_type or "").strip()
        if pt is not None:
            derived = "Paquete pantalla" if pt == "credito_pantalla" else "Paquete saldo"
            if st_in and _norm_type(st_in) != _norm_type(derived):
                raise ValueError("service_type no coincide con product_type.")
            service_type = derived
        else:
            if not st_in:
                raise ValueError("Indica product_type o service_type.")
            service_type = st_in
        label = service_type.strip()
        screens = self.screens_count
        if label == "Paquete pantalla":
            if screens is not None and screens < 1:
                raise ValueError("screens_count debe ser ≥ 1.")
        else:
            screens = None
        return self.model_copy(update={"service_type": service_type, "screens_count": screens})

    @field_validator("inventory_opening_qty", mode="before")
    @classmethod
    def _opening_qty_optional(cls, v: object) -> object:
        if v is None or (isinstance(v, str) and not str(v).strip()):
            return None
        return v


class PackageOpeningCredentialItem(BaseModel):
    """Credenciales IPTV opcionales por cada unidad de stock inicial del paquete (índice alinea con Cant. inicial)."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    username: Optional[str] = Field(
        default=None,
        max_length=120,
        validation_alias=AliasChoices("username", "usuario", "iptv_username"),
    )
    password: Optional[str] = Field(
        default=None,
        max_length=255,
        validation_alias=AliasChoices("password", "contrasena", "iptv_password"),
    )

    @field_validator("username", "password", mode="before")
    @classmethod
    def _strip_cred(cls, v: object) -> object:
        if v is None:
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v


class ProductPackageItemCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    #: Si viene en PUT, actualiza la fila existente de ``product_package_catalog``.
    catalog_line_id: Optional[int] = Field(
        default=None,
        ge=1,
        validation_alias=AliasChoices("catalog_line_id", "id"),
    )
    package_label: str = Field(..., min_length=1, max_length=120)
    cost_usd: Optional[float] = Field(default=None, ge=0, description="Costo referencial en USD.")
    screens_per_package: int = Field(
        ...,
        ge=1,
        le=200,
        description="Pantallas que entrega un paquete (catálogo; sin multiplicar por cant. inicial).",
        validation_alias=AliasChoices("screens_per_package", "pantallas"),
    )
    listing_price_usd: float = Field(..., gt=0, description="Precio de venta por paquete (USD).")
    inventory_initial_qty: Optional[Decimal] = Field(
        default=None,
        ge=0,
        description="Cantidad inicial de paquetes en bodega (enteros).",
        validation_alias=AliasChoices(
            "inventory_initial_qty",
            "cant_inicial",
            "cantidad_inicial_paquetes",
        ),
    )
    initial_credentials: Optional[list[PackageOpeningCredentialItem]] = Field(
        default=None,
        max_length=500,
        description="Opcional: una credencial por cada unidad de cantidad inicial (mismo índice que el lote).",
    )

    @field_validator("screens_per_package", mode="before")
    @classmethod
    def _screens_pkg_literal_int(cls, v: object) -> object:
        """Evita coerciones ambiguas; debe ser el entero enviado por el cliente."""
        if isinstance(v, bool):
            raise ValueError("screens_per_package inválido.")
        if isinstance(v, int):
            return v
        if isinstance(v, float):
            if not float(v).is_integer():
                raise ValueError("screens_per_package debe ser un entero.")
            return int(v)
        if isinstance(v, str):
            s = str(v).strip()
            if not s.isdigit():
                raise ValueError("screens_per_package debe ser un entero positivo.")
            return int(s)
        raise ValueError("screens_per_package inválido.")

    @field_validator("package_label")
    @classmethod
    def _strip_label(cls, v: str) -> str:
        t = " ".join(str(v).strip().split())
        if not t:
            raise ValueError("El nombre del paquete no puede estar vacío.")
        return t

    @field_validator("inventory_initial_qty", mode="before")
    @classmethod
    def _opening_pkg_qty_optional(cls, v: object) -> object:
        if v is None or (isinstance(v, str) and not str(v).strip()):
            return None
        return v

    @field_validator("inventory_initial_qty")
    @classmethod
    def _opening_pkg_whole(cls, v: Optional[Decimal]) -> Optional[Decimal]:
        if v is None:
            return None
        if v <= 0:
            return None
        fv = float(v)
        iv = int(round(fv))
        if iv <= 0:
            return None
        if abs(fv - iv) > 1e-9:
            raise ValueError("Cantidad inicial debe ser un número entero de paquetes.")
        return Decimal(iv)

    @model_validator(mode="after")
    def _initial_credentials_only_with_opening(self) -> "ProductPackageItemCreate":
        creds = self.initial_credentials
        if not creds:
            return self
        n_qty = self.inventory_initial_qty
        if n_qty is None or int(n_qty) <= 0:
            raise ValueError(
                "initial_credentials solo tiene sentido cuando la cantidad inicial de paquetes es mayor que cero.",
            )
        iv = int(n_qty)
        if len(creds) > iv:
            raise ValueError(
                "initial_credentials no puede tener más elementos que la cantidad inicial de paquetes.",
            )
        return self


class ProductCreate(ProductWriteBase):
    packages_inventory_opening_date: Optional[date] = Field(
        default=None,
        validation_alias=AliasChoices(
            "packages_inventory_opening_date",
            "fecha_inventario_inicial_paquetes",
        ),
        description="Fecha aplicada al inventario inicial de pantallas cuando hay cantidad por paquete.",
    )
    packages: Optional[list[ProductPackageItemCreate]] = Field(
        default=None,
        max_length=40,
        description="Solo para product_type credito_pantalla: líneas del catálogo de paquetes.",
    )

    @field_validator("packages_inventory_opening_date", mode="before")
    @classmethod
    def _pkg_opening_date_empty(cls, v: object) -> object:
        if v is None or v == "":
            return None
        return v

    @field_validator("packages", mode="before")
    @classmethod
    def _normalize_packages(cls, v: object) -> object:
        if v is None or v == []:
            return None
        if isinstance(v, list):
            return v
        return None

    @model_validator(mode="after")
    def _packages_pantalla_screens(self) -> ProductCreate:
        pkgs = self.packages or []
        if not pkgs:
            return self
        if self.product_type != "credito_pantalla":
            raise ValueError("packages solo aplica cuando product_type es «credito_pantalla».")
        first_n = pkgs[0].screens_per_package
        return self.model_copy(update={"screens_count": first_n})

    @model_validator(mode="after")
    def _packages_inventory_opening_rules(self) -> ProductCreate:
        if self.product_type != "credito_pantalla":
            return self
        pkgs = self.packages or []
        need_date = any((p.inventory_initial_qty or 0) > 0 for p in pkgs)
        if need_date and self.packages_inventory_opening_date is None:
            raise ValueError(
                "Indica la fecha de inventario inicial cuando algún paquete tiene cantidad inicial mayor que cero.",
            )
        return self

    @model_validator(mode="after")
    def _derive_price_pantalla_from_packages(self) -> ProductCreate:
        if self.product_type != "credito_pantalla":
            return self
        pkgs = self.packages or []
        if not pkgs:
            return self
        lp = pkgs[0].listing_price_usd
        return self.model_copy(update={"price": float(lp)})

    @model_validator(mode="after")
    def _pantalla_screens_resolve(self) -> ProductCreate:
        """Si sigue sin definirse, usar 3 solo como compatibilidad API sin `packages`."""
        if self.product_type != "credito_pantalla":
            return self
        if self.screens_count is not None and self.screens_count >= 1:
            return self
        return self.model_copy(update={"screens_count": 3})


class ProductBulkCreate(BaseModel):
    """Varios ítems en un solo POST."""

    items: list[ProductCreate] = Field(..., min_length=1, max_length=_MAX_BULK_ITEMS)


class ProductUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    product_type: Optional[ProductTypeLiteral] = None
    service_type: Optional[str] = Field(default=None, min_length=1, max_length=120)
    iptv_provider: Optional[str] = Field(default=None, min_length=1, max_length=64)
    target_audience: Optional[TargetAudience] = None
    currency: Optional[str] = Field(default=None, min_length=3, max_length=MAX_CURRENCY_CODE_LEN)
    price: Optional[float] = Field(default=None, gt=0)
    description: Optional[str] = Field(default=None, max_length=5000)
    is_active: Optional[bool] = None
    screens_count: Optional[int] = Field(default=None)
    sku: Optional[str] = Field(default=None, max_length=80)
    transaction_class_id: Optional[int] = Field(default=None, ge=1)
    inventory_opening_qty: Optional[Decimal] = Field(default=None, ge=0)
    inventory_as_of_date: Optional[date] = None
    reorder_point: Optional[Decimal] = Field(default=None, ge=0)
    inventory_asset_account_id: Optional[int] = Field(default=None, ge=1)
    income_account_id: Optional[int] = Field(default=None, ge=1)
    purchase_description: Optional[str] = Field(default=None, max_length=5000)
    purchase_cost_usd: Optional[float] = Field(default=None, ge=0)
    purchase_expense_account_id: Optional[int] = Field(default=None, ge=1)
    preferred_vendor_id: Optional[int] = Field(default=None, ge=1)
    color: Optional[str] = Field(default=None, max_length=16)
    logo_url: Optional[str] = Field(default=None, max_length=512)

    @field_validator("logo_url", mode="before")
    @classmethod
    def _logo_url_strip_upd(cls, v: object) -> Optional[str]:
        if v is None or (isinstance(v, str) and not str(v).strip()):
            return None
        return str(v).strip()

    @field_validator("sku", mode="before")
    @classmethod
    def _sku_strip_update(cls, v: object) -> object:
        if v is None or v == "":
            return None
        if isinstance(v, str):
            s = v.strip()
            return s if s else None
        return v

    @field_validator("color", mode="before")
    @classmethod
    def _color_strip_optional(cls, v: object) -> Optional[str]:
        if v is None or (isinstance(v, str) and not str(v).strip()):
            return None
        return str(v).strip()

    @field_validator("screens_count")
    @classmethod
    def _screens_ge_if_present(cls, v: Optional[int]) -> Optional[int]:
        if v is None:
            return None
        if v < 1:
            raise ValueError("screens_count debe ser ≥ 1.")
        return v

    @field_validator("service_type", "iptv_provider")
    @classmethod
    def _strip_opt(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        return v.strip()

    @field_validator("currency")
    @classmethod
    def _upper_optional_currency(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        raw = str(v).strip()
        if not raw:
            raise ValueError("Moneda no puede estar vacía.")
        c = normalize_currency_code(raw)
        if not _CURRENCY_RE.match(c):
            raise ValueError(
                "Moneda debe ser 3–10 letras mayúsculas (ej. USD, PEN, USDT).",
            )
        return c


class ProductCatalogLinePublic(BaseModel):
    """Línea de catálogo por producto (solo filas con ``product_id`` del padre)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    product_id: int
    package_label: str
    screens_per_package: int
    reference_cost_usd: Optional[float] = None
    listing_price_usd: Optional[float] = None
    opening_inventory_qty: Optional[float] = None
    sort_order: int


def _catalog_lines_public_from_product(data: Product) -> list[ProductCatalogLinePublic]:
    pid = int(data.id)
    raw = getattr(data, "package_catalog_lines", None) or []
    owned = [ln for ln in raw if int(getattr(ln, "product_id", -1)) == pid]
    owned.sort(key=lambda ln: int(ln.sort_order))
    return [
        ProductCatalogLinePublic(
            id=int(ln.id),
            product_id=int(ln.product_id),
            package_label=ln.package_label,
            screens_per_package=int(ln.screens_per_package),
            reference_cost_usd=ln.reference_cost_usd,
            listing_price_usd=ln.listing_price_usd,
            opening_inventory_qty=float(ln.opening_inventory_qty)
            if ln.opening_inventory_qty is not None
            else None,
            sort_order=int(ln.sort_order),
        )
        for ln in owned
    ]


class ProductResponse(BaseModel):
    id: int
    name: str
    product_type: Optional[str] = None
    service_type: str
    iptv_provider: str
    target_audience: TargetAudience
    currency: str
    price: float
    screens_count: Optional[int] = None
    description: Optional[str] = None
    is_active: bool
    sku: Optional[str] = None
    transaction_class_id: Optional[int] = None
    inventory_opening_qty: Optional[float] = None
    inventory_as_of_date: Optional[date] = None
    inventory_physical_total: Optional[float] = Field(
        default=None,
        description="Créditos cargados (suma recargas IPTV). Referencia admin; no es stock vendible.",
    )
    available_credits: Optional[float] = Field(
        default=None,
        description="Stock real disponible: físico − vendido − reservado (preventas).",
    )
    inventory_reserved_qty: Optional[float] = Field(
        default=None,
        description="Créditos reservados en preventas pendientes.",
    )
    inventory_consumed_qty: Optional[float] = Field(
        default=None,
        description="Créditos ya vendidos/asignados (ventas aprobadas/parciales).",
    )
    reorder_point: Optional[float] = None
    inventory_asset_account_id: Optional[int] = None
    income_account_id: Optional[int] = None
    purchase_description: Optional[str] = None
    purchase_cost_usd: Optional[float] = None
    purchase_expense_account_id: Optional[int] = None
    preferred_vendor_id: Optional[int] = None
    color: str = "#6366f1"
    logo_url: Optional[str] = None
    catalog_packages: list[ProductCatalogLinePublic] = Field(
        default_factory=list,
        description="Catálogo de paquetes (crédito por pantalla); vacío si no hay líneas cargadas.",
    )

    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode="before")
    @classmethod
    def _map_orm(cls, data: Any) -> Any:
        if isinstance(data, Product):
            pt = getattr(data, "product_type", None)
            if not pt:
                pt = (
                    "credito_pantalla"
                    if _norm_type(data.service_type).lower() == "paquete pantalla"
                    else "credito_normal"
                )
            return {
                "id": data.id,
                "name": data.name,
                "product_type": pt,
                "service_type": data.service_type,
                "iptv_provider": data.iptv_provider,
                "target_audience": data.target_audience,
                "currency": (data.listing_currency or "USD").upper(),
                "price": float(data.listing_price),
                "screens_count": data.screens_count,
                "description": data.description,
                "is_active": data.is_active,
                "sku": data.sku,
                "transaction_class_id": data.transaction_class_id,
                "inventory_opening_qty": float(data.inventory_opening_qty)
                if data.inventory_opening_qty is not None
                else None,
                "inventory_as_of_date": data.inventory_as_of_date,
                "reorder_point": float(data.reorder_point) if data.reorder_point is not None else None,
                "inventory_asset_account_id": data.inventory_asset_account_id,
                "income_account_id": data.income_account_id,
                "purchase_description": data.purchase_description,
                "purchase_cost_usd": data.purchase_cost_usd,
                "purchase_expense_account_id": data.purchase_expense_account_id,
                "preferred_vendor_id": data.preferred_vendor_id,
                "color": getattr(data, "color", None) or "#6366f1",
                "logo_url": getattr(data, "logo_url", None),
                "catalog_packages": _catalog_lines_public_from_product(data),
            }
        return data


def _product_response_from_orm(db: Session, product: Product) -> ProductResponse:
    """Serializa producto con stock IPTV real disponible (misma regla que activación de ventas)."""
    row = ProductResponse.model_validate(product)
    if not _is_credito_normal_product(product):
        return row
    from app.services.catalog_inventory import (
        catalog_consumed_credits,
        catalog_credits_available,
        catalog_physical_credits_total,
    )

    payload = row.model_dump()
    payload["inventory_physical_total"] = round(catalog_physical_credits_total(db, product), 4)
    payload["available_credits"] = catalog_credits_available(db, product)
    payload["inventory_reserved_qty"] = round(float(product.inventory_credit_reserved_qty or 0), 4)
    payload["inventory_consumed_qty"] = round(catalog_consumed_credits(db, product), 4)
    return ProductResponse(**payload)


class PackageTypeCreate(BaseModel):
    label: str = Field(..., min_length=1, max_length=120)

    @field_validator("label")
    @classmethod
    def _norm(cls, v: str) -> str:
        t = " ".join(v.strip().split())
        if not t:
            raise ValueError("El nombre del tipo no puede estar vacío.")
        return t


class PackageTypeResponse(BaseModel):
    id: int
    label: str

    model_config = ConfigDict(from_attributes=True)


def _effective_product_create(payload: ProductCreate) -> ProductCreate:
    """Evita persistir inventario/costo «global» cuando el catálogo es por pantalla."""
    if payload.product_type != "credito_pantalla":
        return payload
    return payload.model_copy(
        update={
            "inventory_opening_qty": None,
            "inventory_as_of_date": None,
            "purchase_cost_usd": None,
        }
    )


def _new_product(payload: ProductCreate) -> Product:
    return Product(
        name=payload.name,
        product_type=payload.product_type,
        service_type=payload.service_type,
        iptv_provider=payload.iptv_provider,
        target_audience=payload.target_audience,
        listing_currency=payload.currency,
        listing_price=payload.price,
        screens_count=payload.screens_count,
        description=payload.description,
        is_active=payload.is_active,
        sku=payload.sku,
        transaction_class_id=payload.transaction_class_id,
        inventory_opening_qty=payload.inventory_opening_qty,
        inventory_as_of_date=payload.inventory_as_of_date,
        reorder_point=payload.reorder_point,
        inventory_asset_account_id=payload.inventory_asset_account_id,
        income_account_id=payload.income_account_id,
        purchase_description=payload.purchase_description,
        purchase_cost_usd=payload.purchase_cost_usd,
        purchase_expense_account_id=payload.purchase_expense_account_id,
        preferred_vendor_id=payload.preferred_vendor_id,
        color=payload.color,
        logo_url=payload.logo_url,
    )


def _persist_product_catalog_packages(
    db: Session,
    product_id: int,
    packages: Optional[list[ProductPackageItemCreate]],
) -> None:
    """Persiste líneas de catálogo: ``screens_per_package`` copia literal del payload (nunca pantallas*cant inicial)."""
    if not packages:
        return
    pid = int(product_id)
    for i, row in enumerate(packages):
        d = row.model_dump(mode="python")
        d.pop("catalog_line_id", None)
        structural_screens = int(d["screens_per_package"])
        if structural_screens < 1 or structural_screens > 200:
            raise ValueError("screens_per_package fuera del rango permitido (catálogo).")
        open_q = d.get("inventory_initial_qty")
        db.add(
            ProductPackageCatalog(
                product_id=pid,
                package_label=d["package_label"],
                reference_cost_usd=d.get("cost_usd"),
                listing_price_usd=d["listing_price_usd"],
                screens_per_package=structural_screens,
                opening_inventory_qty=open_q,
                sort_order=i,
            )
        )


def _sync_screen_stock_package_rename(
    db: Session,
    *,
    product_id: int,
    old_label: str,
    new_label: str,
) -> None:
    """Mantiene coherente el texto de paquete en bodega al renombrar una línea de catálogo."""
    o = (old_label or "").strip()
    n = (new_label or "").strip()
    if not o or not n or o == n:
        return
    db.query(ScreenStock).filter(
        ScreenStock.product_id == int(product_id),
        ScreenStock.package == o,
    ).update({ScreenStock.package: n}, synchronize_session=False)


def _upsert_product_catalog_packages(
    db: Session,
    product_id: int,
    packages: Optional[list[ProductPackageItemCreate]],
) -> None:
    """
    Sustituye la estrategia «borrar todo e insertar»: actualiza filas por ``catalog_line_id``,
    inserta líneas nuevas sin id y elimina catálogo que ya no viene en el payload.
    """
    pid = int(product_id)
    if not packages:
        db.query(ProductPackageCatalog).filter(ProductPackageCatalog.product_id == pid).delete(
            synchronize_session=False,
        )
        return

    existing_rows = db.query(ProductPackageCatalog).filter(ProductPackageCatalog.product_id == pid).all()
    existing_by_id = {int(r.id): r for r in existing_rows}

    kept_ids: set[int] = set()

    for i, row in enumerate(packages):
        d = row.model_dump(mode="python")
        structural_screens = int(d["screens_per_package"])
        if structural_screens < 1 or structural_screens > 200:
            raise ValueError("screens_per_package fuera del rango permitido (catálogo).")
        open_q = d.get("inventory_initial_qty")
        label = str(d["package_label"]).strip()
        cid = d.get("catalog_line_id")

        if cid is not None and int(cid) in existing_by_id:
            ent = existing_by_id[int(cid)]
            old_lbl = str(ent.package_label or "").strip()
            if old_lbl != label:
                _sync_screen_stock_package_rename(db, product_id=pid, old_label=old_lbl, new_label=label)
            ent.package_label = label
            ent.reference_cost_usd = d.get("cost_usd")
            ent.listing_price_usd = d["listing_price_usd"]
            ent.screens_per_package = structural_screens
            ent.opening_inventory_qty = open_q
            ent.sort_order = i
            kept_ids.add(int(cid))
        else:
            ent = ProductPackageCatalog(
                product_id=pid,
                package_label=label,
                reference_cost_usd=d.get("cost_usd"),
                listing_price_usd=d["listing_price_usd"],
                screens_per_package=structural_screens,
                opening_inventory_qty=open_q,
                sort_order=i,
            )
            db.add(ent)
            db.flush()
            kept_ids.add(int(ent.id))

    for eid, ent in list(existing_by_id.items()):
        if eid not in kept_ids:
            db.delete(ent)


def _is_credito_pantalla_product(p: Product) -> bool:
    if getattr(p, "product_type", None):
        return p.product_type == "credito_pantalla"
    return (p.service_type or "").strip().lower() == "paquete pantalla"


def _bootstrap_screen_stock_opening_from_packages(
    db: Session,
    product: Product,
    packages: Optional[list[ProductPackageItemCreate]],
    *,
    opening_date: Optional[date],
) -> None:
    """Crea filas ScreenStock por cada paquete con cantidad inicial > 0."""
    if not _is_credito_pantalla_product(product):
        return
    prov = (product.iptv_provider or "").strip()
    if not prov:
        return
    for pkg in packages or []:
        d = pkg.model_dump(mode="python")
        qty = d.get("inventory_initial_qty")
        if qty is None or qty <= 0:
            continue
        n_pkg = int(qty)
        screens_per = int(d["screens_per_package"])
        label = str(d["package_label"]).strip()
        cost = d.get("cost_usd")
        creds_objs: list[Any] = list(pkg.initial_credentials or [])
        # Un lote por cada unidad de cantidad inicial (paquetes físicos), no un solo batch con n×pantallas.
        for pkg_unit_idx in range(n_pkg):
            batch = str(uuid.uuid4())
            u: Optional[str] = None
            p: Optional[str] = None
            if pkg_unit_idx < len(creds_objs):
                citem = creds_objs[pkg_unit_idx]
                u = getattr(citem, "username", None)
                p = getattr(citem, "password", None)
            for _ in range(screens_per):
                db.add(
                    ScreenStock(
                        provider=prov,
                        package=label,
                        expiration_date=opening_date,
                        iptv_username=u,
                        iptv_password=p,
                        status="free",
                        cost_per_package=cost,
                        batch_id=batch,
                        batch_size=screens_per,
                        sale_id=None,
                        product_id=int(product.id),
                    )
                )


def _is_credito_normal_product(p: Product) -> bool:
    if getattr(p, "product_type", None):
        return p.product_type == "credito_normal"
    return (p.service_type or "").strip().lower() != "paquete pantalla"


def _load_product_with_catalog(db: Session, product_id: int) -> Optional[Product]:
    return (
        db.query(Product)
        .options(selectinload(Product.package_catalog_lines))
        .filter(Product.id == int(product_id))
        .one_or_none()
    )


def _bootstrap_inventory_opening_full_credits(db: Session, product: Product) -> None:
    """
    Carga inicial de créditos «Recarga total»: fila iptv_accounts con ``product_id`` explícito.
    """
    qty = product.inventory_opening_qty
    if qty is None or qty <= 0:
        return
    if not _is_credito_normal_product(product):
        return
    prov = (product.iptv_provider or "").strip()
    if not prov:
        return
    amt = float(qty)
    code = f"{prov}:full:product-{product.id}:opening-{uuid.uuid4().hex[:12]}"
    db.add(
        IPTVAccount(
            provider_name=prov,
            panel_account_code=code,
            username=None,
            password=None,
            expiration_date=None,
            service_type="full",
            credits_spent=amt,
            cost_per_credit=None,
            total_cost=None,
            recharge_date=product.inventory_as_of_date or date.today(),
            product_id=int(product.id),
        )
    )


def _available_full_credits_for_catalog_product(db: Session, product: Product) -> float:
    """Saldo disponible (alineado con GET /inventory/catalog-full-credits)."""
    from app.services.catalog_inventory import catalog_credits_available

    return catalog_credits_available(db, product)


def _active_screen_stock_count_for_product(db: Session, product_id: int) -> int:
    """Unidades en bodega: disponible, reservada (venta pendiente) o asignada."""
    n = (
        db.query(func.count(ScreenStock.id))
        .filter(
            ScreenStock.product_id == int(product_id),
            ScreenStock.status.in_(["free", "reserved", "held", "assigned"]),
        )
        .scalar()
    )
    return int(n or 0)


def _needs_packages_inventory_opening_date_raw(raw: dict[str, Any]) -> bool:
    if raw.get("product_type") != "credito_pantalla":
        return False
    for p in raw.get("packages") or []:
        if not isinstance(p, dict):
            continue
        qty = p.get("inventory_initial_qty")
        if qty is None:
            qty = p.get("cant_inicial")
        if qty is None:
            qty = p.get("cantidad_inicial_paquetes")
        try:
            if float(qty or 0) > 0:
                return True
        except (TypeError, ValueError):
            continue
    return False


def _apply_product_create_to_orm(product: Product, eff: ProductCreate) -> None:
    product.name = eff.name
    product.product_type = eff.product_type
    product.service_type = eff.service_type
    product.iptv_provider = eff.iptv_provider
    product.target_audience = eff.target_audience
    product.listing_currency = eff.currency
    product.listing_price = eff.price
    product.screens_count = eff.screens_count
    product.description = eff.description
    product.is_active = eff.is_active
    product.sku = eff.sku
    product.transaction_class_id = eff.transaction_class_id
    product.inventory_opening_qty = eff.inventory_opening_qty
    product.inventory_as_of_date = eff.inventory_as_of_date
    product.reorder_point = eff.reorder_point
    product.inventory_asset_account_id = eff.inventory_asset_account_id
    product.income_account_id = eff.income_account_id
    product.purchase_description = eff.purchase_description
    product.purchase_cost_usd = eff.purchase_cost_usd
    product.purchase_expense_account_id = eff.purchase_expense_account_id
    product.preferred_vendor_id = eff.preferred_vendor_id
    product.color = eff.color
    product.logo_url = eff.logo_url


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.get("/package-types/", response_model=list[str])
def list_package_type_labels(db: DbDep) -> list[str]:
    """Incluye tipos estándar + personalizados guardados en base de datos."""
    rows = db.scalars(select(CatalogPackageType.label).order_by(CatalogPackageType.label)).all()
    merged = {*BUILTIN_PACKAGE_TYPE_LABELS, *rows}
    return sorted(merged)


@router.post(
    "/package-types/",
    response_model=PackageTypeResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_package_type_label(payload: PackageTypeCreate, db: DbDep, _: AdminDep) -> CatalogPackageType:
    label = payload.label
    if label in BUILTIN_PACKAGE_TYPE_LABELS:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ese tipo ya existe como estándar del sistema.",
        )
    row = CatalogPackageType(label=label)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ya existe un tipo con ese nombre.",
        ) from None
    db.refresh(row)
    return row


@router.get("/", response_model=list[ProductResponse])
def list_products(db: DbDep, skip: int = 0, limit: int = 100) -> list[ProductResponse]:
    rows = (
        db.query(Product)
        .options(selectinload(Product.package_catalog_lines))
        .offset(skip)
        .limit(limit)
        .all()
    )
    return [_product_response_from_orm(db, p) for p in rows]


@router.post("/upload-logo", summary="Subir logotipo de producto (admin)")
async def upload_product_logo(
    db: DbDep,
    _: AdminDep,
    file: UploadFile = File(...),
    product_id: Annotated[Optional[int], Form()] = None,
) -> JSONResponse:
    """
    Guarda la imagen en ``uploads/logos/`` y devuelve ``logo_url`` relativa (servida en ``/uploads/...``).
    Si se envía ``product_id``, actualiza ese producto con la URL.
    """
    if file.content_type not in _LOGO_ALLOWED_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Solo se aceptan JPEG, PNG, GIF o WEBP.",
        )
    content = await file.read()
    if len(content) > _MAX_LOGO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="El archivo supera el límite de 10 MB.",
        )
    suf = Path(file.filename or "logo").suffix.lower()
    suffix = suf if suf in (".jpg", ".jpeg", ".png", ".gif", ".webp") else (
        ".jpg"
        if file.content_type == "image/jpeg"
        else ".png"
        if file.content_type == "image/png"
        else ".gif"
        if file.content_type == "image/gif"
        else ".webp"
    )
    filename = f"{uuid.uuid4().hex}{suffix}"
    _LOGO_UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    dest = _LOGO_UPLOAD_ROOT / filename
    dest.write_bytes(content)
    logo_url = f"/uploads/logos/{filename}"

    if product_id is not None:
        product = db.get(Product, product_id)
        if product is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Producto no encontrado.")
        product.logo_url = logo_url
        db.commit()

    return JSONResponse({"logo_url": logo_url})


@router.get("/{product_id}", response_model=ProductResponse)
def get_product(product_id: int, db: DbDep) -> ProductResponse:
    row = _load_product_with_catalog(db, product_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Producto no encontrado.")
    return _product_response_from_orm(db, row)


@router.post("/", response_model=ProductResponse, status_code=status.HTTP_201_CREATED)
def create_product(payload: ProductCreate, db: DbDep, _: AdminDep) -> Product:
    saved_id: Optional[int] = None
    try:
        eff = _effective_product_create(payload)
        product = _new_product(eff)
        db.add(product)
        db.flush()
        saved_id = int(product.id)
        _persist_product_catalog_packages(db, saved_id, payload.packages)
        _bootstrap_screen_stock_opening_from_packages(
            db,
            product,
            payload.packages,
            opening_date=payload.packages_inventory_opening_date,
        )
        _bootstrap_inventory_opening_full_credits(db, product)
        db.commit()
    except ValueError as ve:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(ve),
        ) from ve
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as e:
        db.rollback()
        logger.warning("create_product integrity: %s", e)
        orig = getattr(e, "orig", None)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(orig)
            if orig
            else "Conflicto de integridad al guardar el producto (dato duplicado o restricción en BD).",
        ) from e
    except SQLAlchemyError as e:
        db.rollback()
        logger.exception("create_product: error SQLAlchemy")
        orig = getattr(e, "orig", None)
        msg = (
            str(orig)
            if orig is not None
            else "Error interno accediendo a la base de datos. Verifica migraciones Alembic (ej. iptv_accounts.product_id)."
        )
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=msg) from e

    refreshed = _load_product_with_catalog(db, saved_id) if saved_id is not None else None
    if refreshed is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Producto guardado pero no se pudo recargar el catálogo.",
        )
    return refreshed


@router.post("/bulk", response_model=list[ProductResponse], status_code=status.HTTP_201_CREATED)
def bulk_create_products(payload: ProductBulkCreate, db: DbDep, _: AdminDep) -> list[Product]:
    """Carga masiva desde el modal multi-producto (solo admin)."""
    created_ids: list[int] = []
    try:
        for item in payload.items:
            eff = _effective_product_create(item)
            row = _new_product(eff)
            db.add(row)
            db.flush()
            _persist_product_catalog_packages(db, row.id, item.packages)
            _bootstrap_screen_stock_opening_from_packages(
                db,
                row,
                item.packages,
                opening_date=item.packages_inventory_opening_date,
            )
            _bootstrap_inventory_opening_full_credits(db, row)
            created_ids.append(int(row.id))
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as e:
        db.rollback()
        logger.warning("bulk_create_products integrity: %s", e)
        orig = getattr(e, "orig", None)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(orig) if orig else "Conflicto de integridad durante carga masiva.",
        ) from e
    except SQLAlchemyError as e:
        db.rollback()
        logger.exception("bulk_create_products: error SQLAlchemy")
        orig = getattr(e, "orig", None)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(orig) if orig is not None else str(e),
        ) from e
    except ValueError as ve:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(ve),
        ) from ve
    q = db.query(Product).options(selectinload(Product.package_catalog_lines))
    loaded = (
        q.filter(Product.id.in_(created_ids)).order_by(Product.id.asc()).all()
        if created_ids
        else []
    )
    return loaded


@router.patch("/{product_id}", response_model=ProductResponse)
def update_product(product_id: int, payload: ProductUpdate, db: DbDep, _: AdminDep) -> Product:
    product: Optional[Product] = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Producto no encontrado.")

    patch = payload.model_dump(exclude_unset=True)

    pt_patch = patch.pop("product_type", None)
    if pt_patch is not None:
        product.product_type = pt_patch
        patch["service_type"] = "Paquete pantalla" if pt_patch == "credito_pantalla" else "Paquete saldo"

    currency = patch.pop("currency", None)
    price_val = patch.pop("price", None)

    tentative_type_n = _norm_type(
        str(patch.get("service_type", product.service_type))
    )

    if (
        "screens_count" in patch
        and patch["screens_count"] is not None
        and tentative_type_n != "Paquete pantalla"
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="screens_count solo aplica cuando el tipo es «Paquete pantalla».",
        )

    if tentative_type_n != "Paquete pantalla":
        patch["screens_count"] = None
    else:
        if "screens_count" in patch and patch["screens_count"] is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Paquete pantalla requiere screens_count ≥ 1.",
            )
        if "screens_count" not in patch:
            prev_type_n = _norm_type(product.service_type)
            if prev_type_n != "Paquete pantalla":
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail="Al seleccionar «Paquete pantalla» indica la cantidad de pantallas.",
                )

    if currency is not None:
        product.listing_currency = currency
    if price_val is not None:
        product.listing_price = price_val

    for field, value in patch.items():
        setattr(product, field, value)

    final_type = _norm_type(product.service_type)
    if final_type == "Paquete pantalla":
        if product.screens_count is None or product.screens_count < 1:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Paquete pantalla requiere screens_count ≥ 1.",
            )
    elif product.screens_count is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="screens_count solo aplica cuando el tipo es «Paquete pantalla».",
        )

    db.commit()

    refreshed = _load_product_with_catalog(db, product_id)
    if refreshed is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Producto no encontrado tras actualización.",
        )
    return refreshed


@router.put("/{product_id}", response_model=ProductResponse)
async def replace_product(product_id: int, request: Request, db: DbDep, _: AdminDep) -> Product:
    """Reemplazo completo del producto (misma forma que POST /products/), incluye catálogo de paquetes."""
    product: Optional[Product] = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Producto no encontrado.")

    raw_body: Any = await request.json()
    if not isinstance(raw_body, dict):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Se esperaba un objeto JSON.",
        )

    if _needs_packages_inventory_opening_date_raw(raw_body) and not raw_body.get(
        "packages_inventory_opening_date",
    ):
        raw_body["packages_inventory_opening_date"] = date.today().isoformat()

    try:
        payload = ProductCreate.model_validate(raw_body)
    except ValidationError as ve:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=ve.errors()) from ve

    try:
        eff = _effective_product_create(payload)
        _apply_product_create_to_orm(product, eff)

        if eff.product_type == "credito_pantalla":
            _upsert_product_catalog_packages(db, int(product_id), eff.packages)
        else:
            db.query(ProductPackageCatalog).filter(ProductPackageCatalog.product_id == int(product_id)).delete(
                synchronize_session=False,
            )
            product.screens_count = None

        db.commit()
    except ValueError as ve:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(ve)) from ve
    except IntegrityError as e:
        db.rollback()
        logger.warning("replace_product integrity: %s", e)
        orig = getattr(e, "orig", None)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=str(orig) if orig else "Conflicto de integridad al guardar el producto.",
        ) from e
    except SQLAlchemyError as e:
        db.rollback()
        logger.exception("replace_product: error SQLAlchemy")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(getattr(e, "orig", None) or e),
        ) from e

    refreshed = _load_product_with_catalog(db, product_id)
    if refreshed is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Producto no encontrado tras actualización.",
        )
    return refreshed


@router.delete("/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product(product_id: int, db: DbDep, _: AdminDep) -> None:
    product: Optional[Product] = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Producto no encontrado.")

    if _is_credito_normal_product(product):
        if _available_full_credits_for_catalog_product(db, product) > 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No se puede eliminar un producto con inventario activo.",
            )
    elif _is_credito_pantalla_product(product):
        if _active_screen_stock_count_for_product(db, int(product_id)) > 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No se puede eliminar un producto con inventario activo.",
            )

    try:
        db.delete(product)
        db.commit()
    except IntegrityError as e:
        db.rollback()
        logger.warning("delete_product integrity: %s", e)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No se puede eliminar el producto: hay registros enlazados.",
        ) from e
