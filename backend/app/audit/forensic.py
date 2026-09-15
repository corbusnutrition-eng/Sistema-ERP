"""
Canal forense: eventos que NO deben desaparecer con un ``db.rollback()``.

La bitácora transaccional (``app.audit.listeners``) vive deliberadamente
dentro de la misma transacción que el negocio, así que un rollback la
descarta — es lo correcto para "se creó la venta 812" cuando la venta nunca
se persistió. Pero un intento de login fallido, un 403 por permisos, o un uso
del PIN maestro SON el hecho en sí mismo: deben registrarse aunque la
operación de negocio que los acompaña falle o se revierta.

Por eso este canal usa una sesión propia, de vida corta, independiente de
la transacción de negocio. Regla de uso: llamar SIEMPRE después de que el
router haya hecho su ``db.rollback()`` (si lo hizo), nunca mientras la
transacción de negocio mantiene locks abiertos (p. ej. dentro del bucle de
``SELECT ... FOR UPDATE`` de la cascada BaaS) — abrir una segunda conexión ahí
es exactamente el escenario de deadlock que este diseño evita en el canal
principal (ver R2 en el plan de seguridad).
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from app.audit.context import current_audit_context
from app.audit.serialization import to_jsonable
from app.database import SessionLocal
from app.models.audit_log import AuditLog
from app.timezone_utils import now_utc

logger = logging.getLogger("app.audit.forensic")


def record_forensic_event(
    action: str,
    *,
    entity_table: str = "-",
    entity_id: Optional[str] = None,
    detail: Optional[dict[str, Any]] = None,
) -> None:
    """
    Registra un hecho forense con su propia sesión/transacción corta.

    Nunca propaga excepciones: un fallo registrando el intento no debe volverse
    un segundo error encima del que ya está manejando el caller.
    """
    ctx = current_audit_context()
    session = SessionLocal()
    try:
        session.execute(
            AuditLog.__table__.insert(),
            [
                {
                    "timestamp": now_utc(),
                    "actor_type": (ctx.actor_type if ctx else "system"),
                    "actor_id": (ctx.actor_id if ctx else None),
                    "actor_label": (ctx.actor_label if ctx else None),
                    "ip": (ctx.ip if ctx else None),
                    "user_agent": (ctx.user_agent if ctx else None),
                    "request_id": (ctx.request_id if ctx else None),
                    "action": action,
                    "entity_table": entity_table,
                    "entity_id": entity_id,
                    "before": None,
                    "after": None,
                    "changed_fields": None,
                    "meta": to_jsonable(detail) if detail else None,
                }
            ],
        )
        session.commit()
    except Exception:
        logger.exception("Fallo registrando evento forense de auditoría: %s", action)
        session.rollback()
    finally:
        session.close()
