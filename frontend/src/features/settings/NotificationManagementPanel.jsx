import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { Loader2, Megaphone, Pencil, RefreshCw, Search, Trash2, X } from 'lucide-react'
import Select from 'react-select'
import api from '../../api/axios'
import { getApiErrorMessage } from '../../lib/apiErrors'
import usePermissions from '../../hooks/usePermissions'
import { PERMS } from '../../lib/permissions'
import { formatSaleTableDate } from '../sales/saleTableHelpers'

const DELETE_SECURITY_PIN = '301985'
const HISTORY_ITEMS_PER_PAGE = 5

/** Normaliza la respuesta del API (array directo, { items }, { batches } o null). */
function normalizeHistoryPayload(data) {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    if (Array.isArray(data.items)) return data.items
    if (Array.isArray(data.batches)) return data.batches
    if (Array.isArray(data.history)) return data.history
  }
  return []
}

/** Fila de historial con defaults seguros para evitar crash en render. */
function normalizeHistoryRow(row) {
  if (!row || typeof row !== 'object') {
    return {
      batch_id: '',
      title: 'Sin título',
      message: '',
      target_label: '—',
      created_at: null,
      read_count: 0,
      total_count: 0,
      unread_count: 0,
    }
  }
  return {
    batch_id: String(row.batch_id ?? row.id ?? '').trim(),
    title: String(row.title ?? 'Sin título'),
    message: String(row.message ?? ''),
    target_label: String(row.target_label ?? '—'),
    created_at: row.created_at ?? null,
    read_count: Number(row.read_count ?? 0) || 0,
    total_count: Number(row.total_count ?? 0) || 0,
    unread_count: Number(row.unread_count ?? 0) || 0,
  }
}

function clientDisplayLabel(client) {
  if (!client || typeof client !== 'object') return 'Cliente'
  const name = client.name != null ? String(client.name).trim() : ''
  const username = client.username != null ? String(client.username).trim() : ''
  const email = client.email != null ? String(client.email).trim() : ''
  return name || username || email || `Cliente #${client.id ?? '?'}`
}

function htmlMessageHasContent(html) {
  if (!html || typeof html !== 'string') return false
  const stripped = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.length > 0
}

function htmlToPlainPreview(html, maxLen = 140) {
  if (!html || typeof html !== 'string') return ''
  if (typeof document !== 'undefined') {
    const div = document.createElement('div')
    div.innerHTML = html
    const text = (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim()
    if (text.length <= maxLen) return text
    return `${text.slice(0, maxLen)}…`
  }
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
}

function NotificationMessageEditor({ value, onChange, placeholder }) {
  const safeValue = value ?? ''
  return (
    <textarea
      value={safeValue}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      rows={6}
      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm resize-y min-h-[140px] focus:outline-none focus:ring-2 focus:ring-violet-500/40"
    />
  )
}

const targetOptions = [
  { value: 'all', label: 'Todos los clientes' },
  { value: 'level', label: 'Filtrar por Nivel' },
  { value: 'specific', label: 'Cliente Específico' },
]

const levelOptions = Array.from({ length: 10 }, (_, i) => ({
  value: i + 1,
  label: `Nivel ${i + 1}`,
}))

const notifSelectStyles = {
  control: (base, state) => ({
    ...base,
    minHeight: 40,
    borderRadius: 8,
    borderColor: state.isFocused ? '#8b5cf6' : '#d1d5db',
    boxShadow: state.isFocused ? '0 0 0 2px rgba(139, 92, 246, 0.25)' : 'none',
    backgroundColor: '#ffffff',
    fontSize: 14,
    cursor: 'pointer',
    '&:hover': {
      borderColor: state.isFocused ? '#8b5cf6' : '#9ca3af',
    },
  }),
  valueContainer: (base) => ({
    ...base,
    padding: '0 12px',
  }),
  placeholder: (base) => ({
    ...base,
    color: '#9ca3af',
  }),
  singleValue: (base) => ({
    ...base,
    color: '#111827',
  }),
  indicatorSeparator: () => ({
    display: 'none',
  }),
  dropdownIndicator: (base) => ({
    ...base,
    color: '#6b7280',
    padding: '0 8px',
  }),
  menuPortal: (base) => ({
    ...base,
    zIndex: 6000,
  }),
  menu: (base) => ({
    ...base,
    borderRadius: 8,
    border: '1px solid #d1d5db',
    boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
    overflow: 'hidden',
  }),
  option: (base, state) => ({
    ...base,
    fontSize: 14,
    backgroundColor: state.isSelected ? '#f5f3ff' : state.isFocused ? '#f9fafb' : '#ffffff',
    color: '#111827',
    cursor: 'pointer',
  }),
}

function EditBatchModal({ batch, onClose, onSaved }) {
  const [title, setTitle] = useState(batch?.title ?? '')
  const [message, setMessage] = useState(batch?.message ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setTitle(batch?.title ?? '')
    setMessage(batch?.message ?? '')
    setSubmitting(false)
    setError('')
  }, [batch?.batch_id, batch?.title, batch?.message])

  if (!batch) return null

  async function handleSubmit(e) {
    e.preventDefault()
    if (!title.trim() || !htmlMessageHasContent(message)) return
    setSubmitting(true)
    setError('')
    try {
      const { data } = await api.put(
        `/api/v1/admin/notifications/batch/${encodeURIComponent(batch.batch_id)}`,
        { title: title.trim(), message },
      )
      onSaved?.(data?.message || 'Lote actualizado.')
      onClose?.()
    } catch (err) {
      const d = err?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'No se pudo actualizar el lote.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/55 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Editar notificación</h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100"
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Título</label>
            <input
              type="text"
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/40"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Mensaje</label>
            <NotificationMessageEditor
              value={message || ''}
              onChange={setMessage}
              placeholder="Escribe el contenido enriquecido que verá el cliente…"
            />
          </div>
          {error ? <p className="text-sm text-red-600 font-medium">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim() || !htmlMessageHasContent(message)}
              className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-40"
            >
              {submitting ? 'Guardando…' : 'Guardar cambios'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function NotificationManagementPanel({ clients = [], onToast }) {
  const { hasPermission } = usePermissions()
  const canCreate = hasPermission(PERMS.BAAS_NOTIFICATIONS_CREATE)
  const canEdit = hasPermission(PERMS.BAAS_NOTIFICATIONS_EDIT)
  const canDelete = hasPermission(PERMS.BAAS_NOTIFICATIONS_DELETE)
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [targetType, setTargetType] = useState('all')
  const [targetLevel, setTargetLevel] = useState(1)
  const [targetClientId, setTargetClientId] = useState('')
  const [clientSearch, setClientSearch] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sendError, setSendError] = useState('')

  const [historialNotificaciones, setHistorialNotificaciones] = useState([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyErr, setHistoryErr] = useState(null)
  const [editBatch, setEditBatch] = useState(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [deletingBatchId, setDeletingBatchId] = useState(null)
  const [selectedBatchIds, setSelectedBatchIds] = useState([])
  const [bulkDeleting, setBulkDeleting] = useState(false)

  const itemsPerPage = HISTORY_ITEMS_PER_PAGE

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    setHistoryErr(null)
    try {
      const { data } = await api.get('/api/v1/admin/notifications/history')
      const rows = normalizeHistoryPayload(data).map(normalizeHistoryRow)
      setHistorialNotificaciones(rows)
    } catch (err) {
      setHistoryErr(getApiErrorMessage(err, { fallback: 'No se pudo cargar el historial.' }))
      setHistorialNotificaciones([])
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const sortedHistorial = useMemo(() => {
    if (!Array.isArray(historialNotificaciones)) return []
    return [...historialNotificaciones].sort((a, b) => {
      const ta = a?.created_at ? new Date(a.created_at).getTime() : 0
      const tb = b?.created_at ? new Date(b.created_at).getTime() : 0
      if (tb !== ta) return tb - ta
      return String(b?.batch_id ?? '').localeCompare(String(a?.batch_id ?? ''))
    })
  }, [historialNotificaciones])

  const indexOfLastItem = currentPage * itemsPerPage
  const indexOfFirstItem = indexOfLastItem - itemsPerPage
  const currentItems = sortedHistorial.slice(indexOfFirstItem, indexOfLastItem)
  const totalHistoryPages = Math.max(1, Math.ceil(sortedHistorial.length / itemsPerPage))

  useEffect(() => {
    if (currentPage > totalHistoryPages) {
      setCurrentPage(totalHistoryPages)
    }
  }, [currentPage, totalHistoryPages])

  useEffect(() => {
    const validIds = new Set(
      sortedHistorial.map((row) => String(row?.batch_id ?? '').trim()).filter(Boolean),
    )
    setSelectedBatchIds((prev) => prev.filter((id) => validIds.has(id)))
  }, [sortedHistorial])

  function toggleBatchSelection(batchId) {
    const bid = String(batchId ?? '').trim()
    if (!bid) return
    setSelectedBatchIds((prev) =>
      prev.includes(bid) ? prev.filter((id) => id !== bid) : [...prev, bid],
    )
  }

  async function handleBulkDelete() {
    if (selectedBatchIds.length === 0) return

    const password = window.prompt(
      'Ingrese la contraseña de seguridad para eliminar los elementos seleccionados:',
    )
    if (password === null) return
    if (password !== DELETE_SECURITY_PIN) {
      window.alert('Contraseña incorrecta')
      onToast?.('Contraseña incorrecta')
      return
    }

    setBulkDeleting(true)
    try {
      const { data } = await api.post('/api/v1/admin/notifications/batch/bulk-delete', {
        batch_ids: selectedBatchIds,
      })
      onToast?.(data?.message || 'Lotes seleccionados eliminados.')
      setSelectedBatchIds([])
      await loadHistory()
    } catch (err) {
      const d = err?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudieron eliminar los lotes seleccionados.')
      onToast?.(typeof d === 'string' ? d : 'No se pudieron eliminar los lotes seleccionados.')
    } finally {
      setBulkDeleting(false)
    }
  }

  async function handleDelete(batchId) {
    const bid = String(batchId ?? '').trim()
    if (!bid) return

    const password = window.prompt('Ingrese la contraseña de seguridad para eliminar:')
    if (password === null) return
    if (password !== DELETE_SECURITY_PIN) {
      window.alert('Contraseña incorrecta')
      onToast?.('Contraseña incorrecta')
      return
    }

    setDeletingBatchId(bid)
    try {
      const { data } = await api.delete(
        `/api/v1/admin/notifications/batch/${encodeURIComponent(bid)}`,
      )
      onToast?.(data?.message || 'Lote eliminado.')
      setSelectedBatchIds((prev) => prev.filter((id) => id !== bid))
      await loadHistory()
    } catch (err) {
      const d = err?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo eliminar el lote.')
      onToast?.(typeof d === 'string' ? d : 'No se pudo eliminar el lote.')
    } finally {
      setDeletingBatchId(null)
    }
  }

  const filteredClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase()
    const list = Array.isArray(clients) ? clients : []
    if (!q) return list.slice(0, 50)
    return list
      .filter((c) => {
        const name = String(c?.name ?? '').toLowerCase()
        const email = String(c?.email ?? '').toLowerCase()
        const username = String(c?.username ?? '').toLowerCase()
        const id = String(c?.id ?? '')
        return name.includes(q) || email.includes(q) || username.includes(q) || id.includes(q)
      })
      .slice(0, 50)
  }, [clients, clientSearch])

  const selectedTargetOption = useMemo(
    () => targetOptions.find((opt) => opt.value === targetType) || targetOptions[0],
    [targetType],
  )

  const selectedLevelOption = useMemo(
    () => levelOptions.find((opt) => opt.value === Number(targetLevel)) || levelOptions[0],
    [targetLevel],
  )

  const canSubmit =
    canCreate &&
    title.trim().length > 0 &&
    htmlMessageHasContent(message) &&
    !submitting &&
    (targetType !== 'specific' || Boolean(targetClientId))

  async function handleSend(e) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setSendError('')
    try {
      const payload = {
        title: title.trim(),
        message: message.trim(),
        target_type: targetType,
        target_value:
          targetType === 'level'
            ? Number(targetLevel)
            : targetType === 'specific'
              ? Number(targetClientId)
              : null,
      }
      const { data } = await api.post('/api/v1/admin/notifications/send', payload)
      onToast?.(data?.message || 'Notificaciones enviadas.')
      setTitle('')
      setMessage('')
      setTargetType('all')
      setTargetLevel(1)
      setTargetClientId('')
      setClientSearch('')
      setCurrentPage(1)
      await loadHistory()
    } catch (err) {
      setSendError(getApiErrorMessage(err, { fallback: 'No se pudo enviar la notificación.' }))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="flex items-center gap-2 px-6 py-4 border-b border-gray-100">
          <Megaphone size={18} className="text-violet-600" />
          <h2 className="text-base font-semibold text-gray-800">Enviar notificación</h2>
        </div>
        {!canCreate ? (
          <p className="px-6 py-5 text-sm text-gray-500">No tienes permiso para enviar notificaciones.</p>
        ) : (
        <form onSubmit={handleSend} className="px-6 py-5 space-y-4">
          <div>
            <label htmlFor="notif-panel-title" className="block text-xs font-semibold text-gray-600 mb-1.5">
              Título del mensaje
            </label>
            <input
              id="notif-panel-title"
              type="text"
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/40"
              placeholder="Ej. Mantenimiento programado"
            />
          </div>
          <div>
            <label htmlFor="notif-panel-message" className="block text-xs font-semibold text-gray-600 mb-1.5">
              Cuerpo del mensaje
            </label>
            <NotificationMessageEditor
              value={message || ''}
              onChange={setMessage}
              placeholder="Escribe el contenido que verá el cliente en su portal…"
            />
          </div>
          <div>
            <label htmlFor="notif-panel-target" className="block text-xs font-semibold text-gray-600 mb-1.5">
              Destinatarios
            </label>
            <Select
              inputId="notif-panel-target"
              options={targetOptions}
              value={selectedTargetOption}
              onChange={(selectedOption) => setTargetType(selectedOption?.value ?? 'all')}
              styles={notifSelectStyles}
              classNamePrefix="notif-target"
              menuPortalTarget={typeof document !== 'undefined' ? document.body : null}
              menuPosition="fixed"
              isSearchable={false}
            />
          </div>
          {targetType === 'level' ? (
            <div>
              <label htmlFor="notif-panel-level" className="block text-xs font-semibold text-gray-600 mb-1.5">
                Nivel de red BaaS
              </label>
              <Select
                inputId="notif-panel-level"
                options={levelOptions}
                value={selectedLevelOption}
                onChange={(selected) => setTargetLevel(selected?.value ?? 1)}
                styles={notifSelectStyles}
                classNamePrefix="notif-target"
                menuPortalTarget={typeof document !== 'undefined' ? document.body : null}
                menuPosition="fixed"
                isSearchable={false}
              />
            </div>
          ) : null}
          {targetType === 'specific' ? (
            <div className="space-y-2">
              <label htmlFor="notif-panel-client-search" className="block text-xs font-semibold text-gray-600">
                Cliente específico
              </label>
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  id="notif-panel-client-search"
                  type="search"
                  value={clientSearch}
                  onChange={(e) => setClientSearch(e.target.value)}
                  placeholder="Buscar por nombre, email, usuario o ID…"
                  className="w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/40"
                />
              </div>
              <select
                value={targetClientId}
                onChange={(e) => setTargetClientId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-500/40"
                size={Math.min(6, Math.max(3, filteredClients.length))}
              >
                <option value="">Selecciona un cliente…</option>
                {filteredClients.map((c) => (
                  <option key={c?.id ?? clientDisplayLabel(c)} value={String(c?.id ?? '')}>
                    #{c?.id ?? '?'} · {clientDisplayLabel(c)}
                    {c?.email ? ` · ${c.email}` : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {sendError ? <p className="text-sm text-red-600 font-medium">{sendError}</p> : null}
          <div className="flex justify-end pt-1">
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Enviando…
                </>
              ) : (
                'Enviar Notificación'
              )}
            </button>
          </div>
        </form>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col min-h-[420px]">
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-800">Historial de envíos</h2>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canDelete && selectedBatchIds.length > 0 ? (
              <button
                type="button"
                onClick={() => void handleBulkDelete()}
                disabled={bulkDeleting || historyLoading}
                className="inline-flex items-center gap-1 rounded-lg border border-red-300 bg-red-600 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-red-700 disabled:opacity-50"
              >
                <Trash2 size={13} />
                {bulkDeleting
                  ? 'Eliminando…'
                  : `Eliminar seleccionados (${selectedBatchIds.length})`}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void loadHistory()}
              disabled={historyLoading || bulkDeleting}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw size={13} className={historyLoading ? 'animate-spin' : ''} />
              Actualizar
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {historyLoading ? (
            <p className="m-0 flex items-center gap-2 text-sm text-gray-500">
              <Loader2 size={16} className="animate-spin" />
              Cargando historial…
            </p>
          ) : historyErr ? (
            <p className="m-0 text-sm text-red-600">{historyErr}</p>
          ) : !Array.isArray(historialNotificaciones) || sortedHistorial.length === 0 ? (
            <p className="m-0 text-sm text-gray-500">Aún no hay envíos masivos registrados.</p>
          ) : (
            <>
            <ul className="m-0 list-none space-y-3 p-0">
              {Array.isArray(currentItems) &&
                currentItems.map((rawRow, index) => {
                  const row = normalizeHistoryRow(rawRow)
                  const batchId = row.batch_id
                  return (
                <li
                  key={batchId || `batch-row-${indexOfFirstItem + index}`}
                  className={`rounded-xl border px-4 py-3 transition ${
                    selectedBatchIds.includes(batchId)
                      ? 'border-red-300 bg-red-50/60'
                      : 'border-gray-200 bg-gray-50/60 hover:border-violet-200 hover:bg-violet-50/30'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selectedBatchIds.includes(batchId)}
                      onChange={() => toggleBatchSelection(batchId)}
                      disabled={!batchId || bulkDeleting}
                      aria-label={`Seleccionar lote ${batchId || index + 1}`}
                      className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300 text-violet-600 focus:ring-violet-500 disabled:opacity-40"
                    />
                    <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-sm font-semibold text-gray-900 truncate">
                        {row.title}
                      </p>
                      <p className="m-0 mt-1 text-xs text-gray-500 line-clamp-2">
                        {htmlToPlainPreview(row.message)}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500">
                        <span>{row.created_at ? formatSaleTableDate(row.created_at) : '—'}</span>
                        <span className="font-medium text-violet-700">
                          {row.target_label}
                        </span>
                        <span>
                          {row.read_count}/{row.total_count} leídas ·{' '}
                          <span className="text-amber-700 font-semibold">
                            {row.unread_count} pendientes
                          </span>
                        </span>
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => setEditBatch(row)}
                          disabled={!batchId}
                          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                        >
                          <Pencil size={13} />
                          Editar
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => void handleDelete(batchId)}
                          disabled={!batchId || deletingBatchId === batchId}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-40"
                        >
                          <Trash2 size={13} />
                          {deletingBatchId === batchId ? 'Eliminando…' : 'Eliminar'}
                        </button>
                      )}
                    </div>
                    </div>
                  </div>
                </li>
                  )
                })}
            </ul>
            {sortedHistorial.length > itemsPerPage ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-4">
                <p className="m-0 text-[11px] text-gray-500">
                  Mostrando {indexOfFirstItem + 1}–{Math.min(indexOfLastItem, sortedHistorial.length)} de{' '}
                  {sortedHistorial.length} envíos
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Anterior
                  </button>
                  <span className="text-xs tabular-nums text-gray-600">
                    Página {currentPage} de {totalHistoryPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCurrentPage((p) => Math.min(totalHistoryPages, p + 1))}
                    disabled={currentPage >= totalHistoryPages}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            ) : null}
            </>
          )}
        </div>
      </div>

      {editBatch ? (
        <EditBatchModal
          batch={editBatch}
          onClose={() => setEditBatch(null)}
          onSaved={async (msg) => {
            onToast?.(msg)
            await loadHistory()
          }}
        />
      ) : null}
    </div>
  )
}
