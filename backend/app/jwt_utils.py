"""Utilidades JWT compartidas (evita import circular auth ↔ dependencies)."""

from __future__ import annotations

import datetime
from typing import Optional

from jose import JWTError, jwt

from app.timezone_utils import now_utc

SECRET_KEY = "iptv-erp-jwt-secret-key-fase10-rbac"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_HOURS = 8


def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = now_utc() + datetime.timedelta(hours=ACCESS_TOKEN_EXPIRE_HOURS)
    to_encode["exp"] = expire
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)


def decode_access_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None
