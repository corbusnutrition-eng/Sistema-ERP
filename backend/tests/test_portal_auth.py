"""
Login del portal (correo + contraseña) sobre el link permanente
``/portal/{token}``: gate de sesión, alta de contraseña, login, aislamiento
entre clientes y reseteo por admin.
"""

from __future__ import annotations

import uuid as uuid_module

import bcrypt
from fastapi.testclient import TestClient

from app.audit.context import ACTOR_STAFF, audit_actor_scope
from app.models.client import Client
from app.models.user import User, UserRole
from app.security.portal_session import hash_portal_password


def _make_client(db, *, email: str, has_password: bool = False) -> Client:
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        c = Client(
            email=email,
            username=email.split("@", 1)[0],
            wallet_balance=0.0,
            currency="USD",
            payment_token=uuid_module.uuid4(),
            password_hash=hash_portal_password("Sup3rSecret!") if has_password else None,
        )
        db.add(c)
        db.commit()
        db.refresh(c)
    return c


def _make_admin(db, email: str) -> User:
    u = User(
        name="Admin Test",
        email=email,
        hashed_password=bcrypt.hashpw(b"x" * 12, bcrypt.gensalt()).decode(),
        role=UserRole.admin,
        is_active=True,
        permissions=[],
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _login_staff(client: TestClient, email: str, ip: str) -> None:
    resp = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "x" * 12},
        headers={"X-Forwarded-For": ip},
    )
    assert resp.status_code == 200


# ── Gate de sesión ───────────────────────────────────────────────────────────


def test_ruta_portal_sin_sesion_devuelve_401(client: TestClient, db):
    c = _make_client(db, email="sin-sesion@example.com")
    resp = client.get(f"/api/v1/portal/{c.payment_token}", headers={"X-Forwarded-For": "10.20.1.1"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "portal_session_required"


def test_ruta_portal_con_token_inexistente_conserva_404(client: TestClient, db):
    resp = client.get(
        f"/api/v1/portal/{uuid_module.uuid4()}", headers={"X-Forwarded-For": "10.20.1.2"}
    )
    assert resp.status_code == 404


# ── /auth/status ─────────────────────────────────────────────────────────────


def test_status_sin_password_indica_que_falta_crearla(client: TestClient, db):
    c = _make_client(db, email="nuevo-portal@example.com")
    resp = client.get(
        f"/api/v1/portal/{c.payment_token}/auth/status", headers={"X-Forwarded-For": "10.20.2.1"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["authenticated"] is False
    assert body["has_password"] is False


# ── setup-password ───────────────────────────────────────────────────────────


def test_setup_password_crea_sesion_y_desbloquea_el_portal(client: TestClient, db):
    c = _make_client(db, email="setup-ok@example.com")
    ip = "10.20.3.1"

    resp = client.post(
        f"/api/v1/portal/{c.payment_token}/auth/setup-password",
        json={"email": c.email, "password": "Nuev4Clave!", "password_confirm": "Nuev4Clave!"},
        headers={"X-Forwarded-For": ip},
    )
    assert resp.status_code == 200

    home = client.get(f"/api/v1/portal/{c.payment_token}", headers={"X-Forwarded-For": ip})
    assert home.status_code == 200

    again = client.post(
        f"/api/v1/portal/{c.payment_token}/auth/setup-password",
        json={"email": c.email, "password": "OtraClave1!", "password_confirm": "OtraClave1!"},
        headers={"X-Forwarded-For": ip},
    )
    assert again.status_code == 409


def test_setup_password_con_correo_distinto_falla(client: TestClient, db):
    c = _make_client(db, email="setup-email-mismatch@example.com")
    resp = client.post(
        f"/api/v1/portal/{c.payment_token}/auth/setup-password",
        json={"email": "otro@example.com", "password": "Nuev4Clave!", "password_confirm": "Nuev4Clave!"},
        headers={"X-Forwarded-For": "10.20.3.2"},
    )
    assert resp.status_code == 401


# ── login ────────────────────────────────────────────────────────────────────


def test_login_credenciales_correctas_abre_sesion(client: TestClient, db):
    c = _make_client(db, email="login-ok@example.com", has_password=True)
    ip = "10.20.4.1"

    resp = client.post(
        f"/api/v1/portal/{c.payment_token}/auth/login",
        json={"email": c.email, "password": "Sup3rSecret!"},
        headers={"X-Forwarded-For": ip},
    )
    assert resp.status_code == 200

    home = client.get(f"/api/v1/portal/{c.payment_token}", headers={"X-Forwarded-For": ip})
    assert home.status_code == 200


def test_login_password_incorrecta(client: TestClient, db):
    c = _make_client(db, email="login-bad-pw@example.com", has_password=True)
    resp = client.post(
        f"/api/v1/portal/{c.payment_token}/auth/login",
        json={"email": c.email, "password": "no-es-esta"},
        headers={"X-Forwarded-For": "10.20.4.2"},
    )
    assert resp.status_code == 401


def test_login_sin_password_configurada(client: TestClient, db):
    c = _make_client(db, email="login-no-pw@example.com")
    resp = client.post(
        f"/api/v1/portal/{c.payment_token}/auth/login",
        json={"email": c.email, "password": "cualquiera"},
        headers={"X-Forwarded-For": "10.20.4.3"},
    )
    assert resp.status_code == 409


def test_login_hash_no_bcrypt_no_revienta_con_500(client: TestClient, db):
    c = _make_client(db, email="login-hash-raro@example.com")
    c.password_hash = "sha256$not-a-bcrypt-hash"
    db.commit()

    resp = client.post(
        f"/api/v1/portal/{c.payment_token}/auth/login",
        json={"email": c.email, "password": "cualquiera"},
        headers={"X-Forwarded-For": "10.20.4.4"},
    )
    assert resp.status_code == 401


# ── Aislamiento entre clientes ───────────────────────────────────────────────


def test_sesion_de_un_cliente_no_abre_el_portal_de_otro(client: TestClient, db):
    a = _make_client(db, email="cliente-a@example.com", has_password=True)
    b = _make_client(db, email="cliente-b@example.com", has_password=True)
    ip = "10.20.5.1"

    login = client.post(
        f"/api/v1/portal/{a.payment_token}/auth/login",
        json={"email": a.email, "password": "Sup3rSecret!"},
        headers={"X-Forwarded-For": ip},
    )
    assert login.status_code == 200

    cross = client.get(f"/api/v1/portal/{b.payment_token}", headers={"X-Forwarded-For": ip})
    assert cross.status_code == 401


# ── Reset por admin ──────────────────────────────────────────────────────────


def test_admin_resetea_password_invalida_sesion_existente(client: TestClient, db, monkeypatch):
    monkeypatch.setenv("MASTER_ADMIN_PIN", "135790")
    c = _make_client(db, email="reset-target@example.com", has_password=True)
    admin = _make_admin(db, "admin-reset@example.com")
    ip = "10.20.6.1"

    login = client.post(
        f"/api/v1/portal/{c.payment_token}/auth/login",
        json={"email": c.email, "password": "Sup3rSecret!"},
        headers={"X-Forwarded-For": ip},
    )
    assert login.status_code == 200
    assert client.get(f"/api/v1/portal/{c.payment_token}", headers={"X-Forwarded-For": ip}).status_code == 200

    _login_staff(client, "admin-reset@example.com", "10.20.6.2")
    reset = client.post(
        f"/api/v1/admin/clients/{c.id}/reset-portal-password",
        json={"pin": "135790"},
        headers={"X-Forwarded-For": "10.20.6.3"},
    )
    assert reset.status_code == 200

    still_in = client.get(f"/api/v1/portal/{c.payment_token}", headers={"X-Forwarded-For": ip})
    assert still_in.status_code == 401

    status_resp = client.get(
        f"/api/v1/portal/{c.payment_token}/auth/status", headers={"X-Forwarded-For": ip}
    )
    assert status_resp.json()["has_password"] is False


# ── portal-abono también exige sesión ───────────────────────────────────────


def test_portal_abono_sin_sesion_devuelve_401(client: TestClient, db):
    c = _make_client(db, email="abono-sin-sesion@example.com")
    resp = client.post(
        "/api/v1/payments/portal-abono",
        data={
            "portal_token": str(c.payment_token),
            "payment_method_id": "1",
            "deposit_account_id": "1",
            "paid_amount": "10.0",
        },
        files={"receipt_file": ("r.png", b"fake", "image/png")},
        headers={"X-Forwarded-For": "10.20.7.1"},
    )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "portal_session_required"
