"""
Pruebas de autenticación: login/refresh/logout por cookies, rate limiting,
endpoints antes huérfanos, y las dos regresiones críticas de la auditoría
de seguridad (backdoor eliminado, usuario desactivado pierde acceso ya).
"""

from __future__ import annotations

import uuid

import bcrypt
import pytest
from fastapi.testclient import TestClient
from jose import jwt as jose_jwt

from app.jwt_utils import ALGORITHM, ISSUER, SECRET_KEY
from app.main import app
from app.models.user import User, UserRole
from app.permissions import ROLE_TEMPLATE_FULL_ADMIN
from app.security.cookies import ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME

PASSWORD = "correct-horse-battery-staple"


def _hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8")[:72], bcrypt.gensalt()).decode("utf-8")


def _make_user(db, *, email: str, role: UserRole = UserRole.worker, is_active: bool = True, permissions=None) -> User:
    user = User(
        name="Test User",
        email=email,
        hashed_password=_hash(PASSWORD),
        role=role,
        is_active=is_active,
        permissions=permissions or [],
        role_template=ROLE_TEMPLATE_FULL_ADMIN if role == UserRole.admin else None,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def client(patched_database) -> TestClient:
    with TestClient(app) as c:
        yield c


def _unique_ip() -> dict:
    """Bucket de rate-limit aislado por test (evita interferencia entre tests)."""
    return {"X-Forwarded-For": f"10.{uuid.uuid4().int % 250}.{uuid.uuid4().int % 250}.1"}


# ── Login ─────────────────────────────────────────────────────────────────────


def test_login_correcto_fija_cookies_httponly(client: TestClient, db):
    _make_user(db, email="staff@example.com")

    resp = client.post(
        "/api/v1/auth/login",
        json={"email": "staff@example.com", "password": PASSWORD},
        headers=_unique_ip(),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "access_token" not in body  # el token ya no viaja en el cuerpo
    assert body["user"]["role"] == "worker"

    set_cookie_headers = resp.headers.get_list("set-cookie")
    access_cookie = next(h for h in set_cookie_headers if h.startswith(f"{ACCESS_COOKIE_NAME}="))
    refresh_cookie = next(h for h in set_cookie_headers if h.startswith(f"{REFRESH_COOKIE_NAME}="))
    assert "HttpOnly" in access_cookie
    assert "samesite=lax" in access_cookie.lower()
    assert "HttpOnly" in refresh_cookie


def test_login_incorrecto_no_fija_cookies(client: TestClient, db):
    _make_user(db, email="staff2@example.com")
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": "staff2@example.com", "password": "wrong-password"},
        headers=_unique_ip(),
    )
    assert resp.status_code == 401
    assert ACCESS_COOKIE_NAME not in resp.cookies


def test_backdoor_admin_mock_ya_no_existe(client: TestClient, db):
    """Regresión: admin@erp.com / admin123 no debe autenticar sin existir en la BD."""
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": "admin@erp.com", "password": "admin123"},
        headers=_unique_ip(),
    )
    assert resp.status_code == 401


def test_login_email_inexistente_no_filtra_tiempo_de_forma_burda(client: TestClient, db):
    """No es una prueba de temporización estricta: solo confirma que ambos casos
    (email inexistente vs. contraseña incorrecta) devuelven la misma respuesta genérica."""
    _make_user(db, email="staff3@example.com")
    r1 = client.post(
        "/api/v1/auth/login",
        json={"email": "no-existe@example.com", "password": "cualquiera"},
        headers=_unique_ip(),
    )
    r2 = client.post(
        "/api/v1/auth/login",
        json={"email": "staff3@example.com", "password": "cualquiera-incorrecta"},
        headers=_unique_ip(),
    )
    assert r1.status_code == r2.status_code == 401
    assert r1.json()["detail"] == r2.json()["detail"]


def test_login_usuario_desactivado_403(client: TestClient, db):
    _make_user(db, email="inactive@example.com", is_active=False)
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": "inactive@example.com", "password": PASSWORD},
        headers=_unique_ip(),
    )
    assert resp.status_code == 403


def test_login_rate_limit_5_por_minuto(client: TestClient, db):
    _make_user(db, email="ratelimited@example.com")
    ip = _unique_ip()
    for _ in range(5):
        resp = client.post(
            "/api/v1/auth/login",
            json={"email": "ratelimited@example.com", "password": "wrong"},
            headers=ip,
        )
        assert resp.status_code == 401
    sixth = client.post(
        "/api/v1/auth/login",
        json={"email": "ratelimited@example.com", "password": "wrong"},
        headers=ip,
    )
    assert sixth.status_code == 429


# ── Tokens ────────────────────────────────────────────────────────────────────


def test_token_firmado_con_otro_secreto_es_rechazado(client: TestClient, db):
    user = _make_user(db, email="tampered@example.com")
    forged = jose_jwt.encode(
        {"sub": user.email, "user_id": user.id, "role": "admin", "iss": ISSUER, "exp": 9999999999},
        "un-secreto-distinto",
        algorithm=ALGORITHM,
    )
    resp = client.get("/api/v1/auth/me", cookies={ACCESS_COOKIE_NAME: forged}, headers=_unique_ip())
    assert resp.status_code == 401


def test_token_expirado_distingue_motivo(client: TestClient, db):
    user = _make_user(db, email="expired@example.com")
    expired = jose_jwt.encode(
        {"sub": user.email, "user_id": user.id, "role": "worker", "iss": ISSUER, "exp": 1},
        SECRET_KEY,
        algorithm=ALGORITHM,
    )
    resp = client.get("/api/v1/auth/me", cookies={ACCESS_COOKIE_NAME: expired}, headers=_unique_ip())
    assert resp.status_code == 401
    assert resp.json()["detail"] == "token_expired"


def test_usuario_desactivado_tras_emitir_token_pierde_acceso_de_inmediato(client: TestClient, db):
    """
    Regresión del fallo #9: antes, get_current_user solo miraba el payload del
    token y un admin desactivado conservaba acceso hasta que el token expirara
    (hasta 8h). Ahora se revalida `is_active` en BD en cada request.
    """
    user = _make_user(db, email="tobedeactivated@example.com")
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "tobedeactivated@example.com", "password": PASSWORD},
        headers=_unique_ip(),
    )
    assert login.status_code == 200

    me_ok = client.get("/api/v1/auth/me")
    assert me_ok.status_code == 200

    user.is_active = False
    db.commit()

    me_after = client.get("/api/v1/auth/me")
    assert me_after.status_code == 401


def test_no_admin_no_alcanza_ruta_admin_aunque_el_token_diga_role_admin(client: TestClient, db):
    """
    Regresión: get_current_admin_user confía en current_user['role'], pero ese
    valor ahora SIEMPRE viene de una relectura fresca en BD dentro de
    get_current_user — un token forjado/viejo con `role: admin` no basta.
    """
    user = _make_user(db, email="worker-forged@example.com", role=UserRole.worker)
    forged = jose_jwt.encode(
        {
            "sub": user.email,
            "user_id": user.id,
            "role": "admin",  # mentira: en BD sigue siendo worker
            "token_type": "access",
            "iss": ISSUER,
            "exp": 9999999999,
        },
        SECRET_KEY,
        algorithm=ALGORITHM,
    )
    resp = client.get(
        "/api/v1/permissions/catalog",
        cookies={ACCESS_COOKIE_NAME: forged},
        headers=_unique_ip(),
    )
    # No debe colarse como admin: 401/403, nunca 200 con privilegios de admin.
    assert resp.status_code in (401, 403)


# ── Refresh / logout ──────────────────────────────────────────────────────────


def test_refresh_rota_cookies_y_el_anterior_deja_de_servir(client: TestClient, db):
    _make_user(db, email="refresher@example.com")
    login = client.post(
        "/api/v1/auth/login",
        json={"email": "refresher@example.com", "password": PASSWORD},
        headers=_unique_ip(),
    )
    old_refresh = login.cookies.get(REFRESH_COOKIE_NAME)
    assert old_refresh

    refreshed = client.post("/api/v1/auth/refresh", headers=_unique_ip())
    assert refreshed.status_code == 200
    new_refresh = refreshed.cookies.get(REFRESH_COOKIE_NAME)
    assert new_refresh and new_refresh != old_refresh

    # Reusar el refresh viejo (ya revocado) debe fallar y no dejar sesión.
    reuse = client.post(
        "/api/v1/auth/refresh",
        cookies={REFRESH_COOKIE_NAME: old_refresh},
        headers=_unique_ip(),
    )
    assert reuse.status_code == 401
    assert reuse.json()["detail"] == "refresh_reuse_detected"


def test_logout_revoca_y_limpia_cookies(client: TestClient, db):
    _make_user(db, email="logout@example.com")
    client.post(
        "/api/v1/auth/login",
        json={"email": "logout@example.com", "password": PASSWORD},
        headers=_unique_ip(),
    )
    out = client.post("/api/v1/auth/logout", headers=_unique_ip())
    assert out.status_code == 200

    me = client.get("/api/v1/auth/me")
    assert me.status_code == 401


# ── Endpoints antes huérfanos (fallo #4) ───────────────────────────────────────


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/api/v1/tags"),
        ("post", "/api/v1/tag-groups/"),
        ("get", "/api/v1/sale-tags"),
    ],
)
def test_endpoints_antes_huerfanos_ahora_exigen_sesion(client: TestClient, method: str, path: str):
    resp = getattr(client, method)(path, headers=_unique_ip())
    assert resp.status_code in (401, 422)  # 422 si el body JSON falta antes de llegar a la auth, nunca 200
