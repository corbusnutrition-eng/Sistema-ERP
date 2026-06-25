import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  Plus,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Info,
  AlertCircle,
  Search,
  X,
} from 'lucide-react'
import api from '../../api/axios'
import { getApiErrorMessage } from '../../lib/apiErrors'
import { ACCOUNT_TYPE_LABELS } from './constants'
import NuevaCuentaModal from './components/NuevaCuentaModal'

/** Saldo efectivo según líneas del libro mayor (`system_balance` = apertura + journal). */
function ledgerDisplayBalance(row) {
  if (row == null) return 0
  const s = row.system_balance
  if (s !== undefined && s !== null && String(s).trim() !== '') return Number(s) || 0
  return Number(row.current_balance) || 0
}

function moneyInCurrency(n, currencyCode = 'USD') {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: currencyCode,
      minimumFractionDigits: 2,
    }).format(Number(n) || 0)
  } catch {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
    }).format(Number(n) || 0)
  }
}

/** Etiqueta tipo QuickBooks: detalle específico (detail_type); si falta, categoría ledger en español. */
function accountTypeDisplayLabel(row) {
  const detail = typeof row.detail_type === 'string' ? row.detail_type.trim() : ''
  if (detail) return detail
  return ACCOUNT_TYPE_LABELS[row.account_type] || row.account_type || '—'
}

/**
 * Filtro jerárquico: una coincidencia incluye esa cuenta + todos los descendientes;
 * coincidencias en hijas incluyen la cadena de ancestros hacia la raíz, sin hermanos.
 */
function filterChartAccountsHierarchy(accounts, searchTermRaw) {
  const needle = (searchTermRaw || '').trim().toLowerCase()
  const list = Array.isArray(accounts) ? [...accounts] : []
  if (!needle) return list

  const byId = new Map(list.map((a) => [a.id, a]))

  /** parent_id → id de cuenta hija directa */
  const childrenIdsByParentId = new Map()
  for (const a of list) {
    const pid = a.parent_id
    if (pid == null) continue
    if (!childrenIdsByParentId.has(pid)) childrenIdsByParentId.set(pid, [])
    childrenIdsByParentId.get(pid).push(a.id)
  }

  function rowMatches(acc) {
    const blob = [
      acc.name,
      acc.account_number,
      acc.account_type,
      acc.detail_type,
      acc.linked_payment_method,
      acc.currency,
      accountTypeDisplayLabel(acc),
      ACCOUNT_TYPE_LABELS[acc.account_type],
    ]
      .filter((x) => x != null && String(x).trim() !== '')
      .map((x) => String(x).toLowerCase())
      .join(' ')
    return blob.includes(needle)
  }

  const directHits = new Set()
  for (const a of list) {
    if (rowMatches(a)) directHits.add(a.id)
  }

  function descendantIds(seedId) {
    const acc = new Set()
    const stack = [...(childrenIdsByParentId.get(seedId) || [])]
    while (stack.length) {
      const id = stack.pop()
      if (acc.has(id)) continue
      acc.add(id)
      const kids = childrenIdsByParentId.get(id)
      if (kids) stack.push(...kids)
    }
    return acc
  }

  /** ids de ascendientes hasta la raíz (no incluye el propio seedId salvo llamador) */
  function ancestorChainIds(accId) {
    const acc = new Set()
    let cur = byId.get(accId)
    while (cur?.parent_id != null) {
      const pid = cur.parent_id
      acc.add(pid)
      cur = byId.get(pid)
    }
    return acc
  }

  const includeIds = new Set()
  for (const id of directHits) {
    includeIds.add(id)
    for (const a of ancestorChainIds(id)) includeIds.add(a)
    for (const d of descendantIds(id)) includeIds.add(d)
  }

  return list.filter((a) => includeIds.has(a.id))
}

function PlanToast({ toast, onDismiss }) {
  if (!toast) return null
  const { message, type } = toast
  const palette =
    type === 'success'
      ? 'bg-green-50 text-green-800 ring-green-200 border-green-100'
      : type === 'error'
        ? 'bg-red-50 text-red-800 ring-red-200 border-red-100'
        : 'bg-sky-50 text-sky-900 ring-sky-200 border-sky-100'
  const Icon = type === 'success' ? CheckCircle2 : type === 'error' ? AlertCircle : Info
  const iconCls =
    type === 'success' ? 'text-green-600' : type === 'error' ? 'text-red-500' : 'text-sky-600'

  return (
    <div
      className={`fixed bottom-6 right-6 z-[70] flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ring-1 border ${palette} max-w-sm`}
    >
      <Icon size={18} className={`shrink-0 mt-0.5 ${iconCls}`} />
      <span className="flex-1 leading-snug">{message}</span>
      <button type="button" onClick={onDismiss} className="opacity-60 hover:opacity-100 shrink-0 p-0.5" aria-label="Cerrar">
        <X size={16} />
      </button>
    </div>
  )
}

/**
 * Ordena cuentas: cada raíz (sin parent_id) seguida de sus descendientes en profundidad.
 * displayBalance: raíz = saldo propio + suma recursiva de subcuentas; fila hija = solo saldo propio.
 */
function buildHierarchyChartRows(accounts) {
  const list = Array.isArray(accounts) ? accounts : []

  function cmpAccount(a, b) {
    const t = String(a.account_type || '').localeCompare(String(b.account_type || ''))
    if (t !== 0) return t
    return String(a.name || '').localeCompare(String(b.name || ''), 'es', { sensitivity: 'base' })
  }

  const sumDescendantBalances = (parentId) => {
    let sum = 0
    for (const a of list) {
      if (a.parent_id === parentId) {
        sum += ledgerDisplayBalance(a)
        sum += sumDescendantBalances(a.id)
      }
    }
    return sum
  }

  const childrenMap = new Map()
  for (const a of list) {
    const pid = a.parent_id
    if (pid == null) continue
    if (!childrenMap.has(pid)) childrenMap.set(pid, [])
    childrenMap.get(pid).push(a)
  }
  for (const kids of childrenMap.values()) {
    kids.sort(cmpAccount)
  }

  const roots = list.filter((a) => a.parent_id == null)
  roots.sort(cmpAccount)

  const ordered = []
  const visitAccountKeys = new Set()

  const byId = new Map(list.map((a) => [a.id, a]))

  function depthOf(acc) {
    let d = 0
    let cur = acc
    while (cur?.parent_id != null && byId.has(cur.parent_id)) {
      d += 1
      cur = byId.get(cur.parent_id)
    }
    return d
  }

  function walk(node, depth = 0) {
    const isSubaccount = node.parent_id != null
    const own = ledgerDisplayBalance(node)
    const displayBalance = isSubaccount ? own : own + sumDescendantBalances(node.id)
    ordered.push({ row: node, isSubaccount, displayBalance, depth })
    visitAccountKeys.add(node.id)
    const kids = childrenMap.get(node.id) || []
    for (const child of kids) walk(child, depth + 1)
  }

  for (const r of roots) walk(r)

  const orphans = list.filter((a) => !visitAccountKeys.has(a.id))
  orphans.sort(cmpAccount)
  for (const o of orphans) {
    ordered.push({
      row: o,
      isSubaccount: true,
      displayBalance: ledgerDisplayBalance(o),
      depth: depthOf(o),
    })
  }

  return ordered
}

const MENU_APPROX_HEIGHT = 260
const MENU_GAP = 8

/** Split button estilo QuickBooks: historial + menú en portal (evita clip por overflow de la tabla). */
function RowSplitActions({
  onViewHistory,
  onReconcile,
  onEdit,
  onCreateSubaccount,
  onDeactivate,
  onReport,
}) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef(null)
  const anchorRef = useRef(null)
  const menuPortalRef = useRef(null)
  const [menuStyle, setMenuStyle] = useState(null)

  const items = [
    { label: 'Conciliar', onClick: onReconcile },
    { label: 'Editar', onClick: onEdit },
    { label: 'Crear cuenta secundaria', onClick: onCreateSubaccount },
    { label: 'Desactivar (reduce el uso)', onClick: onDeactivate },
    { label: 'Generar informe', onClick: onReport },
  ]

  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(null)
      return
    }
    const anchor = anchorRef.current
    if (!anchor) return

    const computePosition = () => {
      const rect = anchor.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP
      const spaceAbove = rect.top - MENU_GAP
      const openUpward = spaceBelow < MENU_APPROX_HEIGHT && spaceAbove > spaceBelow

      setMenuStyle({
        position: 'fixed',
        right: Math.max(MENU_GAP, window.innerWidth - rect.right),
        zIndex: 100,
        minWidth: 240,
        ...(openUpward
          ? { bottom: window.innerHeight - rect.top + MENU_GAP }
          : { top: rect.bottom + MENU_GAP }),
      })
    }

    computePosition()
    window.addEventListener('scroll', computePosition, true)
    window.addEventListener('resize', computePosition)
    return () => {
      window.removeEventListener('scroll', computePosition, true)
      window.removeEventListener('resize', computePosition)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e) {
      const t = e.target
      if (wrapperRef.current?.contains(t)) return
      if (menuPortalRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const menuNode =
    open &&
    menuStyle &&
    createPortal(
      <div
        ref={menuPortalRef}
        role="menu"
        style={menuStyle}
        className="py-1 bg-white rounded-xl shadow-xl ring-1 ring-gray-200 border border-gray-100 text-sm"
      >
        {items.map(({ label, onClick }) => (
          <button
            key={label}
            type="button"
            role="menuitem"
            className="w-full px-3 py-2.5 text-left text-gray-800 hover:bg-gray-50 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
              onClick()
            }}
          >
            {label}
          </button>
        ))}
      </div>,
      document.body,
    )

  return (
    <div
      className="flex justify-end"
      ref={wrapperRef}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="inline-flex rounded-lg border border-gray-200 bg-white shadow-sm">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onViewHistory()
          }}
          className="px-3 py-2 text-sm font-medium text-green-700 hover:text-green-800 hover:bg-emerald-50/70 transition-colors text-left"
        >
          Historial de la cuenta
        </button>
        <div className="relative flex border-l border-gray-200" ref={anchorRef}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setOpen((o) => !o)
            }}
            className="px-2.5 py-2 text-gray-600 hover:bg-gray-50 hover:text-gray-900"
            aria-expanded={open}
            aria-haspopup="menu"
            aria-label="Más acciones"
          >
            <ChevronDown size={18} className={open ? 'rotate-180 transition-transform duration-200' : ''} />
          </button>
        </div>
      </div>
      {menuNode}
    </div>
  )
}

export default function ChartOfAccounts() {
  const navigate = useNavigate()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [modalEditAccount, setModalEditAccount] = useState(null)
  const [modalInitialParentId, setModalInitialParentId] = useState(null)
  const [toast, setToast] = useState(null)
  const [deactivatingId, setDeactivatingId] = useState(null)
  const [searchTerm, setSearchTerm] = useState('')
  /** Expandir/colapsar nodos padre `{ [accountId]: true }`; ausente = contraído. */
  const [expandedAccounts, setExpandedAccounts] = useState(() => ({}))

  const cuentasFiltradas = useMemo(
    () => filterChartAccountsHierarchy(rows, searchTerm),
    [rows, searchTerm],
  )

  const hierarchicalRows = useMemo(() => buildHierarchyChartRows(cuentasFiltradas), [cuentasFiltradas])

  /** Padres que tienen al menos una subcuenta en el conjunto filtrado (expandir/colapsar al clic en el nombre). */
  const parentIdsWithChildren = useMemo(() => {
    const s = new Set()
    for (const a of cuentasFiltradas) {
      if (a.parent_id != null) s.add(a.parent_id)
    }
    return s
  }, [cuentasFiltradas])

  const hasActiveSearch = searchTerm.trim() !== ''

  const isParentExpanded = useCallback(
    (parentId) => {
      if (hasActiveSearch) return true
      return Boolean(expandedAccounts[parentId])
    },
    [expandedAccounts, hasActiveSearch],
  )

  const toggleExpand = useCallback((accountId) => {
    setExpandedAccounts((prev) => ({
      ...prev,
      [accountId]: !prev[accountId],
    }))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get('/api/v1/accounts/')
      setRows(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(getApiErrorMessage(err, { fallback: 'No se pudo cargar el plan de cuentas.' }))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function showToast(message, type = 'info') {
    setToast({ message, type })
    window.setTimeout(() => setToast(null), 4200)
  }

  function toastInfo() {
    showToast('Módulo en desarrollo', 'info')
  }

  function handleViewHistory(accountId) {
    navigate(`/contabilidad/cuenta/${accountId}`)
  }

  function handleReconcile(accountId) {
    navigate(`/contabilidad/conciliar/${accountId}`)
  }

  function handleEditAccount(account) {
    setModalEditAccount(account)
    setModalInitialParentId(null)
    setModalOpen(true)
  }

  function handleOpenCreateSubaccount(account) {
    setModalEditAccount(null)
    setModalInitialParentId(account.id)
    setModalOpen(true)
  }

  async function handleDeactivateAccount(accountId) {
    if (deactivatingId != null) return
    setDeactivatingId(accountId)
    try {
      await api.patch(`/api/v1/accounts/${accountId}/deactivate`)
      showToast('Cuenta desactivada correctamente.', 'success')
      await load()
    } catch (e) {
      const d = e?.response?.data?.detail
      showToast(typeof d === 'string' ? d : 'No se pudo desactivar la cuenta.', 'error')
    } finally {
      setDeactivatingId(null)
    }
  }

  function openNewModal() {
    setModalEditAccount(null)
    setModalInitialParentId(null)
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
    setModalEditAccount(null)
    setModalInitialParentId(null)
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <span>Contabilidad</span>
            <ChevronRight size={12} className="text-gray-300" />
            <span className="text-gray-700 font-medium">Plan de cuentas</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Plan de cuentas</h1>
          <p className="text-sm text-gray-500 mt-0.5">Estructura tipo QuickBooks · saldos desde movimientos del sistema</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Actualizar
          </button>
          <button
            type="button"
            onClick={openNewModal}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 shadow-sm"
          >
            <Plus size={16} />
            Nuevo
          </button>
        </div>
      </div>

      <div className="relative max-w-xl">
        <Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          type="search"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Buscar por nombre, tipo de cuenta o moneda…"
          className="w-full pl-10 pr-10 py-2.5 rounded-xl border border-gray-200 bg-white text-sm text-gray-900 placeholder:text-gray-400 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
          aria-label="Buscar cuentas"
        />
        {searchTerm.trim() !== '' && (
          <button
            type="button"
            aria-label="Limpiar búsqueda"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            onClick={() => setSearchTerm('')}
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200/80 shadow-sm overflow-visible pb-2">
        <div className="px-6 py-3 border-b border-gray-100 bg-gradient-to-r from-gray-50 to-white">
          <div className="grid grid-cols-12 gap-2 text-[11px] font-bold uppercase tracking-wider text-gray-500">
            <div className="col-span-4">Nombre</div>
            <div className="col-span-2">Tipo de cuenta</div>
            <div className="col-span-1">Moneda</div>
            <div className="col-span-2 text-right">Saldo en el sistema</div>
            <div className="col-span-3 text-right">Acciones</div>
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-400 text-sm">Cargando cuentas…</div>
        ) : error ? (
          <div className="p-8 text-center text-red-500 text-sm">{error}</div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center text-gray-400 text-sm">
            No hay cuentas todavía. Pulsa <strong>Nuevo</strong> para crear la primera.
          </div>
        ) : cuentasFiltradas.length === 0 ? (
          <div className="p-12 text-center text-gray-400 text-sm">
            No hay cuentas que coincidan con <strong>{searchTerm.trim()}</strong>. Prueba con otro término o limpia el
            filtro.
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {hierarchicalRows.map(({ row, isSubaccount, displayBalance, depth }) => {
              const pid = row.parent_id
              if (pid != null && !isParentExpanded(pid)) {
                return null
              }

              const hasChildren = parentIdsWithChildren.has(row.id)
              /** Negrita (peso ~600): raíces o cualquier cuenta que tiene subcuentas. */
              const nameStrong = Boolean(hasChildren) || !isSubaccount

              const depthPx = (typeof depth === 'number' ? depth : 0) * 16

              const nameCellClickable = Boolean(hasChildren)
              const ariaExpanded =
                nameCellClickable && !hasActiveSearch ? Boolean(expandedAccounts[row.id]) : undefined

              const handleToggleNameCell = () => {
                if (hasChildren) toggleExpand(row.id)
              }

              const handleNameKeyDown = (e) => {
                if (!hasChildren) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggleExpand(row.id)
                }
              }

              return (
              <div
                key={row.id}
                className="grid grid-cols-12 gap-2 items-center px-6 py-3.5 hover:bg-slate-50/80 transition-colors text-sm"
              >
                <div
                  className={`col-span-4 min-w-0 ${isSubaccount ? 'border-l border-gray-200/90 pl-2.5' : ''} ${
                    nameCellClickable
                      ? 'cursor-pointer select-none rounded-md -mx-1 px-1 py-0.5 hover:bg-slate-100/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50'
                      : ''
                  }`}
                  style={{
                    paddingLeft: depthPx,
                    marginLeft: isSubaccount ? 4 : 0,
                  }}
                  onClick={nameCellClickable ? handleToggleNameCell : undefined}
                  onKeyDown={nameCellClickable ? handleNameKeyDown : undefined}
                  role={nameCellClickable ? 'button' : undefined}
                  tabIndex={nameCellClickable ? 0 : undefined}
                  aria-expanded={ariaExpanded}
                  aria-label={
                    nameCellClickable
                      ? expandedAccounts[row.id]
                        ? 'Contraer subcuentas'
                        : 'Expandir subcuentas'
                      : undefined
                  }
                >
                    <p className={`truncate ${nameStrong ? 'font-semibold text-gray-900' : 'font-normal text-gray-600'}`}>
                      {row.name}
                    </p>
                  {row.account_number && (
                    <p className={`text-xs ${isSubaccount ? 'text-gray-500' : 'text-gray-500'}`}>
                      N.º {row.account_number}
                    </p>
                  )}
                  {row.parent_name && (
                    <p className={`text-[11px] ${isSubaccount ? 'text-gray-500' : 'text-gray-400'}`}>
                      Subcuenta de {row.parent_name}
                    </p>
                  )}
                </div>
                <div className={`col-span-2 ${isSubaccount ? 'text-gray-600' : 'text-gray-700 font-medium'}`}>
                  {accountTypeDisplayLabel(row)}
                </div>
                <div className={`col-span-1 ${isSubaccount ? 'text-gray-600 font-normal' : 'text-gray-600 font-semibold'}`}>
                  {row.currency}
                </div>
                <div
                  className={`col-span-2 text-right tabular-nums ${
                    isSubaccount ? 'font-normal text-gray-600' : 'font-semibold text-gray-900'
                  }`}
                >
                  {moneyInCurrency(displayBalance, row.currency)}
                </div>
                <div className="col-span-3 min-w-0">
                  <RowSplitActions
                    onViewHistory={() => handleViewHistory(row.id)}
                    onReconcile={() => handleReconcile(row.id)}
                    onEdit={() => handleEditAccount(row)}
                    onCreateSubaccount={() => handleOpenCreateSubaccount(row)}
                    onDeactivate={() => handleDeactivateAccount(row.id)}
                    onReport={toastInfo}
                  />
                </div>
              </div>
              )
            })}
          </div>
        )}
      </div>

      {modalOpen && (
        <NuevaCuentaModal
          editAccount={modalEditAccount}
          initialParentId={modalInitialParentId}
          onClose={closeModal}
          onCreated={() => {
            load()
          }}
        />
      )}

      <PlanToast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}
