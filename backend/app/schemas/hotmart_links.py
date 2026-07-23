"""Enlaces y bloques de cobro adjuntos a ventas, recargas BaaS y plantillas."""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

LinkTypeLiteral = Literal["standard", "custom"]
MediaTypeLiteral = Literal["image", "video", "pdf"]


def _strip_optional_url(v: object) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    if not s.lower().startswith(("http://", "https://")):
        raise ValueError("La URL debe comenzar con http:// o https://.")
    return s


def _coerce_optional_amount(v: object) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        n = round(float(v), 2)
    except (TypeError, ValueError) as exc:
        raise ValueError("Monto de cobro inválido.") from exc
    if n <= 0:
        raise ValueError("El monto debe ser mayor a cero.")
    return n


class HotmartLinkItem(BaseModel):
    type: LinkTypeLiteral = Field(default="standard")
    url: Optional[str] = Field(default=None, max_length=2048)
    amount: Optional[float] = Field(default=None, gt=0)
    text: Optional[str] = Field(default=None, max_length=2000)
    image_url: Optional[str] = Field(default=None, max_length=2048)
    media_type: Optional[MediaTypeLiteral] = Field(
        default=None,
        description="Tipo de archivo en image_url: image, video o pdf (bloques personalizados).",
    )

    @field_validator("type", mode="before")
    @classmethod
    def _norm_type(cls, v: object) -> str:
        if v is None or str(v).strip() == "":
            return "standard"
        s = str(v).strip().lower()
        if s in ("standard", "custom"):
            return s
        return "standard"

    @field_validator("text", mode="before")
    @classmethod
    def _strip_text(cls, v: object) -> Optional[str]:
        if v is None:
            return None
        s = str(v).strip()
        return s or None

    @field_validator("image_url", mode="before")
    @classmethod
    def _strip_image_url(cls, v: object) -> Optional[str]:
        return _strip_optional_url(v)

    @field_validator("media_type", mode="before")
    @classmethod
    def _norm_media_type(cls, v: object) -> Optional[str]:
        if v is None or str(v).strip() == "":
            return None
        s = str(v).strip().lower()
        if s in ("image", "video", "pdf"):
            return s
        return None

    @field_validator("url", mode="before")
    @classmethod
    def _strip_link_url(cls, v: object) -> Optional[str]:
        if v is None or str(v).strip() == "":
            return None
        return _strip_optional_url(v)

    @field_validator("amount", mode="before")
    @classmethod
    def _coerce_amount(cls, v: object) -> Optional[float]:
        return _coerce_optional_amount(v)

    @model_validator(mode="after")
    def _validate_block(self) -> "HotmartLinkItem":
        block_type = self.type or "standard"
        if block_type == "standard":
            if not self.url:
                raise ValueError("Los links estándar requieren una URL de pago.")
            if self.amount is None:
                raise ValueError("Los links estándar requieren un monto mayor a cero.")
            return self

        has_text = bool(self.text)
        has_image = bool(self.image_url)
        has_url = bool(self.url)
        has_amount = self.amount is not None
        if not (has_text or has_image or has_url or has_amount):
            raise ValueError(
                "El bloque personalizado debe incluir al menos texto, imagen, URL o valor.",
            )
        return self


def normalize_hotmart_links_list(raw: Any) -> Optional[list[dict[str, Any]]]:
    """Valida y normaliza lista JSON para persistencia (None si vacía)."""
    if raw is None:
        return None
    if not isinstance(raw, list):
        raise ValueError("hotmart_links debe ser una lista.")
    if not raw:
        return None
    out: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, HotmartLinkItem):
            out.append(item.model_dump(mode="json", exclude_none=False))
        elif isinstance(item, dict):
            out.append(HotmartLinkItem.model_validate(item).model_dump(mode="json", exclude_none=False))
        else:
            raise ValueError("Cada bloque de cobro debe ser un objeto JSON.")
    return out or None


def hotmart_links_from_model(raw: Any) -> list[HotmartLinkItem]:
    if not isinstance(raw, list) or not raw:
        return []
    out: list[HotmartLinkItem] = []
    for item in raw:
        try:
            if isinstance(item, dict):
                out.append(HotmartLinkItem.model_validate(item))
            elif isinstance(item, HotmartLinkItem):
                out.append(item)
        except Exception:
            continue
    return out
