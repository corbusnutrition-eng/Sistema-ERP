from __future__ import annotations

import datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.api.v1.dependencies import require_permission
from app.permissions import DASHBOARD_OVERVIEW_VIEW

from app.database import get_db
from app.models.client import Client
from app.models.expense import Expense
from app.models.iptv_account import IPTVAccount
from app.models.iptv_screen import IPTVScreen
from app.models.sale import Sale

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

DbDep = Annotated[Session, Depends(get_db)]
DashboardViewDep = Annotated[dict, Depends(require_permission(DASHBOARD_OVERVIEW_VIEW))]


# ── Schemas ───────────────────────────────────────────────────────────────────

class RecentSale(BaseModel):
    id: int
    client_name: str
    amount: Decimal
    currency: str
    date: str


class Financials(BaseModel):
    total_income: Decimal
    net_profit: Decimal


class DashboardSummary(BaseModel):
    total_clients: int
    available_screens_flujo: int
    available_screens_stella: int
    financials: Financials
    recent_sales: list[RecentSale]


# ── Endpoint ──────────────────────────────────────────────────────────────────

@router.get("/summary/", response_model=DashboardSummary)
def get_dashboard_summary(db: DbDep, _: DashboardViewDep) -> DashboardSummary:
    total_clients: int = db.query(func.count(Client.id)).scalar() or 0

    available_screens_flujo: int = (
        db.query(func.count(IPTVScreen.id))
        .join(IPTVAccount, IPTVScreen.iptv_account_id == IPTVAccount.id)
        .filter(IPTVScreen.is_available.is_(True), IPTVAccount.provider_name == "Flujo")
        .scalar()
        or 0
    )

    available_screens_stella: int = (
        db.query(func.count(IPTVScreen.id))
        .join(IPTVAccount, IPTVScreen.iptv_account_id == IPTVAccount.id)
        .filter(IPTVScreen.is_available.is_(True), IPTVAccount.provider_name == "Stella")
        .scalar()
        or 0
    )

    total_income: Decimal = db.query(func.coalesce(func.sum(Sale.amount), 0)).scalar()
    total_expenses: Decimal = (
        db.query(func.coalesce(func.sum(Expense.total_amount), 0)).filter(Expense.status == "posted").scalar()
        or 0
    )
    net_profit: Decimal = total_income - total_expenses

    recent_sales_rows = (
        db.query(Sale)
        .options(joinedload(Sale.client))
        .order_by(Sale.created_at.desc())
        .limit(5)
        .all()
    )

    recent_sales = [
        RecentSale(
            id=sale.id,
            client_name=sale.client.display_name() if sale.client else "—",
            amount=sale.amount,
            currency=sale.currency,
            date=sale.created_at.date().isoformat(),
        )
        for sale in recent_sales_rows
    ]

    return DashboardSummary(
        total_clients=total_clients,
        available_screens_flujo=available_screens_flujo,
        available_screens_stella=available_screens_stella,
        financials=Financials(
            total_income=total_income,
            net_profit=net_profit,
        ),
        recent_sales=recent_sales,
    )
