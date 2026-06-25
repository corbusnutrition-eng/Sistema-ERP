from __future__ import annotations

import uuid
from decimal import Decimal
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from sqlalchemy.orm import Session, joinedload

from app.api.v1.dependencies import require_permission
from app.permissions import (
    ACCOUNTING_EXPENSES_CREATE,
    ACCOUNTING_EXPENSES_DELETE,
    ACCOUNTING_EXPENSES_EDIT,
    ACCOUNTING_EXPENSES_VIEW,
)
from app.api.v1.accounts import refresh_accounts_balance_cache
from app.currency_utils import normalize_currency_code
from app.database import get_db
from app.models.account import Account
from app.models.expense import Expense, ExpenseLine
from app.models.user import User
from app.schemas.expenses import ExpenseCreate, ExpenseLineResponse, ExpenseListItem, ExpenseResponse
from app.services.expense_document_journal import delete_vendor_expense_journal, post_vendor_expense_journal

router = APIRouter(prefix="/expenses", tags=["expenses"])

DbDep = Annotated[Session, Depends(get_db)]
ExpensesViewDep = Annotated[dict, Depends(require_permission(ACCOUNTING_EXPENSES_VIEW))]
ExpensesCreateDep = Annotated[dict, Depends(require_permission(ACCOUNTING_EXPENSES_CREATE))]
ExpensesEditDep = Annotated[dict, Depends(require_permission(ACCOUNTING_EXPENSES_EDIT))]
ExpensesDeleteDep = Annotated[dict, Depends(require_permission(ACCOUNTING_EXPENSES_DELETE))]

UPLOAD_DIR = Path("uploads")
EXP_ATTACH_MAX_BYTES = 20 * 1024 * 1024
EXP_ATTACH_CT = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
}


def _expense_line_to_response(line: ExpenseLine) -> ExpenseLineResponse:
    ea = line.expense_account
    cn = line.customer.display_name() if line.customer is not None else None
    kl = line.klass.name if line.klass is not None else None
    return ExpenseLineResponse(
        id=line.id,
        expense_id=line.expense_id,
        expense_account_id=line.expense_account_id,
        expense_account_name=(ea.name if ea else "") or "",
        description=line.description,
        amount=Decimal(str(line.amount)),
        customer_id=line.customer_id,
        customer_name=cn,
        class_id=line.class_id,
        class_name=kl,
        line_no=line.line_no,
    )


def _expense_to_response(expense: Expense) -> ExpenseResponse:
    payee = expense.payee
    pa = expense.payment_account
    att = expense.attachments_json if isinstance(expense.attachments_json, list) else []
    return ExpenseResponse(
        id=expense.id,
        payee_id=expense.payee_id,
        payee_name=(payee.name if payee else "") or "",
        payment_account_id=expense.payment_account_id,
        payment_account_name=(pa.name if pa else "") or "",
        payment_date=expense.payment_date,
        payment_method=expense.payment_method,
        reference_number=expense.reference_number,
        memo=expense.memo,
        subtotal_amount=Decimal(str(expense.subtotal_amount)),
        tax_amount=Decimal(str(expense.tax_amount)),
        total_amount=Decimal(str(expense.total_amount)),
        status=expense.status,
        attachments_json=att,
        created_at=expense.created_at,
        lines=[_expense_line_to_response(ln) for ln in sorted(expense.lines, key=lambda x: (x.line_no, x.id))],
    )


def _validate_expense_accounts(db: Session, payload: ExpenseCreate) -> None:
    for ln in payload.lines:
        acc = db.get(Account, ln.expense_account_id)
        if acc is None or not acc.is_active:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta de categoría no encontrada.")
        if acc.account_type not in ("expense", "cost_of_sales"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="La categoría debe ser tipo Gastos u Otros gastos (expense) o Costos de venta.",
            )


@router.get("/", response_model=list[ExpenseListItem])
def list_expenses(db: DbDep, _: ExpensesViewDep) -> list[ExpenseListItem]:
    rows = (
        db.query(Expense)
        .options(
            joinedload(Expense.payee),
            joinedload(Expense.payment_account),
            joinedload(Expense.lines).joinedload(ExpenseLine.expense_account),
        )
        .order_by(Expense.payment_date.desc(), Expense.id.desc())
        .all()
    )
    out: list[ExpenseListItem] = []
    for e in rows:
        cats = []
        for ln in sorted(e.lines, key=lambda x: (x.line_no, x.id)):
            acc = ln.expense_account
            if acc and acc.name not in cats:
                cats.append(acc.name)
        cat_label = ", ".join(cats) if cats else "—"
        ref_disp = e.reference_number or f"{e.id:04d}"
        out.append(
            ExpenseListItem(
                id=e.id,
                payment_date=e.payment_date,
                type_label="Gasto",
                reference_number=ref_disp,
                payee_name=e.payee.name if e.payee else "—",
                category_label=cat_label,
                currency=normalize_currency_code(e.payment_account.currency if e.payment_account else "USD"),
                subtotal_amount=Decimal(str(e.subtotal_amount)),
                tax_amount=Decimal(str(e.tax_amount)),
                total_amount=Decimal(str(e.total_amount)),
                status=e.status,
            ),
        )
    return out


@router.get("/{expense_id}", response_model=ExpenseResponse)
def get_expense(expense_id: int, db: DbDep, _: ExpensesViewDep) -> ExpenseResponse:
    row = (
        db.query(Expense)
        .options(
            joinedload(Expense.payee),
            joinedload(Expense.payment_account),
            joinedload(Expense.lines).joinedload(ExpenseLine.expense_account),
            joinedload(Expense.lines).joinedload(ExpenseLine.customer),
            joinedload(Expense.lines).joinedload(ExpenseLine.klass),
        )
        .filter(Expense.id == expense_id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Gasto no encontrado.")
    return _expense_to_response(row)


@router.post("/", response_model=ExpenseResponse, status_code=status.HTTP_201_CREATED)
def create_expense(payload: ExpenseCreate, db: DbDep, _: ExpensesCreateDep) -> ExpenseResponse:
    payee = db.get(User, payload.payee_id)
    if payee is None or not payee.is_active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Beneficiario no encontrado.")
    pay_acc = db.get(Account, payload.payment_account_id)
    if pay_acc is None or not pay_acc.is_active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cuenta de pago no encontrada.")

    _validate_expense_accounts(db, payload)

    subtotal = sum(Decimal(str(l.amount)).quantize(Decimal("0.0001")) for l in payload.lines)
    tax = Decimal(str(payload.tax_amount)).quantize(Decimal("0.0001"))
    total = (subtotal + tax).quantize(Decimal("0.0001"))

    attachments: list[str] = []
    for u in payload.attachment_urls:
        s = str(u).strip()
        if s:
            attachments.append(s)

    expense = Expense(
        payee_id=payload.payee_id,
        payment_account_id=payload.payment_account_id,
        payment_date=payload.payment_date,
        payment_method=payload.payment_method.strip() if payload.payment_method else None,
        reference_number=payload.reference_number.strip() if payload.reference_number else None,
        memo=payload.memo.strip() if payload.memo else None,
        subtotal_amount=subtotal,
        tax_amount=tax,
        total_amount=total,
        status="posted",
        attachments_json=attachments,
    )
    db.add(expense)
    db.flush()

    for i, ln in enumerate(payload.lines):
        db.add(
            ExpenseLine(
                expense_id=expense.id,
                expense_account_id=ln.expense_account_id,
                description=ln.description.strip() if ln.description else None,
                amount=Decimal(str(ln.amount)).quantize(Decimal("0.0001")),
                customer_id=ln.customer_id,
                class_id=ln.class_id,
                line_no=i + 1,
            ),
        )
    db.flush()

    db.refresh(expense)
    expense = (
        db.query(Expense)
        .options(
            joinedload(Expense.payee),
            joinedload(Expense.payment_account),
            joinedload(Expense.lines).joinedload(ExpenseLine.expense_account),
            joinedload(Expense.lines).joinedload(ExpenseLine.customer),
            joinedload(Expense.lines).joinedload(ExpenseLine.klass),
        )
        .filter(Expense.id == expense.id)
        .first()
    )
    assert expense is not None

    try:
        post_vendor_expense_journal(db, expense)
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    db.refresh(expense)
    return _expense_to_response(expense)


@router.patch("/{expense_id}/void", response_model=ExpenseResponse)
def void_expense(expense_id: int, db: DbDep, _: ExpensesEditDep) -> ExpenseResponse:
    row = db.get(Expense, expense_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Gasto no encontrado.")
    if row.status == "voided":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="El gasto ya está anulado.")
    touched = delete_vendor_expense_journal(db, expense_id)
    refresh_accounts_balance_cache(db, touched)
    row.status = "voided"
    db.commit()
    db.refresh(row)
    row = (
        db.query(Expense)
        .options(
            joinedload(Expense.payee),
            joinedload(Expense.payment_account),
            joinedload(Expense.lines).joinedload(ExpenseLine.expense_account),
            joinedload(Expense.lines).joinedload(ExpenseLine.customer),
            joinedload(Expense.lines).joinedload(ExpenseLine.klass),
        )
        .filter(Expense.id == expense_id)
        .first()
    )
    assert row is not None
    return _expense_to_response(row)


@router.delete("/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_expense(expense_id: int, db: DbDep, _: ExpensesDeleteDep) -> None:
    row = db.get(Expense, expense_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Gasto no encontrado.")
    touched = delete_vendor_expense_journal(db, expense_id)
    refresh_accounts_balance_cache(db, touched)
    db.delete(row)
    db.commit()


@router.post("/attachments/upload")
async def upload_expense_attachment(file: UploadFile, _: ExpensesCreateDep) -> dict[str, str]:
    if file.content_type not in EXP_ATTACH_CT:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Solo se aceptan JPEG, PNG, GIF, WEBP o PDF.",
        )
    raw = await file.read()
    if len(raw) > EXP_ATTACH_MAX_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="El archivo supera los 20 MB.",
        )
    suf = Path(file.filename or "adjunto").suffix.lower()
    suffix = suf if suf in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".pdf") else (
        ".pdf" if file.content_type == "application/pdf" else ".jpg"
    )
    filename = f"{uuid.uuid4().hex}{suffix}"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (UPLOAD_DIR / filename).write_bytes(raw)
    return {"url": f"/uploads/{filename}"}
