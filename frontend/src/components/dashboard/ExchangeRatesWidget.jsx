import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Pencil, RefreshCw, Search } from 'lucide-react'
import api from '../../api/axios'
import { useAuth } from '../../context/AuthContext'

function formatRate(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n.toLocaleString('es-EC', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
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

function EditRateModal({ open, row, saving, onClose, onSave }) {
  const [manualRate, setManualRate] = useState('')
  const [useManual, setUseManual] = useState(false)

  useEffect(() => {
    if (!open || !row) return
    setManualRate(
      row.manual_rate != null && Number(row.manual_rate) > 0
        ? String(row.manual_rate)
        : row.active_rate != null
          ? String(row.active_rate)
          : '',
    )
    setUseManual(Boolean(row.use_manual_override))
  }, [open, row])

  if (!open || !row) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-5 shadow-xl">
        <h3 className="notranslate m-0 text-lg font-bold text-gray-900" translate="no">
          Editar tasa — {row.currency_code}
        </h3>
        <p className="m-0 mt-1 text-sm text-gray-500">
          Unidades de moneda local por 1 USDT (referencia Binance P2P).
        </p>

        <div className="mt-4 space-y-4">
          <label className="block">
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

          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={useManual}
              onChange={(e) => setUseManual(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            Usar tasa manual (ignorar Binance)
          </label>

          {row.binance_rate != null ? (
            <p className="m-0 text-xs text-gray-400">
              Binance actual: {formatRate(row.binance_rate)} · actualizado{' '}
              {formatUpdatedAt(row.updated_at)}
            </p>
          ) : null}
        </div>

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
              onSave({
                manual_rate: parsed,
                use_manual_override: useManual,
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

export default function ExchangeRatesWidget() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [syncMessage, setSyncMessage] = useState('')
  const [search, setSearch] = useState('')
  const [editingRow, setEditingRow] = useState(null)

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

  const filteredItems = useMemo(() => {
    const q = search.trim().toUpperCase()
    if (!q) return items
    return items.filter((row) => String(row?.currency_code ?? '').toUpperCase().includes(q))
  }, [items, search])

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
      setError(typeof detail === 'string' ? detail : 'No se pudo sincronizar con Binance.')
    } finally {
      setSyncing(false)
    }
  }

  const handleSaveEdit = async (payload) => {
    if (!editingRow || saving) return
    setSaving(true)
    setError('')
    try {
      const { data } = await api.put(
        `/api/v1/exchange-rates/${encodeURIComponent(editingRow.currency_code)}`,
        payload,
      )
      setItems((prev) =>
        prev.map((row) => (row.currency_code === data.currency_code ? data : row)),
      )
      setEditingRow(null)
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'No se pudo guardar la tasa.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="notranslate rounded-2xl border border-gray-100 bg-white shadow-sm" translate="no">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
        <div>
          <h2 className="m-0 text-lg font-bold text-gray-900">Tipos de Cambio P2P (USDT)</h2>
          <p className="m-0 mt-0.5 text-sm text-gray-500">
            Referencia Binance P2P · actualización automática cada hora
          </p>
        </div>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => void handleSync()}
            disabled={syncing || loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Sincronizando…' : 'Sincronizar ahora'}
          </button>
        ) : null}
      </div>

      <div className="space-y-3 px-5 py-4">
        <div className="relative max-w-xs">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
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

        {syncMessage ? (
          <p className="m-0 text-sm text-emerald-700">{syncMessage}</p>
        ) : null}

        <div className="overflow-x-auto notranslate" translate="no">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="notranslate px-2 py-2 font-semibold" translate="no">
                  Moneda
                </th>
                <th className="px-2 py-2 font-semibold">Tasa Binance</th>
                <th className="px-2 py-2 font-semibold">Tasa activa</th>
                {isAdmin ? <th className="px-2 py-2 font-semibold text-right">Acción</th> : null}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={isAdmin ? 4 : 3} className="px-2 py-6 text-center text-gray-400">
                    Cargando tasas…
                  </td>
                </tr>
              ) : filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 4 : 3} className="px-2 py-6 text-center text-gray-400">
                    No hay monedas que coincidan con la búsqueda.
                  </td>
                </tr>
              ) : (
                filteredItems.map((row) => (
                  <tr key={row.currency_code} className="border-b border-gray-50 last:border-0">
                    <td
                      className="notranslate px-2 py-3 font-semibold text-gray-900"
                      translate="no"
                    >
                      {row.currency_code}
                    </td>
                    <td className="px-2 py-3 text-gray-700">
                      <div>{formatRate(row.binance_rate)}</div>
                      <div className="text-[11px] text-gray-400">{formatUpdatedAt(row.updated_at)}</div>
                    </td>
                    <td className="px-2 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-sm font-bold tabular-nums ${
                          row.use_manual_override
                            ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                            : 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                        }`}
                      >
                        {formatRate(row.active_rate)}
                      </span>
                      {row.use_manual_override ? (
                        <div className="mt-1 text-[11px] text-amber-600">Manual</div>
                      ) : null}
                    </td>
                    {isAdmin ? (
                      <td className="px-2 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setEditingRow(row)}
                          className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                        >
                          <Pencil size={12} />
                          Editar
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <EditRateModal
        open={Boolean(editingRow)}
        row={editingRow}
        saving={saving}
        onClose={() => {
          if (!saving) setEditingRow(null)
        }}
        onSave={handleSaveEdit}
      />
    </div>
  )
}
