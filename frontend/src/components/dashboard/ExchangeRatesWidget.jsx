import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  Trash2,
} from 'lucide-react'
import api from '../../api/axios'
import SearchableSelect from '../ui/SearchableSelect'
import { WORLD_CURRENCIES, buildCurrencySelectOptions } from '../../data/worldCurrencies'
import { useAuth } from '../../context/AuthContext'

const DEFAULT_ROWS_PER_PAGE = 5
const ROWS_PER_PAGE_ALL = 'all'
const DRAG_MIME = 'application/x-exchange-rate-code'

function reorderWithSequentialOrder(list, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= list.length || toIndex >= list.length) {
    return list
  }
  const next = [...list]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next.map((row, idx) => ({ ...row, display_order: idx }))
}

function buildReorderPayload(list) {
  return list.map((row, idx) => ({
    currency_code: row.currency_code,
    display_order: idx,
  }))
}

function formatRate(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n.toLocaleString('es-EC', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
}

function formatPersonalRate(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '-'
  return formatRate(n)
}

function formatUpdatedAt(value) {
  if (!value) return 'Sin datos'
  try {
    return new Date(value).toLocaleString('es-EC', {
      dateStyle: 'short',
      timeStyle: 'short',
    })
  } catch {
    return '—'
  }
}

function computeToleranceBreach(row) {
  if (!row?.use_manual_override) return null

  const toleranceType = String(row?.tolerance_type ?? '').trim().toLowerCase()
  const toleranceLimit = Number(row?.tolerance_value)
  if (!toleranceType || !Number.isFinite(toleranceLimit) || toleranceLimit <= 0) return null

  const official = Number(row?.binance_rate)
  const manual = Number(row?.manual_rate)
  if (!Number.isFinite(official) || official <= 0 || !Number.isFinite(manual) || manual <= 0) {
    return null
  }

  let diff
  let message
  if (toleranceType === 'value') {
    diff = Math.abs(official - manual)
    if (diff <= toleranceLimit) return null
    message =
      `Brecha absoluta de ${formatRate(diff)} supera el límite de ${formatRate(toleranceLimit)}. ` +
      `Tasa oficial: ${formatRate(official)} | Tasa manual: ${formatRate(manual)}.`
  } else if (toleranceType === 'percentage') {
    diff = Math.abs((official - manual) / manual) * 100
    if (diff <= toleranceLimit) return null
    message =
      `Variación del ${diff.toFixed(2)}% supera el límite del ${toleranceLimit.toFixed(2)}%. ` +
      `Tasa oficial: ${formatRate(official)} | Tasa manual: ${formatRate(manual)}.`
  } else {
    return null
  }

  return { diff, message, toleranceType }
}

function ToleranceAlertIcon({ tooltip }) {
  return (
    <span
      className="ml-1 inline-flex animate-pulse cursor-help text-base leading-none text-red-500"
      title={tooltip}
      aria-label={tooltip}
    >
      ⚠️
    </span>
  )
}

function ToleranceRulesModal({ open, row, saving, onClose, onSave }) {
  const [ruleType, setRuleType] = useState('none')
  const [ruleValue, setRuleValue] = useState('')

  useEffect(() => {
    if (!open || !row) return
    const type = String(row.tolerance_type ?? '').trim().toLowerCase()
    if (type === 'value' || type === 'percentage') {
      setRuleType(type)
      setRuleValue(
        row.tolerance_value != null && Number(row.tolerance_value) > 0
          ? String(row.tolerance_value)
          : '',
      )
    } else {
      setRuleType('none')
      setRuleValue('')
    }
  }, [open, row])

  if (!open || !row) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-5 shadow-xl">
        <h3 className="notranslate m-0 text-lg font-bold text-gray-900" translate="no">
          Reglas de tolerancia — {row.currency_code}
        </h3>
        <p className="m-0 mt-1 text-sm text-gray-500">
          Alerta cuando la tasa oficial se aleje de tu tasa manual en uso.
        </p>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            Tipo de regla
          </span>
          <select
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring-2"
          >
            <option value="none">Ninguna</option>
            <option value="value">Valor Absoluto</option>
            <option value="percentage">Porcentaje (%)</option>
          </select>
        </label>

        {ruleType !== 'none' ? (
          <label className="mt-4 block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
              {ruleType === 'percentage' ? 'Límite (%)' : 'Límite (valor absoluto)'}
            </span>
            <input
              type="number"
              min="0"
              step={ruleType === 'percentage' ? '0.01' : '0.0001'}
              value={ruleValue}
              onChange={(e) => setRuleValue(e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring-2"
              placeholder={ruleType === 'percentage' ? 'Ej. 2.5' : 'Ej. 0.50'}
            />
          </label>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              if (ruleType === 'none') {
                onSave({ tolerance_type: null, tolerance_value: null })
                return
              }
              const parsed = Number(ruleValue)
              if (!Number.isFinite(parsed) || parsed <= 0) {
                window.alert('Ingresa un valor de tolerancia válido.')
                return
              }
              onSave({
                tolerance_type: ruleType,
                tolerance_value: parsed,
              })
            }}
            className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EditRateModal({ open, row, saving, onClose, onSave }) {
  const [manualRate, setManualRate] = useState('')

  useEffect(() => {
    if (!open || !row) return
    setManualRate(
      row.manual_rate != null && Number(row.manual_rate) > 0 ? String(row.manual_rate) : '',
    )
  }, [open, row])

  if (!open || !row) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-5 shadow-xl">
        <h3 className="notranslate m-0 text-lg font-bold text-gray-900" translate="no">
          Tasa manual — {row.currency_code}
        </h3>
        <p className="m-0 mt-1 text-sm text-gray-500">
          Unidades de moneda local por 1 USD.
        </p>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            Tasa manual
          </span>
          <input
            type="number"
            min="0"
            step="0.0001"
            value={manualRate}
            onChange={(e) => setManualRate(e.target.value)}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 outline-none ring-blue-500 focus:ring-2"
            placeholder="Ej. 6.95"
          />
        </label>

        {row.binance_rate != null ? (
          <p className="m-0 mt-3 text-xs text-gray-400">
            Tasa mercado actual: {formatRate(row.binance_rate)}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              const parsed = Number(manualRate)
              if (!Number.isFinite(parsed) || parsed <= 0) {
                window.alert('Ingresa una tasa manual válida.')
                return
              }
              onSave({ manual_rate: parsed })
            }}
            className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AddCurrencyModal({ open, saving, options, onClose, onSave }) {
  const [selectedCode, setSelectedCode] = useState('')

  useEffect(() => {
    if (open) setSelectedCode('')
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-5 shadow-xl">
        <h3 className="m-0 text-lg font-bold text-gray-900">Agregar moneda</h3>
        <p className="m-0 mt-1 text-sm text-gray-500">
          Monedas de Latinoamérica. Busca por país, código ISO o nombre.
        </p>
        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            Moneda
          </span>
          <SearchableSelect
            value={selectedCode}
            onChange={setSelectedCode}
            options={options}
            placeholder="Buscar moneda…"
            hideClear
            showSearch
            dropdownZClass="z-[6000]"
          />
        </label>
        {options.length === 0 ? (
          <p className="m-0 mt-3 text-xs text-amber-700">
            Todas las monedas LATAM del catálogo ya están en la lista activa.
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving || !selectedCode}
            onClick={() => onSave(selectedCode)}
            className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DeleteCurrencyModal({ open, row, saving, onClose, onConfirm }) {
  const [masterPin, setMasterPin] = useState('')
  const [pinError, setPinError] = useState('')

  useEffect(() => {
    if (!open) return
    setMasterPin('')
    setPinError('')
  }, [open, row])

  if (!open || !row) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-red-100 bg-white p-5 shadow-xl">
        <h3 className="notranslate m-0 text-lg font-bold text-red-700" translate="no">
          Eliminar moneda — {row.currency_code}
        </h3>
        <p className="m-0 mt-3 text-sm font-medium text-gray-800">
          ¿Estás absolutamente seguro de que deseas eliminar la moneda{' '}
          <span className="font-bold">{row.currency_code}</span>?
        </p>
        <p className="m-0 mt-2 text-xs text-gray-500">
          La moneda dejará de mostrarse en el panel. Esta acción requiere PIN Maestro.
        </p>

        <label className="mt-4 block">
          <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">
            PIN Maestro
          </span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={masterPin}
            onChange={(e) => {
              setMasterPin(e.target.value)
              if (pinError) setPinError('')
            }}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 outline-none ring-red-500 focus:ring-2"
            placeholder="Ingresa el PIN Maestro"
          />
        </label>

        {pinError ? <p className="m-0 mt-2 text-sm text-red-600">{pinError}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving || !masterPin.trim()}
            onClick={() => {
              const pin = masterPin.trim()
              if (!pin) {
                setPinError('Ingresa el PIN Maestro.')
                return
              }
              onConfirm(pin, setPinError)
            }}
            className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            {saving ? 'Eliminando…' : 'Eliminar moneda'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ExchangeRatesWidget() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [draggingCode, setDraggingCode] = useState(null)
  const [dragOverCode, setDragOverCode] = useState(null)
  const dragSourceIndexRef = useRef(null)
  const [error, setError] = useState('')
  const [syncMessage, setSyncMessage] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [rowsPerPage, setRowsPerPage] = useState(DEFAULT_ROWS_PER_PAGE)
  const [editingRow, setEditingRow] = useState(null)
  const [toleranceRow, setToleranceRow] = useState(null)
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [addingCurrency, setAddingCurrency] = useState(false)
  const [deletingRow, setDeletingRow] = useState(null)
  const [deletingCurrency, setDeletingCurrency] = useState(false)

  const loadRates = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data } = await api.get('/api/v1/exchange-rates')
      setItems(Array.isArray(data?.items) ? data.items : [])
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'No se pudieron cargar las tasas.')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRates()
  }, [loadRates])

  useEffect(() => {
    setPage(1)
  }, [search, rowsPerPage])

  const sortByDisplayOrder = useCallback((list) => {
    return [...list].sort((a, b) => {
      const oa = Number(a.display_order ?? 0)
      const ob = Number(b.display_order ?? 0)
      if (oa !== ob) return oa - ob
      return String(a.currency_code).localeCompare(String(b.currency_code))
    })
  }, [])

  const sortedItems = useMemo(() => sortByDisplayOrder(items), [items, sortByDisplayOrder])

  const availableLatamCurrencies = useMemo(
    () =>
      WORLD_CURRENCIES.filter(
        (currency) =>
          !items.some(
            (rate) => String(rate.currency_code ?? '').toUpperCase() === currency.code,
          ),
      ),
    [items],
  )

  const addCurrencyOptions = useMemo(
    () => buildCurrencySelectOptions(availableLatamCurrencies),
    [availableLatamCurrencies],
  )

  const filteredItems = useMemo(() => {
    const q = search.trim().toUpperCase()
    if (!q) return sortedItems
    return sortedItems.filter((row) => String(row?.currency_code ?? '').toUpperCase().includes(q))
  }, [sortedItems, search])

  const pageSize = useMemo(() => {
    if (rowsPerPage === ROWS_PER_PAGE_ALL) {
      return Math.max(filteredItems.length, 1)
    }
    return rowsPerPage
  }, [rowsPerPage, filteredItems.length])

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredItems.length / pageSize)),
    [filteredItems.length, pageSize],
  )

  const showPageControls = rowsPerPage !== ROWS_PER_PAGE_ALL && totalPages > 1

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  const paginatedItems = useMemo(() => {
    const start = (page - 1) * pageSize
    return filteredItems.slice(start, start + pageSize)
  }, [filteredItems, page, pageSize])

  const mergeRowUpdate = useCallback(
    (updated) => {
      setItems((prev) => {
        const next = prev.map((row) =>
          row.currency_code === updated.currency_code ? updated : row,
        )
        return sortByDisplayOrder(next)
      })
    },
    [sortByDisplayOrder],
  )

  const patchRow = useCallback(
    async (currencyCode, payload, { silent = false } = {}) => {
      if (!isAdmin) return null
      if (!silent) setSaving(true)
      setError('')
      try {
        const { data } = await api.put(
          `/api/v1/exchange-rates/${encodeURIComponent(currencyCode)}`,
          payload,
        )
        mergeRowUpdate(data)
        return data
      } catch (err) {
        const detail = err?.response?.data?.detail
        setError(typeof detail === 'string' ? detail : 'No se pudo actualizar la tasa.')
        return null
      } finally {
        if (!silent) setSaving(false)
      }
    },
    [isAdmin, mergeRowUpdate],
  )

  const persistReorder = useCallback(
    async (payload) => {
      await api.post('/api/v1/exchange-rates/reorder', { items: payload })
    },
    [],
  )

  const canDragReorder = isAdmin && !search.trim() && !reordering

  const applyGlobalReorder = useCallback(
    async (fromIndex, toIndex) => {
      if (!isAdmin || reordering || fromIndex === toIndex) return
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= sortedItems.length ||
        toIndex >= sortedItems.length
      ) {
        return
      }

      const reordered = reorderWithSequentialOrder(sortedItems, fromIndex, toIndex)
      const reorderPayload = buildReorderPayload(reordered)
      const previousItems = items

      setReordering(true)
      setItems(reordered)

      try {
        await persistReorder(reorderPayload)
      } catch (err) {
        setItems(previousItems)
        const detail = err?.response?.data?.detail
        setError(typeof detail === 'string' ? detail : 'No se pudo reordenar las monedas.')
      } finally {
        setReordering(false)
      }
    },
    [isAdmin, items, persistReorder, reordering, sortedItems],
  )

  const handleDragStart = useCallback(
    (event, globalIndex, currencyCode) => {
      if (!canDragReorder) {
        event.preventDefault()
        return
      }
      if (event.target.closest('button, input, a, label, select, textarea')) {
        event.preventDefault()
        return
      }
      dragSourceIndexRef.current = globalIndex
      setDraggingCode(currencyCode)
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(DRAG_MIME, currencyCode)
      event.dataTransfer.setData('text/plain', currencyCode)
    },
    [canDragReorder],
  )

  const handleDragOver = useCallback(
    (event, currencyCode) => {
      if (!canDragReorder || dragSourceIndexRef.current == null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setDragOverCode(currencyCode)
    },
    [canDragReorder],
  )

  const handleDrop = useCallback(
    (event, toGlobalIndex) => {
      event.preventDefault()
      const fromGlobalIndex = dragSourceIndexRef.current
      dragSourceIndexRef.current = null
      setDraggingCode(null)
      setDragOverCode(null)
      if (fromGlobalIndex == null) return
      void applyGlobalReorder(fromGlobalIndex, toGlobalIndex)
    },
    [applyGlobalReorder],
  )

  const handleDragEnd = useCallback(() => {
    dragSourceIndexRef.current = null
    setDraggingCode(null)
    setDragOverCode(null)
  }, [])

  const handleSync = async () => {
    if (!isAdmin || syncing) return
    setSyncing(true)
    setSyncMessage('')
    setError('')
    try {
      const { data } = await api.post('/api/v1/exchange-rates/sync')
      setSyncMessage(data?.message || 'Sincronización completada.')
      await loadRates()
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'No se pudo sincronizar las tasas de mercado.')
    } finally {
      setSyncing(false)
    }
  }

  const handleAddCurrency = async (currencyCode) => {
    if (!isAdmin || addingCurrency) return
    setAddingCurrency(true)
    setError('')
    try {
      await api.post('/api/v1/exchange-rates', { currency_code: currencyCode })
      setAddModalOpen(false)
      setSyncMessage(`Moneda ${currencyCode} agregada correctamente.`)
      await loadRates()
    } catch (err) {
      const d = err?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'No se pudo agregar la moneda.')
    } finally {
      setAddingCurrency(false)
    }
  }

  const handleDeleteCurrency = async (masterPin, setPinError) => {
    if (!isAdmin || !deletingRow || deletingCurrency) return
    setDeletingCurrency(true)
    setError('')
    try {
      await api.delete(`/api/v1/exchange-rates/${encodeURIComponent(deletingRow.currency_code)}`, {
        data: { master_pin: masterPin },
      })
      setDeletingRow(null)
      setSyncMessage(`Moneda ${deletingRow.currency_code} eliminada correctamente.`)
      await loadRates()
    } catch (err) {
      const status = err?.response?.status
      const detail = err?.response?.data?.detail
      if (status === 403) {
        setPinError(typeof detail === 'string' ? detail : 'PIN Maestro incorrecto.')
        return
      }
      setError(typeof detail === 'string' ? detail : 'No se pudo eliminar la moneda.')
    } finally {
      setDeletingCurrency(false)
    }
  }

  const handleSaveEdit = async (payload) => {
    if (!editingRow || saving) return
    const updated = await patchRow(editingRow.currency_code, payload)
    if (updated) setEditingRow(null)
  }

  const handleSaveTolerance = async (payload) => {
    if (!toleranceRow || saving) return
    const updated = await patchRow(toleranceRow.currency_code, payload)
    if (updated) setToleranceRow(null)
  }

  const handleActiveSourceChange = async (row, useManual) => {
    if (!isAdmin) return
    if (useManual) {
      if (!row.manual_rate || Number(row.manual_rate) <= 0) {
        setEditingRow(row)
        return
      }
      await patchRow(row.currency_code, { use_manual_override: true }, { silent: true })
      return
    }
    await patchRow(row.currency_code, { use_manual_override: false }, { silent: true })
  }

  const adminColSpan = 5
  const userColSpan = 4

  return (
    <div className="notranslate rounded-2xl border border-gray-100 bg-white shadow-sm" translate="no">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
        <div>
          <h2 className="m-0 text-lg font-bold text-gray-900">Tipos de Cambio (Mercado USD)</h2>
          <p className="m-0 mt-0.5 text-sm text-gray-500">
            Referencia Mercado Internacional (Open Exchange) · actualización automática cada hora
          </p>
        </div>
        {isAdmin ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setAddModalOpen(true)}
              disabled={loading || addingCurrency}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              + Agregar Moneda
            </button>
            <button
              type="button"
              onClick={() => void handleSync()}
              disabled={syncing || loading || addingCurrency}
              className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50"
            >
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Sincronizando…' : 'Sincronizar ahora'}
            </button>
          </div>
        ) : null}
      </div>

      <div className="space-y-3 px-5 py-4">
        <div className="relative max-w-xs">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar moneda (ej. BOB)"
            className="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm text-gray-900 outline-none ring-blue-500 focus:ring-2"
          />
        </div>

        {error ? (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertCircle size={16} className="shrink-0" />
            {error}
          </div>
        ) : null}

        {syncMessage ? <p className="m-0 text-sm text-emerald-700">{syncMessage}</p> : null}

        {isAdmin && search.trim() ? (
          <p className="m-0 text-xs text-amber-700">
            Limpia la búsqueda para reordenar monedas arrastrando filas.
          </p>
        ) : null}

        <div className="overflow-x-auto notranslate" translate="no">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="notranslate px-2 py-2 font-semibold" translate="no">
                  Moneda
                </th>
                <th className="px-2 py-2 font-semibold">Tasa Mercado</th>
                <th className="px-2 py-2 font-semibold">Tasa Manual</th>
                <th className="px-2 py-2 font-semibold">Tasa Activa</th>
                {isAdmin ? (
                  <th className="px-2 py-2 text-right font-semibold">Acción</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={isAdmin ? adminColSpan : userColSpan}
                    className="px-2 py-6 text-center text-gray-400"
                  >
                    Cargando tasas…
                  </td>
                </tr>
              ) : paginatedItems.length === 0 ? (
                <tr>
                  <td
                    colSpan={isAdmin ? adminColSpan : userColSpan}
                    className="px-2 py-6 text-center text-gray-400"
                  >
                    No hay monedas que coincidan con la búsqueda.
                  </td>
                </tr>
              ) : (
                paginatedItems.map((row) => {
                  const globalIdx = sortedItems.findIndex(
                    (r) => r.currency_code === row.currency_code,
                  )
                  const toleranceBreach = computeToleranceBreach(row)
                  const isDragging = draggingCode === row.currency_code
                  const isDropTarget =
                    dragOverCode === row.currency_code && draggingCode !== row.currency_code
                  return (
                    <tr
                      key={row.currency_code}
                      draggable={canDragReorder}
                      onDragStart={(event) => handleDragStart(event, globalIdx, row.currency_code)}
                      onDragOver={(event) => handleDragOver(event, row.currency_code)}
                      onDragLeave={() => {
                        if (dragOverCode === row.currency_code) setDragOverCode(null)
                      }}
                      onDrop={(event) => handleDrop(event, globalIdx)}
                      onDragEnd={handleDragEnd}
                      className={`border-b border-gray-50 last:border-0 transition-colors ${
                        isDragging
                          ? 'bg-blue-50 opacity-50'
                          : isDropTarget
                            ? 'bg-blue-100/70 ring-2 ring-inset ring-blue-300'
                            : canDragReorder
                              ? 'hover:bg-gray-50/80'
                              : ''
                      }`}
                    >
                      <td className="notranslate px-2 py-3" translate="no">
                        <div className="flex items-center gap-1.5">
                          {isAdmin ? (
                            <span
                              data-drag-handle
                              title={
                                search.trim()
                                  ? 'Limpia la búsqueda para reordenar'
                                  : 'Arrastrar para reordenar'
                              }
                              className={`inline-flex touch-none select-none rounded p-0.5 ${
                                canDragReorder
                                  ? 'cursor-grab text-gray-400 active:cursor-grabbing hover:bg-gray-100 hover:text-gray-700'
                                  : 'cursor-not-allowed text-gray-300'
                              }`}
                              aria-hidden="true"
                            >
                              <GripVertical size={16} />
                            </span>
                          ) : null}
                          <span className="font-semibold text-gray-900">{row.currency_code}</span>
                        </div>
                      </td>
                      <td className="px-2 py-3 text-gray-700">
                        <div>{formatRate(row.binance_rate)}</div>
                        <div className="text-[11px] text-gray-400">
                          {formatUpdatedAt(row.updated_at)}
                        </div>
                      </td>
                      <td className="px-2 py-3 tabular-nums text-gray-800">
                        <span className="inline-flex items-center">
                          {formatPersonalRate(row.manual_rate)}
                          {toleranceBreach ? (
                            <ToleranceAlertIcon tooltip={toleranceBreach.message} />
                          ) : null}
                        </span>
                      </td>
                      <td className="px-2 py-3">
                        <div className="flex flex-col gap-1.5">
                          {isAdmin ? (
                            <div className="inline-flex w-fit overflow-hidden rounded-lg border border-gray-200 text-[11px] font-semibold">
                              <button
                                type="button"
                                disabled={saving || reordering}
                                onClick={() => void handleActiveSourceChange(row, false)}
                                className={`px-2.5 py-1 transition ${
                                  !row.use_manual_override
                                    ? 'bg-emerald-600 text-white'
                                    : 'bg-white text-gray-600 hover:bg-gray-50'
                                }`}
                              >
                                Mercado
                              </button>
                              <button
                                type="button"
                                disabled={saving || reordering}
                                onClick={() => void handleActiveSourceChange(row, true)}
                                className={`px-2.5 py-1 transition ${
                                  row.use_manual_override
                                    ? 'bg-amber-500 text-white'
                                    : 'bg-white text-gray-600 hover:bg-gray-50'
                                }`}
                              >
                                Manual
                              </button>
                            </div>
                          ) : (
                            <span className="text-xs text-gray-500">
                              {row.use_manual_override ? 'Manual' : 'Mercado'}
                            </span>
                          )}
                          <span
                            className={`inline-flex w-fit items-center rounded-full px-2.5 py-1 text-sm font-bold tabular-nums ${
                              row.use_manual_override
                                ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                                : 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                            }`}
                          >
                            {formatRate(row.active_rate)}
                            {toleranceBreach ? (
                              <ToleranceAlertIcon tooltip={toleranceBreach.message} />
                            ) : null}
                          </span>
                        </div>
                      </td>
                      {isAdmin ? (
                        <td className="px-2 py-3 text-right">
                          <div className="inline-flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => setToleranceRow(row)}
                              disabled={saving || reordering || deletingCurrency}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                              aria-label={`Reglas de tolerancia ${row.currency_code}`}
                            >
                              <Settings size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingRow(row)}
                              disabled={saving || reordering || deletingCurrency}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                              aria-label={`Editar tasa manual ${row.currency_code}`}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeletingRow(row)}
                              disabled={saving || reordering || deletingCurrency}
                              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
                              aria-label={`Eliminar moneda ${row.currency_code}`}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {!loading && filteredItems.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-3">
            <div className="flex flex-wrap items-center gap-3">
              <p className="m-0 text-xs text-gray-500">
                {filteredItems.length} moneda{filteredItems.length !== 1 ? 's' : ''}
                {search.trim() ? ' encontrada(s)' : ''}
                {rowsPerPage === ROWS_PER_PAGE_ALL
                  ? ' · Todas visibles'
                  : ` · Página ${page} de ${totalPages}`}
              </p>
              <label className="inline-flex items-center gap-1.5 text-xs text-gray-500">
                <span className="font-medium">Filas:</span>
                <select
                  value={rowsPerPage === ROWS_PER_PAGE_ALL ? ROWS_PER_PAGE_ALL : String(rowsPerPage)}
                  onChange={(e) => {
                    const value = e.target.value
                    setRowsPerPage(value === ROWS_PER_PAGE_ALL ? ROWS_PER_PAGE_ALL : Number(value))
                  }}
                  className="rounded-md border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 outline-none ring-blue-500 focus:ring-2"
                  aria-label="Filas por página"
                >
                  <option value="5">5</option>
                  <option value="10">10</option>
                  <option value={ROWS_PER_PAGE_ALL}>Todas</option>
                </select>
              </label>
            </div>
            {showPageControls ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1 || loading}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                >
                  <ChevronLeft size={14} />
                  Anterior
                </button>
                <span className="min-w-[4.5rem] text-center text-xs font-medium text-gray-500">
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages || loading}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                >
                  Siguiente
                  <ChevronRight size={14} />
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <AddCurrencyModal
        open={addModalOpen}
        saving={addingCurrency}
        options={addCurrencyOptions}
        onClose={() => {
          if (!addingCurrency) setAddModalOpen(false)
        }}
        onSave={(code) => void handleAddCurrency(code)}
      />

      <DeleteCurrencyModal
        open={Boolean(deletingRow)}
        row={deletingRow}
        saving={deletingCurrency}
        onClose={() => {
          if (!deletingCurrency) setDeletingRow(null)
        }}
        onConfirm={(pin, setPinError) => void handleDeleteCurrency(pin, setPinError)}
      />

      <EditRateModal
        open={Boolean(editingRow)}
        row={editingRow}
        saving={saving}
        onClose={() => {
          if (!saving) setEditingRow(null)
        }}
        onSave={handleSaveEdit}
      />

      <ToleranceRulesModal
        open={Boolean(toleranceRow)}
        row={toleranceRow}
        saving={saving}
        onClose={() => {
          if (!saving) setToleranceRow(null)
        }}
        onSave={handleSaveTolerance}
      />
    </div>
  )
}
