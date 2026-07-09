"""Informe agrupado por dimensiones de listas (clases, métodos de pago, monedas, etiquetas)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Literal, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.client_debt_payment import ClientDebtPayment, DebtPaymentStatus
from app.models.client_payment import ClientPayment, ClientPaymentStatus
from app.models.expense import Expense, ExpenseLine
from app.models.payment_method import PaymentMethod
from app.models.sale import Sale, SaleStatus
from app.models.sale_transaction_tag import SaleTransactionTag, sale_tag_association
from app.models.transaction_class import TransactionClass
from app.models.client import Client

ListType = Literal["class", "payment_method", "currency", "tag"]

LIST_TYPE_LABELS: dict[str, str] = {
    "class": "Clases",
    "payment_method": "Métodos de pago",
    "currency": "Monedas",
    "tag": "Etiquetas",
}

SALE_COUNTABLE_STATUSES = (SaleStatus.approved, SaleStatus.partially_paid)
UNASSIGNED_LABEL = "Sin asignar"


def _q2(v: Decimal) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.01"))


@dataclass
class _Bucket:
    item_id: Optional[int] = None
    item_key: Optional[str] = None
    item_name: str = UNASSIGNED_LABEL
    transaction_count: int = 0
    total_amount_usd: Decimal = field(default_factory=lambda: Decimal("0"))


class _Aggregator:
    def __init__(self) -> None:
        self._buckets: dict[tuple[Optional[int], Optional[str]], _Bucket] = {}

    def add(
        self,
        *,
        item_id: Optional[int],
        item_key: Optional[str],
        item_name: Optional[str],
        count: int,
        amount_usd: Decimal,
    ) -> None:
        key = (item_id, item_key)
        if key not in self._buckets:
            self._buckets[key] = _Bucket(
                item_id=item_id,
                item_key=item_key,
                item_name=(item_name or UNASSIGNED_LABEL).strip() or UNASSIGNED_LABEL,
            )
        bucket = self._buckets[key]
        bucket.transaction_count += int(count)
        bucket.total_amount_usd += Decimal(str(amount_usd))

    def rows(self) -> list[_Bucket]:
        result = list(self._buckets.values())
        result.sort(key=lambda r: (-r.total_amount_usd, r.item_name.lower()))
        return result


def _aggregate_classes(db: Session, start_date: date, end_date: date) -> _Aggregator:
    agg = _Aggregator()

    sale_rows = (
        db.query(
            Sale.class_id,
            TransactionClass.name,
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.amount), 0),
        )
        .outerjoin(TransactionClass, TransactionClass.id == Sale.class_id)
        .filter(
            func.date(Sale.created_at) >= start_date,
            func.date(Sale.created_at) <= end_date,
            Sale.status.in_(SALE_COUNTABLE_STATUSES),
        )
        .group_by(Sale.class_id, TransactionClass.name)
        .all()
    )
    for class_id, name, cnt, total in sale_rows:
        agg.add(
            item_id=class_id,
            item_key=None,
            item_name=name,
            count=int(cnt or 0),
            amount_usd=Decimal(str(total or 0)),
        )

    expense_rows = (
        db.query(
            ExpenseLine.class_id,
            TransactionClass.name,
            func.count(ExpenseLine.id),
            func.coalesce(func.sum(ExpenseLine.amount), 0),
        )
        .join(Expense, Expense.id == ExpenseLine.expense_id)
        .outerjoin(TransactionClass, TransactionClass.id == ExpenseLine.class_id)
        .filter(
            Expense.payment_date >= start_date,
            Expense.payment_date <= end_date,
            Expense.status == "posted",
        )
        .group_by(ExpenseLine.class_id, TransactionClass.name)
        .all()
    )
    for class_id, name, cnt, total in expense_rows:
        agg.add(
            item_id=class_id,
            item_key=None,
            item_name=name,
            count=int(cnt or 0),
            amount_usd=Decimal(str(total or 0)),
        )

    return agg


def _aggregate_payment_methods(db: Session, start_date: date, end_date: date) -> _Aggregator:
    agg = _Aggregator()

    sale_rows = (
        db.query(
            Sale.payment_method_id,
            PaymentMethod.name,
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.amount), 0),
        )
        .outerjoin(PaymentMethod, PaymentMethod.id == Sale.payment_method_id)
        .filter(
            func.date(Sale.created_at) >= start_date,
            func.date(Sale.created_at) <= end_date,
            Sale.status.in_(SALE_COUNTABLE_STATUSES),
        )
        .group_by(Sale.payment_method_id, PaymentMethod.name)
        .all()
    )
    for pm_id, name, cnt, total in sale_rows:
        agg.add(
            item_id=pm_id,
            item_key=None,
            item_name=name,
            count=int(cnt or 0),
            amount_usd=Decimal(str(total or 0)),
        )

    cp_rows = (
        db.query(
            ClientPayment.payment_method_id,
            PaymentMethod.name,
            func.count(ClientPayment.id),
            func.coalesce(
                func.sum(ClientPayment.amount / func.nullif(ClientPayment.exchange_rate, 0)),
                0,
            ),
        )
        .outerjoin(PaymentMethod, PaymentMethod.id == ClientPayment.payment_method_id)
        .filter(
            ClientPayment.status == ClientPaymentStatus.approved,
            func.coalesce(ClientPayment.approved_at, ClientPayment.created_at).isnot(None),
            func.date(func.coalesce(ClientPayment.approved_at, ClientPayment.created_at)) >= start_date,
            func.date(func.coalesce(ClientPayment.approved_at, ClientPayment.created_at)) <= end_date,
        )
        .group_by(ClientPayment.payment_method_id, PaymentMethod.name)
        .all()
    )
    for pm_id, name, cnt, total in cp_rows:
        agg.add(
            item_id=pm_id,
            item_key=None,
            item_name=name,
            count=int(cnt or 0),
            amount_usd=Decimal(str(total or 0)),
        )

    dp_rows = (
        db.query(
            ClientDebtPayment.payment_method_id,
            PaymentMethod.name,
            func.count(ClientDebtPayment.id),
            func.coalesce(func.sum(ClientDebtPayment.amount), 0),
        )
        .outerjoin(PaymentMethod, PaymentMethod.id == ClientDebtPayment.payment_method_id)
        .filter(
            ClientDebtPayment.status == DebtPaymentStatus.approved,
            func.coalesce(ClientDebtPayment.approved_at, ClientDebtPayment.created_at).isnot(None),
            func.date(func.coalesce(ClientDebtPayment.approved_at, ClientDebtPayment.created_at)) >= start_date,
            func.date(func.coalesce(ClientDebtPayment.approved_at, ClientDebtPayment.created_at)) <= end_date,
        )
        .group_by(ClientDebtPayment.payment_method_id, PaymentMethod.name)
        .all()
    )
    for pm_id, name, cnt, total in dp_rows:
        agg.add(
            item_id=pm_id,
            item_key=None,
            item_name=name,
            count=int(cnt or 0),
            amount_usd=Decimal(str(total or 0)),
        )

    return agg


def _aggregate_currencies(db: Session, start_date: date, end_date: date) -> _Aggregator:
    agg = _Aggregator()

    sale_rows = (
        db.query(
            Sale.currency,
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.amount), 0),
            func.coalesce(func.sum(Sale.local_amount), 0),
        )
        .filter(
            func.date(Sale.created_at) >= start_date,
            func.date(Sale.created_at) <= end_date,
            Sale.status.in_(SALE_COUNTABLE_STATUSES),
        )
        .group_by(Sale.currency)
        .all()
    )
    for currency, cnt, total_usd, total_local in sale_rows:
        code = (currency or "USD").strip().upper() or "USD"
        agg.add(
            item_id=None,
            item_key=code,
            item_name=code,
            count=int(cnt or 0),
            amount_usd=Decimal(str(total_usd or 0)),
        )

    cp_rows = (
        db.query(
            ClientPayment.currency,
            func.count(ClientPayment.id),
            func.coalesce(
                func.sum(ClientPayment.amount / func.nullif(ClientPayment.exchange_rate, 0)),
                0,
            ),
        )
        .filter(
            ClientPayment.status == ClientPaymentStatus.approved,
            func.coalesce(ClientPayment.approved_at, ClientPayment.created_at).isnot(None),
            func.date(func.coalesce(ClientPayment.approved_at, ClientPayment.created_at)) >= start_date,
            func.date(func.coalesce(ClientPayment.approved_at, ClientPayment.created_at)) <= end_date,
        )
        .group_by(ClientPayment.currency)
        .all()
    )
    for currency, cnt, total_usd in cp_rows:
        code = (currency or "USD").strip().upper() or "USD"
        agg.add(
            item_id=None,
            item_key=code,
            item_name=code,
            count=int(cnt or 0),
            amount_usd=Decimal(str(total_usd or 0)),
        )

    return agg


def _aggregate_tags(db: Session, start_date: date, end_date: date) -> _Aggregator:
    agg = _Aggregator()

    tag_rows = (
        db.query(
            SaleTransactionTag.id,
            SaleTransactionTag.name,
            func.count(Sale.id),
            func.coalesce(func.sum(Sale.amount), 0),
        )
        .join(sale_tag_association, sale_tag_association.c.tag_id == SaleTransactionTag.id)
        .join(Sale, Sale.id == sale_tag_association.c.sale_id)
        .filter(
            func.date(Sale.created_at) >= start_date,
            func.date(Sale.created_at) <= end_date,
            Sale.status.in_(SALE_COUNTABLE_STATUSES),
        )
        .group_by(SaleTransactionTag.id, SaleTransactionTag.name)
        .all()
    )
    for tag_id, name, cnt, total in tag_rows:
        agg.add(
            item_id=tag_id,
            item_key=None,
            item_name=name,
            count=int(cnt or 0),
            amount_usd=Decimal(str(total or 0)),
        )

    untagged_count = (
        db.query(func.count(Sale.id), func.coalesce(func.sum(Sale.amount), 0))
        .outerjoin(sale_tag_association, sale_tag_association.c.sale_id == Sale.id)
        .filter(
            sale_tag_association.c.tag_id.is_(None),
            func.date(Sale.created_at) >= start_date,
            func.date(Sale.created_at) <= end_date,
            Sale.status.in_(SALE_COUNTABLE_STATUSES),
        )
        .one()
    )
    if untagged_count[0]:
        agg.add(
            item_id=None,
            item_key=None,
            item_name=UNASSIGNED_LABEL,
            count=int(untagged_count[0] or 0),
            amount_usd=Decimal(str(untagged_count[1] or 0)),
        )

    return agg


def build_list_classification_report(
    db: Session,
    *,
    start_date: date,
    end_date: date,
    list_type: ListType,
    include_transactions: bool = False,
) -> dict:
    if start_date > end_date:
        raise ValueError("La fecha inicial no puede ser posterior a la final.")

    if list_type == "class":
        buckets = _aggregate_classes(db, start_date, end_date).rows()
    elif list_type == "payment_method":
        buckets = _aggregate_payment_methods(db, start_date, end_date).rows()
    elif list_type == "currency":
        buckets = _aggregate_currencies(db, start_date, end_date).rows()
    elif list_type == "tag":
        buckets = _aggregate_tags(db, start_date, end_date).rows()
    else:
        raise ValueError(f"Tipo de lista no soportado: {list_type}")

    rows = []
    for b in buckets:
        row = {
            "item_id": b.item_id,
            "item_key": b.item_key,
            "item_name": b.item_name,
            "transaction_count": b.transaction_count,
            "total_amount_usd": _q2(b.total_amount_usd),
            "transactions": [],
        }
        if include_transactions:
            row["transactions"] = fetch_list_classification_row_transactions(
                db,
                start_date=start_date,
                end_date=end_date,
                list_type=list_type,
                item_id=b.item_id,
                item_key=b.item_key,
                item_name=b.item_name,
            )
        rows.append(row)

    grand_count = sum(r["transaction_count"] for r in rows)
    grand_total = _q2(sum((r["total_amount_usd"] for r in rows), Decimal("0")))

    return {
        "start_date": start_date,
        "end_date": end_date,
        "list_type": list_type,
        "list_type_label": LIST_TYPE_LABELS[list_type],
        "rows": rows,
        "grand_total_count": grand_count,
        "grand_total_amount_usd": grand_total,
    }


def _is_unassigned_row(item_id: Optional[int], item_key: Optional[str], item_name: Optional[str]) -> bool:
    if item_id is not None or item_key is not None:
        return False
    return (item_name or UNASSIGNED_LABEL).strip() == UNASSIGNED_LABEL


def _client_display_name(client: Optional[Client]) -> Optional[str]:
    if client is None:
        return None
    return client.display_name()


def _sale_reference(sale_id: int) -> str:
    return f"FAC-{int(sale_id):04d}"


def _serialize_sale_row(sale: Sale, client: Optional[Client]) -> dict:
    txn_date = sale.created_at.date() if sale.created_at else date.today()
    return {
        "id": sale.id,
        "type": "sale",
        "client_id": sale.client_id,
        "client_name": _client_display_name(client),
        "date": txn_date,
        "amount_usd": _q2(sale.amount),
        "reference": _sale_reference(sale.id),
    }


def _serialize_payment_row(payment: ClientPayment, client: Optional[Client]) -> dict:
    when = payment.approved_at or payment.created_at
    txn_date = when.date() if when is not None else date.today()
    rate = Decimal(str(payment.exchange_rate or 1))
    if rate <= 0:
        rate = Decimal("1")
    amount_usd = _q2(Decimal(str(payment.amount)) / rate)
    return {
        "id": payment.id,
        "type": "payment",
        "client_id": payment.client_id,
        "client_name": _client_display_name(client),
        "date": txn_date,
        "amount_usd": amount_usd,
        "reference": payment.payment_number or f"PAY-{payment.id}",
    }


def _serialize_debt_payment_row(payment: ClientDebtPayment, client: Optional[Client]) -> dict:
    when = payment.approved_at or payment.created_at
    txn_date = when.date() if when is not None else date.today()
    return {
        "id": payment.id,
        "type": "debt_payment",
        "client_id": payment.client_id,
        "client_name": _client_display_name(client),
        "date": txn_date,
        "amount_usd": _q2(payment.amount),
        "reference": f"ABN-{payment.id:04d}",
    }


def _serialize_expense_line_row(line: ExpenseLine, expense: Expense, client: Optional[Client]) -> dict:
    ref = (expense.reference_number or "").strip() or f"GAS-{expense.id:04d}"
    return {
        "id": expense.id,
        "type": "expense",
        "client_id": line.customer_id,
        "client_name": _client_display_name(client),
        "date": expense.payment_date,
        "amount_usd": _q2(line.amount),
        "reference": ref,
    }


def _sale_date_filters(start_date: date, end_date: date):
    return (
        func.date(Sale.created_at) >= start_date,
        func.date(Sale.created_at) <= end_date,
        Sale.status.in_(SALE_COUNTABLE_STATUSES),
    )


def _payment_date_filters(start_date: date, end_date: date):
    when = func.coalesce(ClientPayment.approved_at, ClientPayment.created_at)
    return (
        ClientPayment.status == ClientPaymentStatus.approved,
        when.isnot(None),
        func.date(when) >= start_date,
        func.date(when) <= end_date,
    )


def _debt_payment_date_filters(start_date: date, end_date: date):
    when = func.coalesce(ClientDebtPayment.approved_at, ClientDebtPayment.created_at)
    return (
        ClientDebtPayment.status == DebtPaymentStatus.approved,
        when.isnot(None),
        func.date(when) >= start_date,
        func.date(when) <= end_date,
    )


def fetch_list_classification_row_transactions(
    db: Session,
    *,
    start_date: date,
    end_date: date,
    list_type: ListType,
    item_id: Optional[int] = None,
    item_key: Optional[str] = None,
    item_name: Optional[str] = None,
) -> list[dict]:
    if start_date > end_date:
        raise ValueError("La fecha inicial no puede ser posterior a la final.")

    unassigned = _is_unassigned_row(item_id, item_key, item_name)
    out: list[dict] = []

    if list_type == "class":
        sale_q = (
            db.query(Sale, Client)
            .join(Client, Client.id == Sale.client_id)
            .filter(*_sale_date_filters(start_date, end_date))
        )
        if unassigned:
            sale_q = sale_q.filter(Sale.class_id.is_(None))
        else:
            sale_q = sale_q.filter(Sale.class_id == item_id)
        for sale, client in sale_q.all():
            out.append(_serialize_sale_row(sale, client))

        exp_q = (
            db.query(ExpenseLine, Expense, Client)
            .join(Expense, Expense.id == ExpenseLine.expense_id)
            .outerjoin(Client, Client.id == ExpenseLine.customer_id)
            .filter(
                Expense.payment_date >= start_date,
                Expense.payment_date <= end_date,
                Expense.status == "posted",
            )
        )
        if unassigned:
            exp_q = exp_q.filter(ExpenseLine.class_id.is_(None))
        else:
            exp_q = exp_q.filter(ExpenseLine.class_id == item_id)
        for line, expense, client in exp_q.all():
            out.append(_serialize_expense_line_row(line, expense, client))

    elif list_type == "payment_method":
        sale_q = (
            db.query(Sale, Client)
            .join(Client, Client.id == Sale.client_id)
            .filter(*_sale_date_filters(start_date, end_date))
        )
        if unassigned:
            sale_q = sale_q.filter(Sale.payment_method_id.is_(None))
        else:
            sale_q = sale_q.filter(Sale.payment_method_id == item_id)
        for sale, client in sale_q.all():
            out.append(_serialize_sale_row(sale, client))

        cp_q = (
            db.query(ClientPayment, Client)
            .join(Client, Client.id == ClientPayment.client_id)
            .filter(*_payment_date_filters(start_date, end_date))
        )
        if unassigned:
            cp_q = cp_q.filter(ClientPayment.payment_method_id.is_(None))
        else:
            cp_q = cp_q.filter(ClientPayment.payment_method_id == item_id)
        for payment, client in cp_q.all():
            out.append(_serialize_payment_row(payment, client))

        dp_q = (
            db.query(ClientDebtPayment, Client)
            .join(Client, Client.id == ClientDebtPayment.client_id)
            .filter(*_debt_payment_date_filters(start_date, end_date))
        )
        if unassigned:
            dp_q = dp_q.filter(ClientDebtPayment.payment_method_id.is_(None))
        else:
            dp_q = dp_q.filter(ClientDebtPayment.payment_method_id == item_id)
        for payment, client in dp_q.all():
            out.append(_serialize_debt_payment_row(payment, client))

    elif list_type == "currency":
        code = (item_key or item_name or "USD").strip().upper() or "USD"
        sale_q = (
            db.query(Sale, Client)
            .join(Client, Client.id == Sale.client_id)
            .filter(*_sale_date_filters(start_date, end_date))
            .filter(func.upper(Sale.currency) == code)
        )
        for sale, client in sale_q.all():
            out.append(_serialize_sale_row(sale, client))

        cp_q = (
            db.query(ClientPayment, Client)
            .join(Client, Client.id == ClientPayment.client_id)
            .filter(*_payment_date_filters(start_date, end_date))
            .filter(func.upper(ClientPayment.currency) == code)
        )
        for payment, client in cp_q.all():
            out.append(_serialize_payment_row(payment, client))

    elif list_type == "tag":
        if unassigned:
            sale_q = (
                db.query(Sale, Client)
                .join(Client, Client.id == Sale.client_id)
                .outerjoin(sale_tag_association, sale_tag_association.c.sale_id == Sale.id)
                .filter(
                    sale_tag_association.c.tag_id.is_(None),
                    *_sale_date_filters(start_date, end_date),
                )
            )
        else:
            sale_q = (
                db.query(Sale, Client)
                .join(Client, Client.id == Sale.client_id)
                .join(sale_tag_association, sale_tag_association.c.sale_id == Sale.id)
                .filter(
                    sale_tag_association.c.tag_id == item_id,
                    *_sale_date_filters(start_date, end_date),
                )
            )
        for sale, client in sale_q.all():
            out.append(_serialize_sale_row(sale, client))
    else:
        raise ValueError(f"Tipo de lista no soportado: {list_type}")

    out.sort(key=lambda r: (r["date"], r["reference"]), reverse=True)
    return out
