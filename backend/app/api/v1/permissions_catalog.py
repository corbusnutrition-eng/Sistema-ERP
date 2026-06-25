"""Catálogo de permisos RBAC — matriz QBO + roles predefinidos."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.v1.dependencies import AdminDep
from app.permissions import (
    PERMISSION_ACTIONS,
    PERMISSION_GROUPS,
    PERMISSION_MATRIX,
    PREDEFINED_ROLES,
)

router = APIRouter(prefix="/permissions", tags=["permissions"])


class PermissionCatalogResponse(BaseModel):
    groups: list[dict[str, Any]]


class PermissionMatrixResponse(BaseModel):
    actions: list[dict[str, str]]
    modules: list[dict[str, Any]]
    predefined_roles: list[dict[str, Any]]


@router.get("/catalog", response_model=PermissionCatalogResponse)
def permission_catalog(_: AdminDep) -> PermissionCatalogResponse:
    """Catálogo legacy (checkboxes simples)."""
    return PermissionCatalogResponse(groups=PERMISSION_GROUPS)


@router.get("/matrix", response_model=PermissionMatrixResponse)
def permission_matrix(_: AdminDep) -> PermissionMatrixResponse:
    """Matriz completa estilo QuickBooks + plantillas de rol."""
    return PermissionMatrixResponse(
        actions=PERMISSION_ACTIONS,
        modules=PERMISSION_MATRIX,
        predefined_roles=[
            {
                "id": r["id"],
                "label": r["label"],
                "description": r.get("description"),
                "system_role": r.get("system_role", "worker"),
                "permissions": list(r.get("permissions") or []),
            }
            for r in PREDEFINED_ROLES
        ],
    )
