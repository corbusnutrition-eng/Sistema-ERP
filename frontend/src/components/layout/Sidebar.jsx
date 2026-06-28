import { useState, useRef, useEffect } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useModal } from '../../context/ModalContext'
import { useAuth } from '../../context/AuthContext'
import { PERMS, isNavItemVisible } from '../../lib/permissions'
import {
  getPrimaryAssignedAccountPath,
  isRestrictedLedgerUser,
} from '../../lib/permissionMatrix'
import {
  LayoutDashboard,
  Users,
  Tv2,
  ShoppingCart,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  UsersRound,
  LogOut,
  Plus,
  UserPlus,
  Banknote,
  ArrowLeftRight,
  Receipt,
  ChevronDown,
  BarChart3,
  Building2,
  FileText,
  Landmark,
  Package,
  Wallet,
} from 'lucide-react'

// ── Quick-create menu ─────────────────────────────────────────────────────────

// action: 'newClient' | 'newSale' | 'receivePayment' | string route
const CREATE_GROUPS = [
  {
    heading: 'CRM',
    items: [
      { icon: UserPlus,        label: 'Nuevo cliente',        action: 'newClient', permission: PERMS.CLIENTS_CREATE },
    ],
  },
  {
    heading: 'Ventas',
    items: [
      { icon: ShoppingCart,    label: 'Nueva venta',          action: 'newSale'       },
      { icon: Banknote,        label: 'Recibir pago',          action: 'receivePayment' },
    ],
  },
  {
    heading: 'Finanzas',
    items: [
      { icon: ArrowLeftRight,  label: 'Transferencia', action: 'openTransfer' },
      { icon: Receipt,         label: 'Gasto',         action: 'newExpense' },
    ],
  },
  {
    heading: 'Proveedores',
    items: [
      { icon: Receipt,         label: 'Gasto',                         action: 'newExpense' },
      { icon: FileText,        label: 'Factura de proveedor',           action: 'openVendorBill' },
      { icon: Landmark,        label: 'Pagar facturas de proveedores', action: 'openPayBills' },
      { icon: Building2,       label: 'Agregar proveedor',             action: 'openVendorForm' },
    ],
  },
  {
    heading: 'Otros',
    items: [
      { icon: Package, label: 'Producto/servicio', action: 'openProductService' },
    ],
  },
]

function CreateMenu({ collapsed, hasPermission }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const navigate = useNavigate()
  const {
    openNewClient,
    openNewSale,
    openReceivePayment,
    openNewExpense,
    openTransferModal,
    openVendorForm,
    openVendorBillModal,
    openPayBillsModal,
    openProductServiceModal,
  } = useModal()

  // Close on click-outside
  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function handleAction(action) {
    setOpen(false)
    if (action === 'newClient') { openNewClient(); return }
    if (action === 'newSale') { openNewSale(); return }
    if (action === 'receivePayment') { openReceivePayment(); return }
    if (action === 'newExpense') { openNewExpense(); return }
    if (action === 'openTransfer') { openTransferModal(); return }
    if (action === 'openVendorForm') { openVendorForm(); return }
    if (action === 'openVendorBill') { openVendorBillModal({}); return }
    if (action === 'openPayBills') { openPayBillsModal({}); return }
    if (action === 'openProductService') { openProductServiceModal(); return }
    navigate(action)
  }

  return (
    <div ref={ref} className="relative px-3 pb-3 pt-2 border-b border-gray-100">
      {/* Trigger button */}
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 w-full rounded-xl border transition-all shadow-sm px-3 py-2.5 font-semibold text-sm
          ${open
            ? 'bg-blue-600 border-blue-600 text-white shadow-blue-200'
            : 'bg-white border-gray-200 text-gray-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-600'
          }
          ${collapsed ? 'justify-center' : 'justify-start'}
        `}
        aria-label="Crear"
      >
        <Plus
          size={18}
          strokeWidth={2.5}
          className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-45 text-white' : 'text-blue-500'}`}
        />
        {!collapsed && <span>Crear</span>}
      </button>

      {/* Dropdown popover */}
      {open && (
        <div
          className={`absolute top-2 z-50 bg-white rounded-xl shadow-xl border border-gray-100 py-2 w-64
            ${collapsed ? 'left-14' : 'left-full ml-2'}
          `}
        >
          {CREATE_GROUPS.map((group, gi) => (
            <div key={group.heading}>
              {gi > 0 && <hr className="my-1.5 border-gray-100" />}
              <p className="px-4 pt-1.5 pb-1 text-[10px] font-bold uppercase tracking-widest text-gray-400">
                {group.heading}
              </p>
              {group.items
                .filter((item) => !item.permission || hasPermission(item.permission))
                .map(({ icon: Icon, label, action }) => (
                <button
                  key={label}
                  onClick={() => handleAction(action)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors text-left"
                >
                  <Icon size={15} className="text-gray-400 shrink-0" />
                  {label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Contabilidad (submenú estilo menú Crear) ──────────────────────────────────

function AccountingDropdown({ item, collapsed }) {
  const location = useLocation()
  const { icon: Icon, label, submenu } = item
  const inSection = submenu?.some((s) => location.pathname === s.to)
  const [open, setOpen] = useState(inSection)
  const ref = useRef(null)

  useEffect(() => {
    if (inSection) setOpen(true)
  }, [inSection])

  useEffect(() => {
    if (!open) return
    function handler(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (collapsed) {
    return (
      <div ref={ref} className="relative px-2">
        <button
          type="button"
          title={label}
          onClick={() => setOpen((o) => !o)}
          className={`w-full flex items-center justify-center p-2.5 rounded-lg text-sm font-medium transition-colors ${
            inSection ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
          }`}
        >
          <Icon size={18} className={inSection ? 'text-blue-600' : 'text-gray-400'} />
        </button>
        {open && (
          <div className="absolute left-full top-0 ml-2 z-50 w-52 bg-white rounded-xl shadow-xl border border-gray-100 py-2">
            {submenu.map((s) => (
              <NavLink
                key={s.to}
                to={s.to}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  `w-full flex items-center px-4 py-2.5 text-sm text-left transition-colors ${
                    isActive ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700'
                  }`
                }
              >
                {s.label}
              </NavLink>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={ref} className="px-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          inSection ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
        }`}
      >
        <Icon
          size={18}
          className={`shrink-0 ${inSection ? 'text-blue-600' : 'text-gray-400 group-hover:text-gray-600'}`}
        />
        <span className="flex-1 text-left truncate">{label}</span>
        <ChevronDown
          size={16}
          className={`shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''} ${
            inSection ? 'text-blue-600' : 'text-gray-400'
          }`}
        />
      </button>
      {open && (
        <ul className="mt-0.5 ml-3 pl-3 border-l border-gray-100 space-y-0.5 py-1">
          {submenu.map((s) => (
            <li key={s.to}>
              <NavLink
                to={s.to}
                className={({ isActive }) =>
                  `block py-2 pl-1 pr-2 rounded-lg text-sm transition-colors ${
                    isActive
                      ? 'text-blue-600 font-semibold bg-blue-50/70'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                  }`
                }
              >
                {s.label}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Definición de navegación con control de acceso ───────────────────────────

const NAV_ITEMS = [
  { label: 'Dashboard',          icon: LayoutDashboard, to: '/dashboard',     permission: PERMS.DASHBOARD_VIEW },
  { label: 'Clientes',           icon: Users,           to: '/clientes',      permission: PERMS.CLIENTS_VIEW },
  { label: 'Inventario IPTV',    icon: Package,         to: '/inventario',    permission: PERMS.INVENTORY_VIEW },
  { label: 'Ventas',             icon: ShoppingCart,    to: '/ventas',        permissionAny: 'sales' },
  { label: 'Suscripciones IPTV', icon: Tv2,             to: '/suscripciones', permission: PERMS.SALES_SUBSCRIPTIONS_VIEW },
  {
    label: 'Contabilidad',
    icon: BookOpen,
    permissionAny: 'accounting',
    submenu: [
      { label: 'Plan de cuentas', to: '/contabilidad/plan-de-cuentas', permission: PERMS.ACCOUNTING_CHART_VIEW },
      { label: 'Cuentas por cobrar', to: '/contabilidad/cuentas-por-cobrar', permission: PERMS.ACCOUNTING_RECEIVABLES_VIEW },
      { label: 'Gastos',          to: '/contabilidad/gastos', permission: PERMS.ACCOUNTING_EXPENSES_VIEW },
      { label: 'Proveedores',     to: '/contabilidad/proveedores', permission: PERMS.ACCOUNTING_VENDORS_VIEW },
      { label: 'Conciliar',       to: '/contabilidad/conciliar', permission: PERMS.ACCOUNTING_RECONCILE_VIEW },
    ],
  },
  { label: 'Informes', icon: BarChart3, to: '/informes', permission: PERMS.REPORTS_FINANCIAL_VIEW },
]

const BOTTOM_ITEMS = [
  { label: 'Equipo', icon: UsersRound, to: '/equipo', permission: PERMS.TEAM_USERS_VIEW },
  { label: 'Billeteras BaaS', icon: Wallet, to: '/equipo/distribuidores', baasAccess: true },
]

// ── Componente ───────────────────────────────────────────────────────────────

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const navigate = useNavigate()
  const { user, isAdmin, hasAnyBaasAccess, hasPermission, permissions, clearSession } = useAuth()

  const navCtx = { role: user?.role, permissions, isAdmin, hasAnyBaasAccess }

  const primaryLedgerPath = getPrimaryAssignedAccountPath(user)
  const restrictedLedger = isRestrictedLedgerUser(user)
  const directContabilidadNav = restrictedLedger && primaryLedgerPath

  const visibleNavItems = NAV_ITEMS
    .filter((item) => isNavItemVisible(item, navCtx))
    .map((item) =>
      item.submenu
        ? {
            ...item,
            submenu: item.submenu.filter((s) => isNavItemVisible({ permission: s.permission }, navCtx)),
          }
        : item,
    )
    .filter((item) => !item.submenu || item.submenu.length > 0)

  const visibleBottomItems = BOTTOM_ITEMS.filter((item) => isNavItemVisible(item, navCtx))

  function handleLogout() {
    clearSession()
    navigate('/login', { replace: true })
  }

  return (
    <aside
      className={`relative flex flex-col bg-white border-r border-gray-200 h-screen transition-all duration-300 shrink-0 ${
        collapsed ? 'w-16' : 'w-60'
      }`}
    >
      {/* Logo */}
      <div className="flex items-center h-16 px-4 border-b border-gray-100 shrink-0">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <Tv2 size={16} className="text-white" />
          </div>
          {!collapsed && (
            <span className="font-bold text-gray-800 text-sm tracking-wide whitespace-nowrap">
              IPTV ERP
            </span>
          )}
        </div>
      </div>

      {/* Quick-create menu — oculto para trabajador/verificador con acceso limitado */}
      {!restrictedLedger && (
        <CreateMenu collapsed={collapsed} hasPermission={hasPermission} />
      )}

      {/* Navigation */}
      <nav className="flex-1 py-4 overflow-y-auto flex flex-col justify-between">
        <ul className="space-y-1 px-2">
          {visibleNavItems.map((item) =>
            item.submenu && directContabilidadNav ? (
              <li key={item.label}>
                <NavLink
                  to={primaryLedgerPath}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors group ${
                      isActive
                        ? 'bg-blue-50 text-blue-600'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                    }`
                  }
                >
                  {({ isActive }) => {
                    const Icon = item.icon
                    return (
                      <>
                        <Icon
                          size={18}
                          className={`shrink-0 ${
                            isActive
                              ? 'text-blue-600'
                              : 'text-gray-400 group-hover:text-gray-600'
                          }`}
                        />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </>
                    )
                  }}
                </NavLink>
              </li>
            ) : item.submenu ? (
              <li key={item.label}>
                <AccountingDropdown item={item} collapsed={collapsed} />
              </li>
            ) : (
            <li key={item.label}>
              <NavLink
                to={item.to}
                end={item.to === '/'}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors group ${
                    isActive
                      ? 'bg-blue-50 text-blue-600'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`
                }
              >
                {({ isActive }) => {
                  const Icon = item.icon
                  return (
                  <>
                    <Icon
                      size={18}
                      className={`shrink-0 ${
                        isActive
                          ? 'text-blue-600'
                          : 'text-gray-400 group-hover:text-gray-600'
                      }`}
                    />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </>
                  )
                }}
              </NavLink>
            </li>
            ),
          )}
        </ul>

        {/* Bottom section: team + logout */}
        <div className="px-2 pb-2 border-t border-gray-100 pt-2 mt-2 space-y-1">
          {visibleBottomItems.map(({ label, icon: Icon, to }) => (
            <NavLink
              key={label}
              to={to}
              end={to === '/equipo'}
              title={collapsed ? label : undefined}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors group ${
                  isActive
                    ? 'bg-blue-50 text-blue-600'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    size={18}
                    className={`shrink-0 ${
                      isActive
                        ? 'text-blue-600'
                        : 'text-gray-400 group-hover:text-gray-600'
                    }`}
                  />
                  {!collapsed && <span className="truncate">{label}</span>}
                </>
              )}
            </NavLink>
          ))}

          {/* User badge */}
          {!collapsed && user && (
            <div className="px-3 py-2 mt-1 rounded-lg bg-gray-50 border border-gray-100">
              <p className="text-xs font-semibold text-gray-700 truncate">{user.name}</p>
              <p className="text-xs text-gray-400 capitalize">{user.role === 'admin' ? 'Administrador' : 'Trabajador'}</p>
            </div>
          )}

          {/* Logout button */}
          <button
            onClick={handleLogout}
            title={collapsed ? 'Cerrar Sesión' : undefined}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium
                       text-red-500 hover:bg-red-50 hover:text-red-600 transition-colors group"
          >
            <LogOut size={18} className="shrink-0 text-red-400 group-hover:text-red-600" />
            {!collapsed && <span className="truncate">Cerrar Sesión</span>}
          </button>
        </div>
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-20 z-10 flex items-center justify-center w-6 h-6 rounded-full bg-white border border-gray-200 shadow-sm text-gray-500 hover:text-blue-600 hover:border-blue-300 transition-colors"
        aria-label={collapsed ? 'Expandir menú' : 'Colapsar menú'}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
      </button>
    </aside>
  )
}
