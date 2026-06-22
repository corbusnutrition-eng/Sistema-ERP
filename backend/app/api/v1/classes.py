from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.v1.dependencies import UserDep
from app.database import get_db
from app.models.transaction_class import TransactionClass
from app.schemas.transaction_classes import (
    TransactionClassCreate,
    TransactionClassResponse,
    TransactionClassUpdate,
)

router = APIRouter(prefix="/classes", tags=["transaction-classes"])

DbDep = Annotated[Session, Depends(get_db)]


@router.get("/", response_model=list[TransactionClassResponse])
def list_transaction_classes(
    db: DbDep,
    _: UserDep,
    include_inactive: bool = False,
) -> list[TransactionClass]:
    q = db.query(TransactionClass).order_by(TransactionClass.name)
    if not include_inactive:
        q = q.filter(TransactionClass.is_active.is_(True))
    return q.all()


@router.get("/{class_id}", response_model=TransactionClassResponse)
def get_transaction_class(class_id: int, db: DbDep, _: UserDep) -> TransactionClass:
    row = db.get(TransactionClass, class_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Clase no encontrada.")
    return row


@router.post("/", response_model=TransactionClassResponse, status_code=status.HTTP_201_CREATED)
def create_transaction_class(payload: TransactionClassCreate, db: DbDep, _: UserDep) -> TransactionClass:
    row = TransactionClass(name=payload.name, is_active=True)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ya existe una clase con ese nombre.",
        ) from None
    db.refresh(row)
    return row


@router.put("/{class_id}", response_model=TransactionClassResponse)
def update_transaction_class(
    class_id: int,
    payload: TransactionClassUpdate,
    db: DbDep,
    _: UserDep,
) -> TransactionClass:
    row = db.get(TransactionClass, class_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Clase no encontrada.")
    row.name = payload.name
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ya existe una clase con ese nombre.",
        ) from None
    db.refresh(row)
    return row


@router.delete("/{class_id}", status_code=status.HTTP_204_NO_CONTENT)
def deactivate_transaction_class(class_id: int, db: DbDep, _: UserDep) -> None:
    row = db.get(TransactionClass, class_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Clase no encontrada.")
    row.is_active = False
    db.commit()
