"""Reglas de borrado seguro de usuarios del equipo ERP."""

from __future__ import annotations

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models.client import Client
from app.models.client_note import ClientNote
from app.models.distributor_custom_price import DistributorCustomPrice
from app.models.expense import Expense
from app.models.user import User
from app.models.wallet_transaction import WalletTransaction

USER_DELETE_BLOCKED_MESSAGE = (
    "No se puede eliminar a este usuario porque tiene operaciones registradas en el sistema. "
    "Te recomendamos desactivarlo."
)


def user_has_registered_operations(db: Session, user_id: int) -> bool:
    """True si el usuario tiene vínculos financieros u operativos que impiden el borrado."""
    uid = int(user_id)

    if db.query(Expense.id).filter(Expense.payee_id == uid).first() is not None:
        return True

    if db.query(WalletTransaction.id).filter(WalletTransaction.user_id == uid).first() is not None:
        return True

    if db.query(Client.id).filter(Client.parent_distributor_id == uid).first() is not None:
        return True

    if db.query(ClientNote.id).filter(ClientNote.user_id == uid).first() is not None:
        return True

    if (
        db.query(DistributorCustomPrice.id)
        .filter(or_(DistributorCustomPrice.seller_id == uid, DistributorCustomPrice.buyer_id == uid))
        .first()
        is not None
    ):
        return True

    if db.query(User.id).filter(User.parent_id == uid).first() is not None:
        return True

    wallet_balance = db.query(func.coalesce(User.wallet_balance, 0)).filter(User.id == uid).scalar()
    try:
        if float(wallet_balance or 0) > 0.005:
            return True
    except (TypeError, ValueError):
        pass

    return False
