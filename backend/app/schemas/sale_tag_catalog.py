from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field, field_validator


class SaleTagCatalogResponse(BaseModel):
    id: int
    name: str
    group_id: int

    model_config = {"from_attributes": True}


class TagGroupResponse(BaseModel):
    id: int
    name: str
    color: str
    tags: list[SaleTagCatalogResponse]

    model_config = {"from_attributes": True}


class TagGroupCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    color: str = Field(default="#2563EB", max_length=32)
    tag_names: list[str] = Field(
        default_factory=list,
        description="Opcional: crear etiquetas iniciales dentro del grupo.",
    )

    model_config = {"str_strip_whitespace": True}

    @field_validator("tag_names", mode="before")
    @classmethod
    def _strip_tag_names(cls, v: object) -> object:
        if not isinstance(v, list):
            return v
        out: list[str] = []
        for item in v:
            if item is None:
                continue
            s = str(item).strip()
            if s:
                out.append(s[:120])
        return out


class TagGroupUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    color: Optional[str] = Field(default=None, max_length=32)

    model_config = {"str_strip_whitespace": True}


class SaleTagCatalogCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    group_id: int = Field(..., ge=1)

    model_config = {"str_strip_whitespace": True}


class SaleTagCatalogUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    group_id: Optional[int] = Field(default=None, ge=1)

    model_config = {"str_strip_whitespace": True}
