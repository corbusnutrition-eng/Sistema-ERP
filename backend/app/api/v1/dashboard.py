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
from app.models.iptv_account import IPTVAccount
from app.models.iptv_screen import IPTVScreen
from app.models.sale import Sale
from app.services.dashboard_metrics_service import (
    compute_accounts_receivable_usd,
    compute_monthly_revenue_usd,
    compute_pending_reviews_count,
)

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


class DashboardSummary(BaseModel):
    total_clients: int
    monthly_revenue: Decimal
    accounts_receivable: Decimal
    pending_reviews: int
    available_screens_flujo: int
    available_screens_stella: int
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

    monthly_revenue = compute_monthly_revenue_usd(db)
    accounts_receivable = compute_accounts_receivable_usd(db)
    pending_reviews = compute_pending_reviews_count(db)

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
        monthly_revenue=monthly_revenue,
        accounts_receivable=accounts_receivable,
        pending_reviews=pending_reviews,
        available_screens_flujo=available_screens_flujo,
        available_screens_stella=available_screens_stella,
        recent_sales=recent_sales,
    )
