import { useCallback, useEffect, useMemo, useState } from 'react'
import { X, Paperclip } from 'lucide-react'
import api from '../../../api/axios'
import { currencyCodeFromAccountId } from '../../../lib/accountCurrencyCascade'
import { normalizeCurrencyCode } from '../../../lib/currencyCode'
import { formatDateEcuador } from '../../../utils/datetime'
import {
  isPortalSaldoCrossSinComprobante,
  parsePortalCreditAppliedAmount,
} from '../portalCreditMeta'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

function receiptFullUrl(path) {
  if (!path) return null
  const p = String(path).trim()
  if (!p) return null
  if (p.startsWith('http://') || p.startsWith('https://')) return p
  return `${API_BASE}${p.startsWith('/') ? p : `/${p}`}`
}

function formatMoneyDisplay(amount, currency) {
  const cur = normalizeCurrencyCode(currency || 'USD', 'USD')
  const n = Number(amount)
  const safe = Number.isFinite(n) ? n : 0
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safe)
  } catch {
    return `${safe.toFixed(2)} ${cur}`
  }
}

const labelCls = 'text-[11px] font-semibold uppercase tracking-wide text-gray-500'

/**
 * Visor de solo lectura de un cobro aprobado (historial CxC).
 * z-index superior al modal principal «Recibir pago».
 */
export default function ViewPaymentModal({ paymentId, depositAccounts = [], onClose }) {
  const [loading, setLoading] = useState(true)
  const [payment, setPayment] = useState(null)
  const [error, setError] = useState(null)

  const loadPayment = useCallback(async () => {
    if (!paymentId) return
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get(`/api/v1/payments/${paymentId}`)
      setPayment(data)
    } catch (err) {
      console.error(
        '[ViewPaymentModal] GET /api/v1/payments/{id} failed:',
        err?.response?.status,
        err?.response?.data ?? err?.message ?? err,
      )
      setError('No se pudo cargar el detalle del pago.')
      setPayment(null)
    } finally {
      setLoading(false)
    }
  }, [paymentId])

  useEffect(() => {
    void loadPayment()
  }, [loadPayment])

  const currency = normalizeCurrencyCode(payment?.currency || 'USD', 'USD')
  const depositLabel = useMemo(() => {
    if (!payment?.deposit_account_id) return '—'
    const acc = depositAccounts.find((a) => String(a.id) === String(payment.deposit_account_id))
    if (acc) {
      const cur = normalizeCurrencyCode(acc.currency || currency, currency)
      return `${acc.name}${acc.account_number ? ` · ${acc.account_number}` : ''} (${cur})`
    }
    return acc
      ? `${acc.name}${acc.account_number ? ` · ${acc.account_number}` : ''} (${cur})`
      : `Cuenta #${payment.deposit_account_id}`
  }, [payment?.deposit_account_id, depositAccounts, currency])

  const receiptUrl = receiptFullUrl(payment?.receipt_file_url)
  const isSaldoCross = isPortalSaldoCrossSinComprobante({
    receiptFileUrlOrPath: payment?.receipt_file_url,
    notes: payment?.notes,
  })
  const portalSaldoApplied = parsePortalCreditAppliedAmount(payment?.notes)

  const dtRaw = payment?.approved_at || payment?.created_at

  return (
    <div
      className="fixed inset-0 z-[92] flex items-center justify-center bg-black/50 p-3 sm:p-4"
      onClick={(e) => e.target === e.currentTarget && onClose?.()}
      role="presentation"
    >
      <div
        className="flex max-h-[min(90vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-white shadow-2xl ring-1 ring-black/10"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="view-payment-title"
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-5 py-4">
          <div className="min-w-0">
            <h2 id="view-payment-title" className="truncate text-lg font-bold text-gray-900">
              {loading ? 'Cargando pago…' : payment?.payment_number || `Pago #${paymentId}`}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">Detalle del abono (solo lectura)</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-2 text-gray-500 hover:bg-gray-100"
            aria-label="Cerrar"
          >
            <X className="h-5 w-5" strokeWidth={2} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading ? (
            <p className="text-sm text-gray-500 py-8 text-center">Cargando…</p>
          ) : error ? (
            <p className="text-sm text-red-600 py-8 text-center">{error}</p>
          ) : payment ? (
            <>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className={labelCls}>Fecha</dt>
                  <dd className="font-medium text-gray-900">
                    {dtRaw ? formatDateEcuador(dtRaw) : '—'}
                  </dd>
                </div>
                <div>
                  <dt className={labelCls}>Importe</dt>
                  <dd className="font-bold tabular-nums text-gray-900">
                    {formatMoneyDisplay(payment.amount, currency)}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className={labelCls}>Depositar en</dt>
                  <dd className="text-gray-800">{depositLabel}</dd>
                </div>
                <div>
                  <dt className={labelCls}>N.º referencia</dt>
                  <dd className="text-gray-800">{payment.reference_number || '—'}</dd>
                </div>
                <div>
                  <dt className={labelCls}>Método</dt>
                  <dd className="text-gray-800">{payment.payment_method || '—'}</dd>
                </div>
              </dl>

              {payment.notes ? (
                <div>
                  <p className={labelCls}>Nota</p>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{payment.notes}</p>
                </div>
              ) : null}

              <div>
                <p className={`${labelCls} mb-2`}>Comprobante</p>
                {receiptUrl ? (
                  /\.(jpe?g|png|webp|gif)(\?|$)/i.test(payment.receipt_file_url || '') ? (
                    <a href={receiptUrl} target="_blank" rel="noopener noreferrer" className="block">
                      <img
                        src={receiptUrl}
                        alt="Comprobante de pago"
                        className="max-h-56 w-auto rounded-md border border-gray-200 object-contain"
                      />
                    </a>
                  ) : (
                    <a
                      href={receiptUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600 hover:underline"
                    >
                      <Paperclip className="h-4 w-4" aria-hidden />
                      Ver comprobante (PDF / archivo)
                    </a>
                  )
                ) : isSaldoCross ? (
                  <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                    🔄 Cruce con saldo a favor — sin comprobante físico
                    {portalSaldoApplied != null && Number(portalSaldoApplied) > 0 ? (
                      <>
                        {' '}
                        ({formatMoneyDisplay(portalSaldoApplied, currency)})
                      </>
                    ) : null}
                  </p>
                ) : (
                  <p className="text-sm text-gray-400">Sin comprobante adjunto</p>
                )}
              </div>

              {Array.isArray(payment.allocations) && payment.allocations.length > 0 ? (
                <div>
                  <p className={`${labelCls} mb-2`}>Aplicado a</p>
                  <ul className="space-y-1 text-sm text-gray-700">
                    {payment.allocations.map((a, idx) => (
                      <li key={`${a.sale_id ?? a.wallet_recharge_id ?? idx}`} className="flex justify-between gap-2">
                        <span className="truncate">{a.sale_ref || '—'}</span>
                        <span className="tabular-nums font-medium shrink-0">
                          {formatMoneyDisplay(a.amount_applied, a.currency || currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <footer className="shrink-0 border-t border-gray-200 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-md bg-gray-100 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-200"
          >
            Cerrar
          </button>
        </footer>
      </div>
    </div>
  )
}
