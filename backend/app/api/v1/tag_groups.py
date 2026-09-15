"""Grupos de etiquetas para ventas (QuickBooks). Las etiquetas hijas viven en ``/sale-tags``."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.v1.dependencies import UserDep
from app.database import get_db
from app.models.sale_transaction_tag import SaleTransactionTag, TagGroup
from app.schemas.sale_tag_catalog import (
    SaleTagCatalogResponse,
    TagGroupCreate,
    TagGroupResponse,
    TagGroupUpdate,
)

router = APIRouter(prefix="/tag-groups", tags=["sale-tag-groups"])

DbDep = Annotated[Session, Depends(get_db)]
# Catálogo compartido: se lee/crea inline durante la creación de una venta
# (NuevaVentaModal → SaleQBTagsCreatable) y desde la pantalla de Listas
# maestras. Igual que `/classes`: cualquier usuario autenticado, sin permiso
# granular propio — antes NO exigía ni siquiera estar logueado.


def _serialize_group(g: TagGroup) -> TagGroupResponse:
    tags_sorted = sorted(g.tags or [], key=lambda t: (t.name or "").lower())
    return TagGroupResponse(
        id=g.id,
        name=g.name,
        color=g.color,
        tags=[SaleTagCatalogResponse.model_validate(t) for t in tags_sorted],
    )


@router.get("", response_model=list[TagGroupResponse])
@router.get("/", response_model=list[TagGroupResponse])
def list_tag_groups(db: DbDep, _: UserDep) -> list[TagGroupResponse]:
    rows = db.query(TagGroup).order_by(TagGroup.name).all()
    return [_serialize_group(g) for g in rows]


@router.post("", response_model=TagGroupResponse, status_code=status.HTTP_201_CREATED)
@router.post("/", response_model=TagGroupResponse, status_code=status.HTTP_201_CREATED)
def create_tag_group(payload: TagGroupCreate, db: DbDep, _: UserDep) -> TagGroupResponse:
    name = payload.name.strip()
    color = (payload.color or "#2563EB").strip() or "#2563EB"
    g = TagGroup(name=name, color=color[:32])
    db.add(g)
    db.flush()
    for tn in payload.tag_names:
        db.add(SaleTransactionTag(name=tn, group_id=g.id))
    db.commit()
    db.refresh(g)
    return _serialize_group(g)


@router.patch("/{group_id}", response_model=TagGroupResponse)
def update_tag_group(group_id: int, payload: TagGroupUpdate, db: DbDep, _: UserDep) -> TagGroupResponse:
    g = db.get(TagGroup, group_id)
    if not g:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Grupo no encontrado.")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        g.name = data["name"].strip()
    if "color" in data and data["color"] is not None:
        g.color = str(data["color"]).strip()[:32]
    db.commit()
    db.refresh(g)
    return _serialize_group(g)


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tag_group(group_id: int, db: DbDep, _: UserDep) -> None:
    g = db.get(TagGroup, group_id)
    if not g:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Grupo no encontrado.")
    db.delete(g)
    db.commit()
