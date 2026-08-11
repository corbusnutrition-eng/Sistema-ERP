# Guía de Configuración y Despliegue

Esta guía documenta las **variables de entorno**, comandos para desarrollo local y la configuración de despliegue en **Render**.  
**No incluye valores reales de secretos** — configúralos en el panel de Render o en archivos `.env` locales (nunca commitear).

---

## 1. Arquitectura de despliegue (Render)

```
┌─────────────────────────────┐     HTTPS      ┌──────────────────────────────┐
│  Frontend (Static Site)     │ ──────────────►│  Backend (Web Service)        │
│  sistema-erp-1.onrender.com │   VITE_API_*   │  sistema-erp-e2iw.onrender.com│
│  Build: npm run build       │                │  Start: uvicorn app.main:app  │
│  Publish: dist/             │                │  Python 3.9+                  │
└─────────────────────────────┘                └──────────────┬───────────────┘
                                                              │
                                                              ▼
                                               ┌──────────────────────────────┐
                                               │  PostgreSQL (Render DB)       │
                                               │  DATABASE_URL                 │
                                               └──────────────────────────────┘
```

| Servicio Render | Tipo | Rol |
|-----------------|------|-----|
| Backend API | Web Service | FastAPI + Uvicorn |
| Frontend ERP | Static Site | SPA React (Vite) |
| PostgreSQL | Managed DB | Datos persistentes |

**CORS:** el backend en `app/main.py` permite por defecto:
- `https://sistema-erp-1.onrender.com`
- `http://localhost:5173` y `:3000`
- Regex adicional: `https://.*\.onrender\.com` (configurable)

---

## 2. Variables de entorno — Backend

Archivo local: `backend/.env` (cargado automáticamente por `python-dotenv` en `app/main.py`).

### Base de datos

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `DATABASE_URL` | **Sí (prod)** | Connection string PostgreSQL. Formato: `postgresql://user:pass@host:5432/dbname`. Render la inyecta al vincular la DB. Default local: `postgresql://admin:adminpassword@localhost:5432/iptv_erp` |

### Almacenamiento de comprobantes (Cloudinary)

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `CLOUDINARY_CLOUD_NAME` | **Sí** | Nombre del cloud en Cloudinary |
| `CLOUDINARY_API_KEY` | **Sí** | API key |
| `CLOUDINARY_API_SECRET` | **Sí** | API secret |

Sin estas variables, la subida de comprobantes desde portal/ERP fallará.

### Telegram (alertas al equipo)

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `TELEGRAM_BOT_TOKEN` | Opcional | Token del bot de Telegram |
| `TELEGRAM_CHAT_ID` | Opcional | ID del chat/grupo destino |

Si ambas están vacías, las notificaciones Telegram se omiten silenciosamente.

### OCR / IA (análisis de comprobantes)

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `OPENAI_API_KEY` | Opcional | API key OpenAI para OCR de recibos en portal |
| `OPENAI_INVENTORY_VISION_MODEL` | Opcional | Modelo visión inventario (default: `gpt-4o`) |

### Seguridad admin

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `MASTER_ADMIN_PIN` | Recomendada | PIN para operaciones sensibles (ajuste de saldo, etc.) |

> **Nota:** El `SECRET_KEY` JWT está definido en código (`app/jwt_utils.py`). Para producción se recomienda externalizarlo a variable de entorno en una futura mejora de seguridad.

### CORS

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `CORS_ORIGINS` | Opcional | Orígenes extra separados por coma |
| `CORS_ORIGIN_REGEX` | Opcional | Regex de orígenes permitidos (default: `https://.*\.onrender\.com`) |

### Integración catálogo VIP / Render sync

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `CATALOGO_VIP_BASE_URL` | Opcional | URL base del catálogo web externo |
| `CATALOGO_VIP_WEBHOOK_SECRET` | Opcional | Secret para webhooks de sincronización |
| `CATALOGO_VIP_DEFAULT_TEMP_PASSWORD` | Opcional | Contraseña temporal por defecto al crear clientes web |
| `VIP_CATALOG_BRIDGE_URL` | Opcional | URL puente catálogo VIP |
| `VIP_CATALOG_WEBHOOK_SECRET` | Opcional | Secret webhooks bridge |
| `VIP_CATALOG_WEBHOOK_TIMEOUT` | Opcional | Timeout en segundos (default: 15) |
| `PUBLIC_PORTAL_BASE_URL` | Opcional | URL pública base del portal (links en API externa) |

### API externa

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `EXTERNAL_API_KEY` | Opcional | Clave para rutas `/api/v1/external/*` (header `X-API-Key`) |

### Códigos de retiro (integración física)

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `CODIGOS_RETIRO_BASE_URL` | Opcional | URL del servicio de códigos de retiro |
| `CODIGOS_RETIRO_WEBHOOK_API_KEY` | Opcional | API key webhooks entrantes |
| `CODIGOS_RETIRO_ERP_NOTIFY_URL` | Opcional | URL override para notificar al ERP |
| `CODIGOS_RETIRO_ERP_NOTIFY_PATH` | Opcional | Path de notificación |
| `CODIGOS_RETIRO_ERP_NOTIFY_API_KEY` | Opcional | API key saliente hacia códigos retiro |
| `CODIGOS_RETIRO_ERP_NOTIFY_ENABLED` | Opcional | `true`/`false` (default: true) |
| `CODIGOS_RETIRO_ES_PRUEBA` | Opcional | Modo prueba del widget |
| `CODIGOS_RETIRO_ERP_NOTIFY_TIMEOUT` | Opcional | Timeout segundos (default: 12) |

### Alembic (migraciones)

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `DATABASE_URL` | **Sí** | Usada por `alembic/env.py` |
| `ALEMBIC_CONFIG` | Opcional | Path alternativo a `alembic.ini` |

---

## 3. Variables de entorno — Frontend

Vite solo expone variables con prefijo **`VITE_`**.

Archivos:
- `frontend/.env` — desarrollo local
- `frontend/.env.production` — build de producción (Render Static Site)

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `VITE_API_BASE_URL` | **Sí** | URL del backend API. Local: `http://localhost:8000`. Prod: `https://sistema-erp-e2iw.onrender.com` |
| `VITE_CODIGOS_RETIRO_BASE_URL` | Opcional | URL del widget códigos de retiro en portal |
| `VITE_CODIGOS_RETIRO_ES_PRUEBA` | Opcional | `true`/`false` — modo sandbox del widget |

> Las variables `VITE_*` se **incrustan en el bundle** en tiempo de build. Cambiarlas en Render requiere **rebuild** del static site.

---

## 4. Desarrollo local

### Prerrequisitos

- Python 3.9+
- Node.js 18+ (recomendado 20+)
- PostgreSQL local (o contenedor Docker)

### Backend

```bash
# Desde la raíz del proyecto o backend/
cd backend

# Entorno virtual (recomendado)
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

pip install -r requirements.txt

# Configurar backend/.env con DATABASE_URL, Cloudinary, Telegram, etc.

# Migraciones
alembic upgrade head

# Arrancar servidor
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Verificar:
- `GET http://localhost:8000/health` → `{"status":"ok"}`
- Docs OpenAPI: `http://localhost:8000/docs`

### Frontend

```bash
cd frontend
npm install

# frontend/.env debe tener:
# VITE_API_BASE_URL=http://localhost:8000

npm run dev
```

Abrir: `http://localhost:5173`

### Portal de prueba

Accede con el UUID del cliente:
```
http://localhost:5173/portal/<payment_token_del_cliente>
```

El `payment_token` está en la tabla `clients` (columna `payment_token`).

---

## 5. Despliegue en Render

### Backend (Web Service)

| Campo | Valor típico |
|-------|--------------|
| **Root Directory** | `backend` |
| **Build Command** | `pip install -r requirements.txt` |
| **Start Command** | `uvicorn app.main:app --host 0.0.0.0 --port $PORT` |
| **Environment** | Python 3 |

**Variables en Render Dashboard → Environment:**
- `DATABASE_URL` (desde PostgreSQL addon)
- `CLOUDINARY_*` (3 variables)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- `OPENAI_API_KEY` (si usas OCR)
- `MASTER_ADMIN_PIN`
- CORS extras si aplica

**Migraciones en deploy** (opcional, añadir al Build Command):
```bash
pip install -r requirements.txt && alembic upgrade head
```

### Frontend (Static Site)

| Campo | Valor típico |
|-------|--------------|
| **Root Directory** | `frontend` |
| **Build Command** | `npm install && npm run build` |
| **Publish Directory** | `dist` |

**Variables de entorno en Render** (antes del build):
```
VITE_API_BASE_URL=https://<tu-backend>.onrender.com
VITE_CODIGOS_RETIRO_BASE_URL=https://codigos-retiro.onrender.com
VITE_CODIGOS_RETIRO_ES_PRUEBA=false
```

### PostgreSQL

1. Crear PostgreSQL en Render.
2. Vincular `DATABASE_URL` al Web Service del backend.
3. Ejecutar `alembic upgrade head` (build o shell one-off).

---

## 6. Reporte matutino por Telegram (Cron Job)

Script independiente que envía al grupo principal de Telegram un resumen financiero diario:

- **Cuentas por cobrar (deuda firme):** misma lógica que `/contabilidad/cuentas-por-cobrar` (`list_client_ar_firm_obligations_for_report`), agrupada por moneda. Excluye solicitudes en Pendiente o En revisión.
- **Verificación bancaria:** depósitos pendientes por cada **Verificador de Cuentas** activo, según las cuentas asignadas (`accounts.verifier_id`).

Archivo: `backend/scripts/daily_telegram_report.py`

### Variables requeridas

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `DATABASE_URL` | **Sí** | Conexión PostgreSQL (misma que el backend) |
| `TELEGRAM_BOT_TOKEN` | **Sí** | Token del bot |
| `TELEGRAM_CHAT_ID` | **Sí** | ID del grupo principal destino |

### Prueba manual

Desde el directorio `backend/` (con el entorno virtual activado):

```bash
# Ver el mensaje en consola sin enviar
PYTHONPATH=. python3 scripts/daily_telegram_report.py --dry-run

# Enviar al grupo de Telegram
PYTHONPATH=. python3 scripts/daily_telegram_report.py
```

### Programación Cron (9:00 AM Ecuador)

Ecuador (`America/Guayaquil`, UTC−5 sin DST) corresponde a **14:00 UTC**. Expresión cron:

```cron
0 14 * * *
```

Ejemplo en crontab del servidor (ajusta rutas):

```cron
0 14 * * * cd /ruta/sistema_facturacion/backend && PYTHONPATH=. /ruta/venv/bin/python3 scripts/daily_telegram_report.py >> /var/log/erp-daily-report.log 2>&1
```

### Render Cron Job (opcional)

Si usas un **Cron Job** en Render vinculado al mismo repositorio:

| Campo | Valor típico |
|-------|--------------|
| **Root Directory** | `backend` |
| **Schedule** | `0 14 * * *` |
| **Command** | `PYTHONPATH=. python scripts/daily_telegram_report.py` |

Variables de entorno: las mismas del Web Service (`DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).

> El script es **solo lectura** (consultas + envío Telegram). No modifica asientos contables ni journal entries.

---

## 7. Checklist post-despliegue

- [ ] `GET /health` responde OK en backend
- [ ] Login ERP funciona (`/login`)
- [ ] Frontend carga y las peticiones API no tienen error CORS
- [ ] Subida de comprobante funciona (Cloudinary configurado)
- [ ] Portal accesible con token UUID
- [ ] Telegram recibe alertas de prueba (si configurado)
- [ ] Reporte matutino probado con `--dry-run` y cron `0 14 * * *` configurado (opcional)
- [ ] Migraciones aplicadas (`alembic current`)

---

## 8. Seguridad — buenas prácticas

1. **Nunca commitear** `.env` con secretos reales — usar `.gitignore`.
2. Rotar `TELEGRAM_BOT_TOKEN`, `CLOUDINARY_API_SECRET`, `EXTERNAL_API_KEY` periódicamente.
3. `MASTER_ADMIN_PIN` solo en backend; no exponer al frontend.
4. Revisar `CORS_ORIGINS` — no usar `*` con credenciales.
5. Considerar mover `SECRET_KEY` JWT a variable de entorno en producción.

---

## 9. Comandos útiles

```bash
# Tests backend
cd backend && pytest

# Build frontend local
cd frontend && npm run build && npm run preview

# Estado migraciones
cd backend && alembic current && alembic history --verbose

# Reporte matutino Telegram (dry-run)
cd backend && PYTHONPATH=. python3 scripts/daily_telegram_report.py --dry-run

# Logs Render (CLI)
render logs -s <nombre-servicio-backend>
```

---

## 10. Documentación relacionada

| Archivo | Contenido |
|---------|-----------|
| `backend/DOCUMENTACION_BACKEND.md` | Arquitectura API, modelos, servicios |
| `frontend/DOCUMENTACION_FRONTEND.md` | Rutas React, estado, flujos UI |
| `http://localhost:8000/docs` | OpenAPI interactivo (Swagger) |

---

*Última actualización: generada a partir del análisis del repositorio.*
