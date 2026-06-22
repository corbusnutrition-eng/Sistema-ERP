from fastapi import APIRouter
from app.schemas.client_schema import ClientCreate, ClientResponse

router = APIRouter()
fake_clients_db = []


@router.post("/", response_model=ClientResponse)
def create_client(client: ClientCreate):
    new_client = client.model_dump()
    new_client["id"] = len(fake_clients_db) + 1
    fake_clients_db.append(new_client)
    return new_client


@router.get("/", response_model=list[ClientResponse])
def get_clients():
    return fake_clients_db
