import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, Loader2, X } from 'lucide-react'
import { formatDateTimeEcuador } from '../../utils/datetime'

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

function paymentStatusLabel(status) {
  const st = String(status || '').toLowerCase()
  if (st === 'approved') return 'Aprobado'
  if (st === 'rejected') return 'Rechazado'
  return 'En revisión'
}

export default function WalletHistoryModal({ open, onClose, token, api }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState(null)

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
      setExpandedId(null)
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
            <p className="m-1 mb-0 text-xs text-slate-400">Últimas 10 solicitudes y sus abonos</p>
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
                const isOpen = expandedId === rid
                const payments = Array.isArray(row?.payments) ? row.payments : []
                const ref = String(row?.reference || `REC-${String(rid).padStart(5, '0')}`)
                return (
                  <li
                    key={`wallet-recharge-${rid}`}
                    className="overflow-hidden rounded-xl border border-white/10 bg-slate-950/55"
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedId(isOpen ? null : rid)}
                      className="flex w-full items-center gap-3 px-3.5 py-3.5 text-left transition hover:bg-white/[0.03]"
                      aria-expanded={isOpen}
                    >
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
                      <div className="flex shrink-0 items-center gap-2">
                        <p className="m-0 text-right text-[14px] font-bold tabular-nums text-slate-100">
                          {formatMoney(row?.amount_requested, row?.currency)}
                        </p>
                        <ChevronDown
                          size={16}
                          className={`text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                          aria-hidden
                        />
                      </div>
                    </button>

                    {isOpen ? (
                      <div className="border-t border-white/8 bg-black/20 px-3.5 py-3">
                        {payments.length === 0 ? (
                          <p className="m-0 text-center text-[12px] text-slate-500 py-2">
                            Sin abonos registrados todavía.
                          </p>
                        ) : (
                          <ul className="m-0 list-none space-y-2 p-0">
                            {payments.map((pay, idx) => {
                              const isSuccess = Boolean(pay?.is_successful)
                              const payKey = `${rid}-pay-${pay?.id ?? idx}`
                              return (
                                <li
                                  key={payKey}
                                  className="rounded-lg border border-white/8 bg-slate-900/70 px-3 py-2.5"
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <p className="m-0 text-[11px] text-slate-500 tabular-nums">
                                        {pay?.date ? formatDateTimeEcuador(pay.date) : '—'}
                                      </p>
                                      <p className="m-0 mt-1 text-[12px] font-medium text-slate-200">
                                        {String(pay?.payment_method_name || 'Transferencia bancaria')}
                                      </p>
                                      <p className="m-0 mt-0.5 text-[10px] text-slate-500">
                                        {paymentStatusLabel(pay?.status)}
                                      </p>
                                    </div>
                                    <p
                                      className={`m-0 shrink-0 text-right text-[13px] font-bold tabular-nums ${
                                        isSuccess ? 'text-emerald-400' : 'text-slate-300'
                                      }`}
                                    >
                                      {formatMoney(pay?.amount, pay?.currency)}
                                    </p>
                                  </div>
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </div>
                    ) : null}
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
