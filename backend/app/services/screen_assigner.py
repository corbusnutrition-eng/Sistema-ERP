"""
Servicio central de asignación de pantallas IPTV.

Utiliza SELECT ... FOR UPDATE SKIP LOCKED para eliminar condiciones de carrera
cuando múltiples compras ocurren en el mismo milisegundo. Solo un proceso puede
bloquear y asignar una pantalla a la vez; los demás saltan a la siguiente libre.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session, joinedload

from app.models.iptv_account import IPTVAccount
from app.models.iptv_screen import IPTVScreen


class NoScreenAvailableError(Exception):
    """Se lanza cuando no hay pantallas libres para el servicio solicitado."""


@dataclass(frozen=True)
class ScreenAssignment:
    screen_id: int
    screen_number: int
    account_username: str
    account_password: str
    provider_name: str
    panel_account_code: str


def assign_screen_to_sale(
    db: Session,
    client_id: int,
    service_type: str,
) -> ScreenAssignment:
    """
    Busca una pantalla IPTV libre para el proveedor dado y la asigna al cliente.

    El bloqueo with_for_update(skip_locked=True) garantiza que dos transacciones
    concurrentes nunca puedan asignar la misma pantalla: la primera la bloquea y
    la segunda la salta automáticamente, tomando la siguiente disponible.

    Args:
        db: Sesión activa de SQLAlchemy.
        client_id: ID entero del cliente que realiza la compra.
        service_type: Nombre del proveedor (ej. "Flujo" o "Stella").

    Returns:
        ScreenAssignment con las credenciales y datos de la pantalla asignada.

    Raises:
        NoScreenAvailableError: Si no existe ninguna pantalla libre para el servicio.
    """
    screen: Optional[IPTVScreen] = (
        db.query(IPTVScreen)
        .join(IPTVScreen.iptv_account)
        .filter(
            IPTVScreen.is_available.is_(True),
            IPTVAccount.provider_name == service_type,
        )
        .with_for_update(skip_locked=True)
        .options(joinedload(IPTVScreen.iptv_account))
        .first()
    )

    if screen is None:
        raise NoScreenAvailableError(
            f"No hay pantallas disponibles para el servicio '{service_type}'."
        )

    screen.is_available = False
    screen.client_id = client_id
    db.commit()
    db.refresh(screen)

    account: IPTVAccount = screen.iptv_account

    return ScreenAssignment(
        screen_id=screen.id,
        screen_number=screen.screen_number,
        account_username=account.username,
        account_password=account.password,
        provider_name=account.provider_name,
        panel_account_code=account.panel_account_code,
    )
