"""Catálogo RBAC granular del ERP — matriz estilo QuickBooks + roles predefinidos."""

from __future__ import annotations

from typing import Any, Optional

# ── Acciones de columna (matriz) ───────────────────────────────────────────────

PERMISSION_ACTIONS: list[dict[str, str]] = [
    {"id": "view", "label": "Acceder/Ver"},
    {"id": "create", "label": "Crear"},
    {"id": "edit", "label": "Editar"},
    {"id": "delete", "label": "Eliminar"},
    {"id": "approve", "label": "Aprobar"},
]

# ── Permisos legacy BaaS (endpoints ya protegidos) ───────────────────────────

BAAS_VIEW_USERS_TAB = "baas:view_users_tab"
BAAS_VIEW_REQUESTS_TAB = "baas:view_requests_tab"
BAAS_VIEW_NOTIFICATIONS_TAB = "baas:view_notifications_tab"
BAAS_CREATE_RECHARGE = "baas:create_recharge"

# Matriz → legacy (para compatibilidad con require_permission existente)
MATRIX_TO_LEGACY: dict[str, str] = {
    "baas:distributors:view": BAAS_VIEW_USERS_TAB,
    "baas:distributors:edit": BAAS_VIEW_USERS_TAB,
    "baas:recharge_requests:view": BAAS_VIEW_REQUESTS_TAB,
    "baas:recharge_requests:edit": BAAS_VIEW_REQUESTS_TAB,
    "baas:recharge_requests:approve": BAAS_VIEW_REQUESTS_TAB,
    "baas:recharge_requests:delete": BAAS_VIEW_REQUESTS_TAB,
    "baas:recharge_requests:create": BAAS_CREATE_RECHARGE,
    "baas:notifications:view": BAAS_VIEW_NOTIFICATIONS_TAB,
    "baas:notifications:create": BAAS_VIEW_NOTIFICATIONS_TAB,
    "baas:notifications:edit": BAAS_VIEW_NOTIFICATIONS_TAB,
    "baas:notifications:delete": BAAS_VIEW_NOTIFICATIONS_TAB,
}

LEGACY_TO_MATRIX: dict[str, list[str]] = {}
for _matrix_key, _legacy_key in MATRIX_TO_LEGACY.items():
    LEGACY_TO_MATRIX.setdefault(_legacy_key, []).append(_matrix_key)

_BAAS_LEGACY = frozenset(
    {
        BAAS_VIEW_USERS_TAB,
        BAAS_VIEW_REQUESTS_TAB,
        BAAS_VIEW_NOTIFICATIONS_TAB,
        BAAS_CREATE_RECHARGE,
    }
)


def _cell(module_id: str, row_id: str, action: str) -> str:
    return f"{module_id}:{row_id}:{action}"


def _cells(module_id: str, row_id: str, actions: tuple[str, ...]) -> set[str]:
    return {_cell(module_id, row_id, a) for a in actions}


def _row(module_id: str, row_id: str, label: str, *, actions: Optional[list[str]] = None) -> dict[str, Any]:
    allowed = actions or ["view", "create", "edit", "delete"]
    cells: dict[str, Optional[str]] = {}
    for action in PERMISSION_ACTIONS:
        aid = action["id"]
        cells[aid] = _cell(module_id, row_id, aid) if aid in allowed else None
    return {"id": row_id, "label": label, "cells": cells}


# ── Matriz por módulos del menú lateral ──────────────────────────────────────

PERMISSION_MATRIX: list[dict[str, Any]] = [
    {
        "id": "dashboard",
        "label": "Dashboard",
        "features_summary": ["Panel principal", "Métricas"],
        "rows": [
            _row("dashboard", "overview", "Panel principal", actions=["view"]),
        ],
    },
    {
        "id": "clients_inventory",
        "label": "Clientes e Inventario",
        "features_summary": ["Clientes", "Inventario IPTV", "Productos"],
        "rows": [
            _row("clients_inventory", "clients", "Clientes"),
            _row("clients_inventory", "inventory", "Inventario IPTV"),
            _row("clients_inventory", "products", "Productos y servicios"),
        ],
    },
    {
        "id": "sales",
        "label": "Ventas",
        "features_summary": ["Facturas", "Suscripciones IPTV", "Recibos de pago"],
        "rows": [
            _row("sales", "invoices", "Facturas"),
            _row("sales", "subscriptions", "Suscripciones IPTV"),
            _row("sales", "receipts", "Recibos de pago"),
        ],
    },
    {
        "id": "baas",
        "label": "Billeteras BaaS",
        "features_summary": ["Distribuidores", "Solicitudes de recarga", "Notificaciones"],
        "rows": [
            _row("baas", "distributors", "Distribuidores"),
            _row("baas", "recharge_requests", "Solicitudes de recarga", actions=["view", "create", "edit", "delete", "approve"]),
            _row("baas", "notifications", "Gestión de notificaciones"),
        ],
    },
    {
        "id": "accounting",
        "label": "Contabilidad",
        "features_summary": ["Plan de cuentas", "CxC", "Gastos", "Proveedores", "Conciliar"],
        "rows": [
            _row("accounting", "chart", "Plan de cuentas"),
            _row("accounting", "receivables", "Cuentas por cobrar"),
            _row("accounting", "expenses", "Gastos"),
            _row("accounting", "vendors", "Proveedores"),
            _row("accounting", "reconcile", "Conciliar"),
        ],
    },
    {
        "id": "reports",
        "label": "Informes y Listas",
        "features_summary": ["Informes financieros", "Listas maestras", "Clases"],
        "rows": [
            _row("reports", "financial", "Informes financieros", actions=["view"]),
            _row("reports", "lists", "Listas maestras"),
            _row("reports", "classes", "Clases de informes", actions=["view", "create", "edit", "delete"]),
        ],
    },
    {
        "id": "team",
        "label": "Equipo",
        "features_summary": ["Usuarios", "Roles"],
        "rows": [
            _row("team", "users", "Administración de usuarios"),
        ],
    },
]


def _collect_matrix_keys() -> frozenset[str]:
    keys: set[str] = set()
    for module in PERMISSION_MATRIX:
        for row in module.get("rows", []):
            for perm_key in (row.get("cells") or {}).values():
                if perm_key:
                    keys.add(str(perm_key))
    return frozenset(keys)


MATRIX_PERMISSIONS: frozenset[str] = _collect_matrix_keys()

ALL_PERMISSIONS: frozenset[str] = MATRIX_PERMISSIONS | _BAAS_LEGACY

# ── Atajos de permisos (matriz) para require_permission y UI ───────────────────

DASHBOARD_OVERVIEW_VIEW = "dashboard:overview:view"

CLIENTS_VIEW = "clients_inventory:clients:view"
CLIENTS_CREATE = "clients_inventory:clients:create"
CLIENTS_EDIT = "clients_inventory:clients:edit"
CLIENTS_DELETE = "clients_inventory:clients:delete"

INVENTORY_VIEW = "clients_inventory:inventory:view"
PRODUCTS_VIEW = "clients_inventory:products:view"

SALES_INVOICES_VIEW = "sales:invoices:view"
SALES_SUBSCRIPTIONS_VIEW = "sales:subscriptions:view"
SALES_RECEIPTS_VIEW = "sales:receipts:view"

TEAM_USERS_VIEW = "team:users:view"
REPORTS_FINANCIAL_VIEW = "reports:financial:view"
PERMISSION_GROUPS: list[dict[str, Any]] = [
    {
        "module": "baas",
        "label": "Billeteras BaaS / Distribuidores",
        "permissions": [
            {"key": BAAS_VIEW_USERS_TAB, "label": "Ver pestaña Usuarios y billetera"},
            {"key": BAAS_VIEW_REQUESTS_TAB, "label": "Ver pestaña Solicitudes de recarga"},
            {"key": BAAS_VIEW_NOTIFICATIONS_TAB, "label": "Ver pestaña Gestión de Notificaciones"},
            {"key": BAAS_CREATE_RECHARGE, "label": "Crear solicitud de recarga"},
        ],
    },
]

# ── Roles predefinidos (plantillas) ────────────────────────────────────────────

ROLE_TEMPLATE_CUSTOM = "custom"
ROLE_TEMPLATE_FULL_ADMIN = "full_admin"

PREDEFINED_ROLES: list[dict[str, Any]] = [
    {
        "id": ROLE_TEMPLATE_FULL_ADMIN,
        "label": "Administrador total",
        "description": "Acceso completo a todos los módulos del ERP.",
        "system_role": "admin",
        "permissions": sorted(ALL_PERMISSIONS),
    },
    {
        "id": "cashier",
        "label": "Cajero",
        "description": "Clientes, ventas y cobros. Sin contabilidad ni equipo.",
        "system_role": "worker",
        "permissions": sorted(
            _cells("clients_inventory", "clients", ("view", "create", "edit"))
            | _cells("sales", "invoices", ("view", "create", "edit"))
            | {_cell("sales", "receipts", "view"), _cell("sales", "receipts", "create")}
            | {_cell("sales", "subscriptions", "view")}
        ),
    },
    {
        "id": "baas_manager",
        "label": "Gestor BaaS",
        "description": "Acceso completo al módulo de billeteras y distribuidores.",
        "system_role": "worker",
        "permissions": sorted(
            k
            for k in MATRIX_PERMISSIONS
            if k.startswith("baas:")
        ),
    },
    {
        "id": "accountant",
        "label": "Contador interno",
        "description": "Contabilidad, informes y consulta de clientes.",
        "system_role": "worker",
        "permissions": sorted(
            {_cell("clients_inventory", "clients", "view")}
            | _cells("accounting", "chart", ("view", "create", "edit"))
            | _cells("accounting", "receivables", ("view", "create", "edit", "approve"))
            | _cells("accounting", "expenses", ("view", "create", "edit", "delete"))
            | _cells("accounting", "vendors", ("view", "create", "edit"))
            | {_cell("accounting", "reconcile", "view"), _cell("accounting", "reconcile", "edit")}
            | {_cell("reports", "financial", "view"), _cell("reports", "lists", "view")}
        ),
    },
    {
        "id": "standard_limited",
        "label": "Estándar limitado",
        "description": "Solo lectura en clientes y ventas.",
        "system_role": "worker",
        "permissions": sorted(
            {
                _cell("clients_inventory", "clients", "view"),
                _cell("sales", "invoices", "view"),
                _cell("sales", "subscriptions", "view"),
                _cell("sales", "receipts", "view"),
            }
        ),
    },
    {
        "id": ROLE_TEMPLATE_CUSTOM,
        "label": "Personalizado",
        "description": "Configura permisos fila por fila en la matriz.",
        "system_role": "worker",
        "permissions": [],
    },
]

_PREDEFINED_BY_ID: dict[str, dict[str, Any]] = {r["id"]: r for r in PREDEFINED_ROLES}


def permissions_for_role_template(template_id: str) -> tuple[str, list[str]]:
    """Devuelve (system_role, permisos expandidos) para una plantilla."""
    tpl = _PREDEFINED_BY_ID.get(str(template_id or "").strip())
    if tpl is None:
        return "worker", []
    role = str(tpl.get("system_role") or "worker")
    perms = list(tpl.get("permissions") or [])
    if tpl["id"] == ROLE_TEMPLATE_FULL_ADMIN:
        return role, sorted(ALL_PERMISSIONS)
    return role, expand_permissions_with_legacy(normalize_permissions(perms))


def infer_role_template(*, role: str, permissions: Optional[Any]) -> str:
    """Infiera la plantilla más cercana (para listados)."""
    if str(role or "").lower() == "admin":
        return ROLE_TEMPLATE_FULL_ADMIN
    normalized = set(expand_permissions_with_legacy(normalize_permissions(permissions)))
    if not normalized:
        return ROLE_TEMPLATE_CUSTOM
    best_id = ROLE_TEMPLATE_CUSTOM
    best_score = -1
    for tpl in PREDEFINED_ROLES:
        if tpl["id"] in (ROLE_TEMPLATE_CUSTOM, ROLE_TEMPLATE_FULL_ADMIN):
            continue
        tpl_set = set(expand_permissions_with_legacy(normalize_permissions(tpl.get("permissions"))))
        if not tpl_set:
            continue
        if tpl_set == normalized:
            return str(tpl["id"])
        overlap = len(normalized & tpl_set)
        if overlap > best_score:
            best_score = overlap
            best_id = str(tpl["id"])
    return best_id


def role_template_label(template_id: str) -> str:
    tpl = _PREDEFINED_BY_ID.get(str(template_id or "").strip())
    if tpl:
        return str(tpl.get("label") or template_id)
    if template_id == ROLE_TEMPLATE_FULL_ADMIN:
        return "Administrador total"
    if template_id == ROLE_TEMPLATE_CUSTOM:
        return "Personalizado"
    return str(template_id or "—")


def expand_permissions_with_legacy(raw: list[str]) -> list[str]:
    """Añade claves legacy BaaS cuando hay permisos de matriz equivalentes."""
    seen: set[str] = set()
    out: list[str] = []
    for item in raw:
        key = str(item or "").strip()
        if not key or key not in ALL_PERMISSIONS:
            continue
        for k in (key, MATRIX_TO_LEGACY.get(key)):
            if k and k not in seen:
                seen.add(k)
                out.append(k)
    return sorted(seen)


def coerce_permissions_input(raw: Optional[Any]) -> list[str]:
    """
    Acepta permisos como lista de claves, dict plano/matriz, CSV o JSON string.
    Devuelve claves válidas deduplicadas (sin expandir legacy).
    """
    if raw is None:
        return []

    items: list[Any]

    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict):
        items = []
        for key, val in raw.items():
            k = str(key or "").strip()
            if not k:
                continue
            if isinstance(val, dict):
                for row_key, actions in val.items():
                    rk = str(row_key or "").strip()
                    if not rk:
                        continue
                    if isinstance(actions, dict):
                        for action, allowed in actions.items():
                            if allowed in (True, 1, "1", "true", "yes"):
                                items.append(f"{k}:{rk}:{action}")
                    elif actions in (True, 1, "1", "true", "yes"):
                        items.append(f"{k}:{rk}:view")
            elif val in (True, 1, "1", "true", "yes"):
                items.append(k)
        if not items:
            items = list(raw.keys())
    elif isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        if s.startswith("[") or s.startswith("{"):
            try:
                import json

                parsed = json.loads(s)
                return coerce_permissions_input(parsed)
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
        items = [p.strip() for p in s.split(",") if p.strip()]
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
    return sorted(out)


def normalize_permissions(raw: Optional[Any]) -> list[str]:
    """Filtra y deduplica permisos válidos desde JSON/lista/dict."""
    return coerce_permissions_input(raw)


def effective_permissions(*, role: str, permissions: Optional[Any]) -> list[str]:
    if str(role or "").strip().lower() == "admin":
        return sorted(ALL_PERMISSIONS)
    return expand_permissions_with_legacy(normalize_permissions(permissions))


def user_has_permission(*, role: str, permissions: Optional[Any], permission: str) -> bool:
    perm = str(permission or "").strip()
    if not perm:
        return False
    if str(role or "").strip().lower() == "admin":
        return True
    granted = set(effective_permissions(role=role, permissions=permissions))
    if perm in granted:
        return True
    # Legacy endpoint pide clave antigua; usuario puede tener solo matriz equivalente
    for matrix_key, legacy_key in MATRIX_TO_LEGACY.items():
        if perm == legacy_key and matrix_key in granted:
            return True
    return False


def user_has_any_baas_permission(*, role: str, permissions: Optional[Any]) -> bool:
    if str(role or "").strip().lower() == "admin":
        return True
    granted = set(effective_permissions(role=role, permissions=permissions))
    for key in granted:
        if key.startswith("baas:") or key in _BAAS_LEGACY:
            return True
    return False


def module_access_summary(module: dict[str, Any], granted: set[str]) -> dict[str, Any]:
    """Resumen colapsado estilo QBO para un acordeón."""
    rows = module.get("rows") or []
    if not rows:
        return {"level": "none", "label": "Sin acceso", "with_access": [], "without_access": []}
    with_access: list[str] = []
    without_access: list[str] = []
    for row in rows:
        cells = row.get("cells") or {}
        keys = [k for k in cells.values() if k]
        if keys and any(k in granted for k in keys):
            with_access.append(str(row.get("label") or row.get("id")))
        else:
            without_access.append(str(row.get("label") or row.get("id")))
    if with_access and not without_access:
        level = "full"
        label = "Acceso completo"
    elif with_access:
        level = "partial"
        label = "Acceso parcial"
    else:
        level = "none"
        label = "Sin acceso"
    return {
        "level": level,
        "label": label,
        "with_access": with_access,
        "without_access": without_access,
    }
