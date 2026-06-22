"""CRUD de etiquetas de venta (tabla ``sale_tags``). Agrupadas vía ``group_id`` → ``tag_groups``."""

from __future__ import annotations

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.sale_transaction_tag import SaleTransactionTag, TagGroup
from app.schemas.sale_tag_catalog import SaleTagCatalogCreate, SaleTagCatalogResponse, SaleTagCatalogUpdate

router = APIRouter(prefix="/sale-tags", tags=["sale-tags"])

DbDep = Annotated[Session, Depends(get_db)]


@router.get("", response_model=list[SaleTagCatalogResponse])
def list_sale_tags(db: DbDep, group_id: Optional[int] = Query(default=None, ge=1)) -> list[SaleTagCatalogResponse]:
    q = db.query(SaleTransactionTag).order_by(SaleTransactionTag.name)
    if group_id is not None:
        q = q.filter(SaleTransactionTag.group_id == group_id)
    rows = q.all()
    return [SaleTagCatalogResponse.model_validate(r) for r in rows]


@router.post("", response_model=SaleTagCatalogResponse, status_code=status.HTTP_201_CREATED)
def create_sale_tag(payload: SaleTagCatalogCreate, db: DbDep) -> SaleTransactionTag:
    grp = db.get(TagGroup, payload.group_id)
    if not grp:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Grupo de etiquetas no válido.")
    name = payload.name.strip()
    row = SaleTransactionTag(name=name, group_id=payload.group_id)
    db.add(row)
    db.commit()
    db.refresh(row)
    return SaleTagCatalogResponse.model_validate(row)


@router.patch("/{tag_id}", response_model=SaleTagCatalogResponse)
def update_sale_tag(tag_id: int, payload: SaleTagCatalogUpdate, db: DbDep) -> SaleTransactionTag:
    row = db.get(SaleTransactionTag, tag_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Etiqueta no encontrada.")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        row.name = data["name"].strip()
    if "group_id" in data and data["group_id"] is not None:
        gid = data["group_id"]
        if not db.get(TagGroup, gid):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Grupo no válido.")
        row.group_id = gid
    db.commit()
    db.refresh(row)
    return SaleTagCatalogResponse.model_validate(row)


@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sale_tag(tag_id: int, db: DbDep) -> None:
    row = db.get(SaleTransactionTag, tag_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Etiqueta no encontrada.")
    db.delete(row)
    db.commit()
