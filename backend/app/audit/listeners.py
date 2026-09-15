"""
Captura real de la auditoría: event listeners de ``sqlalchemy.orm.Session``.

Por qué event listeners y no un mixin en los modelos ni llamadas explícitas
en los servicios: ver la cabecera de ``app.audit`` y el plan de seguridad.
En resumen — cobertura total del unit of work sin tocar un solo modelo ni
servicio existente, y es el único punto donde el valor ANTERIOR de una
columna (``history.deleted``) está disponible.

Ciclo (ver también R1-R8 en el plan — invariantes ACID que este diseño
protege deliberadamente):

    before_flush   → calcula el diff, lo acumula en session.info["_audit_buffer"]
    after_flush    → resuelve entity_id de los INSERT (la PK ya está poblada)
    before_commit  → session.flush() de lo pendiente + UN SOLO INSERT Core
                     con todas las filas acumuladas, en la MISMA transacción
                     que el negocio. Cero commits adicionales.
    after_commit /
    after_rollback → limpia el buffer en memoria (nunca debe sobrevivir a la
                     transacción: en rollback, además, los datos ya nunca se
                     escribieron — el INSERT de auditoría vivía en la misma
                     transacción abortada).

Kill switches (variables de entorno, no requieren desplegar):
    AUDIT_ENABLED=0  → desactiva toda la captura (cero coste).
    AUDIT_STRICT=1   → un fallo en el listener propaga la excepción en vez
                       de tragarla (solo para tests/staging).
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

from sqlalchemy import event, inspect as sa_inspect
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import get_history

from app.audit.context import current_audit_context
from app.audit.scope import AUDITED
from app.audit.serialization import redact_and_serialize
from app.models.audit_log import AuditLog
from app.timezone_utils import now_utc

logger = logging.getLogger("app.audit")

_BUFFER_KEY = "_audit_buffer"
_BULK_SEQ_KEY = "_audit_bulk_seq"


def _audit_enabled() -> bool:
    return (os.getenv("AUDIT_ENABLED", "1").strip() or "1") not in ("0", "false", "False")


def _audit_strict() -> bool:
    return (os.getenv("AUDIT_STRICT", "0").strip() or "0") in ("1", "true", "True")


def _buffer(session: Session) -> dict[Any, dict[str, Any]]:
    buf = session.info.get(_BUFFER_KEY)
    if buf is None:
        buf = {}
        session.info[_BUFFER_KEY] = buf
    return buf


def _clear_buffer(session: Session) -> None:
    session.info[_BUFFER_KEY] = {}


def _pk_attr_keys(mapper) -> list[str]:
    pk_columns = set(mapper.primary_key)
    return [prop.key for prop in mapper.column_attrs if prop.columns[0] in pk_columns]


def _entity_id_from_obj(obj: Any, mapper) -> Optional[str]:
    values = [getattr(obj, key, None) for key in _pk_attr_keys(mapper)]
    if not values or any(v is None for v in values):
        return None
    return "|".join(str(v) for v in values)


def _full_snapshot(obj: Any, mapper) -> dict[str, Any]:
    return {
        prop.key: redact_and_serialize(prop.key, getattr(obj, prop.key, None))
        for prop in mapper.column_attrs
    }


def _capture_insert(session: Session, obj: Any, table: str, mapper) -> None:
    # El snapshot NO se toma aquí: en before_flush el objeto todavía no tiene
    # ni su PK ni los valores por defecto que SQLAlchemy aplica al compilar el
    # INSERT (server_default / default= de columna) — se capturaría "id: None"
    # y cualquier columna con default implícito quedaría vacía. Se resuelve
    # completo en after_flush, cuando el objeto ya refleja la fila real.
    buf = _buffer(session)
    buf[id(obj)] = {
        "obj": obj,  # referencia fuerte: evita GC + reciclado de id() dentro de la transacción
        "mapper": mapper,
        "table": table,
        "action": "insert",
        "entity_id": None,
        "before": None,
        "after": None,
        "changed_fields": None,
    }


def _capture_update(session: Session, obj: Any, table: str, mapper) -> None:
    changed: dict[str, Any] = {}
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    for prop in mapper.column_attrs:
        key = prop.key
        # Passive por defecto (sin restringir): si el atributo está expirado
        # pero AÚN NO se sobrescribió, get_history() dispara un SELECT y
        # compara correctamente contra el valor real. Cubre el patrón real
        # del ERP: una Session por request (get_db()), el objeto se carga
        # fresco vía query y se muta antes de cualquier commit, así que nunca
        # llega expirado a la primera vez que se toca.
        #
        # Límite conocido (no un caso real en este código): si el MISMO
        # objeto Python se reutiliza tras un commit previo en la misma
        # Session y se sobrescribe un atributo expirado SIN leerlo antes,
        # SQLAlchemy ya no tiene "antes" que comparar — antes de eso, el
        # `set` ocurre a ciegas. Solo importa para scripts/tests que reusan
        # una Session larga entre varios commits sin volver a consultar el
        # objeto (ver test_update_registra_solo_campos_cambiados).
        hist = get_history(obj, key)
        if not hist.added and not hist.deleted:
            continue  # sin cambio neto en esta columna (p. ej. obj.x = obj.x)
        old_val = hist.deleted[0] if hist.deleted else None
        new_val = hist.added[0] if hist.added else getattr(obj, key, None)
        if old_val == new_val:
            continue  # comparación de valores igual de estricta que el flush real
        before[key] = redact_and_serialize(key, old_val)
        after[key] = redact_and_serialize(key, new_val)
        changed[key] = True

    if not changed:
        return  # ruido cero: sin columnas realmente modificadas, no se emite fila

    buf = _buffer(session)
    entry = buf.get(id(obj))
    if entry is None:
        buf[id(obj)] = {
            "obj": obj,
            "mapper": mapper,
            "table": table,
            "action": "update",
            "entity_id": _entity_id_from_obj(obj, mapper),
            "before": before,
            "after": after,
            "changed_fields": set(changed.keys()),
        }
    elif entry["action"] == "insert":
        # El objeto se insertó en un flush anterior de ESTA MISMA transacción
        # y ahora se modifica antes del commit: sigue siendo un insert neto
        # (la fila no existía antes de la transacción). No hay "before" que
        # anotar — after_flush ya recalcula el snapshot final completo en
        # cada pasada, así que aquí no hace falta tocar nada más.
        return
    else:
        # Coalescencia: mismo objeto modificado en varios flushes de la misma
        # transacción → 1 sola fila, con el `before` más antiguo y el `after` final.
        for key in changed:
            entry["after"][key] = after[key]
            if key not in entry["before"]:
                entry["before"][key] = before[key]
        entry["changed_fields"] = (entry.get("changed_fields") or set()) | set(changed.keys())


def _capture_delete(session: Session, obj: Any, table: str, mapper) -> None:
    buf = _buffer(session)
    buf[id(obj)] = {
        "obj": obj,
        "mapper": mapper,
        "table": table,
        "action": "delete",
        # La PK se captura AHORA: tras el flush el objeto pasa a "deleted" y
        # su identidad ya no es fiable de leer.
        "entity_id": _entity_id_from_obj(obj, mapper),
        "before": _full_snapshot(obj, mapper),
        "after": None,
        "changed_fields": None,
    }


def _before_flush(session: Session, flush_context: Any, instances: Any) -> None:
    if not _audit_enabled():
        return
    try:
        for obj in list(session.new):
            table = type(obj).__tablename__ if hasattr(type(obj), "__tablename__") else None
            if table not in AUDITED:
                continue
            _capture_insert(session, obj, table, sa_inspect(obj).mapper)

        for obj in list(session.dirty):
            if not session.is_modified(obj, include_collections=False):
                continue
            table = type(obj).__tablename__ if hasattr(type(obj), "__tablename__") else None
            if table not in AUDITED:
                continue
            _capture_update(session, obj, table, sa_inspect(obj).mapper)

        for obj in list(session.deleted):
            table = type(obj).__tablename__ if hasattr(type(obj), "__tablename__") else None
            if table not in AUDITED:
                continue
            _capture_delete(session, obj, table, sa_inspect(obj).mapper)
    except Exception:
        logger.exception("Fallo capturando diff de auditoría en before_flush")
        if _audit_strict():
            raise


def _after_flush(session: Session, flush_context: Any) -> None:
    if not _audit_enabled():
        return
    try:
        buf = _buffer(session)
        for entry in buf.values():
            if entry["action"] != "insert":
                continue
            obj = entry.get("obj")
            mapper = entry.get("mapper")
            if obj is None or mapper is None:
                continue
            # La PK ya está poblada (post-fetch/RETURNING del INSERT) y los
            # defaults de columna ya se aplicaron: recién ahora el snapshot
            # refleja la fila real persistida.
            entry["entity_id"] = _entity_id_from_obj(obj, mapper)
            entry["after"] = _full_snapshot(obj, mapper)
    except Exception:
        logger.exception("Fallo resolviendo entity_id de auditoría en after_flush")
        if _audit_strict():
            raise


def _do_orm_execute(orm_execute_state: Any) -> None:
    """
    Intercepta ``query.update()``/``query.delete()`` (bulk), que el unit of
    work NO ve — antes de este listener, esas operaciones eran un hueco
    silencioso en la bitácora.

    No hay before/after fila a fila sin un SELECT previo carísimo (y ese
    SELECT tendría el mismo problema de ventana-de-lock que ``load_history``
    dentro de la cascada BaaS): se deja constancia del criterio SQL en
    ``meta``, degradación consciente y documentada, no un hueco silencioso.
    """
    if not _audit_enabled():
        return
    if orm_execute_state.is_select:
        return
    if not (orm_execute_state.is_update or orm_execute_state.is_delete):
        return
    try:
        bind_mapper = orm_execute_state.bind_mapper
        table = getattr(getattr(bind_mapper, "local_table", None), "name", None)
        if table not in AUDITED:
            return
        session = orm_execute_state.session
        stmt = orm_execute_state.statement
        try:
            sql_text = str(stmt.compile(compile_kwargs={"literal_binds": False}))
        except Exception:
            sql_text = str(stmt)
        seq = session.info.get(_BULK_SEQ_KEY, 0) + 1
        session.info[_BULK_SEQ_KEY] = seq
        buf = _buffer(session)
        buf[("bulk", seq)] = {
            "obj": None,
            "mapper": None,
            "table": table,
            "action": "bulk_delete" if orm_execute_state.is_delete else "bulk_update",
            "entity_id": None,
            "before": None,
            "after": None,
            "changed_fields": None,
            "meta": {"sql": sql_text[:4000]},
        }
    except Exception:
        logger.exception("Fallo interceptando operación bulk para auditoría")
        if _audit_strict():
            raise


def _build_rows(session: Session) -> list[dict[str, Any]]:
    ctx = current_audit_context()
    rows: list[dict[str, Any]] = []
    now = now_utc()
    for entry in _buffer(session).values():
        changed_fields = entry.get("changed_fields")
        rows.append(
            {
                "timestamp": now,
                "actor_type": (ctx.actor_type if ctx else "system"),
                "actor_id": (ctx.actor_id if ctx else None),
                "actor_label": (ctx.actor_label if ctx else None),
                "ip": (ctx.ip if ctx else None),
                "user_agent": (ctx.user_agent if ctx else None),
                "request_id": (ctx.request_id if ctx else None),
                "action": entry["action"],
                "entity_table": entry["table"],
                "entity_id": entry.get("entity_id"),
                "before": entry.get("before"),
                "after": entry.get("after"),
                "changed_fields": sorted(changed_fields) if changed_fields else None,
                "meta": entry.get("meta") or ((ctx.meta or None) if ctx else None),
            }
        )
    return rows


def _before_commit(session: Session) -> None:
    if not _audit_enabled():
        return
    try:
        # `before_commit` se dispara ANTES del flush-guard loop propio de
        # `commit()` (SessionTransaction._prepare_impl): si no forzamos el
        # flush aquí, los objetos añadidos y nunca flusheados no habrían
        # pasado por `before_flush` y no se auditarían. Ese flush lo iba a
        # hacer el commit de todos modos, microsegundos después — no añade
        # una sola sentencia SQL de negocio extra.
        if not session._is_clean():  # noqa: SLF001 - mismo chequeo que usa SQLAlchemy internamente
            session.flush()

        rows = _build_rows(session)
        _clear_buffer(session)  # nunca debe sobrevivir a esta transacción

        if not rows:
            return

        session.execute(AuditLog.__table__.insert(), rows)
    except Exception:
        logger.exception("Fallo emitiendo la bitácora de auditoría (no se aborta la transacción)")
        _clear_buffer(session)
        if _audit_strict():
            raise


def _after_commit(session: Session) -> None:
    _clear_buffer(session)


def _after_soft_rollback(session: Session, previous_transaction: Any) -> None:
    # El rollback descarta el trabajo de negocio; la auditoría debe descartarse
    # igual — una fila diciendo "se creó la venta 812" cuando la venta nunca
    # se persistió sería una mentira forense.
    _clear_buffer(session)


_installed = False


def install_audit_listeners() -> None:
    """Idempotente: registra los listeners una sola vez por proceso."""
    global _installed
    if _installed:
        return
    event.listen(Session, "before_flush", _before_flush)
    event.listen(Session, "after_flush", _after_flush)
    event.listen(Session, "do_orm_execute", _do_orm_execute)
    event.listen(Session, "before_commit", _before_commit)
    event.listen(Session, "after_commit", _after_commit)
    event.listen(Session, "after_soft_rollback", _after_soft_rollback)
    _installed = True
