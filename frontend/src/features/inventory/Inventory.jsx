import {
  Fragment,
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
} from 'react'
import {
  PlusCircle, Tv2, Monitor, CheckCircle2, Coins,
  CalendarDays, X, Loader2,
  Pencil, Trash2, AlertTriangle, ChevronDown, ChevronRight, ChevronLeft,
  Package, History,
} from 'lucide-react'
import api from '../../api/axios'
import SearchableSelect from '../../components/ui/SearchableSelect'
import { useInventoryData } from '../../context/InventoryDataContext'
import { useModal } from '../../context/ModalContext'
import CuentaMasterModal from './components/CuentaMasterModal'
import InventorySummaryCards from './components/InventorySummaryCards'
import { calculateExpirationStats, parseCreatedDate } from './screenPackageExpiration'

// ── Constants ─────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'full',    label: 'Crédito normal',        icon: Tv2     },
  { id: 'screens', label: 'Crédito por pantalla', icon: Monitor },
  { id: 'history', label: 'Historial (Pantallas)', icon: History },
]

/** Paginación tabla «Relleno por pantalla»: hasta N grupos/lotes por página (no pantallas sueltas). */
const ITEMS_PER_PAGE = 20

/** Valor «Todos» en selects de filtro de pantallas. */
const SCREEN_FILTER_ALL = '__ALL__'

/** Estado reservado (preventa); «held» es legado API/BD antes de renombrar a reserved. */
function isScreenReservedLike(status) {
  return status === 'reserved' || status === 'held'
}

/** Clave única de paquete (producto + proveedor + nombre de paquete). */
function packageKeyForScreen(screen) {
  const pid = Number(screen?.product_id)
  const pkg = String(screen?.package ?? '').trim().toLowerCase()
  const prov = String(screen?.provider ?? '').trim().toLowerCase()
  return `${Number.isFinite(pid) ? pid : 'na'}|${prov}|${pkg}`
}

function buildFreeCountByPackageKey(screensList) {
  const m = new Map()
  for (const s of screensList) {
    const key = packageKeyForScreen(s)
    if (!m.has(key)) m.set(key, 0)
    if (s.status === 'free') m.set(key, m.get(key) + 1)
  }
  return m
}

const IPTV_PROVIDER_SELECT_OPTIONS = [
  { value: 'Flujo', label: 'Flujo' },
  { value: 'Stella', label: 'Stella' },
]

const SCREEN_STOCK_STATUS_OPTIONS = [
  { value: 'free', label: 'Disponible' },
  { value: 'reserved', label: 'Reservada (preventa)' },
  { value: 'assigned', label: 'Asignada' },
]

/** Filtros de pestaña pantallas. */
const SCREEN_TAB_STATUS_FILTER_OPTIONS = [
  { value: SCREEN_FILTER_ALL, label: 'Todos' },
  { value: 'free', label: 'Disponible' },
  { value: 'reserved', label: 'Reservada' },
  { value: 'assigned', label: 'Asignada' },
]

/** Columnas tabla pantallas: orden debe coincidir con las celdas `<td>` del cuerpo. */
const SCREEN_COLUMN_CONFIG = [
  { id: 'idx', label: '#', defaultWidth: 52, minWidth: 44, maxWidth: 120 },
  {
    id: 'product_pkg',
    label: 'Producto / Paquete',
    defaultWidth: 304,
    minWidth: 200,
    maxWidth: 560,
  },
  { id: 'status', label: 'Estado', defaultWidth: 136, minWidth: 108, maxWidth: 220 },
  { id: 'created', label: 'Fecha creación', defaultWidth: 122, minWidth: 104, maxWidth: 220 },
  { id: 'expiration', label: 'Vencimiento', defaultWidth: 148, minWidth: 120, maxWidth: 280 },
  { id: 'cost', label: 'Costo/Paquete', defaultWidth: 132, minWidth: 104, maxWidth: 220 },
  { id: 'batch', label: 'Lote', defaultWidth: 100, minWidth: 72, maxWidth: 160 },
  { id: 'creds', label: 'Credenciales', defaultWidth: 148, minWidth: 108, maxWidth: 320 },
  { id: 'client', label: 'Cliente', defaultWidth: 136, minWidth: 100, maxWidth: 260 },
  { id: 'actions', label: 'Acciones', defaultWidth: 108, minWidth: 88, maxWidth: 220 },
]

function ResizableScreenTh({ column, width, onColumnResize, children }) {
  const { id, minWidth, maxWidth } = column
  const isSticky = id === 'actions'

  const onResizeStart = useCallback(
    (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startW = width
      const move = (ev) => {
        const dx = ev.clientX - startX
        const next = Math.min(maxWidth, Math.max(minWidth, startW + dx))
        onColumnResize(id, next)
      }
      const up = () => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    },
    [id, width, minWidth, maxWidth, onColumnResize],
  )

  return (
    <th
      scope="col"
      style={{ width, minWidth }}
      className={`relative border-b border-gray-100 bg-gray-50 text-left align-middle ${
        isSticky
          ? 'sticky right-0 z-20 border-l border-gray-200 shadow-[-6px_0_14px_-8px_rgba(0,0,0,0.12)]'
          : ''
      }`}
    >
      <div className="pointer-events-none flex items-center px-4 py-3 pr-3 min-w-0">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider truncate">{children}</span>
      </div>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Redimensionar columna ${column.label}`}
        title="Arrastrar para cambiar ancho"
        className="absolute top-0 bottom-0 right-0 z-[25] w-3 cursor-col-resize border-0 bg-transparent p-0 hover:bg-slate-300/25 active:bg-slate-400/35"
        onMouseDown={onResizeStart}
      />
    </th>
  )
}

/** Lista de páginas a pintar (números o 'ellipsis'). */
function buildScreenPaginationPages(current, total) {
  if (total <= 0) return []
  if (total <= 9) return Array.from({ length: total }, (_, i) => i + 1)
  const want = new Set([1, total])
  for (let d = -2; d <= 2; d++) {
    const p = current + d
    if (p >= 1 && p <= total) want.add(p)
  }
  const sorted = [...want].sort((a, b) => a - b)
  const out = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push('ellipsis')
    out.push(sorted[i])
  }
  return out
}

const STATUS_CFG = {
  free:     { label: 'Disponible', cls: 'bg-green-50 text-green-700 ring-green-200', dot: 'bg-green-500' },
  reserved: { label: 'Reservada',  cls: 'bg-yellow-100 text-yellow-800 ring-yellow-200', dot: 'bg-yellow-500' },
  assigned: { label: 'Asignada',   cls: 'bg-blue-50 text-blue-700 ring-blue-200',   dot: 'bg-blue-500'  },
}

// ── Pure display sub-components ───────────────────────────────────────────────

function ScreenStatusBadge({ status }) {
  const key = isScreenReservedLike(status) ? 'reserved' : (status ?? 'free')
  const cfg = STATUS_CFG[key] ?? STATUS_CFG.free
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ring-1 ${cfg.cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  )
}

/** Celda de credenciales IPTV (por fila de pantalla). */
function CredentialsBlock({ username, password }) {
  const u = username != null ? String(username).trim() : ''
  const p = password != null ? String(password).trim() : ''
  if (!u && !p) {
    return <span className="text-xs text-gray-400">—</span>
  }
  return (
    <div className="text-xs text-gray-500 space-y-0.5 max-w-[11rem]">
      {u ? <div>Usuario: <span className="text-gray-700 break-all">{u}</span></div> : null}
      {p ? <div>Pass: <span className="text-gray-700 break-all">{p}</span></div> : null}
    </div>
  )
}

function CredentialsTd({ row }) {
  return (
    <td className="px-4 py-3 align-top whitespace-normal">
      <CredentialsBlock username={row?.iptv_username} password={row?.iptv_password} />
    </td>
  )
}

function AssignedClientTd({ row }) {
  const name = row?.assigned_client_name != null ? String(row.assigned_client_name).trim() : ''
  if (!name) {
    return <td className="px-4 py-3 whitespace-nowrap text-gray-400 text-sm">—</td>
  }
  const reservedLike = isScreenReservedLike(row?.status)
  const chipCls = reservedLike
    ? 'text-yellow-950 bg-yellow-50 border-yellow-200/90'
    : 'text-blue-950 bg-slate-100 border-slate-200/90'
  return (
    <td className="px-4 py-3 whitespace-nowrap">
      <span
        className={`inline-flex max-w-[14rem] truncate text-xs font-medium border px-2 py-0.5 rounded-md ${chipCls}`}
        title={name}
      >
        {name}
      </span>
    </td>
  )
}

/** Cabecera de lote: mismas credenciales en todas las filas o aviso. */
function BatchCredentialsTd({ rows }) {
  const first = rows[0]
  const u0 = first?.iptv_username != null ? String(first.iptv_username).trim() : ''
  const p0 = first?.iptv_password != null ? String(first.iptv_password).trim() : ''
  const uniform = rows.every((r) => {
    const u = r?.iptv_username != null ? String(r.iptv_username).trim() : ''
    const pw = r?.iptv_password != null ? String(r.iptv_password).trim() : ''
    return u === u0 && pw === p0
  })
  return (
    <td className="px-4 py-3 align-top whitespace-normal">
      {!uniform ? (
        <span className="text-xs text-gray-400 italic">Varias credenciales</span>
      ) : (
        <CredentialsBlock username={u0} password={p0} />
      )}
    </td>
  )
}

/** Fondo alineado con la franja de fila + sticky para que «Acciones» siga visible al hacer scroll horizontal. */
function stickyActionsTdClass(stripe, { muted, parentBatch } = {}) {
  const bg = parentBatch ? 'bg-gray-100' : stripe.includes('slate') ? 'bg-slate-50' : 'bg-white'
  const hover = muted ? 'group-hover:bg-gray-100/80' : 'group-hover:bg-gray-50'
  return [
    'px-4 py-3 whitespace-nowrap sticky right-0 z-[5]',
    'border-l border-gray-200/90 shadow-[-8px_0_16px_-10px_rgba(0,0,0,0.12)]',
    bg,
    hover,
  ].join(' ')
}

function earliestCreatedAtRaw(rows) {
  let bestRaw = null
  let bestMs = Infinity
  for (const r of rows || []) {
    const d = parseCreatedDate(r?.created_at)
    if (!d) continue
    const t = d.getTime()
    if (t < bestMs) {
      bestMs = t
      bestRaw = r.created_at
    }
  }
  return bestRaw
}

/** Ej. «05 may 2026» — DD mes corto YYYY (es-ES). */
function formatCreatedAtShort(raw) {
  const d = parseCreatedDate(raw)
  if (!d) return null
  return d.toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

/** Cadena buscable para filtro por fecha de creación o vencimiento (substring, sin distinguir mayúsculas). */
function buildScreenDateSearchBlob(screen) {
  const parts = []
  const rawCreated = screen?.created_at
  if (rawCreated != null && rawCreated !== '') {
    parts.push(String(rawCreated))
    const short = formatCreatedAtShort(rawCreated)
    if (short) parts.push(short)
    const d = parseCreatedDate(rawCreated)
    if (d) {
      parts.push(d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }))
      parts.push(d.toLocaleDateString('es-ES'))
    }
  }
  const stats = calculateExpirationStats(screen.created_at, screen.package, new Date())
  if (stats?.fechaExpiracionEfectiva) {
    const fe = stats.fechaExpiracionEfectiva
    parts.push(fe.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }))
    parts.push(fe.toISOString().slice(0, 10))
  }
  if (stats) {
    parts.push(String(stats.diasPasados))
    parts.push(String(stats.diasRestantes))
    if (stats.diasRestantes < 0) parts.push('vencido')
  }
  return parts.join(' ').toLowerCase()
}

function CreatedAtTd({ createdAt }) {
  const txt = formatCreatedAtShort(createdAt)
  return (
    <td className="px-4 py-3 whitespace-nowrap align-middle">
      {txt ? (
        <span className="text-xs text-gray-700 tabular-nums">{txt}</span>
      ) : (
        <span className="text-gray-400 text-xs">—</span>
      )}
    </td>
  )
}

function useNowTicker(intervalMs = 60000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/** Columna VENCIMIENTO — Relleno por pantalla: uso / días restantes según paquete + creación. */
function ScreenExpirationStatsBlock({ createdAt, packageName }) {
  const now = useNowTicker(60000)
  const stats = useMemo(
    () => calculateExpirationStats(createdAt, packageName, now),
    [createdAt, packageName, now],
  )
  if (!stats) {
    return <span className="text-gray-400 text-[11px]">—</span>
  }
  const { diasPasados, diasRestantes } = stats
  const expired = diasRestantes < 0
  return (
    <div className="text-[11px] leading-tight space-y-1 max-w-[9.5rem] min-w-0">
      <p className="text-gray-600 tabular-nums">
        <span className="mr-0.5" aria-hidden="true">
          🟢
        </span>
        Uso:{' '}
        <span className="font-semibold text-gray-800">{diasPasados}</span> días
      </p>
      {expired ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-50 text-red-700 ring-1 ring-red-200 px-2 py-0.5 text-[10px] font-semibold">
          <span aria-hidden="true">
            🔴
          </span>
          Vencido
        </span>
      ) : (
        <p className="text-gray-600 tabular-nums">
          <span className="mr-0.5" aria-hidden="true">
            ⏳
          </span>
          Faltan:{' '}
          <span className="font-semibold text-gray-800">{diasRestantes}</span> días
        </p>
      )}
    </div>
  )
}

const DEFAULT_INVENTORY_PRODUCT_COLOR = '#6366f1'

function normalizeHexColor(input) {
  if (input == null || typeof input !== 'string') return null
  const s = input.trim()
  if (/^#[0-9A-Fa-f]{6}$/.test(s)) return s
  if (/^#[0-9A-Fa-f]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
  }
  return null
}

function inventoryAccentHex(row) {
  return normalizeHexColor(row?.product_color) ?? DEFAULT_INVENTORY_PRODUCT_COLOR
}

/** Nombre comercial del producto (API); si es legado sin FK, muestra proveedor IPTV. */
function inventoryDisplayName(row) {
  const pn = row?.product_name != null ? String(row.product_name).trim() : ''
  if (pn) return pn
  const pv = row?.provider_name != null ? String(row.provider_name).trim() : ''
  if (pv) return pv
  const prov = row?.provider != null ? String(row.provider).trim() : ''
  return prov || '—'
}

function ProductInventoryBadge({ row }) {
  const accent = inventoryAccentHex(row)
  const label = inventoryDisplayName(row)
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border border-gray-200 bg-gray-50">
      <Tv2 size={11} style={{ color: accent }} aria-hidden />
      <span style={{ color: accent }}>{label}</span>
    </span>
  )
}

/** Celda combinada: producto (badge) + nombre de paquete + cantidad de pantallas en esta fila/lote. */
function ScreenProductPackageCell({ row, screensInCell = 1 }) {
  const accent = inventoryAccentHex(row)
  const productLabel = inventoryDisplayName(row)
  const pkg = String(row?.package ?? '').trim() || '—'
  const n = Math.max(1, Math.min(5000, Math.round(Number(screensInCell) || 1)))
  return (
    <td className="px-4 py-3 align-top min-w-0">
      <div className="flex flex-col gap-1 min-w-0 max-w-[22rem]">
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border border-gray-200 bg-gray-50 w-fit max-w-full">
          <Tv2 size={11} style={{ color: accent }} aria-hidden />
          <span className="truncate" style={{ color: accent }} title={productLabel}>
            {productLabel}
          </span>
        </span>
        <span className="text-sm font-semibold text-gray-800 leading-snug break-words" title={pkg}>
          {pkg}
        </span>
        <span className="text-xs text-gray-400">
          {n} pantalla{n !== 1 ? 's' : ''}
        </span>
      </div>
    </td>
  )
}

function CreditsBadge({ value }) {
  if (value === null || value === undefined)
    return <span className="text-gray-400 text-xs">—</span>
  return (
    <span className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-600">
      <Coins size={13} />{Number(value).toFixed(2)}
    </span>
  )
}

function ExpirationCell({ dateStr }) {
  if (!dateStr) return <span className="text-gray-400 text-xs">—</span>
  const d    = new Date(dateStr + 'T00:00:00')
  const now  = new Date()
  const days = Math.ceil((d - now) / (1000 * 60 * 60 * 24))
  const fmt  = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })
  const cls  = days < 0 ? 'text-red-600' : days <= 7 ? 'text-amber-600' : 'text-gray-600'
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${cls}`}>
      <CalendarDays size={11} />{fmt}
      {days < 0  && <span className="text-[10px] bg-red-50 text-red-600 ring-1 ring-red-200 px-1.5 py-0.5 rounded-full">Vencida</span>}
      {days >= 0 && days <= 7 && <span className="text-[10px] bg-amber-50 text-amber-600 ring-1 ring-amber-200 px-1.5 py-0.5 rounded-full">{days}d</span>}
    </span>
  )
}

function KpiCard({ label, value, color, bg, icon: Icon }) {
  return (
    <div className={`${bg} rounded-2xl px-5 py-4 ring-1 ring-gray-100 flex items-center justify-between`}>
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
        <p className={`text-3xl font-bold mt-1 ${color}`}>{value}</p>
      </div>
      {Icon && <Icon size={28} className={`${color} opacity-20`} />}
    </div>
  )
}

// ── Row action buttons ─────────────────────────────────────────────────────────

function RowActions({ onEdit, onDelete, hideDelete }) {
  return (
    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        type="button"
        onClick={onEdit}
        className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
        title="Editar"
      >
        <Pencil size={13} />
      </button>
      {hideDelete ? null : (
        <button
          type="button"
          onClick={onDelete}
          className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
          title="Eliminar"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}

// ── Delete confirmation modal ─────────────────────────────────────────────────

function DeleteConfirmModal({ label, onConfirm, onCancel, loading }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-50 ring-1 ring-red-200 flex items-center justify-center shrink-0">
            <AlertTriangle size={18} className="text-red-500" />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900">Eliminar registro</h3>
            <p className="text-sm text-gray-500 mt-1 leading-relaxed">
              ¿Estás seguro de que deseas eliminar <span className="font-medium text-gray-700">{label}</span>?
              Esta acción no se puede deshacer.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm font-semibold text-white bg-red-500 hover:bg-red-600 disabled:opacity-60 rounded-xl transition-colors flex items-center gap-2"
          >
            {loading && <Loader2 size={13} className="animate-spin" />}
            Sí, eliminar
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Edit modal — full-service account ────────────────────────────────────────

function EditFullModal({ record, onSave, onClose }) {
  const [form, setForm] = useState({
    provider_name:   record.provider_name ?? '',
    credits_spent:   record.credits_spent   ?? '',
    cost_per_credit: record.cost_per_credit ?? '',
    recharge_date:   record.recharge_date   ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  const totalPreview = useMemo(() => {
    const c = parseFloat(form.credits_spent)
    const p = parseFloat(form.cost_per_credit)
    if (!isNaN(c) && !isNaN(p) && c > 0 && p > 0) return (c * p).toFixed(2)
    return null
  }, [form.credits_spent, form.cost_per_credit])

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.patch(`/api/v1/inventory/accounts/${record.id}`, {
        provider_name:   form.provider_name,
        credits_spent:   form.credits_spent   !== '' ? parseFloat(form.credits_spent)   : null,
        cost_per_credit: form.cost_per_credit !== '' ? parseFloat(form.cost_per_credit) : null,
        recharge_date:   form.recharge_date   || null,
      })
      onSave()
    } catch (err) {
      setError(err?.response?.data?.detail ?? 'Error al guardar.')
    } finally {
      setSaving(false)
    }
  }

  const lbl = 'block text-xs font-semibold text-gray-600 mb-1.5'
  const inp = 'w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900">Editar recarga</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X size={15} /></button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div>
            <label className={lbl}>Proveedor</label>
            <SearchableSelect
              value={form.provider_name}
              onChange={(v) => setForm((p) => ({ ...p, provider_name: v }))}
              options={IPTV_PROVIDER_SELECT_OPTIONS}
              hideClear
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>Créditos totales</label>
              <input type="number" min="0" step="1" value={form.credits_spent} onChange={e => setForm(p => ({ ...p, credits_spent: e.target.value }))} className={inp} />
            </div>
            <div>
              <label className={lbl}>Costo/crédito (USD)</label>
              <input type="number" min="0" step="0.01" value={form.cost_per_credit} onChange={e => setForm(p => ({ ...p, cost_per_credit: e.target.value }))} className={inp} />
            </div>
          </div>
          {totalPreview && (
            <p className="text-xs text-emerald-600 font-semibold bg-emerald-50 rounded-lg px-3 py-2">
              Total a pagar: <span className="text-sm">${totalPreview} USD</span>
            </p>
          )}
          <div>
            <label className={lbl}>Fecha de recarga</label>
            <input type="date" value={form.recharge_date} onChange={e => setForm(p => ({ ...p, recharge_date: e.target.value }))} className={inp} />
          </div>
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors">Cancelar</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-60 rounded-xl transition-colors flex items-center gap-2">
              {saving && <Loader2 size={13} className="animate-spin" />}Guardar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Edit modal — screen stock ─────────────────────────────────────────────────

function EditScreenModal({ record, onSave, onClose }) {
  const [form, setForm] = useState({
    status:           isScreenReservedLike(record.status) ? 'reserved' : (record.status ?? 'free'),
    expiration_date:  record.expiration_date  ?? '',
    cost_per_package: record.cost_per_package ?? '',
    iptv_username:    record.iptv_username ?? '',
    iptv_password:    record.iptv_password ?? '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.patch(`/api/v1/inventory/screens/${record.id}`, {
        status:           form.status,
        expiration_date:  form.expiration_date || null,
        cost_per_package: form.cost_per_package !== '' ? parseFloat(form.cost_per_package) : null,
        iptv_username:    form.iptv_username.trim() || null,
        iptv_password:    form.iptv_password.trim() || null,
      })
      onSave()
    } catch (err) {
      setError(err?.response?.data?.detail ?? 'Error al guardar.')
    } finally {
      setSaving(false)
    }
  }

  const lbl = 'block text-xs font-semibold text-gray-600 mb-1.5'
  const inp = 'w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-slate-200 focus:border-slate-500 transition'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h3 className="font-semibold text-gray-900">Editar pantalla</h3>
            <p className="text-xs text-gray-400 mt-0.5">{record.provider} · {record.package}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X size={15} /></button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div>
            <label className={lbl}>Estado</label>
            <SearchableSelect
              value={form.status}
              onChange={(v) => setForm((p) => ({ ...p, status: v }))}
              options={SCREEN_STOCK_STATUS_OPTIONS}
              hideClear
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>Vencimiento</label>
              <input type="date" value={form.expiration_date} onChange={e => setForm(p => ({ ...p, expiration_date: e.target.value }))} className={inp} />
            </div>
            <div>
              <label className={lbl}>Costo/paq. (USD)</label>
              <input type="number" min="0" step="0.01" value={form.cost_per_package} onChange={e => setForm(p => ({ ...p, cost_per_package: e.target.value }))} className={inp} />
            </div>
          </div>
          <div>
            <label className={lbl}>Usuario IPTV</label>
            <input
              type="text"
              autoComplete="off"
              value={form.iptv_username}
              onChange={e => setForm(p => ({ ...p, iptv_username: e.target.value }))}
              className={inp}
              placeholder="Opcional (registros antiguos)"
            />
          </div>
          <div>
            <label className={lbl}>Contraseña IPTV</label>
            <input
              type="password"
              autoComplete="new-password"
              value={form.iptv_password}
              onChange={e => setForm(p => ({ ...p, iptv_password: e.target.value }))}
              className={inp}
              placeholder="Opcional"
            />
          </div>
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors">Cancelar</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-semibold text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-60 rounded-xl transition-colors flex items-center gap-2">
              {saving && <Loader2 size={13} className="animate-spin" />}Guardar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, type = 'success', onDismiss }) {
  const base  = 'fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ring-1'
  const style = type === 'success'
    ? `${base} bg-green-50 text-green-800 ring-green-200`
    : `${base} bg-red-50 text-red-800 ring-red-200`
  return (
    <div className={style}>
      <CheckCircle2 size={16} className="text-green-500 shrink-0" />
      <span>{message}</span>
      <button onClick={onDismiss} className="ml-2 opacity-60 hover:opacity-100"><X size={14} /></button>
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ tab }) {
  const { icon: Icon, label } = TABS.find(t => t.id === tab) ?? TABS[0]
  const span = tab === 'screens' || tab === 'history' ? 10 : 6
  const hint =
    tab === 'history'
      ? 'Los paquetes agotados (sin pantallas disponibles) aparecerán aquí.'
      : 'Haz clic en «Recargar créditos» para añadir el primero'
  return (
    <tr>
      <td colSpan={span} className="px-6 py-16 text-center">
        <Icon size={32} className="mx-auto text-gray-200 mb-3" />
        <p className="text-gray-400 text-sm font-medium">Sin registros de {label}</p>
        <p className="text-gray-300 text-xs mt-1">{hint}</p>
      </td>
    </tr>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Inventory() {
  const {
    accounts,
    screens,
    loading,
    refreshInventoryData,
    accountsFailed,
    screensFailed,
  } = useInventoryData()
  const { openProductServiceModal } = useModal()

  const fetchError =
    accountsFailed && screensFailed
      ? 'No se pudo cargar el inventario. Verifica la conexión con el servidor.'
      : null

  const [modalOpen, setModalOpen]         = useState(false)
  const [activeTab, setActiveTab]         = useState('full')
  const [toast, setToast]                 = useState(null)

  // Edit / delete targets
  const [editTarget, setEditTarget]       = useState(null)   // { type: 'full'|'screen', record }
  const [deleteTarget, setDeleteTarget]   = useState(null)   // { type, id, label }
  const [deleting, setDeleting]           = useState(false)
  const [summaryKey, setSummaryKey]       = useState(0)      // incremented to refresh InventorySummaryCards
  /** Filtro activado al hacer clic en tarjetas superiores: tab + proveedor + producto. */
  const [summarySelection, setSummarySelection] = useState(null)
  const summarySelRef = useRef(null)
  summarySelRef.current = summarySelection

  useEffect(() => {
    function onProductsChanged() {
      setSummaryKey((k) => k + 1)
    }
    window.addEventListener('products:changed', onProductsChanged)
    return () => window.removeEventListener('products:changed', onProductsChanged)
  }, [])

  function handleSuccess(serviceType) {
    setModalOpen(false)
    refreshInventoryData()
    setSummaryKey((k) => k + 1)
    const n = serviceType === 'screens'
    showToast(n ? 'Pantallas añadidas a bodega correctamente.' : 'Recarga registrada.')
    if (n) setActiveTab('screens')
  }

  function showToast(message, type = 'success') {
    setToast({ message, type })
    setTimeout(() => setToast(null), 4500)
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      if (deleteTarget.type === 'full') {
        await api.delete(`/api/v1/inventory/accounts/${deleteTarget.id}`)
      } else {
        await api.delete(`/api/v1/inventory/screens/${deleteTarget.id}`)
      }
      setDeleteTarget(null)
      refreshInventoryData()
      showToast('Registro eliminado correctamente.')
    } catch (err) {
      showToast(err?.response?.data?.detail ?? 'Error al eliminar.', 'error')
    } finally {
      setDeleting(false)
    }
  }

  const [screenColWidths, setScreenColWidths] = useState(() =>
    Object.fromEntries(SCREEN_COLUMN_CONFIG.map((c) => [c.id, c.defaultWidth])),
  )

  const handleScreenColumnResize = useCallback((columnId, nextWidth) => {
    setScreenColWidths((prev) => ({ ...prev, [columnId]: nextWidth }))
  }, [])

  const screenTableTotalWidth = useMemo(
    () => SCREEN_COLUMN_CONFIG.reduce((sum, c) => sum + (screenColWidths[c.id] ?? c.defaultWidth), 0),
    [screenColWidths],
  )

  const screenBatchGroups = useMemo(() => {
    const m = new Map()
    for (const s of screens) {
      const bid = String(s.batch_id || '').trim() || `orphan-${s.id}`
      if (!m.has(bid)) m.set(bid, [])
      m.get(bid).push(s)
    }
    return [...m.entries()]
      .map(([batchId, rows]) => ({
        batchId,
        rows: [...rows].sort((a, b) => a.id - b.id),
      }))
      .sort((a, b) => {
        const ta = new Date(a.rows[0]?.created_at || 0).getTime()
        const tb = new Date(b.rows[0]?.created_at || 0).getTime()
        return tb - ta
      })
  }, [screens])

  const [filterProvider, setFilterProvider] = useState(SCREEN_FILTER_ALL)
  const [filterPackage, setFilterPackage] = useState(SCREEN_FILTER_ALL)
  const [filterStatus, setFilterStatus] = useState(SCREEN_FILTER_ALL)
  const [searchDate, setSearchDate] = useState('')
  const [searchCredentials, setSearchCredentials] = useState('')
  const [searchClient, setSearchClient] = useState('')

  const screenFilterProviderOptions = useMemo(() => {
    const next = new Set()
    for (const s of screens) {
      const p = String(s.provider ?? '').trim()
      if (p) next.add(p)
    }
    return [...next].sort((a, b) => a.localeCompare(b, 'es'))
  }, [screens])

  const screenFilterPackageOptions = useMemo(() => {
    const next = new Set()
    for (const s of screens) {
      const p = String(s.package ?? '').trim()
      if (p) next.add(p)
    }
    return [...next].sort((a, b) => a.localeCompare(b, 'es'))
  }, [screens])

  const screenTabProviderFilterOptions = useMemo(
    () => [
      { value: SCREEN_FILTER_ALL, label: 'Todos' },
      ...screenFilterProviderOptions.map((p) => ({ value: p, label: p })),
    ],
    [screenFilterProviderOptions],
  )

  const screenTabPackageFilterOptions = useMemo(
    () => [
      { value: SCREEN_FILTER_ALL, label: 'Todos' },
      ...screenFilterPackageOptions.map((p) => ({ value: p, label: p })),
    ],
    [screenFilterPackageOptions],
  )

  const freeCountByPackageKey = useMemo(
    () => buildFreeCountByPackageKey(screens),
    [screens],
  )

  const filteredScreenBatchGroups = useMemo(() => {
    const wantProv =
      filterProvider === SCREEN_FILTER_ALL ? '' : String(filterProvider).trim().toLowerCase()
    const wantPkg =
      filterPackage === SCREEN_FILTER_ALL ? '' : String(filterPackage).trim().toLowerCase()
    const wantStatus = filterStatus === SCREEN_FILTER_ALL ? '' : String(filterStatus).trim()
    const dq = searchDate.trim().toLowerCase()
    const cq = searchCredentials.trim().toLowerCase()
    const clq = searchClient.trim().toLowerCase()
    const summaryPid =
      summarySelection?.tab === 'screens' &&
      summarySelection?.productId != null &&
      summarySelection.productId !== ''
        ? Number(summarySelection.productId)
        : null
    const wantProductId =
      summaryPid != null && Number.isFinite(summaryPid) ? summaryPid : null

    function screenMatchesStockScope(screen) {
      if (activeTab !== 'screens' && activeTab !== 'history') return true
      const key = packageKeyForScreen(screen)
      const free = freeCountByPackageKey.get(key) ?? 0
      if (activeTab === 'screens') return free > 0
      return free === 0
    }

    function screenMatches(screen) {
      if (!screenMatchesStockScope(screen)) return false
      if (wantProv && String(screen.provider ?? '').trim().toLowerCase() !== wantProv) return false
      if (
        wantProductId != null &&
        Number(screen?.product_id) !== wantProductId
      ) {
        return false
      }
      if (wantPkg && String(screen.package ?? '').trim().toLowerCase() !== wantPkg) return false
      if (wantStatus === 'free' && screen.status !== 'free') return false
      if (wantStatus === 'reserved' && !isScreenReservedLike(screen.status)) return false
      if (wantStatus === 'assigned' && screen.status !== 'assigned') return false
      if (dq && !buildScreenDateSearchBlob(screen).includes(dq)) return false
      if (cq) {
        const u = String(screen.iptv_username ?? '').toLowerCase()
        const pw = String(screen.iptv_password ?? '').toLowerCase()
        if (!u.includes(cq) && !pw.includes(cq)) return false
      }
      if (clq) {
        const name = String(screen.assigned_client_name ?? '').trim().toLowerCase()
        if (!name.includes(clq)) return false
      }
      return true
    }

    return screenBatchGroups
      .map((g) => ({ ...g, rows: g.rows.filter(screenMatches) }))
      .filter((g) => g.rows.length > 0)
  }, [
    screenBatchGroups,
    filterProvider,
    filterPackage,
    filterStatus,
    searchDate,
    searchCredentials,
    searchClient,
    summarySelection,
    activeTab,
    freeCountByPackageKey,
  ])

  /** Índice global # solo para filas «sueltas» (un pantalla por grupo). En lotes expandidos, # es 1…N por lote. */
  const screenRowsLayout = useMemo(() => {
    let n = 0
    return filteredScreenBatchGroups.map((g, groupIdx) => {
      if (g.rows.length === 1) {
        return { kind: 'single', group: g, groupIdx, serial: ++n }
      }
      return { kind: 'batch', group: g, groupIdx }
    })
  }, [filteredScreenBatchGroups])

  const filteredScreensFlat = useMemo(
    () => filteredScreenBatchGroups.flatMap((g) => g.rows),
    [filteredScreenBatchGroups],
  )

  const screenTotalsFiltered = useMemo(
    () => ({
      total: filteredScreensFlat.length,
      free: filteredScreensFlat.filter((s) => s.status === 'free').length,
      assigned: filteredScreensFlat.filter((s) => s.status === 'assigned').length,
      reserved: filteredScreensFlat.filter((s) => isScreenReservedLike(s.status)).length,
    }),
    [filteredScreensFlat],
  )

  const clearScreenFilters = useCallback(() => {
    setSummarySelection(null)
    setFilterProvider(SCREEN_FILTER_ALL)
    setFilterPackage(SCREEN_FILTER_ALL)
    setFilterStatus(SCREEN_FILTER_ALL)
    setSearchDate('')
    setSearchCredentials('')
    setSearchClient('')
  }, [])

  const screenFiltersActive = useMemo(
    () =>
      filterProvider !== SCREEN_FILTER_ALL ||
      filterPackage !== SCREEN_FILTER_ALL ||
      filterStatus !== SCREEN_FILTER_ALL ||
      Boolean(searchDate.trim()) ||
      Boolean(searchCredentials.trim()) ||
      Boolean(searchClient.trim()),
    [
      filterProvider,
      filterPackage,
      filterStatus,
      searchDate,
      searchCredentials,
      searchClient,
    ],
  )

  const [collapsedBatchIds, setCollapsedBatchIds] = useState(() => new Set())

  const toggleBatchCollapse = useCallback((batchId) => {
    setCollapsedBatchIds((prev) => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId)
      else next.add(batchId)
      return next
    })
  }, [])

  const [screensCurrentPage, setScreensCurrentPage] = useState(1)

  const clearSummaryFilters = clearScreenFilters

  const pickNormalCreditsSummary = useCallback((sel) => {
    const p = String(sel?.provider ?? sel ?? '').trim()
    if (!p) return
    const productId = sel?.productId ?? null
    const prev = summarySelRef.current
    const same =
      prev?.tab === 'full' &&
      String(prev?.provider || '').trim().toLowerCase() === p.toLowerCase() &&
      String(prev?.productId ?? '') === String(productId ?? '')
    if (same) {
      setSummarySelection(null)
      setFilterProvider(SCREEN_FILTER_ALL)
      return
    }
    setSummarySelection({ tab: 'full', provider: p, productId })
    setActiveTab('full')
    setFilterProvider(SCREEN_FILTER_ALL)
  }, [])

  const pickScreensSummary = useCallback((sel) => {
    const p = String(sel?.provider ?? sel ?? '').trim()
    if (!p) return
    const productId = sel?.productId ?? null
    const prev = summarySelRef.current
    const same =
      prev?.tab === 'screens' &&
      String(prev?.provider || '').trim().toLowerCase() === p.toLowerCase() &&
      String(prev?.productId ?? '') === String(productId ?? '')
    if (same) {
      setSummarySelection(null)
      setFilterProvider(SCREEN_FILTER_ALL)
      setScreensCurrentPage(1)
      return
    }
    setSummarySelection({ tab: 'screens', provider: p, productId })
    setActiveTab('screens')
    setFilterProvider(p)
    setScreensCurrentPage(1)
  }, [])

  useEffect(() => {
    setScreensCurrentPage(1)
  }, [
    filterProvider,
    filterPackage,
    filterStatus,
    searchDate,
    searchCredentials,
    searchClient,
    summarySelection,
    activeTab,
  ])

  const screensGroupsTotalPages = useMemo(
    () => Math.max(1, Math.ceil(screenRowsLayout.length / ITEMS_PER_PAGE)),
    [screenRowsLayout.length],
  )

  useEffect(() => {
    setScreensCurrentPage((p) => Math.min(Math.max(1, p), screensGroupsTotalPages))
  }, [screensGroupsTotalPages])

  const paginatedScreenRowsLayout = useMemo(() => {
    const start = (screensCurrentPage - 1) * ITEMS_PER_PAGE
    return screenRowsLayout.slice(start, start + ITEMS_PER_PAGE)
  }, [screenRowsLayout, screensCurrentPage])

  const screenPaginationPages = useMemo(
    () => buildScreenPaginationPages(screensCurrentPage, screensGroupsTotalPages),
    [screensCurrentPage, screensGroupsTotalPages],
  )

  const screensScrollTopRef = useRef(null)
  const screensScrollTopSizerRef = useRef(null)
  const screensScrollBottomRef = useRef(null)
  const screensScrollSyncLock = useRef(false)

  const onScreensBottomScroll = useCallback(() => {
    const b = screensScrollBottomRef.current
    const t = screensScrollTopRef.current
    if (!b || !t || screensScrollSyncLock.current) return
    if (t.scrollLeft === b.scrollLeft) return
    screensScrollSyncLock.current = true
    t.scrollLeft = b.scrollLeft
    requestAnimationFrame(() => {
      screensScrollSyncLock.current = false
    })
  }, [])

  const onScreensTopScroll = useCallback(() => {
    const b = screensScrollBottomRef.current
    const t = screensScrollTopRef.current
    if (!b || !t || screensScrollSyncLock.current) return
    if (b.scrollLeft === t.scrollLeft) return
    screensScrollSyncLock.current = true
    b.scrollLeft = t.scrollLeft
    requestAnimationFrame(() => {
      screensScrollSyncLock.current = false
    })
  }, [])

  useLayoutEffect(() => {
    const bottom = screensScrollBottomRef.current
    const sizer = screensScrollTopSizerRef.current
    if (!bottom || !sizer) return
    const syncSizerWidth = () => {
      sizer.style.width = `${bottom.scrollWidth}px`
    }
    syncSizerWidth()
    const ro = new ResizeObserver(syncSizerWidth)
    ro.observe(bottom)
    const table = bottom.querySelector('table')
    if (table) ro.observe(table)
    return () => ro.disconnect()
  }, [
    paginatedScreenRowsLayout,
    collapsedBatchIds,
    loading,
    screens.length,
    filteredScreenBatchGroups.length,
    screensCurrentPage,
  ])

  useEffect(() => {
    const b = screensScrollBottomRef.current
    const t = screensScrollTopRef.current
    if (b) b.scrollLeft = 0
    if (t) t.scrollLeft = 0
  }, [screensCurrentPage])

  const screensPaginationRange = useMemo(() => {
    const len = screenRowsLayout.length
    if (len === 0) return { from: 0, to: 0 }
    const start = (screensCurrentPage - 1) * ITEMS_PER_PAGE
    return {
      from: start + 1,
      to: Math.min(start + ITEMS_PER_PAGE, len),
    }
  }, [screenRowsLayout.length, screensCurrentPage])

  const fullAccounts = useMemo(
    () => accounts.filter(a => a.service_type === 'full' || !a.service_type),
    [accounts]
  )

  const filteredFullAccounts = useMemo(() => {
    if (summarySelection?.tab !== 'full') return fullAccounts
    const w = String(summarySelection.provider || '').trim().toLowerCase()
    const pid = summarySelection?.productId
    const wantPid =
      pid != null && pid !== '' && Number.isFinite(Number(pid)) ? Number(pid) : null
    return fullAccounts.filter((a) => {
      if (String(a.provider_name ?? '').trim().toLowerCase() !== w) return false
      if (wantPid == null) return true
      const ap = a.product_id
      if (ap == null || ap === '') return false
      return Number(ap) === wantPid
    })
  }, [fullAccounts, summarySelection])

  const screensTabCount = useMemo(
    () =>
      screens.filter((s) => {
        const key = packageKeyForScreen(s)
        return (freeCountByPackageKey.get(key) ?? 0) > 0
      }).length,
    [screens, freeCountByPackageKey],
  )

  const historyTabCount = useMemo(
    () =>
      screens.filter((s) => {
        const key = packageKeyForScreen(s)
        return (freeCountByPackageKey.get(key) ?? 0) === 0
      }).length,
    [screens, freeCountByPackageKey],
  )

  const tabCounts = {
    full: fullAccounts.length,
    screens: screensTabCount,
    history: historyTabCount,
  }

  return (
    <>
      {/* ── Modals ── */}
      {modalOpen && (
        <CuentaMasterModal
          onClose={() => setModalOpen(false)}
          onSuccess={handleSuccess}
          defaultTab={activeTab === 'history' ? 'screens' : activeTab}
        />
      )}
      {editTarget?.type === 'full' && (
        <EditFullModal
          record={editTarget.record}
          onSave={() => { setEditTarget(null); refreshInventoryData(); setSummaryKey(k => k + 1); showToast('Recarga actualizada.') }}
          onClose={() => setEditTarget(null)}
        />
      )}
      {editTarget?.type === 'screen' && (
        <EditScreenModal
          record={editTarget.record}
          onSave={() => { setEditTarget(null); refreshInventoryData(); setSummaryKey(k => k + 1); showToast('Pantalla actualizada.') }}
          onClose={() => setEditTarget(null)}
        />
      )}
      {deleteTarget && (
        <DeleteConfirmModal
          label={deleteTarget.label}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
          loading={deleting}
        />
      )}
      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}

      <div className="max-w-6xl mx-auto space-y-6">

        {/* ── Page header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Inventario IPTV</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {loading ? 'Cargando…' : `${fullAccounts.length} recargas · ${screens.length} pantallas en bodega`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => openProductServiceModal()}
              className="inline-flex items-center gap-2 px-4 py-2 h-10 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 border border-emerald-700 text-white text-sm font-semibold rounded-lg shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2"
            >
              <Package size={16} strokeWidth={2} aria-hidden />
              Nuevo producto/servicio
            </button>
            <button
              onClick={() => setModalOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium rounded-lg shadow-sm transition-colors"
            >
              <PlusCircle size={16} />
              Recargar créditos
            </button>
          </div>
        </div>

        {/* ── Provider inventory cards (global, above tabs) ── */}
        <InventorySummaryCards
          refreshKey={summaryKey}
          summarySelection={summarySelection}
          interactive
          onPickNormalCredits={pickNormalCreditsSummary}
          onPickScreens={pickScreensSummary}
        />

        {/* ── Tabs + limpieza de selección desde tarjetas ── */}
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-gray-200">
          <div className="flex items-center gap-1">
            {TABS.map(tab => {
              const Icon   = tab.icon
              const active = activeTab === tab.id
              const count  = tabCounts[tab.id]
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors -mb-px ${
                    active
                      ? 'border-blue-600 text-blue-600 bg-blue-50/50'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <Icon size={15} />
                  {tab.label}
                  <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-semibold ${
                    active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {count}
                  </span>
                </button>
              )
            })}
          </div>
          {summarySelection ? (
            <button
              type="button"
              onClick={clearSummaryFilters}
              className="mb-px px-3 py-1.5 text-xs font-semibold text-blue-700 hover:text-blue-900 hover:bg-blue-50 rounded-lg transition-colors"
            >
              Limpiar filtros
            </button>
          ) : (
            <span className="mb-px h-px w-px shrink-0 overflow-hidden opacity-0" aria-hidden />
          )}
        </div>

        {/* ══════════════════════════════════════════════════════════════
            TAB 1 — CRÉDITO NORMAL
        ══════════════════════════════════════════════════════════════ */}
        {activeTab === 'full' && (
          <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-100">
            <div className="overflow-x-auto min-w-0">
              <table className="w-full min-w-max text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    {['Proveedor', 'Créditos cargados', 'Costo Unitario', 'Total Invertido', 'Cierre de Recarga', 'Acciones'].map((col, idx, arr) => (
                      <th
                        key={col}
                        className={`px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap ${
                          idx === arr.length - 1
                            ? 'sticky right-0 z-20 bg-gray-50 border-l border-gray-200 shadow-[-6px_0_14px_-8px_rgba(0,0,0,0.12)]'
                            : ''
                        }`}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {loading && (
                    <tr><td colSpan={6} className="px-6 py-12 text-center text-gray-400 text-sm">
                      <Loader2 size={20} className="mx-auto animate-spin text-blue-400 mb-2" />Cargando…
                    </td></tr>
                  )}
                  {!loading && fetchError && (
                    <tr><td colSpan={6} className="px-6 py-12 text-center text-red-500 text-sm">{fetchError}</td></tr>
                  )}
                  {!loading && !fetchError && fullAccounts.length === 0 && <EmptyState tab="full" />}
                  {!loading && !fetchError && fullAccounts.length > 0 && filteredFullAccounts.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-6 py-14 text-center text-gray-500 text-sm">
                        Sin recargas para{' '}
                        {summarySelection?.productId != null && summarySelection.productId !== ''
                          ? 'este producto'
                          : 'este proveedor'}
                        . Usa otra tarjeta de resumen o «Limpiar filtros».
                      </td>
                    </tr>
                  )}
                  {!loading && !fetchError && filteredFullAccounts.map(acc => (
                    <tr key={acc.id} className="group hover:bg-gray-50/60 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap"><ProductInventoryBadge row={acc} /></td>
                      <td className="px-6 py-4 whitespace-nowrap"><CreditsBadge value={acc.credits_spent} /></td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {acc.cost_per_credit != null
                          ? <span className="inline-flex items-center gap-1 text-sm text-gray-700">
                              <span className="text-gray-400 text-xs">$</span>
                              {Number(acc.cost_per_credit).toFixed(2)}
                              <span className="text-xs text-gray-400">USD</span>
                            </span>
                          : <span className="text-gray-400 text-xs">—</span>
                        }
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {acc.total_cost != null
                          ? <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                              <span className="text-emerald-500 text-xs">$</span>
                              {Number(acc.total_cost).toFixed(2)}
                              <span className="text-xs text-emerald-500">USD</span>
                            </span>
                          : <span className="text-gray-400 text-xs">—</span>
                        }
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <ExpirationCell dateStr={acc.recharge_date} />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap sticky right-0 z-[5] border-l border-gray-200/90 bg-white shadow-[-8px_0_16px_-10px_rgba(0,0,0,0.12)] group-hover:bg-gray-50/60">
                        <RowActions
                          onEdit={() => setEditTarget({ type: 'full', record: acc })}
                          onDelete={() => setDeleteTarget({
                            type: 'full',
                            id: acc.id,
                            label: `recarga de ${acc.provider_name} (${acc.credits_spent ?? 0} cr)`,
                          })}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!loading && !fetchError && filteredFullAccounts.length > 0 && (
              <div className="px-6 py-3 border-t border-gray-100 bg-gray-50/50 flex items-center justify-between">
                <span className="text-xs text-gray-400">
                  {filteredFullAccounts.length} recarga{filteredFullAccounts.length !== 1 ? 's' : ''}{' '}
                  en esta vista
                  {summarySelection?.tab === 'full' && fullAccounts.length > filteredFullAccounts.length
                    ? ` · ${fullAccounts.length} en total`
                    : ''}
                </span>
                <span className="text-xs font-semibold text-emerald-600">
                  Total invertido (vista actual): $
                  {filteredFullAccounts.reduce((s, a) => s + (a.total_cost ?? 0), 0).toFixed(2)}{' '}
                  USD
                </span>
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════════
            TAB 2 — CRÉDITO POR PANTALLA / TAB 3 — HISTORIAL (PANTALLAS)
        ══════════════════════════════════════════════════════════════ */}
        {(activeTab === 'screens' || activeTab === 'history') && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-end gap-2 mb-4">
              <label className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                  Proveedor
                </span>
                <SearchableSelect
                  value={
                    summarySelection?.tab === 'screens' && summarySelection?.provider
                      ? summarySelection.provider
                      : filterProvider
                  }
                  onChange={(v) => {
                    setSummarySelection(null)
                    setFilterProvider(v)
                  }}
                  options={screenTabProviderFilterOptions}
                  hideClear
                  disabled={
                    loading ||
                    screens.length === 0 ||
                    (summarySelection?.tab === 'screens' && Boolean(summarySelection?.provider))
                  }
                  className="min-w-[7.5rem]"
                />
              </label>
              <label className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                  Paquete
                </span>
                <SearchableSelect
                  value={filterPackage}
                  onChange={setFilterPackage}
                  options={screenTabPackageFilterOptions}
                  hideClear
                  disabled={loading || screens.length === 0}
                  className="min-w-[7.5rem]"
                />
              </label>
              <label className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                  Estado
                </span>
                <SearchableSelect
                  value={filterStatus}
                  onChange={setFilterStatus}
                  options={SCREEN_TAB_STATUS_FILTER_OPTIONS}
                  hideClear
                  disabled={loading || screens.length === 0}
                  className="min-w-[8rem]"
                />
              </label>
              <label className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                  Fecha
                </span>
                <input
                  type="text"
                  value={searchDate}
                  onChange={(e) => setSearchDate(e.target.value)}
                  disabled={loading || screens.length === 0}
                  placeholder="Creación o vencimiento…"
                  autoComplete="off"
                  className="text-sm py-1 px-2 rounded-lg border border-gray-200 bg-white text-gray-800 placeholder:text-gray-400 min-w-[10rem] w-[10rem] max-w-full focus:outline-none focus:ring-2 focus:ring-slate-200 focus:border-slate-400 disabled:opacity-50"
                />
              </label>
              <label className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                  Credenciales
                </span>
                <input
                  type="text"
                  value={searchCredentials}
                  onChange={(e) => setSearchCredentials(e.target.value)}
                  disabled={loading || screens.length === 0}
                  placeholder="Usuario o contraseña…"
                  autoComplete="off"
                  className="text-sm py-1 px-2 rounded-lg border border-gray-200 bg-white text-gray-800 placeholder:text-gray-400 min-w-[9rem] w-[11rem] max-w-full focus:outline-none focus:ring-2 focus:ring-slate-200 focus:border-slate-400 disabled:opacity-50"
                />
              </label>
              <label className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">
                  Cliente
                </span>
                <input
                  type="text"
                  value={searchClient}
                  onChange={(e) => setSearchClient(e.target.value)}
                  disabled={loading || screens.length === 0}
                  placeholder="Cliente asignado…"
                  autoComplete="off"
                  className="text-sm py-1 px-2 rounded-lg border border-gray-200 bg-white text-gray-800 placeholder:text-gray-400 min-w-[9rem] w-[11rem] max-w-full focus:outline-none focus:ring-2 focus:ring-slate-200 focus:border-slate-400 disabled:opacity-50"
                />
              </label>
              <button
                type="button"
                onClick={clearScreenFilters}
                disabled={loading || screens.length === 0 || !screenFiltersActive}
                className="text-sm py-1 px-3 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Limpiar filtros
              </button>
            </div>

            <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-100">
              {!fetchError && (loading || screens.length > 0) && (
                <div
                  ref={screensScrollTopRef}
                  className="overflow-x-auto overflow-y-hidden min-w-0 border-b border-gray-100 [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300"
                  style={{ height: 14 }}
                  onScroll={onScreensTopScroll}
                >
                  <div
                    ref={screensScrollTopSizerRef}
                    className="h-px shrink-0 pointer-events-none"
                    aria-hidden
                  />
                </div>
              )}
              <div
                ref={screensScrollBottomRef}
                className="overflow-x-auto min-w-0 [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-gray-300"
                onScroll={onScreensBottomScroll}
              >
                <table
                  className="border-collapse text-sm table-fixed min-w-max"
                  style={{ width: screenTableTotalWidth }}
                >
                  <colgroup>
                    {SCREEN_COLUMN_CONFIG.map((c) => (
                      <col key={c.id} style={{ width: screenColWidths[c.id] ?? c.defaultWidth }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr className="border-b border-gray-100">
                      {SCREEN_COLUMN_CONFIG.map((col) => (
                        <ResizableScreenTh
                          key={col.id}
                          column={col}
                          width={screenColWidths[col.id] ?? col.defaultWidth}
                          onColumnResize={handleScreenColumnResize}
                        >
                          {col.label}
                        </ResizableScreenTh>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {loading && (
                      <tr><td colSpan={10} className="px-6 py-12 text-center text-gray-400 text-sm">
                        <Loader2 size={20} className="mx-auto animate-spin text-slate-400 mb-2" />Cargando…
                      </td></tr>
                    )}
                    {!loading && fetchError && (
                      <tr><td colSpan={10} className="px-6 py-12 text-center text-red-500 text-sm">{fetchError}</td></tr>
                    )}
                    {!loading && !fetchError && screens.length === 0 && (
                      <EmptyState tab={activeTab === 'history' ? 'history' : 'screens'} />
                    )}
                    {!loading && !fetchError && screens.length > 0 && filteredScreenBatchGroups.length === 0 && (
                      <tr>
                        <td colSpan={10} className="px-6 py-12 text-center text-gray-500 text-sm">
                          {activeTab === 'history'
                            ? 'No hay paquetes agotados que coincidan con los filtros actuales.'
                            : 'Ningún lote con stock disponible coincide con los filtros actuales.'}{' '}
                          <button
                            type="button"
                            onClick={clearScreenFilters}
                            className="text-slate-600 font-medium underline hover:text-slate-800"
                          >
                            Limpiar filtros
                          </button>
                        </td>
                      </tr>
                    )}
                    {!loading &&
                      !fetchError &&
                      filteredScreenBatchGroups.length > 0 &&
                      paginatedScreenRowsLayout.map((entry) => {
                      const stripe = entry.groupIdx % 2 === 0 ? 'bg-slate-50/40' : 'bg-white'
                      const costTd = (scr) => (
                        <td className="px-4 py-3 whitespace-nowrap">
                          {scr.cost_per_package != null
                            ? <span className="text-sm text-gray-700">${Number(scr.cost_per_package).toFixed(2)} <span className="text-xs text-gray-400">USD</span></span>
                            : <span className="text-gray-400 text-xs">—</span>}
                        </td>
                      )
                      const loteTd = (scr, compact) => {
                        const code = `${(scr.batch_id ?? '').slice(0, 8)}${scr.batch_id ? '…' : ''}`
                        const accent = inventoryAccentHex(scr)
                        return (
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span
                              className={`inline-flex font-mono bg-gray-100 px-2 py-0.5 rounded ${compact ? 'text-[9px]' : 'text-[10px]'}`}
                              title={scr.batch_id}
                            >
                              <span style={{ color: accent }}>{code}</span>
                            </span>
                          </td>
                        )
                      }

                      if (entry.kind === 'single') {
                        const scr = entry.group.rows[0]
                        return (
                          <tr
                            key={scr.id}
                            className={`${stripe} hover:bg-slate-100/70 transition-colors group border-l-4 border-slate-300`}
                          >
                            <td className="px-4 py-3 text-xs text-gray-500 font-mono w-10 whitespace-nowrap">{entry.serial}</td>
                            <ScreenProductPackageCell row={scr} screensInCell={1} />
                            <td className="px-4 py-3 whitespace-nowrap"><ScreenStatusBadge status={scr.status} /></td>
                            <CreatedAtTd createdAt={scr.created_at} />
                            <td className="px-4 py-3 align-top whitespace-nowrap">
                              <ScreenExpirationStatsBlock createdAt={scr.created_at} packageName={scr.package} />
                            </td>
                            {costTd(scr)}
                            {loteTd(scr)}
                            <CredentialsTd row={scr} />
                            <AssignedClientTd row={scr} />
                            <td className={stickyActionsTdClass(stripe)}>
                              <RowActions
                                onEdit={() => setEditTarget({ type: 'screen', record: scr })}
                                hideDelete={scr.status !== 'free'}
                                onDelete={() => setDeleteTarget({
                                  type: 'screen',
                                  id: scr.id,
                                  label: `pantalla ${inventoryDisplayName(scr)} · ${scr.package}`,
                                })}
                              />
                            </td>
                          </tr>
                        )
                      }

                      const { batchId, rows } = entry.group
                      const first = rows[0]
                      const accent = inventoryAccentHex(first)
                      const expanded = !collapsedBatchIds.has(batchId)
                      const freeC = rows.filter((r) => r.status === 'free').length
                      const assignedC = rows.filter((r) => r.status === 'assigned').length
                      const reservedC = rows.filter((r) => isScreenReservedLike(r.status)).length
                      const parts = [`${freeC} disp.`]
                      if (reservedC) parts.push(`${reservedC} reserv.`)
                      parts.push(`${assignedC} asig.`)
                      const statusSummary = parts.join(' · ')
                      const batchShort = `${(batchId ?? '').slice(0, 8)}${batchId ? '…' : ''}`

                      return (
                        <Fragment key={batchId}>
                          <tr
                            className="bg-gray-100 cursor-pointer select-none hover:bg-slate-100/90 transition-colors group border-l-4 border-slate-400"
                            onClick={() => toggleBatchCollapse(batchId)}
                            title={expanded ? 'Ocultar pantallas del lote' : 'Mostrar pantallas del lote'}
                          >
                            <td className="px-4 py-3 w-10 whitespace-nowrap text-slate-500">
                              {expanded ? <ChevronDown size={18} strokeWidth={2.25} /> : <ChevronRight size={18} strokeWidth={2.25} />}
                            </td>
                            <ScreenProductPackageCell row={first} screensInCell={rows.length} />
                            <td className="px-4 py-3 whitespace-nowrap">
                              <span className="text-xs text-gray-600">{statusSummary}</span>
                            </td>
                            <CreatedAtTd createdAt={earliestCreatedAtRaw(rows)} />
                            <td className="px-4 py-3 align-top whitespace-nowrap">
                              <ScreenExpirationStatsBlock
                                createdAt={earliestCreatedAtRaw(rows)}
                                packageName={first.package}
                              />
                            </td>
                            {costTd(first)}
                            <td className="px-4 py-3 whitespace-nowrap">
                              <span className="inline-flex text-[10px] font-mono bg-gray-100 px-2 py-0.5 rounded" title={batchId}>
                                <span style={{ color: accent }}>{batchShort}</span>
                              </span>
                            </td>
                            <BatchCredentialsTd rows={rows} />
                            <td className="px-4 py-3 whitespace-nowrap text-gray-400 text-sm">—</td>
                            <td className={`${stickyActionsTdClass(stripe, { muted: true, parentBatch: true })} text-gray-300 text-xs`}>—</td>
                          </tr>
                          {expanded && rows.map((scr, i) => (
                            <tr
                              key={scr.id}
                              className={`${stripe} hover:bg-slate-100/70 transition-colors group border-l-4 border-slate-200`}
                            >
                              <td className="px-4 py-3 pl-16 text-xs text-gray-500 font-mono w-10 whitespace-nowrap tabular-nums">
                                {i + 1}
                              </td>
                              <ScreenProductPackageCell row={scr} screensInCell={1} />
                              <td className="px-4 py-3 whitespace-nowrap"><ScreenStatusBadge status={scr.status} /></td>
                              <CreatedAtTd createdAt={scr.created_at} />
                              <td className="px-4 py-3 align-top whitespace-nowrap">
                                <ScreenExpirationStatsBlock createdAt={scr.created_at} packageName={scr.package} />
                              </td>
                              {costTd(scr)}
                              {loteTd(scr, true)}
                              <CredentialsTd row={scr} />
                              <AssignedClientTd row={scr} />
                              <td className={`${stickyActionsTdClass(stripe)}`} onClick={(e) => e.stopPropagation()}>
                                <RowActions
                                  onEdit={() => setEditTarget({ type: 'screen', record: scr })}
                                  hideDelete={scr.status !== 'free'}
                                  onDelete={() => setDeleteTarget({
                                    type: 'screen',
                                    id: scr.id,
                                    label: `pantalla ${inventoryDisplayName(scr)} · ${scr.package}`,
                                  })}
                                />
                              </td>
                            </tr>
                          ))}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {!loading && !fetchError && screens.length > 0 && (
                <div className="px-6 py-3 border-t border-gray-100 bg-gray-50/50 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-xs text-gray-400">
                    {screenTotalsFiltered.total} pantalla{screenTotalsFiltered.total !== 1 ? 's' : ''}{' '}
                    {activeTab === 'history' ? 'en historial' : 'en bodega'}
                    {screenFiltersActive && (
                      <span className="text-gray-400">
                        {' '}
                        · filtrado de {screens.length} en total
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-green-600 font-semibold">
                    {screenTotalsFiltered.free} disponible{screenTotalsFiltered.free !== 1 ? 's' : ''}
                    {screenTotalsFiltered.reserved > 0 && (
                      <> · {screenTotalsFiltered.reserved} reservada{screenTotalsFiltered.reserved !== 1 ? 's' : ''}</>
                    )}
                    {' · '}
                    {screenTotalsFiltered.assigned} asignada{screenTotalsFiltered.assigned !== 1 ? 's' : ''}
                  </span>
                </div>
              )}
              {!loading && !fetchError && screenRowsLayout.length > 0 && (
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 px-4 py-3 border-t border-gray-100 bg-white">
                  <p className="text-xs text-gray-500 text-center sm:text-left">
                    Grupos/lotes{' '}
                    <span className="font-semibold text-gray-800">{screensPaginationRange.from}</span>
                    –
                    <span className="font-semibold text-gray-800">{screensPaginationRange.to}</span>
                    {' '}de{' '}
                    <span className="font-semibold text-gray-800">{screenRowsLayout.length}</span>
                    <span className="text-gray-400">
                      {' '}
                      · Página {screensCurrentPage} / {screensGroupsTotalPages}
                    </span>
                  </p>
                  <nav
                    className="flex flex-wrap items-center justify-center gap-1"
                    aria-label="Paginación inventario pantallas"
                  >
                    <button
                      type="button"
                      disabled={screensCurrentPage <= 1}
                      onClick={() => setScreensCurrentPage((p) => Math.max(1, p - 1))}
                      className="inline-flex items-center gap-0.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white transition-colors"
                    >
                      <ChevronLeft size={14} strokeWidth={2.25} />
                      Anterior
                    </button>
                    {screenPaginationPages.map((item, idx) =>
                      item === 'ellipsis' ? (
                        <span key={`ellipsis-${idx}`} className="px-1.5 text-gray-400 text-xs select-none">
                          …
                        </span>
                      ) : (
                        <button
                          key={item}
                          type="button"
                          onClick={() => setScreensCurrentPage(item)}
                          className={`min-w-[2rem] px-2 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                            item === screensCurrentPage
                              ? 'border-slate-500 bg-gray-100 text-slate-800 ring-1 ring-gray-300'
                              : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          {item}
                        </button>
                      ),
                    )}
                    <button
                      type="button"
                      disabled={screensCurrentPage >= screensGroupsTotalPages}
                      onClick={() =>
                        setScreensCurrentPage((p) => Math.min(screensGroupsTotalPages, p + 1))
                      }
                      className="inline-flex items-center gap-0.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white transition-colors"
                    >
                      Siguiente
                      <ChevronRight size={14} strokeWidth={2.25} />
                    </button>
                  </nav>
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </>
  )
}
