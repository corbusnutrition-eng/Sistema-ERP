from __future__ import annotations

import csv
import io
import logging
import uuid
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy.exc import IntegrityError, OperationalError, ProgrammingError
from sqlalchemy.orm import Session, joinedload

from sqlalchemy import func, or_

logger = logging.getLogger(__name__)

from app.database import get_db
from app.models.client import Client
from app.models.iptv_screen import IPTVScreen
from app.models.sale import Sale, SaleStatus
from app.schemas.client import (
    ClientCreate,
    ClientPublicResponse,
    ClientResponse,
    ClientSubClientBrief,
    ClientUpdate,
)
from app.services.client_reseller_service import list_subclients_for_parent
from app.schemas.client_payments import ClientLedgerResponse, LedgerEntry, LedgerRelatedDoc, UnpaidInvoiceOut
from app.services.client_payment_service import (
    build_client_ledger,
    compute_client_pending_balance,
    list_unpaid_invoices,
)
from app.services.catalog_vip_sync import notify_catalog_vip_new_manual_customer

router = APIRouter(prefix="/clients", tags=["clients"])

DbDep = Annotated[Session, Depends(get_db)]

# Columnas que se reconocen al importar (en minúsculas sin espacios)
_CSV_FIELD_MAP: dict[str, str] = {
    "nombre": "name",
    "name": "name",
    "correo": "email",
    "email": "email",
    "telefono": "phone",
    "phone": "phone",
    "usuario": "username",
    "username": "username",
    "pais": "country",
    "país": "country",
    "country": "country",
    "estado": "status",
    "status": "status",
}

_EXPORT_FIELDS = ["id", "name", "email", "phone", "username", "country", "status", "payment_token"]


def _normalize_import_status(raw: Optional[str]) -> str:
    if not raw or not str(raw).strip():
        return "Activo"
    s = str(raw).strip().lower()
    if s in ("inactivo", "inactive", "churned", "perdido", "baja"):
        return "Inactivo"
    return "Activo"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_header(raw: str) -> str:
    return raw.strip().lower().replace(" ", "_").replace("á", "a").replace("é", "e").replace("ó", "o").replace("ú", "u")


def _parse_rows_from_csv(content: bytes) -> list[dict[str, Any]]:
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    rows: list[dict[str, Any]] = []
    for row in reader:
        mapped: dict[str, Any] = {}
        for raw_key, value in row.items():
            norm = _normalize_header(raw_key)
            field = _CSV_FIELD_MAP.get(norm)
            if field:
                mapped[field] = value.strip() if value else None
        if mapped.get("email"):
            rows.append(mapped)
    return rows


def _parse_rows_from_xlsx(content: bytes) -> list[dict[str, Any]]:
    try:
        import openpyxl  # type: ignore
    except ImportError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Para importar archivos .xlsx instala openpyxl en el servidor.",
        ) from exc

    wb = openpyxl.load_workbook(filename=io.BytesIO(content), read_only=True, data_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    headers = [_normalize_header(str(h)) if h else "" for h in next(rows_iter, [])]

    rows: list[dict[str, Any]] = []
    for raw_row in rows_iter:
        mapped: dict[str, Any] = {}
        for header, value in zip(headers, raw_row):
            field = _CSV_FIELD_MAP.get(header)
            if field:
                mapped[field] = str(value).strip() if value is not None else None
        if mapped.get("email"):
            rows.append(mapped)
    return rows


def _attach_parent_fields(db: Session, data: dict[str, Any], client: Client) -> None:
    pid = getattr(client, "parent_id", None)
    if pid is None:
        return
    parent = db.get(Client, int(pid))
    if parent is None:
        return
    data["parent_username"] = parent.username
    data["parent_name"] = (parent.name or "").strip() or parent.username


def _client_response_dict(db: Session, client: Client, *, credit_sync: bool = True) -> dict[str, Any]:
    from app.services.client_payment_service import compute_client_credit_summary, sync_client_credit_from_overpay
    from app.services.client_currency_service import get_client_currency

    if credit_sync:
        sync_client_credit_from_overpay(db, client)
        db.flush()
    data = ClientResponse.model_validate(client).model_dump()
    data["currency"] = get_client_currency(client)
    data.update(compute_client_pending_balance(db, int(client.id)))
    data.update(compute_client_credit_summary(db, int(client.id), sync=False))
    _attach_parent_fields(db, data, client)
    return data


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/", response_model=list[ClientResponse])
def list_clients(
    db: DbDep,
    skip: int = 0,
    limit: int = Query(default=500, ge=1, le=10000),
    search: Optional[str] = Query(
        default=None,
        description="Filtra por usuario, nombre o email (toda la red, incluidos sub-clientes).",
    ),
) -> list[ClientResponse]:
    """Devuelve la lista paginada de clientes registrados (toda la jerarquía B2B2B)."""
    try:
        q = db.query(Client)
        if search and str(search).strip():
            term = f"%{str(search).strip().lower()}%"
            q = q.filter(
                or_(
                    func.lower(Client.username).like(term),
                    func.lower(func.coalesce(Client.name, "")).like(term),
                    func.lower(Client.email).like(term),
                )
            )
        rows = q.order_by(Client.id.asc()).offset(skip).limit(limit).all()
        out: list[ClientResponse] = []
        for client in rows:
            out.append(ClientResponse(**_client_response_dict(db, client)))
        return out
    except (OperationalError, ProgrammingError) as exc:
        logger.exception("GET /clients — error de base de datos al listar clientes")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "No se pudo leer la tabla de clientes. Comprueba la conexión a la base de datos y ejecuta "
                "las migraciones (`alembic upgrade head`). "
                f"Causa: {getattr(exc, 'orig', exc)!s}"
            ),
        ) from exc


router.add_api_route(
    "",
    list_clients,
    methods=["GET"],
    response_model=list[ClientResponse],
    tags=["clients"],
    include_in_schema=False,
)


@router.get(
    "/export/csv",
    summary="Exportar base de datos de clientes en formato CSV",
    response_class=StreamingResponse,
    tags=["clients"],
)
def export_clients_csv(db: DbDep) -> StreamingResponse:
    """Descarga todos los clientes como un archivo CSV (UTF-8 con BOM para compatibilidad Excel)."""
    clients: list[Client] = db.query(Client).order_by(Client.id).all()

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=_EXPORT_FIELDS, extrasaction="ignore")
    writer.writeheader()
    for c in clients:
        writer.writerow({f: str(getattr(c, f, "") or "") for f in _EXPORT_FIELDS})

    # UTF-8 BOM para que Excel lo abra directamente sin problemas de encoding
    bom = "\ufeff"
    content = bom + output.getvalue()

    return StreamingResponse(
        iter([content.encode("utf-8")]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=clientes.csv"},
    )


@router.get(
    "/public/{payment_link_id}",
    response_model=ClientPublicResponse,
    tags=["public"],
    summary="Portal público: datos del cliente por su link único (sin autenticación)",
)
def get_client_public(payment_link_id: uuid.UUID, db: DbDep) -> ClientPublicResponse:
    client: Optional[Client] = (
        db.query(Client)
        .options(joinedload(Client.screens).joinedload(IPTVScreen.iptv_account))
        .filter(Client.payment_token == payment_link_id)
        .first()
    )
    if client is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Link de pago no encontrado.",
        )

    active_screens = [s for s in client.screens if not s.is_available]
    providers = list({s.iptv_account.provider_name for s in active_screens if s.iptv_account})

    return ClientPublicResponse(
        name=client.display_name(),
        email=client.email,
        active_screens=len(active_screens),
        providers=providers,
        payment_token=client.payment_token,
    )


@router.post("/", response_model=ClientResponse, status_code=status.HTTP_201_CREATED)
def create_client(payload: ClientCreate, db: DbDep) -> Client:
    """
    Crea un nuevo cliente.
    El campo payment_token es generado automáticamente (uuid4).
    Sub-clientes con ``parent_id`` heredan la moneda base del distribuidor padre.
    """
    from app.services.client_currency_service import get_client_currency, set_client_currency

    inherit_currency = "USD"
    parent_id = payload.parent_id
    if parent_id is not None:
        parent = db.get(Client, int(parent_id))
        if parent is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Distribuidor padre no encontrado.")
        inherit_currency = get_client_currency(parent)

    client = Client(
        parent_id=int(parent_id) if parent_id is not None else None,
        username=payload.username,
        name=payload.name,
        email=payload.email,
        phone=payload.phone,
        country=payload.country,
        lead_source=payload.lead_source,
        status=payload.status,
        custom_fields=payload.custom_fields,
        note=payload.note,
        tags=payload.tags,
        currency=inherit_currency,
    )
    set_client_currency(client, inherit_currency)
    db.add(client)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Ya existe un cliente con el email '{payload.email}'.",
        )
    db.refresh(client)
    notify_catalog_vip_new_manual_customer(client.email)
    return client


@router.delete("/{client_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_client(client_id: int, db: DbDep) -> None:
    """Elimina un cliente y sus datos asociados de forma permanente."""
    client: Optional[Client] = db.query(Client).filter(Client.id == client_id).first()
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")
    db.delete(client)
    db.commit()


@router.patch("/{client_id}", response_model=ClientResponse)
def update_client(client_id: int, payload: ClientUpdate, db: DbDep) -> Client:
    """Actualiza parcialmente un cliente existente."""
    client: Optional[Client] = db.query(Client).filter(Client.id == client_id).first()
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")

    update_data = payload.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(client, field, value)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Ya existe un cliente con el email '{payload.email}'.",
        )
    db.refresh(client)
    return client


@router.post(
    "/sync-sales",
    summary="Sincronización retroactiva: actualiza clientes con ventas existentes",
    tags=["clients"],
)
def sync_clients_from_sales(db: DbDep) -> dict:
    """
    Recorre todos los clientes que tienen al menos una venta aprobada y actualiza:
      - status       → 'Activo'
      - last_recharge → fecha de su venta más reciente
      - total_credits → suma de los montos USD de todas sus ventas aprobadas
                        (mínimo 1.0 si la suma es 0)
    Devuelve un resumen con cuántos clientes fueron actualizados.
    """
    # Subquery: max(created_at) y sum(amount) por cliente para ventas aprobadas
    stats = (
        db.query(
            Sale.client_id,
            func.max(Sale.created_at).label("latest_sale"),
            func.sum(Sale.amount).label("total_amount"),
        )
        .filter(Sale.status == SaleStatus.approved)
        .group_by(Sale.client_id)
        .all()
    )

    updated = 0
    for row in stats:
        client: Optional[Client] = db.get(Client, row.client_id)
        if client is None:
            continue

        client.status = "Activo"
        client.last_recharge = row.latest_sale

        total = float(row.total_amount or 0)
        # Si el acumulado actual ya es mayor (ventas futuras) lo respetamos;
        # de lo contrario usamos el calculado desde la BD (mínimo 1.0)
        if client.total_credits < total:
            client.total_credits = total if total > 0 else 1.0

        updated += 1

    db.commit()
    return {
        "message": "Sincronización completada.",
        "clients_updated": updated,
    }


@router.post(
    "/import/csv",
    summary="Importar clientes desde un archivo CSV o Excel (.xlsx)",
    status_code=status.HTTP_200_OK,
)
def import_clients_csv(
    db: DbDep,
    file: UploadFile = File(..., description="Archivo CSV o XLSX con columnas: nombre/name, correo/email, telefono/phone, usuario/username, pais/country, estado/status"),
) -> dict[str, Any]:
    """
    Importa clientes en lote desde un CSV o Excel.

    - Si el email ya existe → actualiza los campos (upsert).
    - Si el email no existe → crea el cliente con status='Activo' por defecto.
    - Columnas reconocidas: nombre, correo, telefono, usuario, pais, estado
      (también acepta sus equivalentes en inglés).
    """
    content = file.file.read()
    filename = (file.filename or "").lower()

    if filename.endswith(".xlsx") or filename.endswith(".xls"):
        rows = _parse_rows_from_xlsx(content)
    else:
        rows = _parse_rows_from_csv(content)

    if not rows:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="El archivo no contiene filas válidas. Verifica que tenga las columnas requeridas.",
        )

    created = 0
    updated = 0
    skipped = 0
    errors: list[str] = []

    for i, row in enumerate(rows, start=2):  # fila 2 = primera fila de datos
        email = (row.get("email") or "").strip().lower()
        username_iptv = (row.get("username") or "").strip()
        name_val = (row.get("name") or "").strip()
        name = name_val if name_val else None

        if not email or not username_iptv:
            skipped += 1
            errors.append(f"Fila {i}: 'email' y 'usuario/username' son obligatorios.")
            continue

        final_status = _normalize_import_status(row.get("status"))
        existing: Optional[Client] = db.query(Client).filter(Client.email == email).first()

        if existing:
            existing.name = name
            existing.username = username_iptv
            if row.get("phone") is not None:
                existing.phone = row["phone"] or None
            if row.get("country") is not None:
                existing.country = row["country"] or None
            existing.status = final_status
            updated += 1
        else:
            new_client = Client(
                username=username_iptv,
                name=name,
                email=email,
                phone=row.get("phone") or None,
                country=row.get("country") or None,
                status=final_status,
            )
            db.add(new_client)
            created += 1

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Error de integridad al guardar: {exc.orig}",
        ) from exc

    return {
        "message": "Importación completada.",
        "created": created,
        "updated": updated,
        "skipped": skipped,
        "errors": errors,
    }


@router.get("/{client_id}/unpaid-invoices", response_model=list[UnpaidInvoiceOut])
def get_client_unpaid_invoices(client_id: int, db: DbDep) -> list[UnpaidInvoiceOut]:
    """Facturas con saldo pendiente (aprobada / parcial) para conciliación QB."""
    client = db.query(Client).filter(Client.id == client_id).first()
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")
    raw = list_unpaid_invoices(db, client_id)
    return [UnpaidInvoiceOut(**row) for row in raw]


@router.get("/{client_id}/ledger", response_model=ClientLedgerResponse)
def get_client_ledger(client_id: int, db: DbDep) -> ClientLedgerResponse:
    """Historial financiero unificado: facturas (Factura), cobros (Pago) y recargas BaaS (RECARGA)."""
    client = db.query(Client).filter(Client.id == client_id).first()
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")
    raw = build_client_ledger(db, client_id)
    entries = [
        LedgerEntry(
            date=e["date"],
            type=e["type"],
            ref_number=e["ref_number"],
            note=e["note"],
            amount=e["amount"],
            currency=e["currency"],
            status=e["status"],
            entity_id=e["entity_id"],
            entity_kind=e["entity_kind"],
            payment_id=e.get("payment_id"),
            receipt_file_url=e.get("receipt_file_url"),
            related_docs=[LedgerRelatedDoc(**rd) for rd in e.get("related_docs", [])],
            wallet_transaction_id=e.get("wallet_transaction_id"),
            can_revert=bool(e.get("can_revert")),
            revert_counterparty_id=e.get("revert_counterparty_id"),
            revert_counterparty_name=e.get("revert_counterparty_name"),
            baas_transfer_amount=e.get("baas_transfer_amount"),
        )
        for e in raw
    ]
    return ClientLedgerResponse(client_id=client_id, entries=entries)


@router.get("/{client_id}", response_model=ClientResponse)
def get_client(client_id: int, db: DbDep) -> ClientResponse:
    """Detalle de un cliente por id (incluye saldo CxC pendiente calculado)."""
    client: Optional[Client] = db.query(Client).filter(Client.id == client_id).first()
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")
    payload = _client_response_dict(db, client, credit_sync=True)
    db.commit()
    return ClientResponse(**payload)


@router.get("/{client_id}/sub-clients", response_model=list[ClientSubClientBrief])
def list_client_subclients(client_id: int, db: DbDep) -> list[ClientSubClientBrief]:
    """Sub-clientes directos cuyo ``parent_id`` es el cliente indicado."""
    parent: Optional[Client] = db.query(Client).filter(Client.id == client_id).first()
    if parent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")
    rows = list_subclients_for_parent(db, int(client_id))
    return [ClientSubClientBrief.model_validate(r) for r in rows]
