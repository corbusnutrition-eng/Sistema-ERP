#!/bin/sh
# Punto de entrada del contenedor backend: aplica migraciones pendientes
# antes de arrancar la API, así cada despliegue (incluyendo migraciones
# futuras) queda cubierto sin pasos manuales extra.
set -e

echo "INFO: aplicando migraciones (alembic upgrade head)..."
alembic upgrade head

echo "INFO: iniciando uvicorn..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'
