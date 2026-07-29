import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react'

function formatDateTime(value) {
  if (!value) return '—'
  try {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleString('es-EC', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
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

function SummaryCard({ label, amount, currency }) {
  return (
    <div className="rounded-xl border border-emerald-400/25 bg-emerald-950/25 px-3 py-3 text-center shadow-[inset_0_1px_0_rgba(52,211,153,0.08)]">
      <p className="m-0 text-[10px] font-semibold uppercase tracking-wide text-emerald-200/75">{label}</p>
      <p className="m-0 mt-1.5 text-base font-extrabold tabular-nums text-emerald-50">
        {formatMoney(amount, currency)}
      </p>
    </div>
  )
}

export default function EarningsHistoryModal({ open, onClose, token, api }) {
  const [page, setPage] = useState(1)
  const [summaries, setSummaries] = useState(null)
  const [items, setItems] = useState([])
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadHistory = useCallback(
    async (pageNum) => {
      if (!token) return
      setLoading(true)
      setError('')
      try {
        const { data } = await api.get(
          `/api/v1/portal/${encodeURIComponent(token)}/earnings-history`,
          { params: { page: pageNum, limit: 10 } },
        )
        setSummaries(data?.summaries ?? null)
        setItems(Array.isArray(data?.items) ? data.items : [])
        setTotalPages(Math.max(1, Number(data?.total_pages) || 1))
      } catch (err) {
        const detail = err?.response?.data?.detail
        setError(typeof detail === 'string' ? detail : 'No se pudo cargar el historial de ganancias.')
        setSummaries(null)
        setItems([])
        setTotalPages(1)
      } finally {
        setLoading(false)
      }
    },
    [api, token],
  )

  useEffect(() => {
    if (!open) return
    setPage(1)
  }, [open])

  useEffect(() => {
    if (!open) return
    void loadHistory(page)
  }, [open, page, loadHistory])

  if (!open) return null

  const currency = String(summaries?.currency || 'USD')

  return (
    <div
      className="fixed inset-0 z-[130] flex items-end justify-center p-0 sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="earnings-history-title"
    >
      <button
        type="button"
        aria-label="Cerrar"
        className="absolute inset-0 bg-slate-950/72 backdrop-blur-sm"
        onClick={() => onClose?.()}
      />
      <div className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col rounded-t-3xl border border-emerald-400/30 bg-slate-900 shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-700/50 px-5 py-4">
          <div>
            <h2 id="earnings-history-title" className="m-0 text-lg font-extrabold text-emerald-50">
              Historial de Ganancias
            </h2>
            <p className="m-1 mb-0 text-xs text-slate-400">Comisiones generadas por tu red de distribuidores</p>
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
          <div className="mb-4 grid grid-cols-3 gap-2">
            <SummaryCard label="Hoy" amount={summaries?.daily ?? 0} currency={currency} />
            <SummaryCard label="7 días" amount={summaries?.weekly ?? 0} currency={currency} />
            <SummaryCard label="30 días" amount={summaries?.monthly ?? 0} currency={currency} />
          </div>

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
              Aún no tienes comisiones registradas por tu red.
            </p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-white/10">
              <table className="w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 bg-slate-950/60 text-[11px] uppercase tracking-wide text-slate-400">
                    <th className="px-3 py-2.5 font-semibold">Fecha</th>
                    <th className="px-3 py-2.5 font-semibold">Detalle</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => {
                    const rid = Number(row?.id)
                    return (
                      <tr key={`earnings-${rid}`} className="border-b border-white/5 last:border-b-0">
                        <td className="px-3 py-3 align-top text-[11px] tabular-nums text-slate-400 whitespace-nowrap">
                          {formatDateTime(row?.date)}
                        </td>
                        <td className="px-3 py-3 align-top text-[13px] leading-snug text-slate-100">
                          {String(row?.description || 'Comisión por red')}
                        </td>
                        <td className="px-3 py-3 align-top text-right text-[13px] font-bold tabular-nums text-emerald-300 whitespace-nowrap">
                          +{formatMoney(row?.amount, row?.currency || currency)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="border-t border-slate-700/50 px-5 py-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={loading || page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft size={14} aria-hidden />
              Anterior
            </button>
            <span className="text-xs tabular-nums text-slate-400">
              Página {page} de {totalPages}
            </span>
            <button
              type="button"
              disabled={loading || page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Siguiente
              <ChevronRight size={14} aria-hidden />
            </button>
          </div>
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
