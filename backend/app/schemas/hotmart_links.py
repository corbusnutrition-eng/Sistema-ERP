"""Enlaces de pago Hotmart adjuntos a ventas y recargas BaaS."""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator


class HotmartLinkItem(BaseModel):
    url: str = Field(..., min_length=8, max_length=2048)
    amount: float = Field(..., gt=0)

    @field_validator("url", mode="before")
    @classmethod
    def _strip_url(cls, v: object) -> str:
        s = str(v or "").strip()
        if not s.lower().startswith(("http://", "https://")):
            raise ValueError("La URL de Hotmart debe comenzar con http:// o https://.")
        return s

    @field_validator("amount", mode="before")
    @classmethod
    def _coerce_amount(cls, v: object) -> float:
        try:
            n = round(float(v), 2)
        except (TypeError, ValueError) as exc:
            raise ValueError("Monto de link Hotmart inválido.") from exc
        if n <= 0:
            raise ValueError("El monto del link Hotmart debe ser mayor a cero.")
        return n


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
            out.append(item.model_dump(mode="json"))
        elif isinstance(item, dict):
            out.append(HotmartLinkItem.model_validate(item).model_dump(mode="json"))
        else:
            raise ValueError("Cada link Hotmart debe ser un objeto con url y amount.")
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
