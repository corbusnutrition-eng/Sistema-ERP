import os
from contextlib import asynccontextmanager
from pathlib import Path

# Cargar variables del archivo .env antes de cualquier otra importación.
try:
    from dotenv import load_dotenv

    _backend_env = Path(__file__).resolve().parent.parent / ".env"
    _root_env = Path(__file__).resolve().parent.parent.parent / ".env"
    if _backend_env.exists():
        load_dotenv(_backend_env, override=False)
        print(f"INFO: .env cargado desde {_backend_env}")
    elif _root_env.exists():
        load_dotenv(_root_env, override=False)
        print(f"INFO: .env cargado desde {_root_env}")
    else:
        load_dotenv(override=False)
except ImportError:
    pass  # python-dotenv no instalado; se usan variables de entorno del sistema

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.audit.middleware import AuditContextMiddleware
from app.rate_limit import limiter, rate_limit_exceeded_handler
from app.upload_paths import UPLOAD_ROOT

UPLOAD_DIR = str(UPLOAD_ROOT)
UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
(UPLOAD_ROOT / "logos").mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.services.exchange_rate_scheduler import (
        start_exchange_rate_scheduler,
        stop_exchange_rate_scheduler,
    )

    task, stop_event = start_exchange_rate_scheduler()
    yield
    await stop_exchange_rate_scheduler(task, stop_event)


# ── CORS: registrar ANTES de app.include_router / mount (orden del middleware global) ──
app = FastAPI(
    title="Sistema de Facturación ERP",
    version="1.0.0",
    description="API central para gestión de clientes, inventario IPTV y facturación.",
    # Evita redirecciones 307 entre `/resource` y `/resource/` que suelen perder cabeceras CORS en el navegador.
    redirect_slashes=False,
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
# Starlette hace user_middleware.insert(0, ...): el ÚLTIMO añadido queda MÁS
# INTERNO en ejecución. AuditContextMiddleware va primero para quedar así —
# scope["client"] ya viene corregido por ProxyHeadersMiddleware (IP real de
# Render) y un 429 de slowapi no consume un request_id.
app.add_middleware(AuditContextMiddleware)
app.add_middleware(SlowAPIMiddleware)
# Render actúa como proxy inverso: confiar en X-Forwarded-* para IP/host reales.
app.add_middleware(ProxyHeadersMiddleware, trusted_hosts="*")

# Orígenes permitidos (allow_credentials=True exige dominios explícitos; no usar "*").
# Necesario para JWT / cookies de sesión en peticiones cross-origin desde el frontend.
#
# Deliberadamente SIN regex comodín: `https://.*\.onrender\.com` (el default
# histórico) dejaba pasar credenciales desde CUALQUIER app alojada en Render,
# no solo la nuestra. Con allow_credentials=True eso es una lista de invitados
# abierta a cualquier usuario de Render. Lista explícita, nada más.
ENVIRONMENT = (os.getenv("ENVIRONMENT") or os.getenv("ENV") or "development").strip().lower()
_IS_PRODUCTION = ENVIRONMENT in {"production", "prod"}

_DEV_ORIGINS = [
    "http://localhost:5173",  # Vite dev server
    "http://localhost:3000",  # Entorno local alternativo
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
]

_extra = os.getenv("CORS_ORIGINS", "")
_EXTRA_ORIGINS = [o.strip() for o in _extra.split(",") if o.strip()]

if _IS_PRODUCTION:
    if not _EXTRA_ORIGINS:
        raise RuntimeError(
            "CORS_ORIGINS no está configurada. En producción (ENVIRONMENT=production) "
            "el servidor no puede arrancar sin una lista explícita de orígenes permitidos "
            "(ej. CORS_ORIGINS=https://app.tudominio.com)."
        )
    _ALLOWED_ORIGINS = list(dict.fromkeys(_EXTRA_ORIGINS))
else:
    _ALLOWED_ORIGINS = list(dict.fromkeys(_DEV_ORIGINS + _EXTRA_ORIGINS))

# Regex opcional, SIN valor por defecto: solo quien lo configure explícitamente
# (ej. para previews de un mismo proyecto) asume ese riesgo a sabiendas.
_ALLOW_ORIGIN_REGEX = (os.getenv("CORS_ORIGIN_REGEX") or "").strip() or None

print(f"INFO: CORS allow_origins = {_ALLOWED_ORIGINS}")
if _ALLOW_ORIGIN_REGEX:
    print(f"WARN: CORS allow_origin_regex configurado = {_ALLOW_ORIGIN_REGEX!r} (verifica que no sea demasiado amplio)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_origin_regex=_ALLOW_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-API-Key", "X-Request-ID"],
    expose_headers=["X-Request-ID"],
    max_age=3600,
)

# Archivos estáticos antes de la API (logos y comprobantes legados en /uploads/…)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

try:
    from app.cloudinary_storage import configure_cloudinary

    configure_cloudinary()
    print("INFO: Cloudinary configurado.")
except Exception as exc:
    print(f"WARN: Cloudinary no disponible al arrancar: {exc}")

# Routers (después de CORS y estáticos)
from app.api.v1 import accounting as accounting_router
from app.api.v1 import admin_clients as admin_clients_router
from app.api.v1 import admin_transactions as admin_transactions_router
from app.api.v1 import accounts as chart_accounts_router
from app.api.v1 import audit as audit_router
from app.api.v1 import checkout as checkout_router
from app.api.v1 import portal as portal_router
from app.api.v1 import portal_auth as portal_auth_router
from app.api.v1 import auth as auth_router
from app.api.v1 import classes as classes_router
from app.api.v1 import payment_methods as payment_methods_router
from app.api.v1 import payment_link_templates as payment_link_templates_router
from app.api.v1 import client_payments as client_payments_router
from app.api.v1 import client_notes as client_notes_router
from app.api.v1 import clients as clients_router
from app.api.v1 import customers as customers_router
from app.api.v1 import dashboard as dashboard_router
from app.api.v1 import expenses as expenses_router
from app.api.v1 import inventory as inventory_router
from app.api.v1 import products as products_router
from app.api.v1 import reports_financial as reports_financial_router
from app.api.v1 import sales as sales_router
from app.api.v1 import subscriptions as subscriptions_router
from app.api.v1 import tags as tags_router
from app.api.v1 import tag_groups as tag_groups_router
from app.api.v1 import sale_tags_catalog as sale_tags_catalog_router
from app.api.v1 import uploads as uploads_router
from app.api.v1 import users as users_router
from app.api.v1 import vendors as vendors_ap_router
from app.api.v1 import distributors as distributors_router
from app.api.v1 import external_api as external_api_router
from app.api.v1 import admin_notifications as admin_notifications_router
from app.api.v1 import notifications as notifications_router
from app.api.v1 import currency as currency_router
from app.api.v1 import exchange_rates as exchange_rates_router
from app.api.v1 import permissions_catalog as permissions_catalog_router
from app.api.v1 import webhooks_codigos_retiro as webhooks_codigos_retiro_router

API_V1_PREFIX = "/api/v1"

app.include_router(admin_transactions_router.router, prefix=API_V1_PREFIX)
app.include_router(admin_clients_router.router, prefix=API_V1_PREFIX)
app.include_router(admin_notifications_router.router, prefix=API_V1_PREFIX)
app.include_router(audit_router.router, prefix=API_V1_PREFIX)
app.include_router(accounting_router.router, prefix=API_V1_PREFIX)
app.include_router(chart_accounts_router.router, prefix=API_V1_PREFIX)
app.include_router(classes_router.router, prefix=API_V1_PREFIX)
app.include_router(payment_methods_router.router, prefix=API_V1_PREFIX)
app.include_router(payment_link_templates_router.router, prefix=API_V1_PREFIX)
app.include_router(client_payments_router.router, prefix=API_V1_PREFIX)
app.include_router(auth_router.router, prefix=API_V1_PREFIX)
app.include_router(checkout_router.router, prefix=API_V1_PREFIX)
app.include_router(portal_auth_router.router, prefix=API_V1_PREFIX)
app.include_router(portal_router.router, prefix=API_V1_PREFIX)
app.include_router(client_notes_router.router, prefix=API_V1_PREFIX)
app.include_router(clients_router.router, prefix=API_V1_PREFIX)
app.include_router(customers_router.router, prefix=API_V1_PREFIX)
app.include_router(dashboard_router.router, prefix=API_V1_PREFIX)
app.include_router(expenses_router.router, prefix=API_V1_PREFIX)
app.include_router(inventory_router.router, prefix=API_V1_PREFIX)
app.include_router(products_router.router, prefix=API_V1_PREFIX)
app.include_router(reports_financial_router.router, prefix=API_V1_PREFIX)
app.include_router(sales_router.router, prefix=API_V1_PREFIX)
app.include_router(subscriptions_router.router, prefix=API_V1_PREFIX)
app.include_router(tags_router.router, prefix=API_V1_PREFIX)
app.include_router(tag_groups_router.router, prefix=API_V1_PREFIX)
app.include_router(sale_tags_catalog_router.router, prefix=API_V1_PREFIX)
app.include_router(uploads_router.router, prefix=API_V1_PREFIX)
# Usuarios ERP + modo ``GET ?role=client`` (picker del modal de venta). Rutas `/users` y `/users/`.
app.include_router(users_router.router, prefix=API_V1_PREFIX)
app.include_router(permissions_catalog_router.router, prefix=API_V1_PREFIX)
app.include_router(distributors_router.router, prefix=API_V1_PREFIX)
app.include_router(notifications_router.router, prefix=API_V1_PREFIX)
app.include_router(external_api_router.router, prefix=API_V1_PREFIX)
app.include_router(currency_router.router, prefix=API_V1_PREFIX)
app.include_router(exchange_rates_router.router, prefix=API_V1_PREFIX)
app.include_router(webhooks_codigos_retiro_router.router, prefix=API_V1_PREFIX)
app.include_router(vendors_ap_router.router, prefix=API_V1_PREFIX)
app.include_router(vendors_ap_router.bill_router, prefix=API_V1_PREFIX)
app.include_router(vendors_ap_router.pay_router, prefix=API_V1_PREFIX)


@app.get("/", tags=["health"])
def root() -> dict[str, str]:
    return {"status": "online", "mensaje": "Motor del ERP funcionando correctamente"}


@app.get("/health", tags=["health"])
def health_check() -> dict[str, str]:
    return {"status": "ok"}
