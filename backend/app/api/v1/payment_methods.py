from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.v1.dependencies import UserDep
from app.database import get_db
from app.models.payment_method import PaymentMethod
from app.schemas.payment_methods import (
    PaymentMethodCreate,
    PaymentMethodResponse,
    PaymentMethodStatusUpdate,
    PaymentMethodUpdate,
)

router = APIRouter(prefix="/payment-methods", tags=["payment-methods"])

DbDep = Annotated[Session, Depends(get_db)]


@router.get("/", response_model=list[PaymentMethodResponse])
def list_payment_methods(
    db: DbDep,
    _: UserDep,
    include_inactive: bool = False,
) -> list[PaymentMethod]:
    q = db.query(PaymentMethod).order_by(PaymentMethod.name)
    if not include_inactive:
        q = q.filter(PaymentMethod.is_active.is_(True))
    return q.all()


@router.get("/{method_id}", response_model=PaymentMethodResponse)
def get_payment_method(method_id: int, db: DbDep, _: UserDep) -> PaymentMethod:
    row = db.get(PaymentMethod, method_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Método de pago no encontrado.")
    return row


@router.post("/", response_model=PaymentMethodResponse, status_code=status.HTTP_201_CREATED)
def create_payment_method(payload: PaymentMethodCreate, db: DbDep, _: UserDep) -> PaymentMethod:
    row = PaymentMethod(name=payload.name, is_active=True)
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ya existe un método de pago con ese nombre.",
        ) from None
    db.refresh(row)
    return row


@router.put("/{method_id}", response_model=PaymentMethodResponse)
def update_payment_method(
    method_id: int,
    payload: PaymentMethodUpdate,
    db: DbDep,
    _: UserDep,
) -> PaymentMethod:
    row = db.get(PaymentMethod, method_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Método de pago no encontrado.")
    row.name = payload.name
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ya existe un método de pago con ese nombre.",
        ) from None
    db.refresh(row)
    return row


@router.patch("/{method_id}", response_model=PaymentMethodResponse)
def patch_payment_method_status(
    method_id: int,
    payload: PaymentMethodStatusUpdate,
    db: DbDep,
    _: UserDep,
) -> PaymentMethod:
    row = db.get(PaymentMethod, method_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Método de pago no encontrado.")
    row.is_active = payload.is_active
    db.commit()
    db.refresh(row)
    return row


@router.delete("/{method_id}", status_code=status.HTTP_204_NO_CONTENT)
def deactivate_payment_method(method_id: int, db: DbDep, _: UserDep) -> None:
    row = db.get(PaymentMethod, method_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Método de pago no encontrado.")
    row.is_active = False
    db.commit()
