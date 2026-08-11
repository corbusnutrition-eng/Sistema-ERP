#!/usr/bin/env python3
"""
Reporte gerencial matutino → grupo principal de Telegram.

Recopila CxC firme (misma lógica que /contabilidad/cuentas-por-cobrar) y depósitos
pendientes de verificación bancaria por cajero (Verificador de Cuentas).

Uso (desde ``backend/``):

    PYTHONPATH=. python scripts/daily_telegram_report.py
    PYTHONPATH=. python scripts/daily_telegram_report.py --dry-run

Cron (9:00 AM Ecuador = 14:00 UTC):

    0 14 * * * cd /ruta/backend && PYTHONPATH=. /ruta/venv/bin/python scripts/daily_telegram_report.py
"""

from __future__ import annotations

import argparse
import os
import sys
from decimal import Decimal
from pathlib import Path

import requests
from dotenv import load_dotenv
from sqlalchemy import or_
from sqlalchemy.orm import Session

_backend_dir = Path(__file__).resolve().parent.parent
_repo_root = _backend_dir.parent
load_dotenv(_repo_root / ".env")
load_dotenv(_backend_dir / ".env")

from app.account_constants import is_liquid_deposit_account  # noqa: E402
from app.account_verifier_access import ROLE_TEMPLATE_ACCOUNT_VERIFIER  # noqa: E402
from app.currency_utils import normalize_currency_code  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models.account import Account  # noqa: E402
from app.models.client import Client  # noqa: E402
from app.models.journal_entry import JournalEntryLine  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.client_payment_service import list_client_ar_firm_obligations_for_report  # noqa: E402
from app.services.telegram_service import TELEGRAM_API_BASE  # noqa: E402
from app.timezone_utils import now_ecuador  # noqa: E402

_FP_EPS = Decimal("0.005")
_RESOLVED_VERIFICATION = frozenset({"confirmed", "not_found", "wrong_account"})

_CURRENCY_PREFIX = {
    "USD": "$",
    "PEN": "S/",
    "BOB": "Bs",
    "COP": "$",
    "EUR": "€",
}


def _q2(v: Decimal) -> Decimal:
    return Decimal(str(v)).quantize(Decimal("0.01"))


def _format_money(amount: Decimal, currency: str) -> str:
    cur = normalize_currency_code(currency or "USD")
    prefix = _CURRENCY_PREFIX.get(cur, cur)
    value = _q2(amount)
    formatted = f"{value:,.2f}"
    if cur in _CURRENCY_PREFIX:
        return f"{prefix} {formatted}"
    return f"{formatted} {cur}"


def _escape_telegram_markdown(text: str) -> str:
    """Escapa caracteres reservados del Markdown legacy de Telegram."""
    out = str(text or "")
    for ch in ("_", "*", "`", "["):
        out = out.replace(ch, f"\\{ch}")
    return out


def collect_firm_ar_by_currency(db: Session) -> dict[str, Decimal]:
    """
    Totales CxC firmes por moneda (cartera admin: clientes con ``parent_id`` nulo).
    """
    due_by_currency: dict[str, Decimal] = {}
    client_ids = [
        int(row[0])
        for row in db.query(Client.id).filter(Client.parent_id.is_(None)).all()
    ]
    for cid in client_ids:
        for inv in list_client_ar_firm_obligations_for_report(db, cid):
            cur = normalize_currency_code(str(inv.get("currency") or "USD"))
            open_b = _q2(Decimal(str(inv.get("open_balance") or 0)))
            if open_b <= _FP_EPS:
                continue
            due_by_currency[cur] = due_by_currency.get(cur, Decimal("0")) + open_b
    return {cur: _q2(amt) for cur, amt in sorted(due_by_currency.items())}


def _line_is_pending_verification(line: JournalEntryLine) -> bool:
    raw = getattr(line, "verification_status", None)
    if raw is None:
        return True
    status = str(raw).strip().lower()
    if not status:
        return True
    if status in _RESOLVED_VERIFICATION:
        return False
    return status == "interbank"


def collect_verifier_pending_deposits(db: Session) -> list[dict]:
    """
    Depósitos bancarios sin cerrar por verificador activo.

    Pendiente = sin estado o ``interbank`` (excluye Confirmado, No efectiva, Cuenta incorrecta).
    """
    verifiers = (
        db.query(User)
        .filter(
            User.is_active.is_(True),
            User.role_template == ROLE_TEMPLATE_ACCOUNT_VERIFIER,
        )
        .order_by(User.name.asc(), User.id.asc())
        .all()
    )

    rows: list[dict] = []
    for verifier in verifiers:
        accounts = (
            db.query(Account)
            .filter(
                Account.verifier_id == int(verifier.id),
                Account.is_active.is_(True),
            )
            .order_by(Account.id.asc())
            .all()
        )
        bank_account_ids = [
            int(acc.id) for acc in accounts if is_liquid_deposit_account(acc)
        ]

        if not bank_account_ids:
            rows.append(
                {
                    "verifier_id": int(verifier.id),
                    "verifier_name": str(verifier.name or "").strip() or f"Usuario #{verifier.id}",
                    "deposit_count": 0,
                    "totals_by_currency": {},
                }
            )
            continue

        pending_lines = (
            db.query(JournalEntryLine, Account)
            .join(Account, JournalEntryLine.account_id == Account.id)
            .filter(
                Account.id.in_(bank_account_ids),
                JournalEntryLine.debit > 0,
                or_(
                    JournalEntryLine.verification_status.is_(None),
                    JournalEntryLine.verification_status == "",
                    JournalEntryLine.verification_status == "interbank",
                ),
            )
            .all()
        )

        totals_by_currency: dict[str, Decimal] = {}
        count = 0
        for line, account in pending_lines:
            if not _line_is_pending_verification(line):
                continue
            dep = _q2(Decimal(str(line.debit or 0)))
            if dep <= _FP_EPS:
                continue
            cur = normalize_currency_code(str(getattr(account, "currency", None) or "USD"))
            totals_by_currency[cur] = totals_by_currency.get(cur, Decimal("0")) + dep
            count += 1

        rows.append(
            {
                "verifier_id": int(verifier.id),
                "verifier_name": str(verifier.name or "").strip() or f"Usuario #{verifier.id}",
                "deposit_count": count,
                "totals_by_currency": {k: _q2(v) for k, v in sorted(totals_by_currency.items())},
            }
        )

    return rows


def _format_verifier_totals(totals_by_currency: dict[str, Decimal]) -> str:
    if not totals_by_currency:
        return ""
    parts = [_format_money(amt, cur) for cur, amt in totals_by_currency.items()]
    return " + ".join(parts)


def build_daily_report_message(
    *,
    ar_by_currency: dict[str, Decimal],
    verifier_rows: list[dict],
    report_date: str,
) -> str:
    lines: list[str] = [
        "📊 *REPORTE MATUTINO ERP* ☀️",
        f"📅 {report_date}",
        "",
        "📉 *Cuentas por Cobrar (Deuda Firme):*",
    ]

    if ar_by_currency:
        for cur, amt in ar_by_currency.items():
            money = _escape_telegram_markdown(_format_money(amt, cur))
            lines.append(f"• {cur}: {money}")
    else:
        lines.append("• Sin deuda firme pendiente ✅")

    lines.extend(["", "🏦 *Pendiente de Verificación por Cajero:*"])

    if not verifier_rows:
        lines.append("• No hay verificadores activos configurados.")
    else:
        for row in verifier_rows:
            name = _escape_telegram_markdown(str(row.get("verifier_name") or "—"))
            count = int(row.get("deposit_count") or 0)
            totals = row.get("totals_by_currency") or {}
            if count <= 0:
                lines.append(f"👤 {name}: ¡Todo al día! ✅")
                continue
            total_label = _escape_telegram_markdown(_format_verifier_totals(totals))
            dep_word = "depósito" if count == 1 else "depósitos"
            lines.append(f"👤 {name}: {count} {dep_word} (Total: {total_label})")

    return "\n".join(lines)


def send_telegram_markdown(message: str) -> bool:
    token = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
    chat_id = (os.getenv("TELEGRAM_CHAT_ID") or "").strip()
    text = str(message or "").strip()
    if not token or not chat_id:
        print("ERROR: TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados.", file=sys.stderr)
        return False
    if not text:
        print("ERROR: mensaje vacío.", file=sys.stderr)
        return False

    url = f"{TELEGRAM_API_BASE}/bot{token}/sendMessage"
    try:
        response = requests.post(
            url,
            json={
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "Markdown",
            },
            timeout=15,
        )
    except requests.RequestException as exc:
        print(f"ERROR: fallo de red Telegram: {exc}", file=sys.stderr)
        return False

    if response.status_code >= 400:
        fallback = requests.post(
            url,
            json={"chat_id": chat_id, "text": text},
            timeout=15,
        )
        if fallback.status_code >= 400:
            print(
                f"ERROR: Telegram respondió {response.status_code}: {(response.text or '')[:400]}",
                file=sys.stderr,
            )
            return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Envía reporte matutino ERP a Telegram.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Imprime el mensaje en consola sin enviarlo.",
    )
    args = parser.parse_args()

    report_date = now_ecuador().strftime("%d/%m/%Y")
    db = SessionLocal()
    try:
        ar_by_currency = collect_firm_ar_by_currency(db)
        verifier_rows = collect_verifier_pending_deposits(db)
    finally:
        db.close()

    message = build_daily_report_message(
        ar_by_currency=ar_by_currency,
        verifier_rows=verifier_rows,
        report_date=report_date,
    )

    if args.dry_run:
        print(message)
        return 0

    ok = send_telegram_markdown(message)
    if not ok:
        return 1
    print("Reporte matutino enviado a Telegram.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
