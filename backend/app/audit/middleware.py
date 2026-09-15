"""Middleware ASGI PURO (no BaseHTTPMiddleware) que abre el contexto de auditoría.

``BaseHTTPMiddleware`` ejecuta ``call_next`` en una tarea anyio distinta
(``task_group.start_soon()``); el ``ContextVar`` se copia en ese momento y
las escrituras posteriores no se propagan de forma fiable en ninguna
dirección (encode/starlette#420, #1258). Un middleware ASGI puro
(``async def __call__(self, scope, receive, send)``) corre en la MISMA
tarea/Context que el endpoint — ahí el `.set()` inicial sí es visible aguas
abajo, garantizado. Ver ``app.audit.context`` para el resto de la historia
(por qué todo lo posterior muta el objeto en vez de volver a hacer `.set()`).
"""

from __future__ import annotations

from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.audit.context import (
    ACTOR_ANONYMOUS,
    ACTOR_PORTAL_CLIENT,
    ACTOR_WEBHOOK,
    AuditContext,
    bind_audit_context,
    new_request_id,
    reset_audit_context,
)

_MAX_UA = 300


def _client_ip(scope: Scope, headers: Headers) -> str | None:
    """Misma semántica que ``app.rate_limit.get_client_ip``, a nivel ASGI."""
    fwd = headers.get("x-forwarded-for")
    if fwd:
        first = fwd.split(",")[0].strip()
        if first:
            return first[:45]
    real = headers.get("x-real-ip")
    if real:
        return real.strip()[:45]
    client = scope.get("client")
    return str(client[0])[:45] if client else None


class AuditContextMiddleware:
    """Corre en la MISMA tarea/Context que el endpoint → el ContextVar se propaga."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        request_id = (headers.get("x-request-id") or "").strip()[:64] or new_request_id()
        path = scope.get("path") or ""

        ctx = AuditContext(
            request_id=request_id,
            ip=_client_ip(scope, headers),
            user_agent=(headers.get("user-agent") or "")[:_MAX_UA] or None,
            method=scope.get("method"),
            path=path[:500],
        )
        # Red de seguridad: atribución por prefijo si un router olvida llamar
        # a set_actor() explícitamente (ver anclajes en dependencies.py,
        # portal.py, checkout.py, los webhooks...).
        if "/portal/" in path or "/checkout/" in path or "/pay/" in path:
            ctx.actor_type = ACTOR_PORTAL_CLIENT
        elif "/webhooks/" in path or "/external/" in path:
            ctx.actor_type = ACTOR_WEBHOOK
        else:
            ctx.actor_type = ACTOR_ANONYMOUS

        scope.setdefault("state", {})["audit_ctx"] = ctx  # → request.state.audit_ctx

        async def _send(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message).append("X-Request-ID", request_id)
            await send(message)

        token = bind_audit_context(ctx)
        try:
            await self.app(scope, receive, _send)
        finally:
            reset_audit_context(token)
