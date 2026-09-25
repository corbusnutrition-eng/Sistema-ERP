# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

ERP de facturación para un negocio de IPTV/BaaS (Billing-as-a-Service): ventas, cuentas por cobrar, inventario de pantallas/cuentas IPTV, contabilidad de doble partida, y una red de distribuidores multinivel (MLM) con billeteras virtuales y comisiones en cascada. Dos partes independientes:

- **`backend/`** — API FastAPI + SQLAlchemy + PostgreSQL (real ERP; ver `backend/DOCUMENTACION_BACKEND.md`)
- **`frontend/`** — SPA React 19 + Vite (ver `frontend/DOCUMENTACION_FRONTEND.md`)

El directorio `app/` en la raíz **no** es el backend real: es un stub legacy que delega a `backend/app/main.py` para que `uvicorn app.main:app` funcione si se arranca desde la raíz por error. Trabaja siempre desde `backend/`.

Para variables de entorno y despliegue (Render, y Docker/VPS + CI por SSH — ver §11), consultar `GUIA_DESPLIEGUE.md`.

## Commands

### Backend (desde `backend/`)

```bash
pip install -r requirements.txt
alembic upgrade head                              # migraciones
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

pytest                                             # toda la suite (SQLite in-memory por defecto)
pytest tests/test_baas_commission_cascade.py       # un archivo
pytest tests/test_baas_commission_cascade.py::test_name -v   # un test
pytest -m concurrency                              # solo pruebas de estrés/concurrencia BaaS
alembic current && alembic history --verbose       # estado de migraciones
PYTHONPATH=. python3 scripts/daily_telegram_report.py --dry-run   # reporte matutino Telegram, sin enviar
```

Los tests corren contra SQLite en memoria salvo que `TEST_DATABASE_URL` o `DATABASE_URL` apunten a PostgreSQL (`backend/tests/conftest.py`).

### Frontend (desde `frontend/`)

```bash
npm install
npm run dev        # http://localhost:5173
npm run build
npm run lint
npm run preview
```

### Docker (build/prueba local de las imágenes de despliegue)

```bash
docker build -t erp-backend ./backend      # entrypoint corre `alembic upgrade head` antes de uvicorn
docker build -t erp-frontend ./frontend \
  --build-arg VITE_API_BASE_URL=http://localhost:8000   # VITE_* se incrustan en build, no en runtime

docker compose -f docker-compose.prod.yml config         # valida el stack de VPS (sin levantarlo)
```

`docker-compose.yml` (raíz) es solo el Postgres de desarrollo local. `docker-compose.prod.yml` es el stack real de VPS (backend + frontend, sin Postgres — la DB vive fuera) y requiere `backend/.env` con secretos reales; ver `GUIA_DESPLIEGUE.md` §11.

## Architecture

### Backend — capas (`backend/app/`)

`api/v1/*.py` (routers, ~34 módulos) → `schemas/*.py` (Pydantic) → `services/*.py` (~45 módulos, lógica de negocio y transacciones) → `models/*.py` (SQLAlchemy, ~31 entidades). `security/*.py` cruza capas para validaciones de dinero, PIN maestro y anti-fraude OCR del portal.

`baas_commission_cascade_service` **no hace commit propio** (solo `db.add`/`flush`): el router orquesta un único `db.commit()`/`rollback()` por request, así la venta y la cascada de comisiones quedan en una sola transacción ACID. `portal_auto_purchase_service` sí ejecuta su propio `db.commit()` al final (línea ~461) — es él quien cierra esa transacción, no el router.

La bitácora de auditoría (`app/audit/`, ver `backend/DOCUMENTACION_BACKEND.md` §Auditoría) captura before/after vía event listeners de `Session` en la misma transacción que el negocio: un rollback descarta también las filas de auditoría, nunca hace un commit adicional.

### Núcleo de dominio (BaaS)

- `clients` es un árbol vía `parent_id` (red de subdistribuidores) y tiene `payment_token` (UUID), el link permanente `/portal/{token}`. Ya no basta por sí solo: además hace falta una sesión de portal (correo + contraseña, o "crear tu contraseña" la primera vez — `client.password_hash`, compartido con catalogo-vip) guardada en una cookie HttpOnly **por cliente** (`erp_portal_{id}`, scope `/api/v1`, `app/security/portal_session.py`), gateada a nivel de router en `api/v1/portal.py`. Sigue sin ser JWT de staff — es la frontera de seguridad entre staff (cookie `erp_access_token`, scope `/`) y clientes (token en URL + cookie de portal propia); el frontend del portal (`ClientPortalPage.jsx`) usa `withCredentials: true` solo contra `/api/v1`, nunca la cookie de staff.
- `baas_commission_cascade_service.py` recorre el árbol hacia arriba desde el comprador (`SELECT FOR UPDATE` en cada nivel), acredita el spread de precio a la billetera virtual de cada upline (nunca genera facturas), y corta a los 256 saltos (`_MAX_CASCADE_HOPS`).
- Pagos (`ClientPayment`) se aplican a ventas o recargas BaaS vía `PaymentAllocation` con lógica FIFO (`client_payment_service.py`).
- Multi-moneda: saldos por moneda en `custom_fields` (JSONB) con `SELECT FOR UPDATE`; conversión vía `currency_consolidation.get_last_exchange_rate`.

Ver `backend/DOCUMENTACION_BACKEND.md` para el diagrama de tablas completo, el flujo de recarga con comprobante (Cloudinary + OCR opcional vía OpenAI + Telegram) y el listado de endpoints.

### Frontend — estado y rutas

Sin Redux/Zustand/React Query: estado global vía tres React Context (`AuthContext`, `ModalContext`, `InventoryDataContext`) + `useState` local por componente, fetch manual en `useEffect`. Dos clientes HTTP distintos: `src/api/axios.js` (`withCredentials: true` — el JWT viaja en una cookie `HttpOnly`, nunca en `localStorage`; refresca la sesión sola en un 401 `token_expired` vía `POST /auth/refresh`, para `/dashboard`, `/ventas`, `/contabilidad`, etc. bajo `MainLayout`) y llamadas axios ad-hoc con `withCredentials: false` explícito para las rutas públicas del portal (`/portal/:token`, `/pay/:paymentId`, `/checkout/:token`), donde el token va en la URL y nunca debe llevar la cookie de sesión de staff.

`AuthProvider` envuelve toda la app, incluida `/login` (dispara `GET /auth/me` también ahí para revalidar la cookie al montar). Por eso `redirectToLogin()` en `axios.js` comprueba `window.location.pathname !== '/login'` antes de navegar: sin esa guarda, un visitante sin sesión que aterriza directo en `/login` entra en un bucle de recargas (Chromium recarga igual con `location.href` al mismo valor, lo que remonta `AuthProvider` y repite el 401).

`ClientPortalPage.jsx` (~10.700 líneas) concentra casi toda la lógica del portal de autogestión del distribuidor (billetera, comisiones, red, notificaciones) en un único componente monolítico — el resto del código está más modularizado por dominio en `src/features/`.

La vista de bitácora de auditoría (`/auditoria`, `src/features/settings/AuditLog.jsx` + `src/api/audit.js`) consume `GET /api/v1/audit` del backend; requiere `PERMS.AUDIT_LOGS_VIEW`, que `full_admin` hereda automáticamente pero los demás roles no.

Ver `frontend/DOCUMENTACION_FRONTEND.md` para rutas, guards de permisos y los flujos de UI del portal.

### Despliegue — Docker + CI/CD

Además de Render, el proyecto se puede desplegar en un VPS con Docker (backend + frontend en contenedores, PostgreSQL siempre externo — nunca en `docker-compose.prod.yml`). Detalle completo en `GUIA_DESPLIEGUE.md` §11.

- `backend/entrypoint.sh` corre `alembic upgrade head` en **cada arranque del contenedor**, antes de levantar uvicorn — las migraciones futuras se aplican solas, sin paso manual de despliegue.
- `frontend/Dockerfile` construye con `npm ci --legacy-peer-deps` (necesario: `react-quill@2.0.0-beta.4` declara peer `react@^16||^17` contra React 19 del proyecto) y sirve el build vía `nginx` (`frontend/nginx.conf`), que hace reverse proxy de `/api/` y `/uploads/` al contenedor backend — mismo origen, evita el problema de cookies cross-subdominio documentado en `GUIA_DESPLIEGUE.md` §1.
- `backend/requirements.txt` fija `sqlalchemy>=2.0,<2.1`: sin ese pin, una instalación limpia resuelve SQLAlchemy 2.1, que cambió el driver por defecto de una URL `postgresql://` (sin sufijo) de psycopg2 a psycopg v3 — no instalado aquí — y la app no arranca.
- `.github/workflows/deploy-qa.yml`: en cada push a `dev`, construye y publica ambas imágenes en GHCR (`ghcr.io/corbusnutrition-eng/sistema-erp-{backend,frontend}:qa-<sha>`) y despliega por SSH (`git reset --hard origin/dev` + `docker compose pull && up -d` en `VPS_DEPLOY_PATH`). El despliegue equivalente a `main` (producción) está pendiente — se planea reusar los mismos Dockerfiles.
