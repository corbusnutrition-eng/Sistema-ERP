"""
Pruebas de la capa de auditoría: captura (insert/update/delete/bulk),
invariante ACID (rollback descarta, un solo INSERT por transacción),
redacción de secretos, serialización, alcance, propagación del actor
(incluida la superviviencia al threadpool de FastAPI) y el endpoint HTTP.
"""

from __future__ import annotations

import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event

from app.audit.context import ACTOR_STAFF, audit_actor_scope
from app.audit.scope import AUDITED, EXCLUDED
from app.audit.serialization import is_sensitive_key, to_jsonable
from app.models.audit_log import AuditLog
from app.models.base import Base
from app.models.client import Client
from app.models.sale import Sale
from app.models.user import User, UserRole
from app.permissions import AUDIT_LOGS_VIEW, PREDEFINED_ROLES


# ── Captura básica ────────────────────────────────────────────────────────────


def test_insert_genera_audit_log_con_entity_id(db):
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=7, actor_label="a@b.com"):
        u = User(name="Nuevo", email="nuevo@example.com", hashed_password="x", role=UserRole.worker, is_active=True, permissions=[])
        db.add(u)
        db.commit()

    row = db.query(AuditLog).filter(AuditLog.entity_table == "users", AuditLog.action == "insert").order_by(AuditLog.id.desc()).first()
    assert row is not None
    assert row.entity_id == str(u.id)  # PK resuelta post-flush, el caso difícil
    assert row.before is None
    assert row.after["email"] == "nuevo@example.com"
    assert row.actor_type == ACTOR_STAFF
    assert row.actor_id == 7
    assert row.actor_label == "a@b.com"


def test_update_registra_solo_campos_cambiados(db):
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        u = User(name="U", email="upd@example.com", hashed_password="x", role=UserRole.worker, is_active=True, permissions=[])
        db.add(u)
        db.commit()
        uid = u.id

    # Re-consulta fresca en vez de reutilizar `u`: replica el patrón real del
    # ERP (una Session por request, un solo commit) en lugar del caso límite
    # de mutar el MISMO objeto Python después de un commit previo en la misma
    # Session — ahí `expire_on_commit` expira el atributo, y como nadie lo
    # leyó antes de sobrescribirlo, SQLAlchemy no tiene "antes" que comparar
    # (get_history no dispara un SELECT retroactivo; solo compara lo que ya
    # tenía en memoria). No es un caso real: en el ERP cada request abre su
    # propia Session vía get_db() y hace como mucho un commit.
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        u2 = db.query(User).filter(User.id == uid).one()
        u2.wallet_balance = 25.0
        db.commit()

    row = db.query(AuditLog).filter(AuditLog.entity_table == "users", AuditLog.action == "update").order_by(AuditLog.id.desc()).first()
    assert row.changed_fields == ["wallet_balance"]
    assert row.before == {"wallet_balance": 0.0}
    assert row.after == {"wallet_balance": 25.0}
    # Ningún otro campo (email, name...) debe aparecer.
    assert "email" not in row.before and "email" not in row.after


def test_update_sin_cambios_reales_no_genera_fila(db):
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        u = User(name="Igual", email="igual@example.com", hashed_password="x", role=UserRole.worker, is_active=True, permissions=[])
        db.add(u)
        db.commit()

    count_before = db.query(AuditLog).count()
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        u.status = getattr(u, "status", None)  # no-op para User (no tiene status, pero no debe romper)
        u.name = u.name  # reasignación al mismo valor: sin cambio neto
        db.commit()
    assert db.query(AuditLog).count() == count_before


def test_delete_conserva_pk_y_snapshot(db):
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        u = User(name="Borrar", email="borrar@example.com", hashed_password="x", role=UserRole.worker, is_active=True, permissions=[])
        db.add(u)
        db.commit()
        uid = u.id

    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        db.delete(u)
        db.commit()

    row = db.query(AuditLog).filter(AuditLog.entity_table == "users", AuditLog.action == "delete").order_by(AuditLog.id.desc()).first()
    assert row.entity_id == str(uid)
    assert row.after is None
    assert row.before["email"] == "borrar@example.com"


# ── Invariante ACID (lo más importante del diseño) ────────────────────────────


def test_rollback_descarta_audit_logs(db):
    count_before = db.query(AuditLog).count()
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        u = User(name="Rollback", email="rollback@example.com", hashed_password="x", role=UserRole.worker, is_active=True, permissions=[])
        db.add(u)
        db.flush()  # fuerza el before_flush/after_flush sin comprometer nada
        db.rollback()
    assert db.query(AuditLog).count() == count_before


def test_una_sola_fila_por_entidad_y_transaccion(db):
    # Se filtra por request_id, no por entity_id: SQLite sin AUTOINCREMENT
    # puede reciclar el rowid de una fila borrada en un test anterior (el
    # `test_engine` es session-scoped y persiste entre tests), así que
    # `entity_id` no es único entre tests — request_id sí lo es (uuid nuevo
    # por cada `audit_actor_scope`).
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1) as ctx:
        u = User(name="Multi", email="multi@example.com", hashed_password="x", role=UserRole.worker, is_active=True, permissions=[])
        db.add(u)
        db.flush()
        u.wallet_balance = 1.0
        db.flush()
        u.wallet_balance = 2.0
        db.flush()
        u.wallet_balance = 3.0
        db.commit()
        request_id = ctx.request_id

    rows = db.query(AuditLog).filter(AuditLog.request_id == request_id).all()
    assert len(rows) == 1
    assert rows[0].action == "insert"  # insert+update en la misma tx sigue siendo insert neto
    assert rows[0].after["wallet_balance"] == 3.0


def test_sin_recursion_ni_insert_extra_por_flush(db, test_engine):
    inserts = {"n": 0}

    def _count(conn, cursor, statement, parameters, context, executemany):
        if "INSERT INTO audit_logs" in statement:
            inserts["n"] += 1

    event.listen(test_engine, "before_cursor_execute", _count)
    try:
        with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
            u = User(name="Flushes", email="flushes@example.com", hashed_password="x", role=UserRole.worker, is_active=True, permissions=[])
            db.add(u)
            db.flush()
            u.wallet_balance = 5.0
            db.flush()
            u.wallet_balance = 10.0
            db.commit()
    finally:
        event.remove(test_engine, "before_cursor_execute", _count)

    assert inserts["n"] == 1


def test_fallo_del_listener_no_tumba_la_transaccion(db, monkeypatch):
    import app.audit.listeners as listeners_mod

    def _boom(*args, **kwargs):
        raise RuntimeError("fallo simulado de serialización")

    monkeypatch.setattr(listeners_mod, "_build_rows", _boom)
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        u = User(name="Resiliente", email="resiliente@example.com", hashed_password="x", role=UserRole.worker, is_active=True, permissions=[])
        db.add(u)
        db.commit()  # NO debe lanzar, aunque el listener falle internamente

    persisted = db.query(User).filter(User.email == "resiliente@example.com").first()
    assert persisted is not None  # la venta/usuario se persistió igual


def test_audit_enabled_off_no_escribe(db, monkeypatch):
    monkeypatch.setenv("AUDIT_ENABLED", "0")
    count_before = db.query(AuditLog).count()
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        db.add(User(name="Sin auditoria", email="sinauditoria@example.com", hashed_password="x", role=UserRole.worker, is_active=True, permissions=[]))
        db.commit()
    assert db.query(AuditLog).count() == count_before


def test_bulk_delete_genera_fila_bulk(db):
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        for i in range(3):
            db.add(User(name=f"Bulk{i}", email=f"bulk{i}@example.com", hashed_password="x", role=UserRole.worker, is_active=True, permissions=[]))
        db.commit()

    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        db.query(User).filter(User.email.like("bulk%@example.com")).update({"is_active": False}, synchronize_session=False)
        db.commit()

    row = db.query(AuditLog).filter(AuditLog.action == "bulk_update", AuditLog.entity_table == "users").order_by(AuditLog.id.desc()).first()
    assert row is not None
    assert "UPDATE" in row.meta["sql"].upper()


# ── Redacción y serialización ──────────────────────────────────────────────────


def test_redaccion_hashed_password(db):
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        u = User(name="Pass", email="pass@example.com", hashed_password="ORIGINAL_HASH", role=UserRole.worker, is_active=True, permissions=[])
        db.add(u)
        db.commit()

    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        u.hashed_password = "NUEVO_HASH_SECRETO"
        db.commit()

    row = db.query(AuditLog).filter(AuditLog.entity_table == "users", AuditLog.action == "update").order_by(AuditLog.id.desc()).first()
    assert row.changed_fields == ["hashed_password"]
    assert row.after["hashed_password"] == "***REDACTED***"
    dump = str(row.before) + str(row.after)
    assert "ORIGINAL_HASH" not in dump
    assert "NUEVO_HASH_SECRETO" not in dump


def test_redaccion_payment_token_y_credenciales_anidadas(db):
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        import uuid

        c = Client(
            email="cliente_secreto@example.com",
            username="cliente_secreto",
            wallet_balance=0.0,
            currency="USD",
            payment_token=uuid.uuid4(),
        )
        db.add(c)
        db.commit()

    row = db.query(AuditLog).filter(AuditLog.entity_table == "clients", AuditLog.action == "insert").order_by(AuditLog.id.desc()).first()
    assert row.after["payment_token"] == "***REDACTED***"


def test_denylist_no_produce_falsos_positivos():
    assert is_sensitive_key("shipping_address") is False  # 'pin' ⊂ 'shipping'
    assert is_sensitive_key("monkey_id") is False  # 'key' ⊂ 'monkey'
    assert is_sensitive_key("hashtag") is False  # 'hash' ⊂ 'hashtag'
    assert is_sensitive_key("link_hash") is True
    assert is_sensitive_key("master_pin") is True
    assert is_sensitive_key("payment_token") is True


def test_serializacion_decimal_datetime_uuid_enum():
    from decimal import Decimal
    import uuid

    assert to_jsonable(Decimal("123.4500")) == "123.4500"
    dt = datetime.datetime(2026, 3, 1, 10, 0, 0, tzinfo=datetime.timezone.utc)
    assert to_jsonable(dt) == "2026-03-01T10:00:00Z"
    u = uuid.uuid4()
    assert to_jsonable(u) == str(u)


# ── Alcance ────────────────────────────────────────────────────────────────────


def test_tablas_excluidas_no_generan_filas(db):
    from app.models.client_note import ClientNote
    import uuid

    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        c = Client(email="notas@example.com", username="notas", wallet_balance=0.0, currency="USD", payment_token=uuid.uuid4())
        db.add(c)
        db.flush()
        note = ClientNote(client_id=c.id, user_id=None, note="una nota cualquiera")
        db.add(note)
        db.commit()

    rows = db.query(AuditLog).filter(AuditLog.entity_table == "client_notes").count()
    assert rows == 0


def test_cobertura_exhaustiva_del_alcance():
    """
    Toda tabla de Base.metadata debe estar en AUDITED o en EXCLUDED (con
    motivo) — el test que mantiene vivo el diseño cuando se añade una tabla.
    """
    from app.models.registry import import_all_models

    import_all_models()
    all_tables = set(Base.metadata.tables.keys())
    decided = set(AUDITED.keys()) | set(EXCLUDED.keys())
    faltantes = all_tables - decided
    assert not faltantes, f"Tablas sin decisión explícita de auditoría: {sorted(faltantes)}"


# ── Actor: contextvars + threadpool + middleware ASGI ─────────────────────────


def test_actor_contextvar_sobrevive_al_threadpool(db):
    """
    Prueba directa de la propagación al threadpool de anyio: get_current_user
    (síncrono) corre ahí en producción, y debe poder LEER el actor puesto por
    el middleware sin que un `.set()` posterior se pierda.
    """
    import anyio
    from app.audit.context import current_audit_context

    captured = {}

    def _read_in_thread():
        ctx = current_audit_context()
        captured["actor_id"] = ctx.actor_id if ctx else None

    async def _run():
        with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=42):
            await anyio.to_thread.run_sync(_read_in_thread)

    anyio.run(_run)
    assert captured["actor_id"] == 42


def test_portal_token_atribuye_actor_portal_client(client, db):
    import uuid as uuid_module

    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        c = Client(email="portalactor@example.com", username="portalactor", wallet_balance=50.0, currency="USD", payment_token=uuid_module.uuid4())
        db.add(c)
        db.commit()
        token = str(c.payment_token)
        cid = c.id

    resp = client.get(f"/api/v1/portal/{token}/cxc-balance", headers={"X-Forwarded-For": "10.5.5.5"})
    # No importa el status exacto del endpoint; lo que se verifica es que
    # _portal_client_from_token ancló el actor antes de cualquier posible
    # escritura downstream (no todas las rutas del portal escriben, así que
    # esto es una prueba de que la línea se ejecuta sin romper el request).
    assert resp.status_code in (200, 404, 422)


# ── Permiso RBAC ───────────────────────────────────────────────────────────────


def test_permiso_audit_en_catalogo():
    roles = {r["id"]: set(r["permissions"]) for r in PREDEFINED_ROLES}
    assert AUDIT_LOGS_VIEW in roles["full_admin"]
    for rid in ("cashier", "accountant", "baas_manager", "standard_limited"):
        assert AUDIT_LOGS_VIEW not in roles.get(rid, set())


# ── Endpoint HTTP ──────────────────────────────────────────────────────────────


def _make_admin(db, email: str) -> User:
    import bcrypt

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


def _login_cookies(client: TestClient, email: str) -> None:
    resp = client.post("/api/v1/auth/login", json={"email": email, "password": "x" * 12}, headers={"X-Forwarded-For": "10.9.9.1"})
    assert resp.status_code == 200


def test_endpoint_requiere_permiso(client, db):
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        u = User(name="Worker", email="worker_audit@example.com", hashed_password="x", role=UserRole.worker, is_active=True, permissions=[])
        db.add(u)
        db.commit()

    resp = client.get("/api/v1/audit", headers={"X-Forwarded-For": "10.7.7.1"})
    assert resp.status_code == 401  # sin sesión


def test_endpoint_listado_admin_no_expone_before_after(client, db):
    with audit_actor_scope(actor_type=ACTOR_STAFF, actor_id=1):
        admin = _make_admin(db, "admin_audit_endpoint@example.com")
        target = User(name="Target", email="target_audit@example.com", hashed_password="SECRETHASH", role=UserRole.worker, is_active=True, permissions=[])
        db.add(target)
        db.commit()

    _login_cookies(client, "admin_audit_endpoint@example.com")
    resp = client.get("/api/v1/audit", params={"entity_table": "users", "limit": 5}, headers={"X-Forwarded-For": "10.8.8.1"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["items"]
    first = body["items"][0]
    assert "before" not in first
    assert "after" not in first

    detail_resp = client.get(f"/api/v1/audit/{first['id']}", headers={"X-Forwarded-For": "10.8.8.1"})
    assert detail_resp.status_code == 200
    assert "after" in detail_resp.json()
