import { useCallback, useEffect, useState } from 'react'
import { History, Loader2, RefreshCw, Search, X } from 'lucide-react'
import { fetchAuditLogDetail, fetchAuditLogs, fetchAuditTables } from '../../api/audit'
import { formatDateTimeEcuador } from '../../utils/datetime'

const ACTIONS = [
  { value: '', label: 'Todas las acciones' },
  { value: 'insert', label: 'Creación' },
  { value: 'update', label: 'Actualización' },
  { value: 'delete', label: 'Eliminación' },
  { value: 'bulk_update', label: 'Actualización masiva' },
  { value: 'bulk_delete', label: 'Eliminación masiva' },
]

const ACTOR_TYPES = [
  { value: '', label: 'Todos los actores' },
  { value: 'staff', label: 'Staff ERP' },
  { value: 'portal_client', label: 'Cliente del portal' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'system', label: 'Sistema' },
  { value: 'script', label: 'Script' },
]

const ACTION_BADGE = {
  insert: 'bg-green-50 text-green-700 ring-1 ring-green-200',
  update: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  delete: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  bulk_update: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
  bulk_delete: 'bg-red-50 text-red-700 ring-1 ring-red-200',
}

function ActionBadge({ action }) {
  const label = ACTIONS.find((a) => a.value === action)?.label || action
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${ACTION_BADGE[action] || 'bg-gray-100 text-gray-600'}`}>
      {label}
    </span>
  )
}

function JsonBlock({ label, value }) {
  if (!value || Object.keys(value).length === 0) {
    return (
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{label}</p>
        <p className="text-sm text-gray-400 italic">— vacío —</p>
      </div>
    )
  }
  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <pre className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function AuditDetailModal({ id, onClose }) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(false)
    fetchAuditLogDetail(id)
      .then((data) => {
        if (active) setDetail(data)
      })
      .catch(() => {
        if (active) setError(true)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [id])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-gray-900">Detalle de auditoría #{id}</h3>
            {detail && (
              <p className="text-sm text-gray-500 mt-0.5">
                {detail.entity_table} · {detail.entity_id ?? '—'} · {formatDateTimeEcuador(detail.timestamp)}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors shrink-0"
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center">
            <Loader2 size={16} className="animate-spin" /> Cargando…
          </div>
        )}
        {error && <p className="text-sm text-red-600">No se pudo cargar el detalle.</p>}

        {detail && !loading && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Actor</p>
                <p className="text-gray-800">{detail.actor_label || detail.actor_type}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">IP</p>
                <p className="text-gray-800">{detail.ip || '—'}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Acción</p>
                <ActionBadge action={detail.action} />
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Request ID</p>
                <p className="text-gray-800 font-mono text-xs break-all">{detail.request_id || '—'}</p>
              </div>
            </div>
            {detail.changed_fields?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Campos modificados</p>
                <div className="flex flex-wrap gap-1.5">
                  {detail.changed_fields.map((f) => (
                    <span key={f} className="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-xs font-mono">
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <JsonBlock label="Antes" value={detail.before} />
            <JsonBlock label="Después" value={detail.after} />
            {detail.meta && <JsonBlock label="Metadatos" value={detail.meta} />}
          </div>
        )}
      </div>
    </div>
  )
}

export default function AuditLogPage() {
  const [rows, setRows] = useState([])
  const [tables, setTables] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [cursorStack, setCursorStack] = useState([]) // pila de cursores para "anterior"
  const [cursor, setCursor] = useState(null)
  const [nextCursor, setNextCursor] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [selectedId, setSelectedId] = useState(null)

  const [filters, setFilters] = useState({
    entity_table: '',
    action: '',
    actor_type: '',
    actor_q: '',
  })

  useEffect(() => {
    fetchAuditTables()
      .then((data) => setTables(Array.isArray(data) ? data : []))
      .catch(() => setTables([]))
  }, [])

  const load = useCallback(
    async (targetCursor) => {
      setLoading(true)
      setError(false)
      try {
        const params = { limit: 50 }
        if (filters.entity_table) params.entity_table = filters.entity_table
        if (filters.action) params.action = filters.action
        if (filters.actor_type) params.actor_type = filters.actor_type
        if (filters.actor_q.trim()) params.actor_q = filters.actor_q.trim()
        if (targetCursor) params.cursor = targetCursor

        const page = await fetchAuditLogs(params)
        setRows(page.items || [])
        setNextCursor(page.next_cursor || null)
        setHasMore(Boolean(page.has_more))
      } catch {
        setError(true)
        setRows([])
      } finally {
        setLoading(false)
      }
    },
    [filters],
  )

  useEffect(() => {
    setCursor(null)
    setCursorStack([])
    load(null)
  }, [load])

  function handleNextPage() {
    if (!nextCursor) return
    setCursorStack((prev) => [...prev, cursor])
    setCursor(nextCursor)
    load(nextCursor)
  }

  function handlePrevPage() {
    setCursorStack((prev) => {
      const next = [...prev]
      const prevCursor = next.pop() ?? null
      setCursor(prevCursor)
      load(prevCursor)
      return next
    })
  }

  const canGoBack = cursorStack.length > 0

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-full">
      {selectedId != null && <AuditDetailModal id={selectedId} onClose={() => setSelectedId(null)} />}

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <History size={14} className="text-blue-500" />
            <span>Equipo · Auditoría</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Bitácora de auditoría</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Quién cambió qué, y qué valor tenía antes — inmutable, sin acciones de escritura desde aquí.
          </p>
        </div>
        <button
          type="button"
          onClick={() => load(cursor)}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm text-gray-700 hover:bg-gray-50 transition-colors shrink-0"
        >
          <RefreshCw size={14} /> Actualizar
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-4 flex flex-wrap gap-3 items-end">
        <div className="min-w-[180px]">
          <label className="text-xs font-medium text-gray-500 block mb-1">Tabla</label>
          <select
            value={filters.entity_table}
            onChange={(e) => setFilters((f) => ({ ...f, entity_table: e.target.value }))}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-200"
          >
            <option value="">Todas las tablas</option>
            {tables.map((t) => (
              <option key={t.table} value={t.table}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[160px]">
          <label className="text-xs font-medium text-gray-500 block mb-1">Acción</label>
          <select
            value={filters.action}
            onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-200"
          >
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[160px]">
          <label className="text-xs font-medium text-gray-500 block mb-1">Actor</label>
          <select
            value={filters.actor_type}
            onChange={(e) => setFilters((f) => ({ ...f, actor_type: e.target.value }))}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-200"
          >
            {ACTOR_TYPES.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[200px] flex-1">
          <label className="text-xs font-medium text-gray-500 block mb-1">Buscar actor (email/nombre)</label>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={filters.actor_q}
              onChange={(e) => setFilters((f) => ({ ...f, actor_q: e.target.value }))}
              placeholder="admin@ejemplo.com"
              className="w-full rounded-lg border border-gray-200 pl-9 pr-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-200"
            />
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Fecha</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Actor</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Acción</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Tabla</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">ID</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Campos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                    <Loader2 size={18} className="animate-spin inline-block" />
                  </td>
                </tr>
              )}
              {!loading && error && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-red-500">
                    No se pudo cargar la bitácora.
                  </td>
                </tr>
              )}
              {!loading && !error && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                    Sin resultados para estos filtros.
                  </td>
                </tr>
              )}
              {!loading &&
                !error &&
                rows.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setSelectedId(row.id)}
                    className="hover:bg-gray-50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatDateTimeEcuador(row.timestamp)}</td>
                    <td className="px-4 py-3 text-gray-800">
                      {row.actor_label || <span className="text-gray-400 italic">{row.actor_type}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <ActionBadge action={row.action} />
                    </td>
                    <td className="px-4 py-3 text-gray-600 font-mono text-xs">{row.entity_table}</td>
                    <td className="px-4 py-3 text-gray-600 font-mono text-xs">{row.entity_id ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs max-w-[220px] truncate">
                      {row.changed_fields?.join(', ') || '—'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-sm text-gray-500">
          <button
            type="button"
            onClick={handlePrevPage}
            disabled={!canGoBack || loading}
            className="px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 transition-colors"
          >
            ← Anterior
          </button>
          <span>{rows.length} fila{rows.length === 1 ? '' : 's'}</span>
          <button
            type="button"
            onClick={handleNextPage}
            disabled={!hasMore || loading}
            className="px-3 py-1.5 rounded-lg border border-gray-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50 transition-colors"
          >
            Siguiente →
          </button>
        </div>
      </div>
    </div>
  )
}
