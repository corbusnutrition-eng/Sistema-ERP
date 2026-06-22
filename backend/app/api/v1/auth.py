from __future__ import annotations

import datetime
from typing import Annotated, Optional

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, status
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.timezone_utils import now_utc

router = APIRouter(prefix="/auth", tags=["auth"])

# ── JWT config ────────────────────────────────────────────────────────────────
# In production replace this with a strong random secret (e.g. os.getenv("SECRET_KEY"))
SECRET_KEY = "iptv-erp-jwt-secret-key-fase10-rbac"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 8

# ── Mock admin fallback (when no admin user exists in the DB yet) ─────────────
MOCK_EMAIL = "admin@erp.com"
MOCK_PASSWORD = "admin123"


# ── JWT helpers ───────────────────────────────────────────────────────────────

def create_access_token(data: dict) -> str:
    """Genera un JWT firmado con expiración de ACCESS_TOKEN_EXPIRE_HOURS horas."""
    to_encode = data.copy()
    expire = now_utc() + datetime.timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    to_encode["exp"] = expire
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> Optional[dict]:
    """Decodifica y valida el JWT. Devuelve el payload o None si es inválido/expirado."""
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None


# ── Schemas ───────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserInfo(BaseModel):
    name: str
    role: str
    user_id: Optional[int] = None


class LoginResponse(BaseModel):
    access_token: str
    token_type: str
    user: UserInfo


# ── Endpoint ──────────────────────────────────────────────────────────────────

DbDep = Annotated[Session, Depends(get_db)]


@router.post("/login", response_model=LoginResponse)
def login(credentials: LoginRequest, db: DbDep) -> LoginResponse:
    """
    Autentica al usuario contra la BD (bcrypt). Si el email no existe en la BD,
    recurre al admin mock para compatibilidad durante el desarrollo.
    Devuelve un JWT firmado con el nombre y rol del usuario.
    """
    db_user: Optional[User] = db.query(User).filter(User.email == credentials.email).first()

    if db_user:
        password_bytes = credentials.password.encode("utf-8")[:72]
        if not bcrypt.checkpw(password_bytes, db_user.hashed_password.encode("utf-8")):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Credenciales incorrectas.",
                headers={"WWW-Authenticate": "Bearer"},
            )
        if not db_user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Usuario desactivado. Contacta al administrador.",
            )
        user_info = UserInfo(name=db_user.name, role=db_user.role.value, user_id=db_user.id)

    elif credentials.email == MOCK_EMAIL and credentials.password == MOCK_PASSWORD:
        user_info = UserInfo(name="Admin", role="admin", user_id=None)

    else:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Credenciales incorrectas.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token_payload: dict = {
        "sub": credentials.email,
        "name": user_info.name,
        "role": user_info.role,
    }
    if db_user is not None:
        token_payload["user_id"] = db_user.id
    token = create_access_token(token_payload)
    return LoginResponse(access_token=token, token_type="bearer", user=user_info)
