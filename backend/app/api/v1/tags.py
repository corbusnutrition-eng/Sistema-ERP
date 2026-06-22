from __future__ import annotations

import uuid
from typing import Annotated, List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.tag import MAX_TAGS, Tag
from app.schemas.tag import TagCreate, TagResponse, TagUpdate

router = APIRouter(prefix="/tags", tags=["tags"])

DbDep = Annotated[Session, Depends(get_db)]


@router.get("", response_model=List[TagResponse])
def list_tags(db: DbDep):
    return db.query(Tag).order_by(Tag.created_at).all()


@router.post("", response_model=TagResponse, status_code=status.HTTP_201_CREATED)
def create_tag(payload: TagCreate, db: DbDep):
    count = db.query(Tag).count()
    if count >= MAX_TAGS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Límite máximo de {MAX_TAGS} etiquetas alcanzado. Elimina una antes de crear otra.",
        )
    existing = db.query(Tag).filter(Tag.name == payload.name).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Ya existe una etiqueta con el nombre '{payload.name}'.",
        )
    tag = Tag(**payload.model_dump())
    db.add(tag)
    db.commit()
    db.refresh(tag)
    return tag


@router.patch("/{tag_id}", response_model=TagResponse)
def update_tag(tag_id: uuid.UUID, payload: TagUpdate, db: DbDep):
    tag = db.get(Tag, tag_id)
    if not tag:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Etiqueta no encontrada.")
    update_data = payload.model_dump(exclude_unset=True)
    if "name" in update_data:
        clash = db.query(Tag).filter(Tag.name == update_data["name"], Tag.id != tag_id).first()
        if clash:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Ya existe una etiqueta con el nombre '{update_data['name']}'.",
            )
    for k, v in update_data.items():
        setattr(tag, k, v)
    db.commit()
    db.refresh(tag)
    return tag


@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tag(tag_id: uuid.UUID, db: DbDep):
    tag = db.get(Tag, tag_id)
    if not tag:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Etiqueta no encontrada.")
    db.delete(tag)
    db.commit()
