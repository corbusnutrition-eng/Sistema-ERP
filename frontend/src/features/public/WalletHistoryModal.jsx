import { useCallback, useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { portalRechargeGross } from './portalRechargeMoney'

function formatShortDate(value) {
  if (!value) return '—'
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleDateString('es-EC', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return '—'
  }
}

function formatMoney(value, currency = 'USD') {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const cur = String(currency || 'USD').trim().toUpperCase().slice(0, 10) || 'USD'
  try {
    if (cur.length === 3) {
      return new Intl.NumberFormat('es-EC', {
        style: 'currency',
        currency: cur,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n)
    }
  } catch {
    /* noop */
  }
  return `${n.toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`
}

export default function WalletHistoryModal({ open, onClose, token, api }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadHistory = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const { data } = await api.get(
        `/api/v1/portal/${encodeURIComponent(token)}/wallet-history`,
        { params: { limit: 10 } },
      )
      setItems(Array.isArray(data?.items) ? data.items : [])
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'No se pudo cargar el historial de recargas.')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [api, token])

  useEffect(() => {
    if (!open) return
    void loadHistory()
  }, [open, loadHistory])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[130] flex items-end justify-center p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Cerrar"
        className="absolute inset-0 bg-slate-950/72 backdrop-blur-sm"
        onClick={() => onClose?.()}
      />
      <div className="relative z-10 flex max-h-[88vh] w-full max-w-md flex-col rounded-t-3xl border border-violet-400/35 bg-slate-900 shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-700/50 px-5 py-4">
          <div>
            <h2 className="m-0 text-lg font-extrabold text-violet-50">Historial de recargas</h2>
            <p className="m-1 mb-0 text-xs text-slate-400">Últimas 10 solicitudes de recarga</p>
          </div>
          <button
            type="button"
            onClick={() => onClose?.()}
            className="rounded-lg p-1 text-slate-400 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {loading ? (
            <p className="m-0 flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
              <Loader2 size={18} className="animate-spin" />
              Cargando historial…
            </p>
          ) : error ? (
            <p className="m-0 rounded-xl border border-red-400/30 bg-red-950/25 px-4 py-6 text-center text-sm text-red-200">
              {error}
            </p>
          ) : items.length === 0 ? (
            <p className="m-0 rounded-xl border border-white/10 bg-black/20 px-4 py-8 text-center text-sm text-slate-400">
              Aún no tienes solicitudes de recarga registradas.
            </p>
          ) : (
            <ul className="m-0 list-none space-y-3 p-0">
              {items.map((row) => {
                const rid = Number(row?.id)
                const ref = String(row?.reference || `REC-${String(rid).padStart(5, '0')}`)
                return (
                  <li
                    key={`wallet-recharge-${rid}`}
                    className="rounded-xl border border-white/10 bg-slate-950/55 px-3.5 py-3.5"
                  >
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="m-0 text-[14px] font-bold text-violet-50">{ref}</p>
                          <span className="rounded-full border border-violet-400/30 bg-violet-950/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-200/90">
                            {String(row?.status_label || '—')}
                          </span>
                        </div>
                        <p className="m-0 mt-1 text-[11px] text-slate-500 tabular-nums">
                          {formatShortDate(row?.created_at)}
                        </p>
                      </div>
                      <p className="m-0 shrink-0 text-right text-[14px] font-bold tabular-nums text-slate-100">
                        {formatMoney(portalRechargeGross(row), row?.currency)}
                      </p>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="border-t border-slate-700/50 px-5 py-4">
          <button
            type="button"
            onClick={() => onClose?.()}
            className="w-full rounded-xl border border-slate-600 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-800"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
