from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.api.v1.dependencies import require_permission
from app.permissions import (
    ACCOUNTING_EXPENSES_CREATE,
    ACCOUNTING_RECEIVABLES_VIEW,
    REPORTS_FINANCIAL_VIEW,
)
from app.currency_utils import normalize_currency_code
from app.database import get_db
from app.models.account import Account
from app.schemas.reports_financial import (
    AccountsReceivableReportResponse,
    ArCurrencyTotal,
    ArInvoicePaymentOut,
    ArOpenInvoiceOut,
    ClientArBalanceRow,
    ExpenseJournalCreate,
    ExpenseJournalResponse,
    PnlLine,
    PnlResponse,
    PnlSection,
    ProfitAndLossResponse,
)
from app.services.accounting_engine import (
    FINANCIAL_EXPENSE_DETAILS,
    TICKETS_DETAIL_BY_INCOME,
    post_manual_expense_journal,
)
from app.models.journal_entry import JournalEntry, JournalEntryLine
from app.models.client import Client
from app.services.client_payment_service import (
    linked_payments_financial_for_wallet_recharge,
    linked_payments_for_sale,
    list_client_ar_open_obligations,
    list_client_credit_balance_rows,
)
from app.timezone_utils import now_ecuador

router = APIRouter(prefix="/reports", tags=["reports"])

DbDep = Annotated[Session, Depends(get_db)]
ReportsFinancialViewDep = Annotated[dict, Depends(require_permission(REPORTS_FINANCIAL_VIEW))]
ReceivablesViewDep = Annotated[dict, Depends(require_permission(ACCOUNTING_RECEIVABLES_VIEW))]
ExpensesCreateDep = Annotated[dict, Depends(require_permission(ACCOUNTING_EXPENSES_CREATE))]

# Detalle contable sembrado como «Otros gastos» (misma account_type expense en BD).
OTHERS_EXPENSE_DETAIL_TYPES = frozenset({"Pérdida de cambio", "Otros gastos", "Liquidaciones"})
OTROS_INGRESOS_DETAIL_TYPES = frozenset({"Otros ingresos principales"})


def _q2(v: Decimal) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.01"))


def _pnl_lines_from_journal(
    db: Session,
    start_date: date,
    end_date: date,
    *,
    currency: Optional[str] = None,
) -> tuple[list[PnlLine], list[PnlLine], list[PnlLine], list[PnlLine], list[PnlLine]]:
    """Actividad P&L por cuenta en USD (``journal_entry_lines`` × ``exchange_rate``)."""
    xr_safe = func.coalesce(func.nullif(JournalEntryLine.exchange_rate, 0), 1)
    income_usd = (JournalEntryLine.credit - JournalEntryLine.debit) / xr_safe
    expense_usd = (JournalEntryLine.debit - JournalEntryLine.credit) / xr_safe
    usd_net = case(
        (Account.account_type == "income", income_usd),
        else_=expense_usd,
    )

    q = (
        db.query(
            Account.id,
            Account.name,
            Account.detail_type,
            Account.account_type,
            func.coalesce(func.sum(usd_net), 0),
        )
        .join(JournalEntryLine, JournalEntryLine.account_id == Account.id)
        .join(JournalEntry, JournalEntry.id == JournalEntryLine.journal_entry_id)
        .filter(
            JournalEntry.date >= start_date,
            JournalEntry.date <= end_date,
            Account.account_type.in_(("income", "expense", "cost_of_sales")),
            Account.is_active.is_(True),
        )
    )
    if currency:
        q = q.filter(Account.currency == currency)

    rows = q.group_by(Account.id, Account.name, Account.detail_type, Account.account_type).all()

    ingresos_lines: list[PnlLine] = []
    otros_ingresos_lines: list[PnlLine] = []
    costo_lines: list[PnlLine] = []
    gastos_lines: list[PnlLine] = []
    otros_gastos_lines: list[PnlLine] = []
    eps = Decimal("0.0001")

    for aid, name, detail, acc_type, usd_amt in rows:
        disp = _q2(Decimal(str(usd_amt)))
        if abs(disp) < eps:
            continue
        dt = (detail or "").strip() or None
        line = PnlLine(account_id=int(aid), name=name, detail_type=dt, amount=disp)

        if acc_type == "income":
            if dt and dt in OTROS_INGRESOS_DETAIL_TYPES:
                otros_ingresos_lines.append(line)
            else:
                ingresos_lines.append(line)
        elif acc_type == "cost_of_sales":
            if dt and dt in ("Descuentos", "descuentos"):
                continue
            costo_lines.append(line)
        elif acc_type == "expense":
            if dt and dt in OTHERS_EXPENSE_DETAIL_TYPES:
                otros_gastos_lines.append(line)
            else:
                gastos_lines.append(line)

    return ingresos_lines, otros_ingresos_lines, costo_lines, gastos_lines, otros_gastos_lines


@router.get("/pnl", response_model=PnlResponse)
def get_pnl_legacy(
    db: DbDep,
    _: ReportsFinancialViewDep,
    start_date: date = Query(..., description="Inicio inclusive (calendario Ecuador)."),
    end_date: date = Query(..., description="Fin inclusive (calendario Ecuador)."),
    currency: Optional[str] = Query(None, description="Filtrar por moneda ISO de la cuenta (opcional)."),
) -> PnlResponse:
    if end_date < start_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="end_date debe ser mayor o igual que start_date.",
        )
    cur_filter = normalize_currency_code(currency) if (currency or "").strip() else None

    (
        ingresos_lines,
        otros_ingresos_lines,
        costo_lines,
        gastos_lines,
        otros_gastos_lines,
    ) = _pnl_lines_from_journal(db, start_date, end_date, currency=cur_filter)

    def subtotal(lines: list[PnlLine]) -> Decimal:
        return _q2(sum((x.amount for x in lines), Decimal("0")))

    total_ingresos_block = subtotal(ingresos_lines)
    total_otros_ingresos = subtotal(otros_ingresos_lines)
    total_costo_ventas = subtotal(costo_lines)
    total_gastos = subtotal(gastos_lines)
    total_otros_gastos = subtotal(otros_gastos_lines)

    total_ingresos = _q2(total_ingresos_block + total_otros_ingresos)
    beneficio_bruto = _q2(total_ingresos - total_costo_ventas)
    ganancia_neta = _q2(beneficio_bruto - total_gastos - total_otros_gastos)

    sections: list[PnlSection] = [
        PnlSection(key="ingresos", label="Ingresos", lines=sorted(ingresos_lines, key=lambda x: x.name), subtotal=total_ingresos_block),
        PnlSection(
            key="otros_ingresos",
            label="Otros ingresos",
            lines=sorted(otros_ingresos_lines, key=lambda x: x.name),
            subtotal=total_otros_ingresos,
        ),
        PnlSection(
            key="costo_ventas",
            label="Costo de ventas",
            lines=sorted(costo_lines, key=lambda x: x.name),
            subtotal=total_costo_ventas,
        ),
        PnlSection(key="gastos", label="Gastos", lines=sorted(gastos_lines, key=lambda x: x.name), subtotal=total_gastos),
        PnlSection(
            key="otros_gastos",
            label="Otros gastos",
            lines=sorted(otros_gastos_lines, key=lambda x: x.name),
            subtotal=total_otros_gastos,
        ),
    ]

    return PnlResponse(
        start_date=start_date,
        end_date=end_date,
        currency_filter=cur_filter,
        sections=sections,
        total_ingresos=total_ingresos,
        total_otros_ingresos=total_otros_ingresos,
        total_costo_ventas=total_costo_ventas,
        beneficio_bruto=beneficio_bruto,
        total_gastos=total_gastos,
        total_otros_gastos=total_otros_gastos,
        ganancia_neta=ganancia_neta,
    )


@router.post("/expense-entry", response_model=ExpenseJournalResponse, status_code=status.HTTP_201_CREATED)
def create_expense_journal_entry(payload: ExpenseJournalCreate, db: DbDep, _: ExpensesCreateDep) -> ExpenseJournalResponse:
    cur = normalize_currency_code(payload.currency)
    entry = post_manual_expense_journal(
        db,
        expense_account_id=payload.expense_account_id,
        source_account_id=payload.source_account_id,
        amount=payload.amount,
        currency=cur,
        entry_date=payload.occurred_at.date() if payload.occurred_at else None,
        notes=payload.notes,
    )
    from app.api.v1.accounts import refresh_accounts_balance_cache

    from app.models.journal_entry import JournalEntryLine

    touched = {int(l.account_id) for l in entry.lines}
    if not touched:
        touched = {
            int(aid)
            for (aid,) in db.query(JournalEntryLine.account_id)
            .filter(JournalEntryLine.journal_entry_id == entry.id)
            .all()
        }
    refresh_accounts_balance_cache(db, touched)
    db.commit()
    db.refresh(entry)

    dr_id = 0
    cr_id = 0
    line_rows = entry.lines or db.query(JournalEntryLine).filter(JournalEntryLine.journal_entry_id == entry.id).all()
    for line in line_rows:
        if Decimal(str(line.debit)) > 0:
            dr_id = int(line.id)
        if Decimal(str(line.credit)) > 0:
            cr_id = int(line.id)

    return ExpenseJournalResponse(
        journal_entry_id=int(entry.id),
        debit_journal_line_id=dr_id,
        credit_journal_line_id=cr_id,
        debit_transaction_id=dr_id,
        credit_transaction_id=cr_id,
    )


_TICKETS_DETAILS = frozenset(TICKETS_DETAIL_BY_INCOME.values())


@router.get("/profit-and-loss", response_model=ProfitAndLossResponse)
def get_profit_and_loss(
    db: DbDep,
    _: ReportsFinancialViewDep,
    start_date: date = Query(..., description="Inicio inclusive del periodo."),
    end_date: date = Query(..., description="Fin inclusive del periodo."),
) -> ProfitAndLossResponse:
    """
    Estado de resultados jerárquico consolidado en **USD**.

    Cada línea del libro mayor se convierte con el ``exchange_rate`` de la transacción origen.
    """
    if end_date < start_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="end_date debe ser mayor o igual que start_date.",
        )

    from app.services.pnl_report import build_pnl_category_trees, sum_pnl_rows

    trees = build_pnl_category_trees(db, start_date, end_date)
    ingresos_operativos = sum_pnl_rows(trees["ingresos"])
    otros_ing = sum_pnl_rows(trees["otros_ingresos"])
    # Misma fuente que la sección «Costo de Ventas» del informe (árbol P&L).
    costos_ventas = sum_pnl_rows(trees["costo_ventas"])
    gastos_operativos = sum_pnl_rows(trees["gastos"])
    otros_gastos_financieros = sum_pnl_rows(trees["otros_gastos_financieros"])

    total_ingresos = _q2(ingresos_operativos + otros_ing)
    utilidad_bruta = _q2(total_ingresos - costos_ventas)
    utilidad_neta = _q2(utilidad_bruta - gastos_operativos - otros_gastos_financieros)

    return ProfitAndLossResponse(
        start_date=start_date,
        end_date=end_date,
        ingresos=trees["ingresos"],
        costo_de_ventas=trees["costo_ventas"],
        gastos=trees["gastos"],
        otros_ingresos=trees["otros_ingresos"],
        cuentas_otros_gastos_financieros=trees["otros_gastos_financieros"],
        ingresos_operativos=ingresos_operativos,
        costos_ventas=costos_ventas,
        utilidad_bruta=utilidad_bruta,
        gastos_operativos=gastos_operativos,
        otros_gastos_financieros=otros_gastos_financieros,
        utilidad_neta=utilidad_neta,
    )


@router.get("/accounts-receivable", response_model=AccountsReceivableReportResponse)
def get_accounts_receivable_summary(
    db: DbDep,
    _: ReceivablesViewDep,
    currency: Optional[str] = Query(
        None,
        description="Filtrar deuda pendiente por moneda ISO (opcional).",
    ),
) -> AccountsReceivableReportResponse:
    """
    Resumen de saldos CxC por cliente: deudores (facturas abiertas) y saldos a favor.

    Solo incluye clientes directos del administrador (``parent_id`` nulo); los sub-clientes
    de distribuidores no forman parte de la cartera admin.

    Pensado para reemplazar la lectura manual del libro mayor de la cuenta CxC.
    """
    cur_filter = normalize_currency_code(currency) if (currency or "").strip() else None
    eps = Decimal("0.005")

    clients = (
        db.query(Client)
        .filter(Client.parent_id.is_(None))
        .order_by(Client.name.asc(), Client.id.asc())
        .all()
    )

    debtors: list[ClientArBalanceRow] = []
    credits: list[ClientArBalanceRow] = []
    due_by_currency: dict[str, Decimal] = {}
    credit_by_currency: dict[str, Decimal] = {}
    total_due = Decimal("0")
    total_credit = Decimal("0")

    for client in clients:
        name = client.display_name()
        username = (client.username or "").strip() or None
        cid = int(client.id)

        by_currency: dict[str, Decimal] = {}
        invoices_by_currency: dict[str, list] = {}
        for inv in list_client_ar_open_obligations(db, cid, currency=cur_filter):
            cur = normalize_currency_code(str(inv.get("currency") or "USD"))
            open_b = Decimal(str(inv.get("open_balance") or 0)).quantize(Decimal("0.01"))
            if open_b <= eps:
                continue
            by_currency[cur] = by_currency.get(cur, Decimal("0")) + open_b
            invoices_by_currency.setdefault(cur, []).append(inv)

        for cur, amt in sorted(by_currency.items(), key=lambda x: (-x[1], x[0])):
            amt_q = amt.quantize(Decimal("0.01"))
            if amt_q <= eps:
                continue
            open_rows: list[ArOpenInvoiceOut] = []
            for row in invoices_by_currency.get(cur, []):
                if Decimal(str(row.get("open_balance") or 0)).quantize(Decimal("0.01")) <= eps:
                    continue
                kind = str(row.get("obligation_kind") or "sale")
                payment_rows: list[ArInvoicePaymentOut] = []
                if kind == "wallet_recharge":
                    wr_row = row.get("_wallet_recharge_row")
                    if wr_row is not None:
                        approved_wr, _ = linked_payments_financial_for_wallet_recharge(db, wr_row)
                        payment_rows = [
                            ArInvoicePaymentOut(
                                payment_id=int(p["payment_id"]),
                                payment_number=p.get("payment_number"),
                                date=p.get("date"),
                                amount_applied=float(p.get("amount_applied") or 0),
                            )
                            for p in approved_wr
                        ]
                    open_rows.append(
                        ArOpenInvoiceOut(
                            obligation_kind="wallet_recharge",
                            wallet_recharge_id=int(row["wallet_recharge_id"]),
                            reference=str(row.get("reference") or ""),
                            date=row.get("date"),
                            total_amount=float(row.get("total_amount") or 0),
                            open_balance=float(row.get("open_balance") or 0),
                            currency=normalize_currency_code(str(row.get("currency") or cur)),
                            payments=payment_rows,
                        )
                    )
                else:
                    sale_id = int(row["sale_id"])
                    payment_rows = [
                        ArInvoicePaymentOut(
                            payment_id=int(p["payment_id"]),
                            payment_number=p.get("payment_number"),
                            date=p.get("date"),
                            amount_applied=float(p.get("amount_applied") or 0),
                        )
                        for p in linked_payments_for_sale(db, sale_id)
                    ]
                    open_rows.append(
                        ArOpenInvoiceOut(
                            obligation_kind="sale",
                            sale_id=sale_id,
                            reference=str(row.get("reference") or ""),
                            date=row.get("date"),
                            total_amount=float(row.get("total_amount") or 0),
                            open_balance=float(row.get("open_balance") or 0),
                            currency=normalize_currency_code(str(row.get("currency") or cur)),
                            payments=payment_rows,
                        )
                    )
            debtors.append(
                ClientArBalanceRow(
                    client_id=cid,
                    client_name=name,
                    client_username=username,
                    currency=cur,
                    amount_due=amt_q,
                    credit_balance=Decimal("0"),
                    open_invoices=open_rows,
                )
            )
            due_by_currency[cur] = due_by_currency.get(cur, Decimal("0")) + amt_q
            if cur_filter:
                total_due += amt_q

        for cur, cb in list_client_credit_balance_rows(client, currency=cur_filter, db=db):
            cb_q = cb.quantize(Decimal("0.01"))
            if cb_q <= eps:
                continue
            credits.append(
                ClientArBalanceRow(
                    client_id=cid,
                    client_name=name,
                    client_username=username,
                    currency=cur,
                    amount_due=Decimal("0"),
                    credit_balance=cb_q,
                )
            )
            credit_by_currency[cur] = credit_by_currency.get(cur, Decimal("0")) + cb_q
            if cur_filter:
                total_credit += cb_q

    debtors.sort(
        key=lambda r: (-r.amount_due, r.currency, r.client_name.lower(), r.client_id),
    )
    credits.sort(
        key=lambda r: (-r.credit_balance, r.currency, r.client_name.lower(), r.client_id),
    )

    all_currencies = sorted(set(due_by_currency) | set(credit_by_currency))
    totals_by_currency = [
        ArCurrencyTotal(
            currency=cur,
            total_amount_due=_q2(due_by_currency.get(cur, Decimal("0"))),
            total_credit_balance=_q2(credit_by_currency.get(cur, Decimal("0"))),
        )
        for cur in all_currencies
    ]

    if cur_filter:
        total_due = _q2(total_due)
        total_credit = _q2(total_credit)
    else:
        total_due = Decimal("0")
        total_credit = Decimal("0")

    return AccountsReceivableReportResponse(
        generated_at=now_ecuador(),
        currency_filter=cur_filter,
        debtors=debtors,
        credit_balances=credits,
        total_amount_due=total_due,
        total_credit_balance=total_credit,
        totals_by_currency=totals_by_currency,
    )
