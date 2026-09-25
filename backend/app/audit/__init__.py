"""
Bitácora de auditoría (before/after) — ver ``docs`` en cada submódulo:

- ``context``: propagación del actor vía ``contextvars`` (petición HTTP,
  portal público, webhooks, scripts/cron).
- ``serialization``: redacción de secretos + JSON-safe (Decimal/datetime/UUID/Enum).
- ``scope``: qué tablas se auditan y por qué se excluyen las demás.
- ``listeners``: captura real vía eventos de ``Session`` (before_flush /
  after_flush / before_commit / do_orm_execute).
- ``middleware``: middleware ASGI puro que abre el contexto por petición.
- ``forensic``: canal aparte para eventos que NO deben desaparecer con un
  rollback (login fallido, permiso denegado, PIN usado...).
"""
