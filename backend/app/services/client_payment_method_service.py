from __future__ import annotations

from collections import defaultdict
from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.account_constants import is_liquid_deposit_account
from app.currency_utils import normalize_currency_code
from app.models.account import Account
from app.models.client import Client
from app.models.client_payment_method import ClientPaymentMethod
from app.models.client_payment_method_account import ClientPaymentMethodAccount
from app.models.payment_method import PaymentMethod
from app.schemas.client_payment_methods import (
    ClientPaymentMethodSelection,
    PaymentMethodAccountOption,
    PaymentMethodWithAccountsOption,
)
from app.schemas.portal_public import PortalAssignedPaymentMethod, PortalDepositPick, PortalPaymentMethodPick


def _payment_method_name_lower(pm: PaymentMethod) -> str:
    return (pm.name or "").strip().lower()


def _liquid_accounts_for_payment_method(db: Session, pm: PaymentMethod) -> list[Account]:
    """Cuentas de depósito (efectivo/banco) vinculadas al método de pago."""
    rows = db.query(Account).filter(Account.is_active.is_(True)).order_by(Account.name.asc()).all()
    by_id = {int(a.id): a for a in rows}
    ml = _payment_method_name_lower(pm)
    if not ml:
        return []

    out: list[Account] = []
    seen: set[int] = set()
    for acc in rows:
        if not is_liquid_deposit_account(acc):
            continue
        aid = int(acc.id)
        if aid in seen:
            continue
        lm = (acc.linked_payment_method or "").strip().lower()
        if lm and lm == ml:
            out.append(acc)
            seen.add(aid)
            continue
        if acc.linked_wallet_id is not None and int(acc.linked_wallet_id) == int(pm.id):
            out.append(acc)
            seen.add(aid)
            continue
        pid = acc.parent_id
        if pid is not None:
            parent = by_id.get(int(pid))
            if parent is not None:
                plm = (parent.linked_payment_method or "").strip().lower()
                if plm and plm == ml:
                    out.append(acc)
                    seen.add(aid)
    return out


def _account_belongs_to_payment_method(db: Session, pm: PaymentMethod, account_id: int) -> bool:
    aid = int(account_id)
    return any(int(a.id) == aid for a in _liquid_accounts_for_payment_method(db, pm))


def payment_method_supports_currency(db: Session, pm: PaymentMethod, currency: str) -> bool:
    cur = normalize_currency_code(currency, "USD")
    for acc in _liquid_accounts_for_payment_method(db, pm):
        if normalize_currency_code(str(acc.currency or "USD"), "USD") == cur:
            return True
    return False


def _short_public_account_note(text: Optional[object], max_len: int = 220) -> Optional[str]:
    if text is None:
        return None
    s = str(text).strip()
    if not s:
        return None
    return s[:max_len]


def _account_to_option(acc: Account) -> PaymentMethodAccountOption:
    return PaymentMethodAccountOption(
        id=int(acc.id),
        name=(acc.name or "").strip() or f"Cuenta {acc.id}",
        account_number=(acc.account_number or "").strip() or None,
        currency=normalize_currency_code(str(acc.currency or "USD"), "USD"),
    )


def _account_to_portal_pick(acc: Account, *, currency: Optional[str] = None) -> PortalDepositPick:
    cur = normalize_currency_code(currency or str(acc.currency or "USD"), "USD")
    return PortalDepositPick(
        id=int(acc.id),
        bank_name=(acc.name or "").strip() or f"Cuenta {acc.id}",
        account_number=(acc.account_number or "").strip() or None,
        currency=cur,
        holder_note=_short_public_account_note(getattr(acc, "description", None)),
    )


def list_payment_methods_with_accounts_for_currency(
    db: Session,
    currency: str,
    *,
    active_only: bool = True,
) -> list[PaymentMethodWithAccountsOption]:
    cur = normalize_currency_code(currency, "USD")
    q = db.query(PaymentMethod).order_by(PaymentMethod.name.asc())
    if active_only:
        q = q.filter(PaymentMethod.is_active.is_(True))
    out: list[PaymentMethodWithAccountsOption] = []
    for pm in q.all():
        accounts = [
            _account_to_option(acc)
            for acc in _liquid_accounts_for_payment_method(db, pm)
            if normalize_currency_code(str(acc.currency or "USD"), "USD") == cur
        ]
        if not accounts:
            continue
        out.append(
            PaymentMethodWithAccountsOption(
                id=int(pm.id),
                name=(pm.name or "").strip() or f"Método #{pm.id}",
                currency=cur,
                is_active=bool(pm.is_active),
                accounts=accounts,
            )
        )
    return out


def _client_has_granular_account_assignments(db: Session, client_id: int) -> bool:
    return (
        db.query(ClientPaymentMethodAccount.id)
        .filter(ClientPaymentMethodAccount.client_id == int(client_id))
        .limit(1)
        .first()
        is not None
    )


def get_client_assigned_selections(db: Session, client_id: int) -> list[ClientPaymentMethodSelection]:
    rows = (
        db.query(
            ClientPaymentMethodAccount.payment_method_id,
            ClientPaymentMethodAccount.account_id,
        )
        .filter(ClientPaymentMethodAccount.client_id == int(client_id))
        .order_by(
            ClientPaymentMethodAccount.payment_method_id.asc(),
            ClientPaymentMethodAccount.account_id.asc(),
        )
        .all()
    )
    if rows:
        grouped: dict[int, list[int]] = defaultdict(list)
        for pm_id, acc_id in rows:
            grouped[int(pm_id)].append(int(acc_id))
        return [
            ClientPaymentMethodSelection(payment_method_id=pid, account_ids=acc_ids)
            for pid, acc_ids in sorted(grouped.items())
        ]

    legacy_pm_ids = get_client_assigned_payment_method_ids(db, int(client_id))
    if not legacy_pm_ids:
        return []
    from app.services.client_currency_service import get_client_currency

    client = db.get(Client, int(client_id))
    cur = get_client_currency(client) if client is not None else "USD"
    out: list[ClientPaymentMethodSelection] = []
    for pid in legacy_pm_ids:
        pm = db.get(PaymentMethod, int(pid))
        if pm is None or not pm.is_active:
            continue
        acc_ids = [
            int(acc.id)
            for acc in _liquid_accounts_for_payment_method(db, pm)
            if normalize_currency_code(str(acc.currency or "USD"), "USD") == cur
        ]
        if acc_ids:
            out.append(ClientPaymentMethodSelection(payment_method_id=int(pid), account_ids=acc_ids))
    return out


def get_client_assigned_payment_method_ids(db: Session, client_id: int) -> list[int]:
    granular = (
        db.query(ClientPaymentMethodAccount.payment_method_id)
        .filter(ClientPaymentMethodAccount.client_id == int(client_id))
        .distinct()
        .order_by(ClientPaymentMethodAccount.payment_method_id.asc())
        .all()
    )
    if granular:
        return [int(r[0]) for r in granular]

    rows = (
        db.query(ClientPaymentMethod.payment_method_id)
        .filter(ClientPaymentMethod.client_id == int(client_id))
        .order_by(ClientPaymentMethod.payment_method_id.asc())
        .all()
    )
    return [int(r[0]) for r in rows]


def get_client_assigned_account_ids(
    db: Session,
    client_id: int,
    *,
    payment_method_id: Optional[int] = None,
    currency: Optional[str] = None,
) -> list[int]:
    q = db.query(ClientPaymentMethodAccount.account_id).filter(
        ClientPaymentMethodAccount.client_id == int(client_id)
    )
    if payment_method_id is not None:
        q = q.filter(ClientPaymentMethodAccount.payment_method_id == int(payment_method_id))
    rows = q.order_by(ClientPaymentMethodAccount.account_id.asc()).all()
    if rows:
        ids = [int(r[0]) for r in rows]
        if currency is None:
            return ids
        cur = normalize_currency_code(currency, "USD")
        out: list[int] = []
        for aid in ids:
            acc = db.get(Account, aid)
            if acc is None or not acc.is_active or not is_liquid_deposit_account(acc):
                continue
            if normalize_currency_code(str(acc.currency or "USD"), "USD") == cur:
                out.append(aid)
        return out

    selections = get_client_assigned_selections(db, int(client_id))
    if not selections:
        return []
    ids_out: list[int] = []
    seen: set[int] = set()
    for sel in selections:
        if payment_method_id is not None and int(sel.payment_method_id) != int(payment_method_id):
            continue
        for aid in sel.account_ids:
            if aid in seen:
                continue
            if currency is not None:
                acc = db.get(Account, aid)
                if acc is None:
                    continue
                if normalize_currency_code(str(acc.currency or "USD"), "USD") != normalize_currency_code(
                    currency, "USD"
                ):
                    continue
            seen.add(aid)
            ids_out.append(aid)
    return ids_out


def get_client_assigned_payment_methods_with_accounts(
    db: Session,
    client_id: int,
    *,
    currency: str,
) -> list[PortalAssignedPaymentMethod]:
    cur = normalize_currency_code(currency, "USD")
    selections = get_client_assigned_selections(db, int(client_id))
    if not selections:
        return []

    out: list[PortalAssignedPaymentMethod] = []
    for sel in selections:
        pm = db.get(PaymentMethod, int(sel.payment_method_id))
        if pm is None or not pm.is_active:
            continue
        deposit_accounts: list[PortalDepositPick] = []
        for aid in sel.account_ids:
            acc = db.get(Account, int(aid))
            if acc is None or not acc.is_active or not is_liquid_deposit_account(acc):
                continue
            if normalize_currency_code(str(acc.currency or "USD"), "USD") != cur:
                continue
            if not _account_belongs_to_payment_method(db, pm, int(aid)):
                continue
            deposit_accounts.append(_account_to_portal_pick(acc, currency=cur))
        if not deposit_accounts:
            continue
        out.append(
            PortalAssignedPaymentMethod(
                id=int(pm.id),
                name=(pm.name or "").strip() or f"Método #{pm.id}",
                deposit_accounts=deposit_accounts,
            )
        )
    return out


def get_client_assigned_payment_method_picks(db: Session, client_id: int) -> list[PortalPaymentMethodPick]:
    nested = get_client_assigned_payment_methods_with_accounts(
        db,
        int(client_id),
        currency="USD",
    )
    if nested:
        return [PortalPaymentMethodPick(id=m.id, name=m.name) for m in nested if m.deposit_accounts]

    ids = get_client_assigned_payment_method_ids(db, client_id)
    if not ids:
        return []
    rows = (
        db.query(PaymentMethod)
        .filter(PaymentMethod.id.in_(ids), PaymentMethod.is_active.is_(True))
        .order_by(PaymentMethod.name.asc())
        .all()
    )
    by_id = {int(r.id): r for r in rows}
    out: list[PortalPaymentMethodPick] = []
    for pid in ids:
        pm = by_id.get(int(pid))
        if pm is None:
            continue
        out.append(
            PortalPaymentMethodPick(
                id=int(pm.id),
                name=(pm.name or "").strip() or f"Método #{pm.id}",
            )
        )
    return out


def build_client_assigned_deposit_picks(
    db: Session,
    client_id: int,
    *,
    currency: str,
    payment_method_id: Optional[int] = None,
) -> list[PortalDepositPick]:
    cur = normalize_currency_code(currency, "USD")
    nested = get_client_assigned_payment_methods_with_accounts(db, int(client_id), currency=cur)
    if nested:
        out: list[PortalDepositPick] = []
        seen: set[int] = set()
        for method in nested:
            if payment_method_id is not None and int(method.id) != int(payment_method_id):
                continue
            for dep in method.deposit_accounts:
                if int(dep.id) in seen:
                    continue
                seen.add(int(dep.id))
                out.append(dep)
        return out

    pm_ids = get_client_assigned_payment_method_ids(db, client_id)
    if not pm_ids:
        return []

    account_ids: list[int] = []
    seen_acc: set[int] = set()
    for pid in pm_ids:
        if payment_method_id is not None and int(pid) != int(payment_method_id):
            continue
        pm = db.get(PaymentMethod, int(pid))
        if pm is None or not pm.is_active:
            continue
        for acc in _liquid_accounts_for_payment_method(db, pm):
            if normalize_currency_code(str(acc.currency or "USD"), "USD") != cur:
                continue
            aid = int(acc.id)
            if aid in seen_acc:
                continue
            seen_acc.add(aid)
            account_ids.append(aid)

    out_legacy: list[PortalDepositPick] = []
    for aid in account_ids:
        a = db.get(Account, aid)
        if a is None or not a.is_active or not is_liquid_deposit_account(a):
            continue
        out_legacy.append(_account_to_portal_pick(a, currency=cur))
    return out_legacy


def _payment_method_ids_for_account(db: Session, account_id: int) -> list[int]:
    """Métodos de pago activos a los que pertenece una cuenta de depósito."""
    aid = int(account_id)
    rows = (
        db.query(PaymentMethod)
        .filter(PaymentMethod.is_active.is_(True))
        .order_by(PaymentMethod.id.asc())
        .all()
    )
    return [int(pm.id) for pm in rows if _account_belongs_to_payment_method(db, pm, aid)]


def account_ids_to_payment_method_selections(
    db: Session,
    client_id: int,
    account_ids: list[int],
) -> list[ClientPaymentMethodSelection]:
    """Convierte IDs planos de cuentas en selecciones agrupadas por método padre."""
    from app.services.client_currency_service import get_client_currency

    client = db.get(Client, int(client_id))
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")
    cur = get_client_currency(client)
    unique_ids = sorted({int(x) for x in account_ids if int(x) > 0})
    if not unique_ids:
        return []

    grouped: dict[int, set[int]] = defaultdict(set)
    for aid in unique_ids:
        acc = db.get(Account, aid)
        if acc is None or not acc.is_active or not is_liquid_deposit_account(acc):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cuenta de depósito #{aid} no encontrada o inactiva.",
            )
        if normalize_currency_code(str(acc.currency or "USD"), "USD") != cur:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"La cuenta «{(acc.name or '').strip()}» no opera en {cur}.",
            )
        pm_ids = _payment_method_ids_for_account(db, aid)
        if not pm_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"La cuenta «{(acc.name or '').strip()}» no está vinculada a ningún método de pago.",
            )
        grouped[int(pm_ids[0])].add(aid)

    return [
        ClientPaymentMethodSelection(payment_method_id=int(pid), account_ids=sorted(grouped[pid]))
        for pid in sorted(grouped)
    ]


def set_client_payment_accounts_from_ids(
    db: Session,
    *,
    client_id: int,
    account_ids: list[int],
) -> int:
    """Reemplaza preferencias del cliente a partir de un array plano de account_ids."""
    selections = account_ids_to_payment_method_selections(db, int(client_id), account_ids)
    return set_client_payment_methods(db, client_id=int(client_id), selections=selections)


def client_has_custom_payment_account_prefs(db: Session, client_id: int) -> bool:
    """True si el admin guardó cuentas granulares en CRM (client_payment_method_accounts)."""
    return _client_has_granular_account_assignments(db, int(client_id))


def get_client_payment_accounts_config(db: Session, client_id: int) -> dict[str, object]:
    from app.services.client_currency_service import get_client_currency

    client = db.get(Client, int(client_id))
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")
    cur = get_client_currency(client)
    account_ids = get_client_assigned_account_ids(db, int(client_id), currency=cur)
    return {
        "client_id": int(client_id),
        "client_currency": cur,
        "account_ids": account_ids,
        "has_custom_payment_accounts": client_has_custom_payment_account_prefs(db, int(client_id)),
    }


def get_client_payment_methods_config(db: Session, client_id: int) -> dict[str, object]:
    from app.services.client_currency_service import get_client_currency

    client = db.get(Client, int(client_id))
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")
    cur = get_client_currency(client)
    assigned_selections = get_client_assigned_selections(db, int(client_id))
    available = list_payment_methods_with_accounts_for_currency(db, cur)
    assigned_pm_ids = sorted({int(s.payment_method_id) for s in assigned_selections if s.account_ids})
    assigned_account_ids = get_client_assigned_account_ids(db, int(client_id), currency=cur)
    return {
        "client_id": int(client_id),
        "client_currency": cur,
        "assigned_selections": assigned_selections,
        "available_payment_methods": available,
        "assigned_payment_method_ids": assigned_pm_ids,
        "assigned_account_ids": assigned_account_ids,
        "has_custom_payment_accounts": client_has_custom_payment_account_prefs(db, int(client_id)),
    }


def set_client_payment_methods(
    db: Session,
    *,
    client_id: int,
    selections: list[ClientPaymentMethodSelection],
) -> int:
    from app.services.client_currency_service import get_client_currency

    client = db.get(Client, int(client_id))
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")

    cur = get_client_currency(client)
    normalized: list[tuple[int, int]] = []
    seen_pairs: set[tuple[int, int]] = set()
    method_ids_with_accounts: set[int] = set()

    for raw in selections:
        pid = int(raw.payment_method_id)
        if pid < 1:
            continue
        pm = db.get(PaymentMethod, pid)
        if pm is None or not pm.is_active:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Método de pago #{pid} no encontrado o inactivo.",
            )
        if not payment_method_supports_currency(db, pm, cur):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"El método «{(pm.name or '').strip()}» no tiene cuentas de depósito en {cur}."
                ),
            )

        unique_acc = sorted({int(x) for x in raw.account_ids if int(x) > 0})
        if not unique_acc:
            continue

        for aid in unique_acc:
            acc = db.get(Account, aid)
            if acc is None or not acc.is_active or not is_liquid_deposit_account(acc):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Cuenta de depósito #{aid} no encontrada o inactiva.",
                )
            if normalize_currency_code(str(acc.currency or "USD"), "USD") != cur:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"La cuenta «{(acc.name or '').strip()}» no opera en {cur}.",
                )
            if not _account_belongs_to_payment_method(db, pm, aid):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"La cuenta «{(acc.name or '').strip()}» no pertenece al método "
                        f"«{(pm.name or '').strip()}»."
                    ),
                )
            pair = (pid, aid)
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            normalized.append(pair)
            method_ids_with_accounts.add(pid)

    db.query(ClientPaymentMethodAccount).filter(ClientPaymentMethodAccount.client_id == int(client_id)).delete(
        synchronize_session=False
    )
    db.query(ClientPaymentMethod).filter(ClientPaymentMethod.client_id == int(client_id)).delete(
        synchronize_session=False
    )

    for pid, aid in normalized:
        db.add(
            ClientPaymentMethodAccount(
                client_id=int(client_id),
                payment_method_id=int(pid),
                account_id=int(aid),
            )
        )
    for pid in sorted(method_ids_with_accounts):
        db.add(
            ClientPaymentMethod(
                client_id=int(client_id),
                payment_method_id=int(pid),
            )
        )
    return len(normalized)


def validate_client_portal_deposit_account_id(
    db: Session,
    client: Client,
    deposit_account_id: Optional[int],
    *,
    currency: str,
    payment_method_id: Optional[int] = None,
) -> None:
    assigned_pm = get_client_assigned_payment_method_ids(db, int(client.id))
    if not assigned_pm:
        return
    if deposit_account_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Indica la cuenta donde realizaste el depósito.",
        )
    allowed_ids = set(
        get_client_assigned_account_ids(
            db,
            int(client.id),
            payment_method_id=payment_method_id,
            currency=currency,
        )
    )
    if allowed_ids and int(deposit_account_id) not in allowed_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cuenta de depósito seleccionada no está habilitada para tu cuenta.",
        )


def validate_client_portal_payment_method_id(
    db: Session,
    client: Client,
    payment_method_id: Optional[int],
) -> None:
    """Si el cliente tiene métodos asignados en CRM, el portal solo puede usar esos."""
    assigned = get_client_assigned_payment_method_ids(db, int(client.id))
    if not assigned:
        return
    if payment_method_id is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Indica el método de pago que utilizaste.",
        )
    pid = int(payment_method_id)
    if pid not in set(assigned):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El método de pago seleccionado no está habilitado para tu cuenta.",
        )
    pm = db.get(PaymentMethod, pid)
    if pm is None or not pm.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Método de pago inválido o inactivo.",
        )
    if _client_has_granular_account_assignments(db, int(client.id)):
        acc_ids = get_client_assigned_account_ids(db, int(client.id), payment_method_id=pid)
        if not acc_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Este método de pago no tiene cuentas habilitadas para tu cuenta.",
            )
