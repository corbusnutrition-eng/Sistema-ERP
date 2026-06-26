import os
from pathlib import Path

# Cargar variables del archivo .env antes de cualquier otra importación.
try:
    from dotenv import load_dotenv

    _env_file = Path(__file__).resolve().parent.parent.parent / ".env"
    if _env_file.exists():
        load_dotenv(_env_file, override=False)
        print(f"INFO: .env cargado desde {_env_file}")
    else:
        load_dotenv(override=False)
except ImportError:
    pass  # python-dotenv no instalado; se usan variables de entorno del sistema

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.upload_paths import UPLOAD_ROOT

UPLOAD_DIR = str(UPLOAD_ROOT)
UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
(UPLOAD_ROOT / "logos").mkdir(parents=True, exist_ok=True)

# ── CORS: registrar ANTES de app.include_router / mount (orden del middleware global) ──
app = FastAPI(
    title="Sistema de Facturación ERP",
    version="1.0.0",
    description="API central para gestión de clientes, inventario IPTV y facturación.",
    # Evita redirecciones 307 entre `/resource` y `/resource/` que suelen perder cabeceras CORS en el navegador.
    redirect_slashes=False,
)

# Orígenes permitidos (allow_credentials=True exige dominios explícitos; no usar "*").
# Necesario para JWT / Authorization en peticiones cross-origin desde el frontend.
_DEFAULT_ORIGINS = [
    "https://sistema-erp-1.onrender.com",  # Frontend producción (Render Static Site)
    "http://localhost:5173",               # Vite dev server
    "http://localhost:3000",               # Entorno local alternativo
]

_extra = os.getenv("CORS_ORIGINS", "")
_EXTRA_ORIGINS = [o.strip() for o in _extra.split(",") if o.strip()]
_ALLOWED_ORIGINS = list(dict.fromkeys(_DEFAULT_ORIGINS + _EXTRA_ORIGINS))

print(f"INFO: CORS allow_origins = {_ALLOWED_ORIGINS}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=600,
)

# Archivos estáticos antes de la API (comprobantes en /uploads/…)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# Routers (después de CORS y estáticos)
from app.api.v1 import accounting as accounting_router
from app.api.v1 import admin_clients as admin_clients_router
from app.api.v1 import admin_transactions as admin_transactions_router
from app.api.v1 import accounts as chart_accounts_router
from app.api.v1 import checkout as checkout_router
from app.api.v1 import portal as portal_router
from app.api.v1 import auth as auth_router
from app.api.v1 import classes as classes_router
from app.api.v1 import payment_methods as payment_methods_router
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
from app.api.v1 import permissions_catalog as permissions_catalog_router
from app.api.v1 import approvals as approvals_router
from app.api.v1 import webhooks_codigos_retiro as webhooks_codigos_retiro_router

API_V1_PREFIX = "/api/v1"

app.include_router(admin_transactions_router.router, prefix=API_V1_PREFIX)
app.include_router(admin_clients_router.router, prefix=API_V1_PREFIX)
app.include_router(admin_notifications_router.router, prefix=API_V1_PREFIX)
app.include_router(accounting_router.router, prefix=API_V1_PREFIX)
app.include_router(chart_accounts_router.router, prefix=API_V1_PREFIX)
app.include_router(classes_router.router, prefix=API_V1_PREFIX)
app.include_router(payment_methods_router.router, prefix=API_V1_PREFIX)
app.include_router(client_payments_router.router, prefix=API_V1_PREFIX)
app.include_router(auth_router.router, prefix=API_V1_PREFIX)
app.include_router(checkout_router.router, prefix=API_V1_PREFIX)
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
app.include_router(approvals_router.router, prefix=API_V1_PREFIX)
app.include_router(distributors_router.router, prefix=API_V1_PREFIX)
app.include_router(notifications_router.router, prefix=API_V1_PREFIX)
app.include_router(external_api_router.router, prefix=API_V1_PREFIX)
app.include_router(currency_router.router, prefix=API_V1_PREFIX)
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
