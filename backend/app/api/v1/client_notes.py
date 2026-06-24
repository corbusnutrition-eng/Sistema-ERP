from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, joinedload

from app.api.v1.dependencies import UserDep
from app.database import get_db
from app.models.client import Client
from app.models.client_note import ClientNote
from app.models.user import User

router = APIRouter(prefix="/client-notes", tags=["client-notes"])

DbDep = Annotated[Session, Depends(get_db)]


# ── Schemas ───────────────────────────────────────────────────────────────────

class ClientNoteCreate(BaseModel):
    client_id: int
    note: str = Field(..., min_length=1, max_length=2000)


class ClientNoteUpdate(BaseModel):
    note: str = Field(..., min_length=1, max_length=2000)


class ClientNoteResponse(BaseModel):
    id: int
    client_id: int
    user_id: Optional[int]
    author_name: Optional[str] = None
    note: str
    created_at: datetime

    model_config = {"from_attributes": True}


def _note_to_response(note: ClientNote) -> ClientNoteResponse:
    return ClientNoteResponse(
        id=note.id,
        client_id=note.client_id,
        user_id=note.user_id,
        author_name=note.author.name if note.author else None,
        note=note.note,
        created_at=note.created_at,
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/{client_id}", response_model=list[ClientNoteResponse])
def get_notes_by_client(
    client_id: int,
    db: DbDep,
    current_user: UserDep,
    skip: int = 0,
    limit: int = 50,
) -> list[ClientNoteResponse]:
    """Devuelve las notas de seguimiento de un cliente específico."""
    client: Optional[Client] = db.get(Client, client_id)
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")

    notes = (
        db.query(ClientNote)
        .options(joinedload(ClientNote.author))
        .filter(ClientNote.client_id == client_id)
        .order_by(ClientNote.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )

    return [_note_to_response(n) for n in notes]


@router.post("/", response_model=ClientNoteResponse, status_code=status.HTTP_201_CREATED)
def create_note(payload: ClientNoteCreate, db: DbDep, current_user: UserDep) -> ClientNoteResponse:
    """Crea una nota de seguimiento para un cliente."""
    client: Optional[Client] = db.get(Client, payload.client_id)
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")

    user_email: str = current_user.get("sub", "")
    db_user: Optional[User] = db.query(User).filter(User.email == user_email).first()

    note = ClientNote(
        client_id=payload.client_id,
        user_id=db_user.id if db_user else None,
        note=payload.note,
    )
    db.add(note)
    db.commit()
    db.refresh(note)

    return ClientNoteResponse(
        id=note.id,
        client_id=note.client_id,
        user_id=note.user_id,
        author_name=db_user.name if db_user else current_user.get("name"),
        note=note.note,
        created_at=note.created_at,
    )


@router.patch(
    "/{client_id}/{note_id}",
    response_model=ClientNoteResponse,
    summary="Actualizar texto de una nota de seguimiento",
)
def update_note(
    client_id: int,
    note_id: int,
    payload: ClientNoteUpdate,
    db: DbDep,
    current_user: UserDep,
) -> ClientNoteResponse:
    """Modifica el contenido de una nota CRM existente del cliente."""
    client: Optional[Client] = db.get(Client, client_id)
    if client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cliente no encontrado.")

    note = (
        db.query(ClientNote)
        .options(joinedload(ClientNote.author))
        .filter(ClientNote.id == note_id, ClientNote.client_id == client_id)
        .first()
    )
    if note is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Nota no encontrada.")

    note.note = payload.note.strip()
    db.commit()
    db.refresh(note)

    return _note_to_response(note)
