import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  UserPlus, Search, Pencil, Trash2, Mail, Phone, MessageSquare,
  X, Download, Upload, Users, RefreshCw, ClipboardList, Loader2, CheckCircle2, Globe,
  Activity, Tag, Tags, ChevronDown, Check, Plus, Sparkles, CreditCard, Clock, CalendarDays, Coins,
} from 'lucide-react'
import api from '../api/axios'
import { fetchClientsList, fetchClientFollowUp } from '../api/clients'
import ClientTimeline from '../features/clients/components/ClientTimeline'
import ClientPaymentMethodsModal from '../features/clients/ClientPaymentMethodsModal'
import { useModal } from '../context/ModalContext'
import SearchableSelect from '../components/ui/SearchableSelect'
import { formatRelativeTimeEcuador, formatShortDateEcuador } from '../utils/datetime'

// ─── Constants ───────────────────────────────────────────────────────────────

const EMPTY_FORM = {
  username: '',
  name: '',
  email: '',
  phone: '',
  country: '',
  note: '',
}

const IPTV_COUNTRIES = [
  'Argentina', 'Bolivia', 'Brasil', 'Canadá', 'Chile', 'Colombia', 'Costa Rica', 'Cuba',
  'Ecuador', 'El Salvador', 'España', 'Estados Unidos', 'Francia', 'Alemania', 'Guatemala',
  'Honduras', 'Italia', 'México', 'Nicaragua', 'Panamá', 'Paraguay', 'Perú', 'Portugal',
  'Puerto Rico', 'Reino Unido', 'República Dominicana', 'Uruguay', 'Venezuela',
]

/** Países para combobox de cliente (valor = etiqueta). */
const IPTV_COUNTRY_OPTIONS = IPTV_COUNTRIES.map((name) => ({ value: name, label: name }))
const CLIENT_TABLE_COUNTRY_LIST_ID = 'iptv-countries-table'

const ITEMS_PER_PAGE = 10

// ─── Tab definitions ─────────────────────────────────────────────────────────

const TABS = [
  { id: 'register', label: 'Registro de Clientes',    icon: ClipboardList },
  { id: 'active',   label: 'Seguimiento de Clientes',  icon: Activity      },
]

function clientDisplayLabel(c) {
  const n = (c.name ?? '').trim()
  const u = (c.username ?? '').trim()
  if (n) return n
  if (u) return u
  return c.email || 'Cliente'
}

function clientAvatarLetter(c) {
  const u = (c.username ?? '').trim()
  const n = (c.name ?? '').trim()
  const ch = (u[0] || n[0] || (c.email ?? '')[0] || '?').toUpperCase()
  return ch
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return null
  const rel = formatRelativeTimeEcuador(dateStr)
  return rel === '—' ? null : rel
}

function cleanPhone(phone) {
  return phone ? phone.replace(/\D/g, '') : ''
}

function formatShortDate(dateStr) {
  if (!dateStr) return null
  const s = formatShortDateEcuador(dateStr)
  return s === '—' ? null : s
}

/** Fecha calendario YYYY-MM-DD en horario Ecuador (filtros de seguimiento). */
function ecuadorYmd(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' })
  } catch {
    return ''
  }
}

const FOLLOW_UP_CREDITS_PRESETS = [
  { value: 'all', label: 'Todos los créditos' },
  { value: 'lt10', label: 'Menos de 10' },
  { value: '10-50', label: '10 – 50' },
  { value: 'gt50', label: 'Más de 50' },
]

const FOLLOW_UP_DAYS_PRESETS = [
  { value: 'all', label: 'Cualquier antigüedad' },
  { value: '7', label: 'Hace 7+ días' },
  { value: '15', label: 'Hace 15+ días' },
  { value: '30plus', label: 'Más de 30 días' },
]

function DaysSinceCell({ days }) {
  const n = Number(days)
  if (!Number.isFinite(n)) return <span className="text-gray-400 text-xs">—</span>
  let cls = 'text-gray-700 bg-gray-50 ring-gray-200'
  if (n > 30) cls = 'text-red-700 bg-red-50 ring-red-200 font-bold'
  else if (n <= 7) cls = 'text-green-700 bg-green-50 ring-green-200 font-semibold'
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2.5 py-0.5 text-xs tabular-nums ring-1 ${cls}`}>
      {n} día{n !== 1 ? 's' : ''}
    </span>
  )
}

function clientParentBadge(c) {
  const pid = c?.parent_id
  if (pid == null) {
    return (
      <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold bg-slate-100 text-slate-700 ring-1 ring-slate-200/90">
        Cliente directo
      </span>
    )
  }
  const parentLabel = (c.parent_username || c.parent_name || '').trim() || `Cliente #${pid}`
  return (
    <span
      className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold bg-violet-50 text-violet-900 ring-1 ring-violet-200/90"
      title={`Sub-cliente de ${parentLabel}`}
    >
      Sub-cliente de: {parentLabel}
    </span>
  )
}

function clientMatchesSearch(c, q) {
  if (!q) return true
  const un = (c.username ?? '').toLowerCase()
  const nm = (c.name ?? '').toLowerCase()
  const em = (c.email ?? '').toLowerCase()
  const ph = (c.phone ?? '').toLowerCase()
  const ct = (c.country ?? '').toLowerCase()
  const pu = (c.parent_username ?? '').toLowerCase()
  const pn = (c.parent_name ?? '').toLowerCase()
  return (
    un.includes(q)
    || nm.includes(q)
    || em.includes(q)
    || ph.includes(q)
    || ct.includes(q)
    || pu.includes(q)
    || pn.includes(q)
  )
}

// ─── UI atoms ────────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  Activo:   { label: 'Activo',   bg: 'bg-green-50',  text: 'text-green-700',  ring: 'ring-green-200',  dot: 'bg-green-500'  },
  Inactivo: { label: 'Inactivo', bg: 'bg-gray-100', text: 'text-gray-600',  ring: 'ring-gray-300',   dot: 'bg-gray-400'   },
}

/** Estado operativo para PATCH (backend solo acepta Activo | Inactivo). */
function normalizeLifecycleStatus(status) {
  return status === 'Inactivo' ? 'Inactivo' : 'Activo'
}

/** Select con aspecto de badge; actualiza estado vía API sin disparar navegación de fila. */
function StatusInlineSelect({ clientId, status, onCommit }) {
  const normalized = normalizeLifecycleStatus(status)
  const [optimistic, setOptimistic] = useState(normalized)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    setOptimistic(normalized)
  }, [normalized])

  async function handleChange(e) {
    e.stopPropagation()
    const next = e.target.value
    if (next === optimistic || pending) return
    setOptimistic(next)
    setPending(true)
    try {
      await onCommit(clientId, next)
    } catch {
      setOptimistic(normalized)
    } finally {
      setPending(false)
    }
  }

  const cfg = STATUS_CONFIG[optimistic]

  return (
    <span
      className="relative inline-flex items-center align-middle"
      data-no-row-nav
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <span className={`pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 z-[1] w-1.5 h-1.5 rounded-full ${cfg.dot}`} aria-hidden />
      <select
        aria-label="Estado del cliente"
        value={optimistic}
        onChange={handleChange}
        onClick={(e) => e.stopPropagation()}
        disabled={pending}
        className={`appearance-none cursor-pointer pl-4 pr-7 py-0.5 rounded-full text-xs font-medium ring-1 border-0 focus:outline-none focus:ring-2 focus:ring-blue-400/40 focus:ring-offset-0 transition-colors disabled:opacity-60 ${cfg.bg} ${cfg.text} ${cfg.ring} hover:brightness-[0.98]`}
      >
        <option value="Activo">Activo</option>
        <option value="Inactivo">Inactivo</option>
      </select>
      <ChevronDown
        size={14}
        className={`pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 opacity-45 shrink-0 ${cfg.text}`}
        aria-hidden
      />
    </span>
  )
}

const WA_SVG = (
  <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current" xmlns="http://www.w3.org/2000/svg">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
  </svg>
)

function WhatsAppButton({ phone, name }) {
  if (!phone) return <span className="text-gray-400 text-xs">—</span>
  const url = `https://wa.me/${cleanPhone(phone)}?text=Hola%20${encodeURIComponent(name)},%20te%20contacto%20desde...`
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1 text-gray-600 text-sm">
        <Phone size={13} className="text-gray-400" />
        {phone}
      </span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium text-green-700 bg-green-50 ring-1 ring-green-200 hover:bg-green-100 transition-colors"
        title={`WhatsApp a ${name}`}
        onClick={(e) => e.stopPropagation()}
      >
        {WA_SVG} WhatsApp
      </a>
    </div>
  )
}

function PhoneCell({ phone }) {
  if (!phone) return <span className="text-gray-400 text-xs">—</span>
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-gray-600">
      <Phone size={13} className="text-gray-400" />
      {phone}
    </span>
  )
}

function SuscripcionBadge({ value }) {
  if (!value) return <span className="text-gray-400 text-xs">—</span>
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-medium bg-blue-50 text-blue-700 ring-1 ring-blue-100">
      <Tv2 size={10} />{value}
    </span>
  )
}

function CreditsBadge({ value }) {
  if (value === null || value === undefined) return <span className="text-gray-400 text-xs">—</span>
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-semibold ${value > 0 ? 'text-emerald-600' : 'text-gray-400'}`}>
      <Coins size={13} />{Number(value).toFixed(2)}
    </span>
  )
}

function LastRechargeBadge({ dateStr }) {
  const rel = formatRelativeTime(dateStr)
  if (!rel) return <span className="text-gray-400 text-xs">—</span>
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-500">
      <Clock size={11} className="text-gray-400" />{rel}
    </span>
  )
}

function LeadSourceBadge({ value }) {
  if (!value) return <span className="text-gray-400 text-xs">—</span>
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-medium bg-purple-50 text-purple-700 ring-1 ring-purple-100">
      <Globe size={10} />{value}
    </span>
  )
}

const TAG_COLORS = [
  'bg-sky-50 text-sky-700 ring-sky-200',
  'bg-violet-50 text-violet-700 ring-violet-200',
  'bg-rose-50 text-rose-700 ring-rose-200',
  'bg-teal-50 text-teal-700 ring-teal-200',
  'bg-orange-50 text-orange-700 ring-orange-200',
]

// Named color palette for the global Tag Manager
const COLOR_MAP = {
  sky:    'bg-sky-50 text-sky-700 ring-sky-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  rose:   'bg-rose-50 text-rose-700 ring-rose-200',
  teal:   'bg-teal-50 text-teal-700 ring-teal-200',
  orange: 'bg-orange-50 text-orange-700 ring-orange-200',
  blue:   'bg-blue-50 text-blue-700 ring-blue-200',
  green:  'bg-green-50 text-green-700 ring-green-200',
  amber:  'bg-amber-50 text-amber-700 ring-amber-200',
  indigo: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  pink:   'bg-pink-50 text-pink-700 ring-pink-200',
}
const DOT_COLORS = {
  sky: 'bg-sky-400', violet: 'bg-violet-400', rose: 'bg-rose-400',
  teal: 'bg-teal-400', orange: 'bg-orange-400', blue: 'bg-blue-400',
  green: 'bg-green-400', amber: 'bg-amber-400', indigo: 'bg-indigo-400',
  pink: 'bg-pink-400',
}
const COLOR_OPTIONS = Object.keys(COLOR_MAP)

// Resolve chip classes from a global tag object (with .color) or fall back to positional
function tagChipCls(tagObj, index = 0) {
  if (tagObj?.color && COLOR_MAP[tagObj.color]) return COLOR_MAP[tagObj.color]
  return TAG_COLORS[index % TAG_COLORS.length]
}

function TagsBadge({ tags }) {
  if (!tags || tags.length === 0) return <span className="text-gray-400 text-xs">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag, i) => (
        <span
          key={tag}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ring-1 ${TAG_COLORS[i % TAG_COLORS.length]}`}
        >
          <Tag size={9} />{tag}
        </span>
      ))}
    </div>
  )
}

function NotesCell({ value }) {
  if (!value) return <span className="text-gray-400 text-xs">—</span>
  return (
    <span
      className="text-xs text-gray-600 max-w-[180px] truncate block"
      title={value}
    >
      {value}
    </span>
  )
}

// ─── InlineEdit ──────────────────────────────────────────────────────────────

function InlineEdit({ value, onSave, type = 'text', emptyLabel = '—', required = false, compact = false, listId = null }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(value ?? '')
  const [saving, setSaving]   = useState(false)
  const ref = useRef(null)

  // Keep draft in sync when the parent value changes (e.g. after an optimistic update)
  useEffect(() => {
    if (!editing) setDraft(value ?? '')
  }, [value, editing])

  useEffect(() => {
    if (editing) ref.current?.focus()
  }, [editing])

  function start(e) {
    e.stopPropagation()
    setDraft(value ?? '')
    setEditing(true)
  }

  async function commit() {
    if (!editing) return
    const trimmed = draft.trim()
    if (required && !trimmed) { cancel(); return }
    setEditing(false)
    if (trimmed === (value ?? '').trim()) return
    setSaving(true)
    try { await onSave(trimmed || null) }
    finally { setSaving(false) }
  }

  function cancel() {
    setEditing(false)
    setDraft(value ?? '')
  }

  const inputCls = 'px-1.5 py-0.5 bg-white border border-blue-400 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-300 w-full min-w-[80px]'

  if (saving) {
    return <span className={`${compact ? 'text-xs' : 'text-sm'} text-gray-400 italic`}>Guardando…</span>
  }

  if (editing) {
    const sharedProps = {
      ref,
      value: draft,
      onChange: (e) => setDraft(e.target.value),
      onBlur: commit,
      className: `${inputCls} ${compact ? 'text-xs' : 'text-sm'}`,
    }
    if (type === 'textarea') {
      return (
        <textarea
          {...sharedProps}
          rows={2}
          onKeyDown={(e) => e.key === 'Escape' && cancel()}
          className={`${inputCls} ${compact ? 'text-xs' : 'text-sm'} resize-none`}
        />
      )
    }
    return (
      <input
        {...sharedProps}
        type={type}
        list={listId || undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          if (e.key === 'Escape') cancel()
        }}
      />
    )
  }

  return (
    <div
      data-no-row-nav
      className="group/ie inline-flex items-center gap-1 cursor-pointer"
      onClick={start}
      title="Clic para editar"
    >
      {value
        ? <span className={`${compact ? 'text-xs text-gray-400' : 'text-sm text-gray-700'} leading-snug`}>{value}</span>
        : <span className={`${compact ? 'text-xs' : 'text-sm'} text-gray-300 italic`}>{emptyLabel}</span>
      }
      <Pencil
        size={compact ? 9 : 10}
        className="shrink-0 text-gray-300 opacity-0 group-hover/ie:opacity-100 transition-opacity"
      />
    </div>
  )
}

// ─── TagEditor ───────────────────────────────────────────────────────────────
// Renders assigned tag chips + a dropdown to pick from global tags catalog.

function TagEditor({ tags: initialTags, onSave, globalTags = [] }) {
  const [tags, setTags]             = useState(initialTags ?? [])
  const [pendingRemove, setPending] = useState(null)
  const [dropdownOpen, setDropdown] = useState(false)
  const [saving, setSaving]         = useState(false)
  const dropdownRef                 = useRef(null)

  // Sync when parent updates tags after a successful PATCH
  const prevRef = useRef(JSON.stringify(initialTags ?? []))
  useEffect(() => {
    const next = JSON.stringify(initialTags ?? [])
    if (next !== prevRef.current) { prevRef.current = next; setTags(initialTags ?? []) }
  }, [initialTags])

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return
    function handler(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setDropdown(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  async function persist(newTags) {
    setSaving(true)
    try { await onSave(newTags) }
    finally { setSaving(false) }
  }

  function assign(tagName) {
    if (tags.includes(tagName)) return
    const newTags = [...tags, tagName]
    setTags(newTags)
    setDropdown(false)
    persist(newTags)
  }

  function confirmRemove() {
    if (!pendingRemove) return
    const newTags = tags.filter((t) => t !== pendingRemove)
    setTags(newTags)
    setPending(null)
    persist(newTags)
  }

  const available = globalTags.filter((gt) => !tags.includes(gt.name))

  return (
    <>
      {/* ── Remove confirmation modal ── */}
      {pendingRemove && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm"
          onClick={(e) => e.target === e.currentTarget && setPending(null)}
        >
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xs p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-amber-50 ring-1 ring-amber-100 flex items-center justify-center shrink-0">
                <Tag size={16} className="text-amber-500" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-sm leading-tight">Quitar etiqueta</h3>
                <p className="text-gray-500 text-xs mt-1.5 leading-relaxed">
                  ¿Estás seguro de que deseas quitar la etiqueta{' '}
                  <span className="font-semibold text-gray-700">"{pendingRemove}"</span>{' '}
                  de este cliente?
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setPending(null)} className="px-3.5 py-2 text-xs font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-xl ring-1 ring-gray-200 transition-colors">Cancelar</button>
              <button onClick={confirmRemove} className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl ring-1 ring-slate-300 transition-colors">Sí, quitar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Chips + add button ── */}
      <div className="flex flex-wrap items-center gap-1.5 min-h-[24px]">
        {tags.map((tagName, i) => {
          const gt = globalTags.find((g) => g.name === tagName)
          const cls = tagChipCls(gt, i)
          return (
            <span key={tagName} className={`inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs font-medium ring-1 ${cls}`}>
              <Tag size={9} />{tagName}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setPending(tagName) }}
                className="ml-0.5 rounded-full p-0.5 opacity-50 hover:opacity-100 hover:bg-black/10 transition-opacity"
                title={`Quitar "${tagName}"`}
              >
                <X size={9} />
              </button>
            </span>
          )
        })}

        {/* Add button + dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setDropdown((o) => !o) }}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs text-gray-400 hover:text-gray-600 hover:bg-gray-100 ring-1 ring-gray-200 transition-colors"
            title="Asignar etiqueta"
          >
            <Plus size={9} />
            {saving ? <Loader2 size={9} className="animate-spin" /> : null}
          </button>

          {dropdownOpen && (
            <div className="absolute left-0 top-full mt-1.5 z-50 w-44 bg-white rounded-xl shadow-lg ring-1 ring-gray-200 py-1.5 overflow-hidden">
              {available.length === 0 ? (
                <p className="px-3 py-2 text-xs text-gray-400 text-center">
                  {globalTags.length === 0 ? 'Sin etiquetas creadas' : 'Todas asignadas'}
                </p>
              ) : (
                available.map((gt, i) => (
                  <button
                    key={gt.id}
                    type="button"
                    onClick={() => assign(gt.name)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-gray-50 transition-colors text-left"
                  >
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium ring-1 ${tagChipCls(gt, i)}`}>
                      <Tag size={9} />{gt.name}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ─── TagManagerModal ─────────────────────────────────────────────────────────

function TagManagerModal({ onClose, globalTags, onRefresh, activeTagFilters, onToggleFilter }) {
  const [name, setName]               = useState('')
  const [color, setColor]             = useState('sky')
  const [creating, setCreating]       = useState(false)
  const [editingId, setEditingId]     = useState(null)
  const [editName, setEditName]       = useState('')
  const [savingId, setSavingId]       = useState(null)
  const [pendingDelete, setPendingDel] = useState(null)
  const [deleting, setDeleting]       = useState(false)
  const [error, setError]             = useState(null)
  const nameRef = useRef(null)

  useEffect(() => { nameRef.current?.focus() }, [])

  async function handleCreate(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setCreating(true); setError(null)
    try {
      await api.post('/api/v1/tags', { name: trimmed, color })
      setName(''); await onRefresh()
    } catch (err) {
      setError(err.response?.data?.detail ?? 'Error al crear la etiqueta.')
    } finally { setCreating(false) }
  }

  async function handleRename(tag) {
    const trimmed = editName.trim()
    if (!trimmed || trimmed === tag.name) { setEditingId(null); return }
    setSavingId(tag.id); setError(null)
    try {
      await api.patch(`/api/v1/tags/${tag.id}`, { name: trimmed })
      setEditingId(null); await onRefresh()
    } catch (err) {
      setError(err.response?.data?.detail ?? 'Error al renombrar.')
    } finally { setSavingId(null) }
  }

  async function handleDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await api.delete(`/api/v1/tags/${pendingDelete.id}`)
      setPendingDel(null); await onRefresh()
    } catch { setError('Error al eliminar la etiqueta.') }
    finally { setDeleting(false) }
  }

  const atLimit = globalTags.length >= 10

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col max-h-[85vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-50 ring-1 ring-blue-100 flex items-center justify-center">
              <Tags size={15} className="text-blue-600" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900 text-sm leading-tight">Gestor de Etiquetas</h2>
              <p className="text-xs text-gray-400 mt-0.5">{globalTags.length} / 10 etiquetas</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Error banner */}
          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-red-50 ring-1 ring-red-100 text-xs text-red-700">
              <X size={12} className="shrink-0" />{error}
              <button className="ml-auto opacity-60 hover:opacity-100" onClick={() => setError(null)}><X size={11} /></button>
            </div>
          )}

          {/* Create form */}
          <form onSubmit={handleCreate} className="space-y-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Nueva etiqueta</p>

            {/* Color picker */}
            <div className="flex items-center gap-1.5 flex-wrap">
              {COLOR_OPTIONS.map((c) => (
                <button
                  key={c} type="button"
                  onClick={() => setColor(c)}
                  className={`w-5 h-5 rounded-full transition-all ${DOT_COLORS[c]} ${color === c ? 'ring-2 ring-offset-1 ring-gray-500 scale-110' : 'opacity-60 hover:opacity-100'}`}
                  title={c}
                />
              ))}
            </div>

            <div className="flex gap-2">
              <input
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nombre (ej. VIP, Recurrente…)"
                disabled={atLimit}
                className="flex-1 px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:opacity-50"
                maxLength={60}
              />
              <button
                type="submit"
                disabled={atLimit || creating || !name.trim()}
                className="px-4 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-xl disabled:opacity-40 transition-colors flex items-center gap-1.5"
              >
                {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                Crear
              </button>
            </div>
            {atLimit && <p className="text-xs text-amber-600">Límite de 10 etiquetas alcanzado. Elimina una para crear otra.</p>}
          </form>

          {/* Tag list */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Etiquetas existentes</p>
              {activeTagFilters.length > 0 && (
                <button
                  onClick={() => activeTagFilters.forEach(n => onToggleFilter(n))}
                  className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                >
                  Limpiar filtros ({activeTagFilters.length})
                </button>
              )}
            </div>

            {globalTags.length === 0 && (
              <p className="text-xs text-gray-400 py-3 text-center">Aún no hay etiquetas. Crea la primera arriba.</p>
            )}

            {globalTags.map((tag, i) => {
              const isFiltered = activeTagFilters.includes(tag.name)
              return (
                <div
                  key={tag.id}
                  className={`flex items-center gap-2 px-3 py-2 rounded-xl transition-colors ${isFiltered ? 'bg-blue-50 ring-1 ring-blue-100' : 'hover:bg-gray-50'}`}
                >
                  {/* Checkbox to toggle filter */}
                  <button
                    type="button"
                    onClick={() => onToggleFilter(tag.name)}
                    className={`w-4 h-4 rounded flex items-center justify-center shrink-0 ring-1 transition-colors ${
                      isFiltered
                        ? 'bg-blue-600 ring-blue-600 text-white'
                        : 'bg-white ring-gray-300 hover:ring-blue-400'
                    }`}
                    title={isFiltered ? 'Quitar filtro' : 'Filtrar por esta etiqueta'}
                  >
                    {isFiltered && <Check size={10} strokeWidth={3} />}
                  </button>

                  {editingId === tag.id ? (
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={() => handleRename(tag)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(tag)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      className="flex-1 text-xs px-2 py-1 border border-blue-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300"
                    />
                  ) : (
                    <span
                      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ring-1 flex-1 cursor-pointer ${tagChipCls(tag, i)}`}
                      onClick={() => onToggleFilter(tag.name)}
                      title={isFiltered ? 'Quitar filtro' : 'Filtrar por esta etiqueta'}
                    >
                      <Tag size={9} />{tag.name}
                      {isFiltered && <span className="ml-1 text-[9px] font-semibold opacity-70">✓ filtro</span>}
                    </span>
                  )}

                  <button
                    onClick={() => { setEditingId(tag.id); setEditName(tag.name) }}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors shrink-0"
                    title="Renombrar"
                    disabled={savingId === tag.id}
                  >
                    {savingId === tag.id ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />}
                  </button>
                  <button
                    onClick={() => setPendingDel(tag)}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-slate-700 hover:bg-slate-100 transition-colors shrink-0"
                    title="Eliminar etiqueta"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Delete confirmation */}
      {pendingDelete && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-gray-900/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-xs p-6 space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-slate-50 ring-1 ring-slate-200 flex items-center justify-center shrink-0">
                <Trash2 size={15} className="text-slate-500" />
              </div>
              <div>
                <h3 className="font-semibold text-gray-900 text-sm">Eliminar etiqueta</h3>
                <p className="text-gray-500 text-xs mt-1.5 leading-relaxed">
                  ¿Eliminar{' '}<span className="font-semibold text-gray-700">"{pendingDelete.name}"</span>?
                  Esta acción no se puede deshacer.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setPendingDel(null)} className="px-3.5 py-2 text-xs font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-xl ring-1 ring-gray-200 transition-colors">Cancelar</button>
              <button onClick={handleDelete} disabled={deleting} className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl ring-1 ring-slate-300 disabled:opacity-50 transition-colors flex items-center gap-1.5">
                {deleting && <Loader2 size={11} className="animate-spin" />}
                Sí, eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function Toast({ message, type = 'success', onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 4500)
    return () => clearTimeout(t)
  }, [onClose])
  const base = 'fixed bottom-6 right-6 z-[60] flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ring-1'
  const style = type === 'success'
    ? `${base} bg-green-50 text-green-800 ring-green-200`
    : `${base} bg-red-50 text-red-800 ring-red-200`
  return (
    <div className={style}>
      {type === 'success' && <CheckCircle2 size={16} className="text-green-500 shrink-0" />}
      <span>{message}</span>
      <button onClick={onClose} className="p-0.5 rounded opacity-60 hover:opacity-100"><X size={14} /></button>
    </div>
  )
}

// ─── Delete Confirm Dialog ────────────────────────────────────────────────────

function DeleteConfirmDialog({ client, onClose, onConfirm, loading }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl ring-1 ring-gray-100 overflow-hidden">
        <div className="px-6 pt-6 pb-4 text-center space-y-3">
          <div className="mx-auto w-11 h-11 rounded-full bg-slate-100 flex items-center justify-center">
            <Trash2 size={20} className="text-slate-500" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-gray-900">{clientDisplayLabel(client)}</h3>
            <p className="text-sm text-gray-500 mt-1">
              ¿Estás seguro de que deseas eliminar este cliente? Esta información será eliminada permanentemente.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 px-6 py-4 border-t border-gray-100 bg-gray-50/60">
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-slate-700 hover:bg-slate-800 active:bg-slate-900 rounded-lg shadow-sm disabled:opacity-60 transition-colors"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? 'Eliminando…' : 'Sí, eliminar'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Register Modal ───────────────────────────────────────────────────────────

export function RegisterModal({ onClose, onSave }) {
  const [form, setForm]     = useState(EMPTY_FORM)
  const [loading, setLoading] = useState(false)
  const [error, setError]   = useState(null)

  function handleChange(e) {
    const { name, value } = e.target
    setForm((prev) => ({ ...prev, [name]: value }))
    setError(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const u = form.username.trim()
    if (!u) {
      setError('El usuario IPTV es obligatorio.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      await onSave({
        username: u,
        name:     form.name.trim() || null,
        email:    form.email.trim(),
        phone:    form.phone.trim()    || null,
        country:  form.country.trim()  || null,
        note:     form.note.trim() || null,
        status:   'Activo',
        custom_fields: {},
      })
    } catch (err) {
      setError(err?.response?.data?.detail ?? 'Error al guardar el cliente. Inténtalo de nuevo.')
      setLoading(false)
    }
  }

  const inputCls = 'w-full px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition'

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl ring-1 ring-gray-100 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Registrar nuevo cliente</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Estado inicial: <span className="font-medium text-green-600">Activo</span>. Usuario IPTV obligatorio.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Usuario IPTV <span className="text-red-500">*</span>
              </label>
              <input type="text" name="username" value={form.username} onChange={handleChange}
                required placeholder="Ej. usuario_panel_123" className={inputCls} autoComplete="off" />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Email <span className="text-red-500">*</span>
              </label>
              <input type="email" name="email" value={form.email} onChange={handleChange}
                required placeholder="correo@ejemplo.com" className={inputCls} />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Nombre completo <span className="text-gray-400 font-normal">(opcional)</span>
              </label>
              <input type="text" name="name" value={form.name} onChange={handleChange}
                placeholder="Ej. Carlos Mendoza" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">Teléfono</label>
              <input type="tel" name="phone" value={form.phone} onChange={handleChange}
                placeholder="+52 55 1234 5678" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">País</label>
              <SearchableSelect
                value={form.country}
                onChange={(v) => {
                  setForm((prev) => ({ ...prev, country: v }))
                  setError(null)
                }}
                options={IPTV_COUNTRY_OPTIONS}
                placeholder="Selecciona o busca país…"
                clearLabel="Sin país"
                disabled={loading}
              />
            </div>
          </div>

          <div className="space-y-4 pt-3 border-t border-gray-100">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">Notas internas</label>
              <textarea
                name="note"
                value={form.note}
                onChange={handleChange}
                rows={3}
                placeholder="Añade observaciones, acuerdos o recordatorios sobre este cliente…"
                className={`${inputCls} resize-none`}
              />
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="flex items-center justify-end gap-3 pt-1 border-t border-gray-100">
            <button
              type="button" onClick={onClose} disabled={loading}
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit" disabled={loading}
              className="inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-lg shadow-sm disabled:opacity-60 transition-colors"
            >
              {loading && <Loader2 size={14} className="animate-spin" />}
              {loading ? 'Guardando…' : 'Registrar Cliente'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Edit Modal ──────────────────────────────────────────────────────────────

const STATUS_OPTIONS = [
  { value: 'Activo', label: 'Activo' },
  { value: 'Inactivo', label: 'Inactivo' },
]

function normalizeClientStatusApi(status) {
  return status === 'Inactivo' ? 'Inactivo' : 'Activo'
}

function clientToEditForm(client) {
  return {
    username: client.username ?? '',
    name:     client.name ?? '',
    email:    client.email ?? '',
    phone:    client.phone ?? '',
    country:  client.country ?? '',
    status:   normalizeClientStatusApi(client.status),
    note:     client.note ?? '',
  }
}

export function EditClientModal({ client, onClose, onSave, onSuccess }) {
  const [form, setForm]       = useState(() => clientToEditForm(client))
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  useEffect(() => {
    setForm(clientToEditForm(client))
    setError(null)
  }, [client.id])

  function handleChange(e) {
    const { name, value } = e.target
    setForm((prev) => ({ ...prev, [name]: value }))
    setError(null)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const u = form.username.trim()
    if (!u) {
      setError('El usuario IPTV es obligatorio.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const payload = {
        username: u,
        name:     form.name.trim() || null,
        email:    form.email.trim(),
        phone:    form.phone.trim()       || null,
        country:  form.country.trim()     || null,
        status:   form.status,
        note:     form.note.trim() || null,
      }
      await onSave(client.id, payload)
      await onSuccess?.()
      setLoading(false)
    } catch (err) {
      setError(err?.response?.data?.detail ?? 'Error al actualizar. Inténtalo de nuevo.')
      setLoading(false)
    }
  }

  const inputCls = 'w-full px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl ring-1 ring-gray-100 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-blue-100">
              <span className="text-sm font-semibold text-blue-600">
                {clientAvatarLetter(client)}
              </span>
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                Editar cliente
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">{clientDisplayLabel(client)} · {client.email}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4 max-h-[80vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Usuario IPTV <span className="text-red-500">*</span>
              </label>
              <input type="text" name="username" value={form.username} onChange={handleChange}
                required placeholder="usuario_panel" className={inputCls} autoComplete="off" />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Email <span className="text-red-500">*</span>
              </label>
              <input type="email" name="email" value={form.email} onChange={handleChange}
                required placeholder="correo@ejemplo.com" className={inputCls} />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1.5">
                Nombre completo <span className="text-gray-400 font-normal">(opcional)</span>
              </label>
              <input type="text" name="name" value={form.name} onChange={handleChange}
                placeholder="Ej. Carlos Mendoza" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">Teléfono</label>
              <input type="tel" name="phone" value={form.phone} onChange={handleChange}
                placeholder="+52 55 1234 5678" className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">País</label>
              <SearchableSelect
                value={form.country}
                onChange={(v) => handleChange({ target: { name: 'country', value: v } })}
                options={IPTV_COUNTRY_OPTIONS}
                placeholder="Selecciona o busca país…"
                clearLabel="Sin país"
                disabled={loading}
              />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-xs font-medium text-gray-700 mb-1.5">Estado</label>
              <SearchableSelect
                value={form.status}
                onChange={(v) => handleChange({ target: { name: 'status', value: v } })}
                options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                hideClear
                disabled={loading}
              />
            </div>
          </div>

          <div className="space-y-4 pt-3 border-t border-gray-100">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1.5">Notas internas</label>
              <textarea
                name="note"
                value={form.note}
                onChange={handleChange}
                rows={3}
                placeholder="Añade observaciones, acuerdos o recordatorios sobre este cliente…"
                className={`${inputCls} resize-none`}
              />
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}

          <div className="flex items-center justify-end gap-3 pt-1 border-t border-gray-100">
            <button
              type="button" onClick={onClose} disabled={loading}
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit" disabled={loading}
              className="inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 rounded-lg shadow-sm disabled:opacity-60 transition-colors"
            >
              {loading && <Loader2 size={14} className="animate-spin" />}
              {loading ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** Alias para código que importaba `EditModal` (p. ej. ficha de cliente). */
export { EditClientModal as EditModal }

// ─── ClientTable ─────────────────────────────────────────────────────────────

function ClientTable({
  rows,
  loading,
  fetchError,
  emptyIcon: EmptyIcon,
  emptyText,
  columns,
  search,
  onSearch,
  onRowClick,
  page = 1,
  totalFiltered = 0,
  onPageChange,
  itemsPerPage = ITEMS_PER_PAGE,
  hideSearch = false,
}) {
  const totalPages = Math.max(1, Math.ceil(totalFiltered / itemsPerPage))
  const currentPage = Math.min(Math.max(1, page), totalPages)
  const rangeStart = totalFiltered === 0 ? 0 : (currentPage - 1) * itemsPerPage + 1
  const rangeEnd = Math.min(currentPage * itemsPerPage, totalFiltered)

  return (
    <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-100 overflow-hidden">
      {!hideSearch ? (
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="relative w-80">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              type="search"
              placeholder="Buscar…"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-lg text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
            />
          </div>
          <span className="text-xs text-gray-400">
            {loading ? '…' : `${totalFiltered} resultado${totalFiltered !== 1 ? 's' : ''}`}
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-end px-6 py-3 border-b border-gray-100">
          <span className="text-xs text-gray-400">
            {loading ? '…' : `${totalFiltered} resultado${totalFiltered !== 1 ? 's' : ''}`}
          </span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              {columns.map((col) => (
                <th key={col.key} className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider whitespace-nowrap">
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading && (
              <tr>
                <td colSpan={columns.length} className="px-6 py-12 text-center text-gray-400 text-sm">
                  <div className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
                    Cargando…
                  </div>
                </td>
              </tr>
            )}
            {!loading && fetchError && (
              <tr>
                <td colSpan={columns.length} className="px-6 py-12 text-center text-red-500 text-sm">{fetchError}</td>
              </tr>
            )}
            {!loading && !fetchError && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-6 py-12 text-center">
                  <div className="flex flex-col items-center gap-2 text-gray-400">
                    <EmptyIcon size={28} className="text-gray-300" />
                    <span className="text-sm">{emptyText}</span>
                  </div>
                </td>
              </tr>
            )}
            {!loading && !fetchError && rows.map((c) => (
              <tr
                key={c.id}
                className={`group transition-colors${onRowClick ? ' cursor-pointer hover:bg-gray-50' : ''}`}
                onClick={(e) => {
                  if (!onRowClick) return
                  if (e.target.closest('button, a, input, textarea, select, [data-no-row-nav]')) return
                  onRowClick(c)
                }}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-5 py-3.5 whitespace-nowrap${col.key === '_actions' ? ' text-right' : ''}`}
                  >
                    {col.render(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-6 py-3 border-t border-gray-100 bg-gray-50/50 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-gray-400">
          {!loading && !fetchError && totalFiltered > 0 ? (
            <>
              Mostrando {rangeStart}–{rangeEnd} de {totalFiltered} · {itemsPerPage} por página
            </>
          ) : (
            <>
              {rows.length} {rows.length === 1 ? 'registro' : 'registros'} en esta página
            </>
          )}
        </span>
        {!loading && !fetchError && totalFiltered > 0 && totalPages > 1 && onPageChange ? (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={currentPage <= 1}
              onClick={() => onPageChange((p) => Math.max(1, p - 1))}
              className="h-8 px-3 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-md shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Anterior
            </button>
            <span className="text-xs text-gray-500 tabular-nums min-w-[4.5rem] text-center">
              {currentPage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={currentPage >= totalPages}
              onClick={() => onPageChange((p) => Math.min(totalPages, p + 1))}
              className="h-8 px-3 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-md shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Siguiente
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Clientes() {
  const navigate = useNavigate()
  const { openNewClient } = useModal()
  const [clientes, setClientes]             = useState([])
  const [loading, setLoading]               = useState(true)
  const [fetchError, setFetchError]         = useState(null)
  const [activeTab, setActiveTab]           = useState('register')
  const [searchReg, setSearchReg]           = useState('')
  const [followUpSearch, setFollowUpSearch] = useState('')
  const [followUpCreditsPreset, setFollowUpCreditsPreset] = useState('all')
  const [followUpDaysPreset, setFollowUpDaysPreset] = useState('all')
  const [followUpDateFrom, setFollowUpDateFrom] = useState('')
  const [followUpDateTo, setFollowUpDateTo] = useState('')
  const [followUpRows, setFollowUpRows] = useState([])
  const [followUpLoading, setFollowUpLoading] = useState(false)
  const [followUpErr, setFollowUpErr] = useState(null)
  const [timelineClient, setTimelineClient]   = useState(null)
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [selectedClient, setSelectedClient]   = useState(null)
  const [paymentMethodsClient, setPaymentMethodsClient] = useState(null)
  const [deleteTarget, setDeleteTarget]       = useState(null)
  const [deleteLoading, setDeleteLoading]     = useState(false)
  const [importLoading, setImportLoading]   = useState(false)
  const [exportLoading, setExportLoading]   = useState(false)
  const [toast, setToast]                   = useState(null)
  const fileInputRef                        = useRef(null)
  // ── Global tag catalog ──
  const [globalTags, setGlobalTags]         = useState([])
  const [tagManagerOpen, setTagManager]     = useState(false)
  const [activeTagFilters, setActiveTagFilters] = useState([]) // array of tag names

  const toggleTagFilter = useCallback((tagName) => {
    setActiveTagFilters((prev) =>
      prev.includes(tagName) ? prev.filter((t) => t !== tagName) : [...prev, tagName],
    )
  }, [])

  const [registerPage, setRegisterPage] = useState(1)
  const [activePage, setActivePage] = useState(1)

  useEffect(() => {
    setRegisterPage(1)
  }, [searchReg])

  useEffect(() => {
    setActivePage(1)
  }, [
    followUpSearch,
    followUpCreditsPreset,
    followUpDaysPreset,
    followUpDateFrom,
    followUpDateTo,
  ])

  const loadFollowUp = useCallback(async () => {
    setFollowUpLoading(true)
    setFollowUpErr(null)
    try {
      const items = await fetchClientFollowUp()
      setFollowUpRows(Array.isArray(items) ? items : [])
    } catch (err) {
      console.error('Error cargando seguimiento:', err)
      setFollowUpErr('No se pudo cargar el seguimiento de clientes.')
      setFollowUpRows([])
    } finally {
      setFollowUpLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadFollowUp()
  }, [loadFollowUp])

  // ── Fetch ──
  const fetchClientes = useCallback(async (opts = {}) => {
    const quiet = opts.quiet === true
    if (!quiet) {
      setLoading(true)
      setFetchError(null)
    }
    try {
      const list = await fetchClientsList({ limit: 500 })
      setClientes(list)
    } catch (err) {
      console.error('Error cargando clientes:', err)
      if (!quiet) {
        setFetchError('No se pudo cargar la lista de clientes. Verifica la conexión con el servidor.')
      }
    } finally {
      if (!quiet) {
        setLoading(false)
      }
    }
  }, [])

  const fetchTags = useCallback(async () => {
    try {
      const { data } = await api.get('/api/v1/tags')
      setGlobalTags(data)
    } catch { /* silently ignore — tags are non-critical */ }
  }, [])

  useEffect(() => { fetchClientes(); fetchTags() }, [fetchClientes, fetchTags])

  // ── Open new client modal (via global context so it also works from Sidebar) ──
  function handleOpenNewClient() {
    openNewClient(() => {
      fetchClientes()
      setToast({ message: 'Cliente registrado correctamente.', type: 'success' })
    })
  }

  // ── Delete client ──
  async function handleDeleteCliente() {
    if (!deleteTarget) return
    setDeleteLoading(true)
    try {
      await api.delete(`/api/v1/clients/${deleteTarget.id}`)
      setClientes((prev) => prev.filter((c) => c.id !== deleteTarget.id))
      setToast({ message: `Cliente "${clientDisplayLabel(deleteTarget)}" eliminado.`, type: 'success' })
      setDeleteTarget(null)
      void loadFollowUp()
    } catch (err) {
      setToast({ message: err?.response?.data?.detail ?? 'Error al eliminar.', type: 'error' })
    } finally {
      setDeleteLoading(false)
    }
  }

  // ── Update existing client (optimistic local update) ──
  async function handleUpdateCliente(clientId, payload) {
    const { data: updated } = await api.patch(`/api/v1/clients/${clientId}`, payload)
    setClientes((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
    setToast({ message: 'Cliente actualizado correctamente.', type: 'success' })
  }

  const handleEditModalSuccess = useCallback(async () => {
    setIsEditModalOpen(false)
    setSelectedClient(null)
    await fetchClientes({ quiet: true })
  }, [fetchClientes])

  const handleInlineStatusChange = useCallback(async (clientId, nextStatus) => {
    try {
      const { data: updated } = await api.patch(`/api/v1/clients/${clientId}`, { status: nextStatus })
      setClientes((prev) => prev.map((c) => (c.id === updated.id ? updated : c)))
      setToast({ message: 'Estado actualizado', type: 'success' })
    } catch (err) {
      const d = err?.response?.data?.detail
      const msg = typeof d === 'string' ? d : Array.isArray(d) ? d.map((x) => x.msg ?? JSON.stringify(x)).join(', ') : 'No se pudo actualizar el estado.'
      setToast({ message: msg, type: 'error' })
      throw err
    }
  }, [])

  // ── Export CSV ──
  async function handleExport() {
    setExportLoading(true)
    try {
      const response = await api.get('/api/v1/clients/export/csv', { responseType: 'blob' })
      const url  = window.URL.createObjectURL(new Blob([response.data]))
      const link = document.createElement('a')
      link.href  = url
      link.setAttribute('download', 'clientes.csv')
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      setToast({ message: 'Error al exportar el archivo CSV.', type: 'error' })
    } finally {
      setExportLoading(false)
    }
  }

  // ── Import CSV ──
  async function handleImportFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportLoading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const { data } = await api.post('/api/v1/clients/import/csv', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      setToast({
        message: `Importación: ${data.created} creados, ${data.updated} actualizados${data.skipped ? `, ${data.skipped} omitidos` : ''}.`,
        type: 'success',
      })
      fetchClientes()
      void loadFollowUp()
    } catch (err) {
      setToast({ message: err?.response?.data?.detail ?? 'Error al importar.', type: 'error' })
    } finally {
      setImportLoading(false)
      e.target.value = ''
    }
  }

  // ── Filtrado por pestaña ──
  const registered = useMemo(() => {
    const q = searchReg.toLowerCase()
    return clientes.filter((c) => clientMatchesSearch(c, q))
  }, [clientes, searchReg])

  const filteredFollowUp = useMemo(() => {
    const q = followUpSearch.trim().toLowerCase()
    return followUpRows.filter((row) => {
      if (q) {
        const hit =
          String(row.username ?? '').toLowerCase().includes(q)
          || String(row.name ?? '').toLowerCase().includes(q)
          || String(row.email ?? '').toLowerCase().includes(q)
          || String(row.phone ?? '').toLowerCase().includes(q)
        if (!hit) return false
      }
      const credits = Number(row.last_recharge_credits) || 0
      if (followUpCreditsPreset === 'lt10' && !(credits < 10)) return false
      if (followUpCreditsPreset === '10-50' && !(credits >= 10 && credits <= 50)) return false
      if (followUpCreditsPreset === 'gt50' && !(credits > 50)) return false
      const days = Number(row.days_since_last_recharge) || 0
      if (followUpDaysPreset === '7' && days < 7) return false
      if (followUpDaysPreset === '15' && days < 15) return false
      if (followUpDaysPreset === '30plus' && days <= 30) return false
      const ymd = ecuadorYmd(row.last_recharge_date)
      if (followUpDateFrom && ymd && ymd < followUpDateFrom) return false
      if (followUpDateTo && ymd && ymd > followUpDateTo) return false
      if ((followUpDateFrom || followUpDateTo) && !ymd) return false
      return true
    })
  }, [
    followUpRows,
    followUpSearch,
    followUpCreditsPreset,
    followUpDaysPreset,
    followUpDateFrom,
    followUpDateTo,
  ])

  const registerTotalPages = Math.max(1, Math.ceil(registered.length / ITEMS_PER_PAGE))
  const followUpTotalPages = Math.max(1, Math.ceil(filteredFollowUp.length / ITEMS_PER_PAGE))

  useEffect(() => {
    setRegisterPage((p) => Math.min(p, registerTotalPages))
  }, [registerTotalPages])

  useEffect(() => {
    setActivePage((p) => Math.min(p, followUpTotalPages))
  }, [followUpTotalPages])

  const registeredPageRows = useMemo(() => {
    const start = (registerPage - 1) * ITEMS_PER_PAGE
    return registered.slice(start, start + ITEMS_PER_PAGE)
  }, [registered, registerPage])

  const followUpPageRows = useMemo(() => {
    const start = (activePage - 1) * ITEMS_PER_PAGE
    return filteredFollowUp.slice(start, start + ITEMS_PER_PAGE)
  }, [filteredFollowUp, activePage])

  const resolveClientForActions = useCallback(
    (row) => clientes.find((c) => Number(c.id) === Number(row.id)) || row,
    [clientes],
  )

  const tabCounts = {
    register: clientes.length,
    active: followUpRows.length,
  }

  // ── Columna acciones ──
  const actionsCol = useMemo(() => ({
    key: '_actions',
    header: 'Acciones',
    render: (c) => (
      <div className="flex items-center justify-end gap-0.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setSelectedClient(c)
            setIsEditModalOpen(true)
          }}
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          title="Editar cliente"
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setTimelineClient(c) }}
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          title="Ver seguimiento CRM"
        >
          <MessageSquare size={14} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setPaymentMethodsClient(c)
          }}
          className="p-1.5 rounded-lg text-gray-400 hover:text-sky-700 hover:bg-sky-50 transition-colors"
          title="Métodos de pago"
        >
          <CreditCard size={14} />
        </button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setDeleteTarget(c) }}
          className="p-1.5 rounded-lg text-gray-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          title="Eliminar cliente"
        >
          <Trash2 size={14} />
        </button>
      </div>
    ),
  }), [])

  const mainColumns = useMemo(() => [
    {
      key: 'username',
      header: 'Usuario',
      render: (c) => (
        <InlineEdit
          value={c.username}
          required
          emptyLabel="—"
          onSave={(v) => handleUpdateCliente(c.id, { username: v })}
        />
      ),
    },
    {
      key: 'name',
      header: 'Nombre',
      render: (c) => (
        <div className="min-w-0 max-w-[220px]">
          <InlineEdit
            value={c.name}
            emptyLabel="Sin nombre"
            onSave={(v) => handleUpdateCliente(c.id, { name: v })}
          />
          <div className="flex items-center gap-1 text-gray-400 mt-0.5">
            <Mail size={10} className="shrink-0" />
            <span className="text-[11px] truncate" title={c.email}>{c.email}</span>
          </div>
          {(() => {
            const creditRows = Array.isArray(c.credit_balances_by_currency)
              ? c.credit_balances_by_currency
              : []
            const hasCredit =
              creditRows.some((row) => Number(row?.amount) > 1e-6) ||
              (Number(c.credit_balance) || 0) > 1e-6
            if (!hasCredit) return null
            const label =
              creditRows.length === 1
                ? `${Number(creditRows[0].amount).toFixed(2)} ${creditRows[0].currency}`
                : creditRows.length > 1
                  ? `${creditRows.length} monedas`
                  : 'Saldo a favor'
            return (
              <span
                className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200/90"
                title={label}
              >
                <Sparkles size={11} aria-hidden /> {label}
              </span>
            )
          })()}
        </div>
      ),
    },
    {
      key: 'hierarchy',
      header: 'Jerarquía',
      render: (c) => clientParentBadge(c),
    },
    {
      key: 'phone',
      header: 'Teléfono',
      render: (c) => (
        <div className="inline-flex items-center gap-1 text-gray-500">
          <Phone size={12} className="shrink-0 text-gray-400" />
          <InlineEdit
            value={c.phone}
            type="tel"
            emptyLabel="—"
            onSave={(v) => handleUpdateCliente(c.id, { phone: v })}
          />
        </div>
      ),
    },
    {
      key: 'country',
      header: 'País',
      render: (c) => (
        <div className="inline-flex items-center gap-1 text-gray-500">
          <Globe size={12} className="shrink-0 text-gray-400" />
          <InlineEdit
            value={c.country}
            listId={CLIENT_TABLE_COUNTRY_LIST_ID}
            emptyLabel="—"
            onSave={(v) => handleUpdateCliente(c.id, { country: v })}
          />
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Estado',
      render: (c) => (
        <StatusInlineSelect
          clientId={c.id}
          status={c.status}
          onCommit={handleInlineStatusChange}
        />
      ),
    },
    actionsCol,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [actionsCol, handleUpdateCliente, handleInlineStatusChange])

  const followUpColumns = useMemo(() => [
    {
      key: 'identity',
      header: 'Usuario / Nombre',
      render: (row) => (
        <div className="min-w-0 max-w-[220px]">
          <p className="text-sm font-semibold text-gray-900 truncate" title={row.username}>
            {row.username || '—'}
          </p>
          <p className="text-xs text-gray-500 truncate mt-0.5" title={row.name || ''}>
            {row.name || 'Sin nombre'}
          </p>
        </div>
      ),
    },
    {
      key: 'phone',
      header: 'Teléfono',
      render: (row) => (
        <WhatsAppButton phone={row.phone} name={row.name || row.username || 'cliente'} />
      ),
    },
    {
      key: 'last_credits',
      header: 'Última recarga',
      render: (row) => <CreditsBadge value={row.last_recharge_credits} />,
    },
    {
      key: 'last_date',
      header: 'Fecha',
      render: (row) => {
        const label = formatShortDate(row.last_recharge_date)
        if (!label) return <span className="text-gray-400 text-xs">—</span>
        return (
          <span className="inline-flex items-center gap-1 text-xs text-gray-600">
            <CalendarDays size={12} className="text-gray-400 shrink-0" />
            {label}
          </span>
        )
      },
    },
    {
      key: 'days_since',
      header: 'Días transcurridos',
      render: (row) => <DaysSinceCell days={row.days_since_last_recharge} />,
    },
    {
      key: '_actions',
      header: 'Acciones',
      render: (row) => {
        const c = resolveClientForActions(row)
        return actionsCol.render(c)
      },
    },
  ], [actionsCol, resolveClientForActions])

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Delete Confirm ── */}
      {deleteTarget && (
        <DeleteConfirmDialog
          client={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={handleDeleteCliente}
          loading={deleteLoading}
        />
      )}

      {/* ── Edit cliente ── */}
      {isEditModalOpen && selectedClient && (
        <EditClientModal
          client={selectedClient}
          onClose={() => {
            setIsEditModalOpen(false)
            setSelectedClient(null)
          }}
          onSave={handleUpdateCliente}
          onSuccess={handleEditModalSuccess}
        />
      )}

      <ClientPaymentMethodsModal
        open={Boolean(paymentMethodsClient)}
        client={paymentMethodsClient}
        onClose={() => setPaymentMethodsClient(null)}
        onToast={(message) => setToast({ message, type: 'success' })}
      />

      {/* ── Timeline panel ── */}
      {timelineClient && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={() => setTimelineClient(null)} />
          <div className="relative w-full max-w-sm bg-white shadow-2xl flex flex-col h-full border-l border-gray-200 z-50">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                  <span className="text-xs font-semibold text-blue-600">
                    {clientAvatarLetter(timelineClient)}
                  </span>
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{clientDisplayLabel(timelineClient)}</p>
                  <p className="text-xs text-gray-500">{timelineClient.email}</p>
                </div>
              </div>
              <button
                onClick={() => setTimelineClient(null)}
                className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 overflow-hidden p-5">
              <ClientTimeline clientId={timelineClient.id} clientName={clientDisplayLabel(timelineClient)} />
            </div>
          </div>
        </div>
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {tagManagerOpen && (
        <TagManagerModal
          onClose={() => setTagManager(false)}
          globalTags={globalTags}
          onRefresh={fetchTags}
          activeTagFilters={activeTagFilters}
          onToggleFilter={toggleTagFilter}
        />
      )}

      <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleImportFile} />

      <datalist id={CLIENT_TABLE_COUNTRY_LIST_ID}>
        {IPTV_COUNTRIES.map((country) => (
          <option key={country} value={country} />
        ))}
      </datalist>

      <div className="max-w-7xl mx-auto space-y-5">

        {/* ── Page Header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">CRM de Clientes</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {loading ? 'Cargando…' : `${clientes.length} clientes en total`}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setTagManager(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors shadow-sm"
              title="Gestor de etiquetas"
            >
              <Tags size={14} />
              Etiquetas
              {globalTags.length > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-4.5 px-1 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700">
                  {globalTags.length}
                </span>
              )}
            </button>
            <button
              onClick={handleExport} disabled={exportLoading}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors shadow-sm"
            >
              {exportLoading ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
              Exportar CSV
            </button>
            <button
              onClick={() => fileInputRef.current?.click()} disabled={importLoading}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors shadow-sm"
            >
              {importLoading ? <RefreshCw size={14} className="animate-spin" /> : <Upload size={14} />}
              Importar
            </button>
            {activeTab === 'register' && (
              <button
                onClick={handleOpenNewClient}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium rounded-lg shadow-sm transition-colors"
              >
                <UserPlus size={15} />
                Nuevo Cliente
              </button>
            )}
          </div>
        </div>

        {/* ── Tabs ── */}
        <div className="flex items-center gap-1 border-b border-gray-200">
          {TABS.map((tab) => {
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
                {count !== undefined && (
                  <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-semibold ${
                    active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {/* ── Tab 1: Registro de Clientes ── */}
        {activeTab === 'register' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">
                Directorio maestro: Todos los clientes registrados en el sistema.
              </p>
            </div>
            <ClientTable
              rows={registeredPageRows}
              loading={loading}
              fetchError={fetchError}
              emptyIcon={ClipboardList}
              emptyText="No hay clientes registrados aún. Usa el botón «Nuevo Cliente» para añadir el primero."
              columns={mainColumns}
              search={searchReg}
              onSearch={setSearchReg}
              onRowClick={(c) => navigate(`/clientes/${c.id}`)}
              page={registerPage}
              totalFiltered={registered.length}
              onPageChange={setRegisterPage}
              itemsPerPage={ITEMS_PER_PAGE}
            />
          </div>
        )}

        {/* ── Tab 2: Seguimiento (créditos normales) ── */}
        {activeTab === 'active' && (
          <div className="space-y-4">
            <div className="space-y-3">
              <p className="text-sm text-gray-500">
                Retención: clientes con compras de <strong className="font-medium text-gray-700">crédito normal</strong>
                {' '}(excluye pantallas y recargas BaaS). Muestra la última transacción qualifying por cliente.
              </p>

              <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-gray-50/80 p-4">
                <label className="flex flex-col gap-1 min-w-[12rem] flex-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    Buscar
                  </span>
                  <div className="relative">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                    <input
                      type="search"
                      value={followUpSearch}
                      onChange={(e) => setFollowUpSearch(e.target.value)}
                      placeholder="Usuario o nombre…"
                      className="w-full pl-8 pr-3 py-1.5 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                    />
                  </div>
                </label>

                <label className="flex flex-col gap-1 min-w-[9rem]">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    Créditos
                  </span>
                  <select
                    value={followUpCreditsPreset}
                    onChange={(e) => setFollowUpCreditsPreset(e.target.value)}
                    className="text-sm py-1.5 px-2 rounded-lg border border-gray-200 bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  >
                    {FOLLOW_UP_CREDITS_PRESETS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 min-w-[9rem]">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    Días transcurridos
                  </span>
                  <select
                    value={followUpDaysPreset}
                    onChange={(e) => setFollowUpDaysPreset(e.target.value)}
                    className="text-sm py-1.5 px-2 rounded-lg border border-gray-200 bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  >
                    {FOLLOW_UP_DAYS_PRESETS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 min-w-[9rem]">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    Fecha desde
                  </span>
                  <input
                    type="date"
                    value={followUpDateFrom}
                    onChange={(e) => setFollowUpDateFrom(e.target.value)}
                    className="text-sm py-1.5 px-2 rounded-lg border border-gray-200 bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  />
                </label>

                <label className="flex flex-col gap-1 min-w-[9rem]">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    Fecha hasta
                  </span>
                  <input
                    type="date"
                    value={followUpDateTo}
                    onChange={(e) => setFollowUpDateTo(e.target.value)}
                    className="text-sm py-1.5 px-2 rounded-lg border border-gray-200 bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => {
                    setFollowUpSearch('')
                    setFollowUpCreditsPreset('all')
                    setFollowUpDaysPreset('all')
                    setFollowUpDateFrom('')
                    setFollowUpDateTo('')
                  }}
                  className="text-sm py-1.5 px-3 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Limpiar filtros
                </button>

                <button
                  type="button"
                  onClick={() => void loadFollowUp()}
                  disabled={followUpLoading}
                  className="inline-flex items-center gap-1.5 text-sm py-1.5 px-3 rounded-lg border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
                >
                  <RefreshCw size={14} className={followUpLoading ? 'animate-spin' : ''} />
                  Actualizar
                </button>
              </div>
            </div>

            <ClientTable
              rows={followUpPageRows}
              loading={followUpLoading || loading}
              fetchError={followUpErr || fetchError}
              emptyIcon={Activity}
              emptyText="Ningún cliente con compras de crédito normal registradas."
              columns={followUpColumns}
              search={followUpSearch}
              onSearch={setFollowUpSearch}
              hideSearch
              onRowClick={(c) => navigate(`/clientes/${c.id}`)}
              page={activePage}
              totalFiltered={filteredFollowUp.length}
              onPageChange={setActivePage}
              itemsPerPage={ITEMS_PER_PAGE}
            />
          </div>
        )}

      </div>
    </>
  )
}
