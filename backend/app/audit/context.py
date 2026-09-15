"""Contexto de auditoría por petición: actor, IP, request_id.

Los listeners de SQLAlchemy (``app.audit.listeners``) no reciben ``Request``
ni pueden usar ``Depends`` — la única vía para saber "quién" está haciendo el
cambio es un ``contextvars.ContextVar`` poblado por el middleware ASGI.

⚠️ INVARIANTE CRÍTICO: el ContextVar se asigna con ``.set()`` UNA SOLA VEZ,
en ``AuditContextMiddleware`` (ver ``app.audit.middleware``). Todo lo demás
MUTA el objeto ``AuditContext`` in-place (``set_actor`` / ``add_meta``).

Motivo: FastAPI ejecuta las dependencias y los endpoints ``def`` síncronos
(la mayoría de este proyecto, incluyendo ``get_current_user``) en el
threadpool de anyio. ``anyio.to_thread.run_sync`` copia el ``Context`` con
``contextvars.copy_context()`` antes de correr la función en el hilo worker:
leer el ContextVar allí funciona (la copia incluye el valor), pero un
``.set()`` hecho en esa copia NO se propaga de vuelta a la tarea async
original. Mutar el objeto SÍ es visible en todas partes, porque la copia de
contexto copia la referencia al objeto, no el objeto en sí.
"""

from __future__ import annotations

import contextlib
import uuid
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any, Iterator, Optional

ACTOR_STAFF = "staff"
ACTOR_PORTAL_CLIENT = "portal_client"
ACTOR_WEBHOOK = "webhook"
ACTOR_SYSTEM = "system"
ACTOR_SCRIPT = "script"
ACTOR_ANONYMOUS = "anonymous"


@dataclass
class AuditContext:
    request_id: str
    actor_type: str = ACTOR_ANONYMOUS
    actor_id: Optional[int] = None
    actor_label: Optional[str] = None
    ip: Optional[str] = None
    user_agent: Optional[str] = None
    method: Optional[str] = None
    path: Optional[str] = None
    meta: dict[str, Any] = field(default_factory=dict)


_AUDIT_CTX: ContextVar[Optional[AuditContext]] = ContextVar("erp_audit_ctx", default=None)


def new_request_id() -> str:
    return uuid.uuid4().hex


def bind_audit_context(ctx: AuditContext) -> Token:
    return _AUDIT_CTX.set(ctx)


def reset_audit_context(token: Token) -> None:
    _AUDIT_CTX.reset(token)


def current_audit_context() -> Optional[AuditContext]:
    return _AUDIT_CTX.get()


def set_actor(*, actor_type: str, actor_id: Any = None, actor_label: Any = None, **meta: Any) -> None:
    """Muta el contexto compartido. Seguro desde el threadpool (no hace `.set()`)."""
    ctx = _AUDIT_CTX.get()
    if ctx is None:
        return
    ctx.actor_type = str(actor_type)
    try:
        ctx.actor_id = int(actor_id) if actor_id is not None else None
    except (TypeError, ValueError):
        ctx.actor_id = None
    if actor_label:
        ctx.actor_label = str(actor_label)[:200]
    if meta:
        ctx.meta.update({k: v for k, v in meta.items() if v is not None})


def add_meta(**meta: Any) -> None:
    ctx = _AUDIT_CTX.get()
    if ctx is not None:
        ctx.meta.update(meta)


@contextlib.contextmanager
def audit_actor_scope(
    *, actor_type: str, actor_label: Optional[str] = None, actor_id: Optional[int] = None, **meta: Any
) -> Iterator[AuditContext]:
    """
    Para scripts, cron y workers sin petición HTTP (``scripts/*.py``, el
    scheduler de tasas de cambio, tareas en segundo plano lanzadas fuera de
    una request). Abre y cierra su propio contexto de auditoría.
    """
    ctx = AuditContext(
        request_id=new_request_id(),
        actor_type=actor_type,
        actor_id=actor_id,
        actor_label=actor_label,
        meta=dict(meta),
    )
    token = _AUDIT_CTX.set(ctx)
    try:
        yield ctx
    finally:
        _AUDIT_CTX.reset(token)
