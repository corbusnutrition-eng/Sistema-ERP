from __future__ import annotations

import logging
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.api.v1.dependencies import UserDep
from app.database import get_db
from app.models.payment_link_template import PaymentLinkTemplate
from app.models.payment_method import PaymentMethod
from app.models.product import Product
from app.schemas.hotmart_links import hotmart_links_from_model
from app.schemas.payment_link_templates import (
    PaymentLinkTemplateCreate,
    PaymentLinkTemplateRead,
    PaymentLinkTemplateUpdate,
    links_storage_from_payload,
)
from app.services.payment_link_template_propagation import propagate_payment_link_template

router = APIRouter(prefix="/payment-link-templates", tags=["payment-link-templates"])

DbDep = Annotated[Session, Depends(get_db)]
logger = logging.getLogger(__name__)


def _row_to_read(row: PaymentLinkTemplate) -> PaymentLinkTemplateRead:
    pm = getattr(row, "payment_method", None)
    prod = getattr(row, "product", None)
    return PaymentLinkTemplateRead(
        id=int(row.id),
        payment_method_id=int(row.payment_method_id),
        payment_method_name=str(pm.name) if pm is not None else None,
        module_type=str(row.module_type or "").strip().upper(),
        product_id=int(row.product_id) if row.product_id is not None else None,
        product_name=str(prod.name) if prod is not None else None,
        links=hotmart_links_from_model(getattr(row, "links", None)),
    )


def _validate_fks(db: Session, payment_method_id: int, module_type: str, product_id: Optional[int]) -> None:
    pm = db.get(PaymentMethod, int(payment_method_id))
    if pm is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Método de pago no encontrado.")
    mod = str(module_type or "").strip().upper()
    if mod == "VENTAS":
        if product_id is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="product_id es obligatorio para plantillas de Ventas.",
            )
        prod = db.get(Product, int(product_id))
        if prod is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Producto no encontrado.")
    elif mod == "BAAS" and product_id is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="product_id debe omitirse para plantillas BaaS.",
        )


def _find_existing(
    db: Session,
    payment_method_id: int,
    module_type: str,
    product_id: Optional[int],
    exclude_id: Optional[int] = None,
) -> PaymentLinkTemplate | None:
    q = (
        db.query(PaymentLinkTemplate)
        .filter(
            PaymentLinkTemplate.payment_method_id == int(payment_method_id),
            PaymentLinkTemplate.module_type == str(module_type).strip().upper(),
        )
    )
    if product_id is None:
        q = q.filter(PaymentLinkTemplate.product_id.is_(None))
    else:
        q = q.filter(PaymentLinkTemplate.product_id == int(product_id))
    if exclude_id is not None:
        q = q.filter(PaymentLinkTemplate.id != int(exclude_id))
    return q.first()


@router.get("/", response_model=list[PaymentLinkTemplateRead])
def list_payment_link_templates(
    db: DbDep,
    _: UserDep,
    payment_method_id: Optional[int] = Query(default=None, ge=1),
    module_type: Optional[str] = Query(default=None),
    product_id: Optional[int] = Query(default=None, ge=1),
) -> list[PaymentLinkTemplateRead]:
    q = (
        db.query(PaymentLinkTemplate)
        .options(joinedload(PaymentLinkTemplate.payment_method), joinedload(PaymentLinkTemplate.product))
        .order_by(PaymentLinkTemplate.id.desc())
    )
    if payment_method_id is not None:
        q = q.filter(PaymentLinkTemplate.payment_method_id == int(payment_method_id))
    if module_type is not None and str(module_type).strip():
        q = q.filter(PaymentLinkTemplate.module_type == str(module_type).strip().upper())
    if product_id is not None:
        q = q.filter(PaymentLinkTemplate.product_id == int(product_id))
    rows = q.all()
    return [_row_to_read(r) for r in rows]


@router.get("/{template_id}", response_model=PaymentLinkTemplateRead)
def get_payment_link_template(template_id: int, db: DbDep, _: UserDep) -> PaymentLinkTemplateRead:
    row = (
        db.query(PaymentLinkTemplate)
        .options(joinedload(PaymentLinkTemplate.payment_method), joinedload(PaymentLinkTemplate.product))
        .filter(PaymentLinkTemplate.id == int(template_id))
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Plantilla no encontrada.")
    return _row_to_read(row)


@router.post("/", response_model=PaymentLinkTemplateRead, status_code=status.HTTP_201_CREATED)
def create_payment_link_template(payload: PaymentLinkTemplateCreate, db: DbDep, _: UserDep) -> PaymentLinkTemplateRead:
    mod = str(payload.module_type).strip().upper()
    _validate_fks(db, payload.payment_method_id, mod, payload.product_id)
    if _find_existing(db, payload.payment_method_id, mod, payload.product_id) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ya existe una plantilla para este método, módulo y producto.",
        )
    try:
        links_norm = links_storage_from_payload(payload.links)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    if not links_norm:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Debe incluir al menos un link válido.")

    row = PaymentLinkTemplate(
        payment_method_id=int(payload.payment_method_id),
        module_type=mod,
        product_id=int(payload.product_id) if payload.product_id is not None else None,
        links=links_norm,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ya existe una plantilla para esta combinación.",
        ) from exc
    db.refresh(row)
    try:
        propagate_payment_link_template(db, row)
    except Exception:
        logger.exception(
            "payment_link_template propagate failed after create id=%s",
            getattr(row, "id", "?"),
        )
    row = (
        db.query(PaymentLinkTemplate)
        .options(joinedload(PaymentLinkTemplate.payment_method), joinedload(PaymentLinkTemplate.product))
        .filter(PaymentLinkTemplate.id == row.id)
        .first()
    )
    return _row_to_read(row)


@router.put("/{template_id}", response_model=PaymentLinkTemplateRead)
def update_payment_link_template(
    template_id: int,
    payload: PaymentLinkTemplateUpdate,
    db: DbDep,
    _: UserDep,
) -> PaymentLinkTemplateRead:
    row = db.get(PaymentLinkTemplate, int(template_id))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Plantilla no encontrada.")

    pm_id = int(payload.payment_method_id) if payload.payment_method_id is not None else int(row.payment_method_id)
    mod = str(payload.module_type or row.module_type).strip().upper()
    prod_id = row.product_id if payload.product_id is None and payload.module_type is None else payload.product_id
    if payload.module_type == "BAAS":
        prod_id = None
    if payload.module_type == "VENTAS" and prod_id is None and row.product_id is not None:
        prod_id = row.product_id

    _validate_fks(db, pm_id, mod, prod_id)
    dup = _find_existing(db, pm_id, mod, prod_id, exclude_id=int(row.id))
    if dup is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ya existe otra plantilla para este método, módulo y producto.",
        )

    if payload.payment_method_id is not None:
        row.payment_method_id = pm_id
    if payload.module_type is not None:
        row.module_type = mod
    if payload.module_type == "BAAS" or payload.product_id is not None or (payload.module_type == "VENTAS" and prod_id is not None):
        row.product_id = int(prod_id) if prod_id is not None else None

    if payload.links is not None:
        try:
            links_norm = links_storage_from_payload(payload.links)
        except ValueError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        if not links_norm:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Debe incluir al menos un link válido.")
        row.links = links_norm

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Conflicto al guardar la plantilla.",
        ) from exc
    db.refresh(row)
    try:
        propagate_payment_link_template(db, row)
    except Exception:
        logger.exception(
            "payment_link_template propagate failed after update id=%s",
            getattr(row, "id", "?"),
        )
    row = (
        db.query(PaymentLinkTemplate)
        .options(joinedload(PaymentLinkTemplate.payment_method), joinedload(PaymentLinkTemplate.product))
        .filter(PaymentLinkTemplate.id == row.id)
        .first()
    )
    return _row_to_read(row)


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_payment_link_template(template_id: int, db: DbDep, _: UserDep) -> None:
    row = db.get(PaymentLinkTemplate, int(template_id))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Plantilla no encontrada.")
    db.delete(row)
    db.commit()
