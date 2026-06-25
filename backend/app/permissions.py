"""Catálogo de permisos granulares (RBAC) del ERP."""

from __future__ import annotations

from typing import Any, Optional

# ── Permisos BaaS / Distribuidores ───────────────────────────────────────────

BAAS_VIEW_USERS_TAB = "baas:view_users_tab"
BAAS_VIEW_REQUESTS_TAB = "baas:view_requests_tab"
BAAS_VIEW_NOTIFICATIONS_TAB = "baas:view_notifications_tab"
BAAS_CREATE_RECHARGE = "baas:create_recharge"

ALL_PERMISSIONS: frozenset[str] = frozenset(
    {
        BAAS_VIEW_USERS_TAB,
        BAAS_VIEW_REQUESTS_TAB,
        BAAS_VIEW_NOTIFICATIONS_TAB,
        BAAS_CREATE_RECHARGE,
    }
)

PERMISSION_GROUPS: list[dict[str, Any]] = [
    {
        "module": "baas",
        "label": "Billeteras BaaS / Distribuidores",
        "permissions": [
            {
                "key": BAAS_VIEW_USERS_TAB,
                "label": "Ver pestaña Usuarios y billetera",
                "description": "Acceso al árbol de clientes/distribuidores y saldos virtuales.",
            },
            {
                "key": BAAS_VIEW_REQUESTS_TAB,
                "label": "Ver pestaña Solicitudes de recarga",
                "description": "Listado, métricas, sincronización y revisión de solicitudes.",
            },
            {
                "key": BAAS_VIEW_NOTIFICATIONS_TAB,
                "label": "Ver pestaña Gestión de Notificaciones",
                "description": "Envío y administración de notificaciones a clientes BaaS.",
            },
            {
                "key": BAAS_CREATE_RECHARGE,
                "label": "Crear solicitud de recarga",
                "description": "Botón «Nueva solicitud de recarga» y generación de enlaces.",
            },
        ],
    },
]

_BAAS_ANY = frozenset(
    {
        BAAS_VIEW_USERS_TAB,
        BAAS_VIEW_REQUESTS_TAB,
        BAAS_VIEW_NOTIFICATIONS_TAB,
        BAAS_CREATE_RECHARGE,
    }
)


def normalize_permissions(raw: Optional[Any]) -> list[str]:
    """Filtra y deduplica permisos válidos desde JSON/lista."""
    if raw is None:
        return []
    items: list[Any]
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, str):
        items = [p.strip() for p in raw.split(",") if p.strip()]
    else:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = str(item or "").strip()
        if not key or key not in ALL_PERMISSIONS or key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def effective_permissions(*, role: str, permissions: Optional[Any]) -> list[str]:
    """Administradores tienen todos los permisos; trabajadores solo los asignados."""
    if str(role or "").strip().lower() == "admin":
        return sorted(ALL_PERMISSIONS)
    return normalize_permissions(permissions)


def user_has_permission(*, role: str, permissions: Optional[Any], permission: str) -> bool:
    perm = str(permission or "").strip()
    if not perm:
        return False
    if str(role or "").strip().lower() == "admin":
        return True
    return perm in set(normalize_permissions(permissions))


def user_has_any_baas_permission(*, role: str, permissions: Optional[Any]) -> bool:
    if str(role or "").strip().lower() == "admin":
        return True
    granted = set(normalize_permissions(permissions))
    return bool(granted & _BAAS_ANY)
