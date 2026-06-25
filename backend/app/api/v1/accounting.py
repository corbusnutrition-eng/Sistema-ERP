from __future__ import annotations

from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.api.v1.dependencies import require_permission
from app.permissions import ACCOUNTING_CHART_VIEW
from app.database import get_db
from app.models.expense import Expense
from app.models.sale import Sale

router = APIRouter(prefix="/accounting", tags=["accounting"])

DbDep = Annotated[Session, Depends(get_db)]
AccountingChartViewDep = Annotated[dict, Depends(require_permission(ACCOUNTING_CHART_VIEW))]


class BalanceResponse(BaseModel):
    total_income: Decimal
    total_expenses: Decimal
    net_profit: Decimal


@router.get("/balance/", response_model=BalanceResponse)
def get_balance(db: DbDep, _: AccountingChartViewDep) -> BalanceResponse:
    total_income: Decimal = db.query(func.coalesce(func.sum(Sale.amount), 0)).scalar()
    total_expenses: Decimal = (
        db.query(func.coalesce(func.sum(Expense.total_amount), 0))
        .filter(Expense.status == "posted")
        .scalar()
    )
    return BalanceResponse(
        total_income=total_income,
        total_expenses=total_expenses,
        net_profit=total_income - total_expenses,
    )
