# Documentación de Arquitectura — Frontend ERP IPTV

> **Stack:** React 19 · Vite 8 · React Router 7 · Tailwind CSS · Axios  
> **Sin** Zustand, Redux, React Query ni SWR — estado vía Context + `useState` local.

Este documento describe la estructura del frontend, rutas, gestión de estado y flujos de UI críticos.

---

## 1. Estructura del frontend

```
frontend/
├── public/
├── src/
│   ├── main.jsx                  # Punto de entrada
│   ├── App.jsx                   # Router principal + guards
│   ├── index.css                 # Tailwind base
│   │
│   ├── api/                      # Cliente HTTP admin
│   │   ├── axios.js              # Interceptores JWT + 401 redirect
│   │   ├── auth.js
│   │   ├── clients.js
│   │   └── users.js
│   │
│   ├── context/                  # Estado global (3 contextos)
│   │   ├── AuthContext.jsx       # Sesión JWT, permisos RBAC
│   │   ├── ModalContext.jsx      # Modales globales admin
│   │   └── InventoryDataContext.jsx  # Snapshot inventario en shell admin
│   │
│   ├── hooks/
│   │   ├── usePermissions.js
│   │   ├── useDebounce.js
│   │   ├── useTableResize.js
│   │   ├── useCopyLinkFeedback.js
│   │   └── useExchangeRateForCurrency.js
│   │
│   ├── lib/
│   │   ├── permissions.js        # Helpers RBAC
│   │   ├── permissionMatrix.js   # Rutas post-login, ledger restringido
│   │   ├── apiErrors.js
│   │   ├── currencyCode.js
│   │   └── exchangeRateApi.js
│   │
│   ├── utils/
│   │   ├── formatters.js
│   │   ├── datetime.js
│   │   └── hotmartLinks.js
│   │
│   ├── pages/                    # Páginas top-level admin
│   │   ├── Dashboard.jsx
│   │   ├── Clientes.jsx
│   │   └── ClientDetail.jsx
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── MainLayout.jsx    # Sidebar + Header + GlobalModals
│   │   │   ├── Sidebar.jsx
│   │   │   ├── Header.jsx
│   │   │   ├── NotificationBell.jsx  # Campana ERP (no portal)
│   │   │   └── GlobalModals.jsx
│   │   └── ui/                   # Componentes reutilizables
│   │
│   └── features/                 # Módulos por dominio (~111 archivos)
│       ├── auth/Login.jsx
│       ├── sales/Sales.jsx
│       ├── accounting/
│       ├── inventory/
│       ├── public/               # Portal y páginas públicas
│       ├── settings/             # Usuarios, BaaS, notificaciones admin
│       ├── reports/
│       ├── lists/
│       ├── vendors/
│       └── …
│
├── .env                          # VITE_API_BASE_URL (local)
├── .env.production               # URLs Render producción
├── package.json
└── vite.config.js
```

---

## 2. Rutas y vistas (React Router)

Definidas en `src/App.jsx`.

### 2.1 Rutas públicas (sin autenticación, sin `MainLayout`)

| Ruta | Componente | Audiencia |
|------|------------|-----------|
| `/login` | `Login` | Staff ERP |
| `/pay/:paymentId` | `PaymentPage` | Cliente final (pago de venta) |
| `/checkout/:token` | `CheckoutPage` | Checkout tokenizado |
| `/portal/recharge/:linkHash` | `RechargePortalPage` | Recarga BaaS por enlace |
| `/portal/:token` | `ClientPortalPage` | **Portal de autogestión del distribuidor** |

Estas rutas usan **axios/fetch sin JWT**. El token del portal va en la URL.

### 2.2 Rutas admin (JWT + `MainLayout`)

Protegidas por `ProtectedRoute` → `InventoryDataProvider` → `MainLayout`.

| Ruta | Permiso | Módulo |
|------|---------|--------|
| `/dashboard` | `DASHBOARD_VIEW` | Dashboard |
| `/clientes`, `/clientes/:id` | `CLIENTS_VIEW` | CRM clientes |
| `/ventas` | prefijo `sales` | Ventas |
| `/suscripciones` | `SALES_SUBSCRIPTIONS_VIEW` | Suscripciones |
| `/inventario` | `INVENTORY_VIEW` | Inventario IPTV |
| `/contabilidad/*` | permisos `accounting` | Contabilidad |
| `/informes/*` | `REPORTS_*` | Reportes financieros |
| `/listas/*` | `REPORTS_LISTS_VIEW` | Métodos de pago, links, monedas |
| `/equipo/usuarios` | `TEAM_USERS_VIEW` | Usuarios ERP |
| `/equipo/distribuidores` | BaaS | Distribuidores BaaS + recargas |
| `/equipo/arbol` | BaaS | Mapa de red |

### 2.3 Guards de ruta

| Guard | Función |
|-------|---------|
| `ProtectedRoute` | Requiere `localStorage.access_token` + user hidratado |
| `PermissionRoute` | Admin bypass; otros necesitan permiso granular |
| `BaasRoute` | Acceso módulo BaaS |
| `AccountingHomeRedirect` | Usuarios ledger-only → cuenta asignada |

---

## 3. Gestión del estado

### 3.1 Contextos globales

```jsx
// App.jsx — árbol de providers
<ModalProvider>
  <AuthProvider>
    <BrowserRouter>
      {/* rutas admin */}
      <InventoryDataProvider>
        <MainLayout />
      </InventoryDataProvider>
    </BrowserRouter>
  </AuthProvider>
</ModalProvider>
```

| Contexto | Datos | Consumidores |
|----------|-------|--------------|
| `AuthContext` | `user`, `permissions`, `hasPermission`, login/logout | Sidebar, guards, hooks |
| `ModalContext` | Toggles modales globales (Nueva venta, Abono, Recarga…) | `GlobalModals`, Header |
| `InventoryDataContext` | Cuentas/pantallas/proveedores precargados | Inventario, ventas |

### 3.2 Cliente HTTP

**Admin (`src/api/axios.js`):**

```javascript
// Base URL desde import.meta.env.VITE_API_BASE_URL
// Request: Authorization: Bearer <access_token>
// Response 401: limpia storage → redirect /login
```

**Portal (`ClientPortalPage.jsx`):**

```javascript
function publicApi() {
  return axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL })
}
// Sin header Authorization — el token va en la ruta /portal/:token
```

### 3.3 Patrón de fetching

- **Manual:** `useEffect` + `useCallback` por componente.
- **Sin cache global:** cada navegación/modal dispara fetch fresco.
- **Polling admin:** `NotificationBell` cada 30 s (`/notifications/pending-payments`).
- **Portal staged loading:**
  1. `GET /portal/:token` → desbloquea UI (`setLoading(false)`).
  2. Widgets secundarios en paralelo (`Promise.allSettled`): CxC, recargas, notificaciones, catálogo autocompra.

### 3.4 Persistencia local

| Clave | Uso |
|-------|-----|
| `localStorage.access_token` | JWT staff |
| `portal-accordion-order-{token}` | Orden drag-and-drop de secciones del portal |

---

## 4. Flujos críticos de UI

### 4.1 Portal de autogestión (`ClientPortalPage.jsx`)

**Archivo:** `src/features/public/ClientPortalPage.jsx` (~10.700 líneas)  
**Ruta:** `/portal/:token`

#### Arquitectura interna

```
ClientPortalPage
└── PortalPageErrorBoundary
    └── ClientPortalPageInner
        ├── ~50 funciones helper (pagos, deuda, formateo)
        ├── ~15 subcomponentes inline (PortalNeoAccordion, cards…)
        ├── ~80 bloques useState
        ├── PortalAccordionSortableList (6 secciones reordenables)
        ├── Secciones fijas (Saldo a favor, Saldo pendiente + ledger)
        └── Modales (recarga, historiales, contacto, sub-clientes)
```

#### Carga de datos

| Fase | Endpoint(s) | Efecto UI |
|------|-------------|-----------|
| Crítica | `GET /portal/:token` | Spinner principal OFF |
| Secundaria | CxC, recargas, notificaciones, catálogo | Spinners locales por widget |

Funciones clave:
- `loadPortalInitial()` — solo espera home.
- `loadPortalSecondaryWidgets()` — background, no bloquea layout.

#### Secciones del acordeón (orden por defecto en `portalAccordionOrder.js`)

| ID | Título | Contenido |
|----|--------|-----------|
| `notifications` | 📬 MIS NOTIFICACIONES | Bandeja admin + comisiones |
| `new-orders` | NUEVOS PEDIDOS PARA PAGO | Ventas pendientes (clientes directos) |
| `wallet` | MI BILLETERA | Saldo, autocompra, historial |
| `tracked-purchases` | MIS COMPRAS | Compras rastreadas con vencimiento |
| `reseller-network` | MI RED DE DISTRIBUIDORES | Sub-clientes, transferencias, precios |
| `active-screens` | Pantallas activas | Credenciales IPTV |

**Fuera del acordeón sortable:**
- Banner **SALDO A FAVOR**
- Acordeón **SALDO PENDIENTE** + formulario de abono + timeline ledger

#### Componentes hijos importados

| Componente | Rol |
|------------|-----|
| `MiniDashboard` | KPIs: ganancias, billetera, pantallas, vencimientos |
| `NetworkDashboard` | Árbol de red |
| `EarningsHistoryModal` | Historial comisiones (lazy) |
| `WalletHistoryModal` | Movimientos billetera |
| `TransferHistoryModal` | Transferencias a sub-clientes |
| `CodigosRetiroWidget` | Iframe pagos físicos |
| `PortalAccordionSortableList` | Drag-and-drop `@dnd-kit` |

#### MiniDashboard → Ganancias

Click en tarjeta **GANANCIAS** abre `EarningsHistoryModal` (`onEarningsClick`).

---

### 4.2 Modal historial de ganancias (`EarningsHistoryModal.jsx`)

**Archivo:** `src/features/public/EarningsHistoryModal.jsx`  
**Props:** `{ open, onClose, token, api }`

#### Lazy loading y paginación

```
Modal open = true
        │
        ├── Reset page → 1
        └── useEffect → loadHistory(page)
                │
                ▼
        GET /portal/:token/earnings-history?page=N&limit=10
                │
                ├── summaries: { daily, weekly, monthly }
                ├── items: [{ date, description, amount, currency }]
                └── total_pages
```

| Aspecto | Implementación |
|---------|----------------|
| Fetch | Solo cuando `open === true` (no precarga en home) |
| Paginación | Estado local `page`, botones Anterior/Siguiente |
| Tabla | `table-fixed`, columnas: Fecha / Detalle / Monto |
| Detalle largo | `break-words whitespace-normal` — no empuja montos |
| Monto | `text-right text-green-400 font-bold` |
| Modal ancho | `max-w-3xl sm:max-w-4xl` |

---

### 4.3 Sistema de jerarquía de notificaciones (portal)

Implementado dentro de `ClientPortalPage.jsx` (sección acordeón `notifications`).

#### Carga

```javascript
GET /api/v1/portal/:token/notifications
// En loadPortalSecondaryWidgets(), no bloquea spinner principal
```

Respuesta incluye `source: "admin" | "system"`.

#### Ordenamiento (frontend refuerza backend)

```javascript
// 1. Admin primero (sourceRank 0)
// 2. created_at DESC
// 3. id DESC
```

#### Visibilidad

- Solo se muestran notificaciones **no leídas** (`visiblePortalNotifications`).
- Al marcar leída → se elimina del estado local (desaparece de la bandeja).
- Contador del acordeón cuenta **todas** las no leídas (badge verde pulsante).

#### Estilos diferenciados

| Origen | Visual |
|--------|--------|
| **Admin** | Borde azul/cielo, glow sky, icono 📌, etiqueta "Mensaje del administrador" |
| **Sistema (comisión)** | Borde verde neón, icono 💸 |

#### Scroll y acciones masivas

| Elemento | Clases / comportamiento |
|----------|-------------------------|
| Contenedor lista | `portal-notif-scroll max-h-[400px] overflow-y-auto sm:max-h-96` |
| Scrollbar | CSS custom WebKit + `scrollbar-width: thin` |
| Marcar una | `PUT .../notifications/{id}/read` |
| Marcar todas | `PUT .../notifications/read-all` → vacía pendientes, contador → 0 |

#### Admin envía notificaciones

`NotificationManagementPanel.jsx` en `/equipo/distribuidores` → pestaña **Gestión de Notificaciones**:
- Editor HTML (React Quill)
- Destinatarios: todos / nivel / cliente específico
- Historial de lotes con estadísticas leídas/pendientes

#### Campana ERP (distinto del portal)

`NotificationBell.jsx` en Header admin:
- Poll `GET /notifications/pending-payments` cada 30 s
- Deep links a ventas, abonos, recargas BaaS
- **No aparece en rutas del portal**

---

## 5. Módulos feature principales

| Módulo | Ruta UI | Descripción |
|--------|---------|-------------|
| **Sales** | `/ventas` | Core ERP: facturas, abonos, tags, Hotmart, activación |
| **Accounting** | `/contabilidad/*` | Plan de cuentas, conciliación, CxC, transferencias |
| **Inventory** | `/inventario` | Cuentas IPTV, bodega, catálogo productos |
| **Clients** | `/clientes` | CRM, timeline, métodos de pago |
| **Settings/BaaS** | `/equipo/distribuidores` | Recargas, árbol, notificaciones broadcast |
| **Public** | `/portal/:token` | Autogestión distribuidor |
| **Reports** | `/informes/*` | P&L, clasificación, CxC report |
| **Lists** | `/listas/*` | Métodos de pago, plantillas links, monedas |

---

## 6. Permisos y navegación

- **`lib/permissions.js`** — constantes `PERMS.*`
- **`lib/permissionMatrix.js`** — resuelve landing post-login según rol
- **`Sidebar.jsx`** — filtra ítems por `hasPermission`
- Admin (`role === 'admin'`) bypass total de permisos

---

## 7. Comandos de desarrollo

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/ para producción
npm run preview  # Preview del build
```

Variables requeridas: ver `GUIA_DESPLIEGUE.md` (`VITE_API_BASE_URL`, etc.).

---

## 8. Observaciones arquitectónicas

1. **`ClientPortalPage.jsx` es un monolito** — lógica, UI y helpers en un solo archivo; el resto del portal está más modularizado.
2. **Doble cliente HTTP** — JWT para staff, token en URL para clientes (frontera de seguridad intencional).
3. **Sin cache de datos** — simple pero implica refetch frecuente; aceptable para escala actual.
4. **Modales admin centralizados** en `ModalContext`; modales del portal son estado local.
5. **Acordeón reordenable** persistido por token en `localStorage` vía `@dnd-kit/sortable`.

---

*Para backend, endpoints y modelos de datos, ver `backend/DOCUMENTACION_BACKEND.md`.*
