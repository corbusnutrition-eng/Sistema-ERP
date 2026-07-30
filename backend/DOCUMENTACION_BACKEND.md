# Documentación de Arquitectura — Backend ERP IPTV

> **Stack:** FastAPI · SQLAlchemy · Alembic · PostgreSQL · Pydantic v2  
> **Prefijo API:** `/api/v1`  
> **Versión:** 1.0.0

Este documento describe la arquitectura del backend del **Sistema de Facturación ERP** (IPTV / BaaS): estructura de carpetas, modelos de datos, servicios críticos y endpoints principales.

---

## 1. Estructura de carpetas

```
backend/
├── alembic/                      # Migraciones de base de datos
│   ├── env.py
│   └── versions/                 # ~24 revisiones (wallet, BaaS, ventas, journal…)
├── alembic.ini
├── app/
│   ├── main.py                   # App FastAPI, CORS, registro de routers, /uploads estáticos
│   ├── config.py                 # Settings (Telegram)
│   ├── database.py               # Engine PostgreSQL + SessionLocal
│   ├── jwt_utils.py              # JWT staff (login ERP)
│   ├── permissions.py            # Catálogo RBAC
│   ├── rate_limit.py             # slowapi (rate limiting)
│   ├── currency_utils.py
│   ├── timezone_utils.py         # Zona horaria Ecuador
│   ├── upload_paths.py
│   ├── cloudinary_storage.py     # Comprobantes en la nube
│   ├── wallet_recharge_helpers.py
│   ├── account_constants.py
│   ├── account_structure.py
│   │
│   ├── api/v1/                   # Capa HTTP (routers)
│   │   ├── dependencies.py       # DbDep, get_current_user, permisos
│   │   ├── auth.py
│   │   ├── portal.py             # Portal público del cliente (token UUID)
│   │   ├── sales.py
│   │   ├── client_payments.py
│   │   ├── distributors.py       # Admin BaaS: recargas, transferencias
│   │   ├── admin_clients.py
│   │   ├── admin_notifications.py
│   │   ├── admin_transactions.py
│   │   ├── notifications.py      # Campana ERP (pagos pendientes)
│   │   ├── clients.py
│   │   ├── inventory.py
│   │   ├── products.py
│   │   ├── accounting.py
│   │   ├── accounts.py
│   │   ├── checkout.py
│   │   ├── dashboard.py
│   │   ├── reports_financial.py
│   │   ├── external_api.py
│   │   ├── webhooks_codigos_retiro.py
│   │   └── … (34 módulos de rutas en total)
│   │
│   ├── models/                   # SQLAlchemy ORM (31 entidades)
│   │   ├── base.py
│   │   ├── registry.py
│   │   ├── client.py
│   │   ├── user.py
│   │   ├── sale.py
│   │   ├── client_payment.py
│   │   ├── wallet_recharge_request.py
│   │   ├── wallet_transaction.py
│   │   ├── client_notification.py
│   │   └── …
│   │
│   ├── schemas/                  # DTOs Pydantic (request/response)
│   │   ├── portal_public.py
│   │   ├── client_notifications.py
│   │   ├── sales.py
│   │   └── …
│   │
│   ├── services/                 # Lógica de negocio (45 módulos)
│   │   ├── baas_commission_cascade_service.py
│   │   ├── wallet_balance_service.py
│   │   ├── wallet_recharge_client_payment.py
│   │   ├── client_payment_service.py
│   │   ├── client_notification_service.py
│   │   ├── portal_auto_purchase_service.py
│   │   ├── portal_home_fast_service.py
│   │   ├── portal_earnings_history_service.py
│   │   ├── telegram_service.py
│   │   └── …
│   │
│   └── security/
│       ├── master_pin.py
│       ├── money_validation.py
│       ├── ownership.py
│       └── portal_confidence.py  # Anti-bypass OCR en portal
│
├── scripts/                      # Utilidades PG (patches, seeds)
├── tests/                        # pytest (cascada BaaS, concurrencia, OCR)
├── uploads/                      # Archivos legados (/uploads montado en main)
├── requirements.txt
└── seed_cuentas.py
```

### Capas y responsabilidades

| Capa | Ubicación | Responsabilidad |
|------|-----------|-----------------|
| **Router** | `app/api/v1/*.py` | HTTP, validación de entrada, auth, delegar a servicios |
| **Schema** | `app/schemas/*.py` | Contratos Pydantic (serialización/deserialización) |
| **Service** | `app/services/*.py` | Reglas de negocio, transacciones, integraciones |
| **Model** | `app/models/*.py` | Tablas SQLAlchemy y relaciones ORM |
| **Security** | `app/security/*.py` | Validaciones transversales (dinero, OCR, PIN) |

---

## 2. Modelos de base de datos

El proyecto usa **SQLAlchemy 2.x** con **PostgreSQL** en producción. No usa Prisma.

### 2.1 Diagrama conceptual (núcleo BaaS)

```
                    ┌─────────────┐
                    │    users    │  Staff ERP (admin/worker)
                    │  parent_id  │  Árbol MLM de distribuidores ERP
                    └──────┬──────┘
                           │ parent_distributor_id
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                         clients                               │
│  parent_id ──► red BaaS (subdistribuidores)                  │
│  wallet_balance, credit_balance, currency                    │
│  payment_token (UUID) ──► acceso portal público                │
│  custom_fields.wallet_balances_by_currency (JSONB)           │
└───────┬──────────────────────────────────────────────────────┘
        │
        ├──► wallet_recharge_requests   (solicitudes de recarga BaaS)
        ├──► wallet_transactions        (movimientos billetera)
        ├──► client_payments            (abonos CxC / comprobantes)
        ├──► client_notifications       (bandeja portal)
        ├──► client_product_prices      (precios asignados por paquete)
        ├──► sales                      (ventas / activaciones)
        └──► payment_allocations        (FIFO: pago → venta o recarga)
```

### 2.2 Tablas principales

| Tabla | Modelo | Descripción clave |
|-------|--------|-------------------|
| `clients` | `Client` | Cliente/distribuidor BaaS. Árbol vía `parent_id`. Portal vía `payment_token`. |
| `users` | `User` | Usuario interno ERP. Roles `admin` / `worker`. Permisos granulares JSON. |
| `sales` | `Sale` | Venta IPTV: monto, moneda, estado, pantalla asignada, links Hotmart. |
| `client_payments` | `ClientPayment` | Abono con comprobante. Estados: pendiente, aprobado, rechazado. OCR (`ai_confidence_score`). |
| `payment_allocations` | `PaymentAllocation` | Aplica un pago a una `sale_id` o `wallet_recharge_id` (FIFO). |
| `wallet_recharge_requests` | `WalletRechargeRequest` | Recarga BaaS: monto, estado, moneda, `link_hash` público. |
| `wallet_transactions` | `WalletTransaction` | Ledger virtual BaaS: depósitos, comisiones (`wallet_deposit`). |
| `client_notifications` | `ClientNotification` | Inbox del portal: admin (`batch_id`) o sistema (comisiones). |
| `client_product_prices` | `ClientProductPrice` | Precio de venta asignado por upline a un subdistribuidor y paquete. |
| `products` | `Product` | Catálogo IPTV (Flujo, Stella, etc.). |
| `product_package_catalog` | `ProductPackageCatalog` | Matriz de paquetes (12 meses, 6 meses…). |
| `screen_stock` | `ScreenStock` | Bodega de pantallas (libre/reservada/asignada). |
| `iptv_accounts` / `iptv_screens` | Inventario proveedor | Cuentas master y slots de pantalla. |
| `accounts` / `journal_entries` | Contabilidad | Plan de cuentas y asientos doble partida. |

### 2.3 Relaciones críticas

**Red BaaS (subdistribuidores):**
- `Client.parent_id → Client.id` — cadena comercial (quién vendió a quién).
- `Client.parent_distributor_id → User.id` — staff ERP que administra ese cliente.

**Precios en la red:**
- `ClientProductPrice` — el upline fija el precio de cada paquete para su downline.
- `DistributorCustomPrice` — precios custom entre usuarios ERP (`users`).

**Pagos unificados:**
- Un `ClientPayment` puede aplicarse a ventas (`sale_id`) o recargas (`wallet_recharge_id`) vía `PaymentAllocation`.
- Meta en notas: `META_WALLET_RECHARGE_ID=<id>` vincula abono ↔ solicitud BaaS.

**Portal público:**
- `Client.payment_token` (UUID) autentica todas las rutas `/portal/{token}/…` sin JWT.

---

## 3. Servicios clave

### 3.1 Flujo de recargas BaaS y validación de pagos

#### Creación de solicitud

1. **Desde ERP (staff):** `POST /api/v1/distributors/request-recharge` crea `WalletRechargeRequest` con estado `pending`.
2. **Desde portal cliente:** `POST /api/v1/portal/{token}/recharges` — recarga iniciada por el distribuidor.
3. **Enlace público:** `POST /api/v1/distributors/generate-recharge-link` → URL `/portal/recharge/{link_hash}`.

#### Pago con comprobante

```
Portal sube comprobante
        │
        ▼
POST /portal/{token}/recharges/{id}/pay
        │
        ├── Crea ClientPayment (status: pending_review)
        ├── Notas: META_WALLET_RECHARGE_ID=<id>
        ├── Sube imagen a Cloudinary
        ├── OCR opcional (OpenAI) → ai_confidence_score
        └── Telegram: schedule_receipt_received_notification()
        │
        ▼
Staff revisa en ERP (Distribuidores BaaS / campana)
        │
        ├── PATCH /payments/{id}/approve
        │       └── finalize_wallet_recharge_payment_approval()
        │               ├── Acredita wallet (wallet_balance_service)
        │               ├── Actualiza WalletRechargeRequest → approved
        │               └── PaymentAllocation FIFO
        │
        └── PATCH /payments/{id}/reject
```

#### Archivos involucrados

| Archivo | Rol |
|---------|-----|
| `wallet_recharge_client_payment.py` | Vincula `ClientPayment` ↔ recarga BaaS |
| `wallet_balance_service.py` | Saldos multi-moneda en `custom_fields` con `SELECT FOR UPDATE` |
| `client_payment_service.py` | Motor CxC: aprobación, FIFO cross-module, saldo a favor |
| `security/portal_confidence.py` | Impide que el cliente falsifique score OCR |
| `telegram_service.py` | Alerta al equipo cuando llega comprobante |

#### Estados de recarga (`wallet_recharge_helpers.py`)

| Estado | Significado |
|--------|-------------|
| `pending` | Esperando pago |
| `in_review` | Comprobante subido, pendiente aprobación |
| `partially_paid` | Abono parcial aplicado |
| `approved` | Recarga acreditada en billetera |
| `rejected` | Rechazada por staff |

---

### 3.2 Motor de comisiones en cascada (MLM)

**Archivo principal:** `baas_commission_cascade_service.py`  
**Disparador:** autocompra desde portal (`portal_auto_purchase_service.py`) tras debitar billetera y crear venta.

#### Algoritmo paso a paso

```
1. Cliente B (buyer) compra paquete Flujo desde su portal (autocompra).
2. Se determina unit_price_paid = lo que B pagó por unidad.
3. current_node = B, current_price = unit_price_paid.

4. WHILE current_node.parent_id IS NOT NULL:
   a. parent = upline (SELECT FOR UPDATE en PostgreSQL)
   b. parent_acquisition = precio de adquisición del paquete PARA el parent
      (ClientProductPrice asignado por el abuelo, o costo base catálogo)
   c. profit = (current_price - parent_acquisition) × quantity
   d. SI profit > 0:
      - add_client_wallet_balance(parent, moneda, profit)
      - WalletTransaction (tipo wallet_deposit, descripción "Comisión por red: …")
      - enqueue_client_network_commission_notification() → bandeja portal
   e. current_price = parent_acquisition   ← el margen del siguiente nivel usa este precio
   f. current_node = parent

5. El commit lo hace el llamador (transacción ACID única con la venta).
```

#### Reglas de negocio importantes

- **Solo acredita billetera virtual** — no crea facturas ni ventas al upline.
- **Margen = spread de precio** entre lo que paga el downline y lo que le cuesta al upline adquirir el mismo paquete.
- **Precios asignados:** `client_product_price_service.py` resuelve tarifas por `package_catalog_id`.
- **Multi-moneda:** conversión vía `currency_consolidation.get_last_exchange_rate`.
- **Tope de seguridad:** máximo 256 saltos en la cadena (`_MAX_CASCADE_HOPS`).

#### Ejemplo numérico simplificado

| Nivel | Precio de venta al downline | Costo de adquisición | Comisión |
|-------|----------------------------|----------------------|----------|
| Raíz asigna a A | — | $8 | — |
| A vende a B | $10 | $8 | $2 para quien está arriba de A |
| B compra | $10 (paga) | — | — |

---

### 3.3 Notificaciones

#### A) Telegram (push al equipo ERP)

**Archivo:** `telegram_service.py`

| Evento | Función | Mensaje |
|--------|---------|---------|
| Nueva solicitud BaaS | `schedule_baas_new_request_notification` | 🚨 NUEVA SOLICITUD BaaS |
| Comprobante recibido | `schedule_receipt_received_notification` | 💰 COMPROBANTE RECIBIDO |

- Envío **asíncrono** vía `BackgroundTasks` (no bloquea la API).
- Requiere `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.
- Formato HTML escapado.

#### B) Campana interna ERP (staff)

**Archivo:** `notification_service.py`  
**Endpoint:** `GET /api/v1/notifications/pending-payments`

Agrega ventas pendientes, abonos en revisión y recargas BaaS para la UI del `NotificationBell` del frontend admin.

#### C) Bandeja del portal (cliente)

**Archivo:** `client_notification_service.py`  
**Modelo:** `ClientNotification`

| Origen | Criterio | Ejemplo |
|--------|----------|---------|
| **Admin** | `batch_id IS NOT NULL` o `target_type ∈ {all, level, specific}` | "INFRACCION — Se descontará $20" |
| **Sistema** | `target_type = network_commission` | "¡Nueva comisión por red! 💸" |

**Ordenamiento en listado:**
```sql
ORDER BY
  CASE WHEN es_admin THEN 0 ELSE 1 END ASC,
  created_at DESC,
  id DESC
```

**Endpoints portal:**
- `GET /portal/{token}/notifications`
- `PUT /portal/{token}/notifications/{id}/read`
- `PUT /portal/{token}/notifications/read-all`

**Broadcast admin:** `POST /admin/notifications/send` (target: todos / nivel / cliente específico).

---

## 4. Listado de endpoints principales

Base URL: `/api/v1`

### Autenticación y usuarios

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/auth/login` | Login staff → JWT |
| GET | `/auth/me` | Usuario actual + permisos |
| GET/POST | `/users/` | CRUD usuarios ERP |

### Portal del cliente (sin JWT, token UUID)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/portal/{token}` | Home del portal (dashboard, ventas, métricas) |
| GET | `/portal/{token}/cxc-balance` | Saldo pendiente CxC |
| GET | `/portal/{token}/recharges` | Solicitudes de recarga |
| POST | `/portal/{token}/recharges/{id}/pay` | Pagar recarga con comprobante |
| POST | `/portal/{token}/auto-purchase` | Autocompra de pantalla (dispara cascada) |
| GET | `/portal/{token}/earnings-history` | Historial comisiones paginado |
| GET | `/portal/{token}/notifications` | Bandeja de mensajes |
| PUT | `/portal/{token}/notifications/read-all` | Marcar todas como leídas |
| GET | `/portal/{token}/sub-clients` | Red de subdistribuidores |
| POST | `/portal/{token}/transfer` | Transferir saldo BaaS a hijo |
| GET | `/portal/{token}/network-tree` | Árbol de red |

### Ventas y pagos (staff JWT)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET/POST | `/sales/` | Listar / crear ventas |
| PATCH | `/sales/{id}/activate` | Activar pantalla |
| POST | `/sales/{id}/approve` | Aprobar venta |
| GET/POST | `/payments/` | Abonos CxC |
| PATCH | `/payments/{id}/approve` | Aprobar comprobante |
| PATCH | `/payments/{id}/reject` | Rechazar comprobante |

### BaaS / Distribuidores (staff JWT)

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/distributors/recharge-requests` | Listar solicitudes |
| POST | `/distributors/approve-recharge/{id}` | Aprobar recarga |
| POST | `/distributors/reject-recharge/{id}` | Rechazar recarga |
| POST | `/distributors/generate-recharge-link` | Link público de recarga |

### Admin

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/admin/clients/{id}/adjust-balance` | Ajuste manual billetera |
| PUT | `/admin/clients/{id}/package-prices` | Precios BaaS por paquete |
| POST | `/admin/notifications/send` | Enviar notificación masiva |
| POST | `/admin/transactions/{id}/revert` | Revertir transferencia BaaS |

### Inventario y contabilidad

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET/POST | `/inventory/…` | Cuentas IPTV, bodega, stock |
| GET/POST | `/accounts/…` | Plan de cuentas |
| GET | `/reports/profit-and-loss` | Estado de resultados |

### Salud

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/` | Estado del motor |

---

## 5. Patrones transversales

### Transacciones ACID

Los servicios críticos (`portal_auto_purchase_service`, `baas_commission_cascade_service`) **no hacen commit interno**. El router orquesta un único `db.commit()` o `rollback()` ante error.

### Autenticación dual

| Actor | Mecanismo |
|-------|-----------|
| Staff ERP | JWT Bearer (`Authorization` header) |
| Cliente portal | UUID en URL (`Client.payment_token`) |
| API externa | Header `X-API-Key` |
| Webhooks | Secret compartido por variable de entorno |

### Optimización portal

`portal_home_fast_service.py` reduce N+1 en métricas del home: batch de allocations, dashboard metrics fast, tracked purchases sin journal por pantalla.

### Migraciones

```bash
cd backend
alembic upgrade head
```

---

## 6. Referencia rápida de servicios por dominio

| Dominio | Servicios |
|---------|-----------|
| Billetera BaaS | `wallet_balance_service`, `wallet_recharge_client_payment`, `client_reseller_service` |
| Pagos CxC | `client_payment_service`, `client_payment_method_service` |
| Comisiones MLM | `baas_commission_cascade_service`, `client_product_price_service` |
| Portal | `portal_auto_purchase_service`, `portal_home_fast_service`, `portal_earnings_history_service` |
| Notificaciones | `client_notification_service`, `telegram_service`, `notification_service` |
| Contabilidad | `accounting_engine`, `sale_journal`, `sale_accounting_sync` |
| Inventario | `catalog_inventory`, `screen_assigner`, `inventory_reconciliation_service` |
| Integraciones | `catalog_vip_sync`, `render_sync`, `codigos_retiro_webhook_service` |

---

*Documento generado a partir del análisis del código fuente. Para variables de entorno y despliegue, ver `GUIA_DESPLIEGUE.md` en la raíz del proyecto.*
