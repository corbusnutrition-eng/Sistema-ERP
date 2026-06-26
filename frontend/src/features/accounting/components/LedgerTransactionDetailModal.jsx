import { useEffect, useState } from 'react'
import { Eye, Loader2, X } from 'lucide-react'
import api from '../../../api/axios'
import { getApiErrorMessage } from '../../../lib/apiErrors'
import { formatSaleLedgerDateParts } from '../../sales/saleTableHelpers'
import { normalizeCurrencyCode } from '../../../lib/currencyCode'

const API_ORIGIN = String(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

function receiptAbsoluteUrl(path) {
  if (path == null || path === '') return null
  const p = String(path).trim()
  if (!p) return null
  if (p.startsWith('http://') || p.startsWith('https://')) return p
  return `${API_ORIGIN}${p.startsWith('/') ? p : `/${p}`}`
}

function receiptIsPdf(urlPath) {
  if (!urlPath) return false
  return String(urlPath).toLowerCase().split('?')[0].endsWith('.pdf')
}

function formatMoney(n, currency) {
  const cur = normalizeCurrencyCode(currency ?? 'USD', 'USD')
  const num = Number(n)
  if (!Number.isFinite(num)) return '—'
  try {
    return new Intl.NumberFormat('es-EC', { style: 'currency', currency: cur }).format(num)
  } catch {
    return `${num.toFixed(2)} ${cur}`
  }
}

function formatDateTime(iso) {
  if (!iso) return '—'
  const { dateLine, timeLine } = formatSaleLedgerDateParts(iso)
  return timeLine ? `${dateLine} · ${timeLine}` : dateLine
}

function Field({ label, value, mono = false }) {
  const display = value != null && String(value).trim() !== '' ? String(value) : '—'
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className={`mt-0.5 text-sm text-gray-900 break-words ${mono ? 'font-mono' : ''}`}>{display}</dd>
    </div>
  )
}

/**
 * Detalle del movimiento contable (origen + asiento débito/crédito + comprobante).
 */
export default function LedgerTransactionDetailModal({
  open,
  accountId,
  ledgerLineId,
  accountCurrency = 'USD',
  saleLine = null,
  onClose,
  onEditSale,
}) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || !accountId || !ledgerLineId) {
      setDetail(null)
      setError('')
      return undefined
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const { data } = await api.get(
          `/api/v1/accounts/${accountId}/ledger/lines/${ledgerLineId}/detail`,
        )
        if (!cancelled) setDetail(data)
      } catch (err) {
        if (!cancelled) {
          setDetail(null)
          setError(getApiErrorMessage(err, 'No se pudo cargar el detalle de la transacción.'))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, accountId, ledgerLineId])

  if (!open) return null

  const receiptHref = detail?.receipt_url ? receiptAbsoluteUrl(detail.receipt_url) : null
  const cur = normalizeCurrencyCode(detail?.currency ?? accountCurrency, accountCurrency)

  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/45" aria-label="Cerrar" onClick={onClose} />
      <div
        className="relative w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden"
        role="dialog"
        aria-labelledby="ledger-detail-title"
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100 shrink-0">
          <div className="min-w-0">
            <h2 id="ledger-detail-title" className="text-base font-semibold text-gray-900">
              Detalles de la Transacción
            </h2>
            {detail?.origin_label ? (
              <p className="text-sm text-gray-500 mt-0.5 truncate">{detail.origin_label}</p>
            ) : null}
          </div>
          <button type="button" className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 shrink-0" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-gray-500">
              <Loader2 size={20} className="animate-spin" aria-hidden />
              Cargando detalle…
            </div>
          )}
          {!loading && error && (
            <p className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-xl px-4 py-3">{error}</p>
          )}
          {!loading && detail && (
            <>
              <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-4">
                <Field label="Referencia" value={detail.reference_number} mono />
                <Field label="Fecha" value={formatDateTime(detail.occurred_at)} />
                <Field label="Tipo" value={detail.line_kind || detail.origin_label} />
                <Field label="Cliente / beneficiario" value={detail.client_name} />
                <Field label="Usuario IPTV" value={detail.iptv_username} mono />
                <Field label="Estado" value={detail.status} />
                <Field label="Monto" value={detail.amount != null ? formatMoney(detail.amount, cur) : null} />
                <Field label="Moneda" value={cur} />
                <Field
                  label="Tasa de cambio"
                  value={detail.exchange_rate != null ? String(detail.exchange_rate) : null}
                  mono
                />
                <Field label="Método de pago" value={detail.payment_method} />
                <Field
                  label="Aprobación"
                  value={
                    detail.approved_at
                      ? formatDateTime(detail.approved_at)
                      : detail.status === 'approved'
                        ? 'Aprobado'
                        : null
                  }
                />
              </dl>

              {detail.description ? (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Descripción contable</p>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap">{detail.description}</p>
                </div>
              ) : null}

              {detail.notes ? (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Notas</p>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{detail.notes}</p>
                </div>
              ) : null}

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  Asiento contable (débito / crédito)
                </p>
                <div className="overflow-x-auto rounded-xl border border-gray-200">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs font-semibold text-gray-600 uppercase tracking-wide">
                      <tr>
                        <th className="px-3 py-2">Cuenta</th>
                        <th className="px-3 py-2 text-right">Débito</th>
                        <th className="px-3 py-2 text-right">Crédito</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {(detail.journal_lines || []).map((jl) => (
                        <tr key={`${jl.account_id}-${jl.debit}-${jl.credit}`} className="hover:bg-slate-50/80">
                          <td className="px-3 py-2 text-gray-900">
                            <span className="font-medium">{jl.account_name}</span>
                            {jl.account_code ? (
                              <span className="ml-2 text-xs font-mono text-gray-400">{jl.account_code}</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-emerald-700">
                            {Number(jl.debit) > 0 ? formatMoney(jl.debit, jl.currency || cur) : '—'}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-rose-700">
                            {Number(jl.credit) > 0 ? formatMoney(jl.credit, jl.currency || cur) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {(Number(detail.debit) > 0 || Number(detail.credit) > 0) && (
                      <tfoot className="bg-slate-50/80 text-xs text-gray-600">
                        <tr>
                          <td className="px-3 py-2 font-medium">En esta cuenta</td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-emerald-700">
                            {Number(detail.debit) > 0 ? formatMoney(detail.debit, cur) : '—'}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium text-rose-700">
                            {Number(detail.credit) > 0 ? formatMoney(detail.credit, cur) : '—'}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>

              {receiptHref ? (
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <a
                    href={receiptHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl
                               bg-slate-100 text-slate-800 hover:bg-slate-200 ring-1 ring-slate-200 transition-colors"
                  >
                    <Eye size={16} aria-hidden />
                    {receiptIsPdf(detail.receipt_url) ? 'Ver comprobante PDF' : 'Ver comprobante'}
                  </a>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-4 border-t border-gray-100 shrink-0 bg-gray-50/80">
          {detail?.sale_id && saleLine && onEditSale ? (
            <button
              type="button"
              onClick={() => {
                onClose?.()
                onEditSale(saleLine)
              }}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 ring-1 ring-blue-100"
            >
              Editar venta en línea
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-300 text-gray-700 hover:bg-white"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
