"""Catálogo de permisos RBAC (administración de equipo)."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.v1.dependencies import AdminDep
from app.permissions import PERMISSION_GROUPS

router = APIRouter(prefix="/permissions", tags=["permissions"])


class PermissionCatalogResponse(BaseModel):
    groups: list[dict[str, Any]]


@router.get("/catalog", response_model=PermissionCatalogResponse)
def permission_catalog(_: AdminDep) -> PermissionCatalogResponse:
    """Lista agrupada de permisos disponibles para asignar a trabajadores."""
    return PermissionCatalogResponse(groups=PERMISSION_GROUPS)
