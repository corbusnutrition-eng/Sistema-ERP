/**
 * Modal de revisión antes de activar una venta portal (payment_submitted).
 * Resume total factura, saldo a favor ya aplicado y saldo pendiente de la venta.
 * El efectivo enviado por el cliente va como abono general (pestaña «En revisión»), salvo datos legados con pending_bank_review.
 */
import { useEffect, useState } from 'react'
import {
  X,
  CheckCircle2,
  Clock,
  CreditCard,
  FileImage,
  AlertTriangle,
  Wallet,
  Receipt,
  Info,
} from 'lucide-react'
import api from '../../../api/axios'
import {
  saleStaffReviewAction,
  staffReviewConfirmLabel,
  staffReviewModalTitle,
} from '../saleStaffReview'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

function fmt(amount, currency = 'USD') {
  const n = Number.isFinite(Number(amount)) ? Number(amount) : 0
  return `${n.toFixed(2)} ${currency}`
}

function ReceiptPreview({ url, currency }) {
  if (!url) return null
  const fullUrl = /^https?:\/\//i.test(url) ? url : `${API_BASE}${url}`
  return (
    <a
      href={fullUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold
                 bg-blue-50 text-blue-700 ring-1 ring-blue-200 hover:bg-blue-100 transition-colors"
    >
      <FileImage size={13} />
      Ver comprobante ({currency})
    </a>
  )
}

export default function SaleActivationReviewModal({ sale, onClose, onConfirm, activating }) {
  const [consolidated, setConsolidated] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!sale?.id) return
    setLoading(true)
    setError(null)
    api
      .get(`/api/v1/sales/${sale.id}/portal-payment-consolidated`)
      .then(({ data }) => setConsolidated(data))
      .catch((err) => {
        const d = err?.response?.data?.detail
        setError(typeof d === 'string' ? d : 'No se pudo cargar el resumen de pagos.')
      })
      .finally(() => setLoading(false))
  }, [sale?.id])

  const cur = consolidated?.currency ?? sale?.currency ?? 'USD'
  const staffAction = consolidated?.staff_review_action ?? saleStaffReviewAction(sale)
  const modalTitle = staffReviewModalTitle(staffAction)
  const confirmLabel = staffReviewConfirmLabel(staffAction)
  const isPaymentOnly = staffAction === 'approve_payment'
  const invoiceTotal = consolidated?.invoice_total ?? 0
  const creditApplied = consolidated?.auto_credit_applied ?? 0
  const balanceDue = Number(consolidated?.balance_due ?? 0)

  const pendingBank = consolidated?.pending_bank_review ?? null
  const bankAmount =
    pendingBank?.amount != null && Number.isFinite(Number(pendingBank.amount))
      ? Number(pendingBank.amount)
      : 0
  const hasLegacyPendingBank = Boolean(pendingBank) && bankAmount > 0.001

  const saleReceiptUrl = sale?.receipt_url ? String(sale.receipt_url).trim() : ''
  const showGeneralAbonoHint =
    !hasLegacyPendingBank && Boolean(saleReceiptUrl)

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !activating) onClose()
      }}
    >
      <div
        className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl ring-1 ring-slate-200/80 overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center">
              <Receipt size={16} className="text-emerald-600" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">{modalTitle}</h2>
              <p className="text-xs text-slate-500">
                #{String(sale?.id ?? '').padStart(4, '0')} · {sale?.client_name ?? ''}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={activating}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-slate-400 text-sm">
              <span className="w-4 h-4 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
              Cargando resumen de pagos…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-start gap-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <p>{error}</p>
            </div>
          )}

          {!loading && !error && consolidated && (
            <>
              <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 ring-1 ring-slate-100">
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <CreditCard size={15} className="text-slate-400" />
                  <span>Subtotal / Total factura</span>
                </div>
                <span className="font-bold text-slate-900 tabular-nums text-sm">
                  {fmt(invoiceTotal, cur)}
                </span>
              </div>

              {creditApplied > 0.001 && (
                <div className="flex items-center justify-between p-3 rounded-xl bg-green-50 ring-1 ring-green-100">
                  <div className="flex items-center gap-2 text-sm text-green-700">
                    <Wallet size={15} className="text-green-500" />
                    <span>Pago auto-aplicado (saldo a favor)</span>
                    <span className="text-[10px] font-bold uppercase bg-green-100 text-green-700 px-1.5 py-0.5 rounded">
                      Aprobado
                    </span>
                  </div>
                  <span className="font-bold text-green-700 tabular-nums text-sm">
                    − {fmt(creditApplied, cur)}
                  </span>
                </div>
              )}

              {hasLegacyPendingBank && (
                <div className="p-3 rounded-xl bg-sky-50 ring-1 ring-sky-100 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-sky-700">
                      <Clock size={15} className="text-sky-500" />
                      <span>Comprobante pendiente (legado)</span>
                      <span className="text-[10px] font-bold uppercase bg-sky-100 text-sky-700 px-1.5 py-0.5 rounded">
                        En revisión
                      </span>
                    </div>
                    <span className="font-bold text-sky-800 tabular-nums text-sm">
                      {fmt(bankAmount, pendingBank.currency ?? cur)}
                    </span>
                  </div>
                  {pendingBank.payment_number && (
                    <p className="text-xs text-sky-600 font-mono">
                      Ref: {pendingBank.payment_number}
                    </p>
                  )}
                  {pendingBank.receipt_url && (
                    <ReceiptPreview url={pendingBank.receipt_url} currency={pendingBank.currency ?? cur} />
                  )}
                </div>
              )}

              {showGeneralAbonoHint && (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-indigo-50 ring-1 ring-indigo-100">
                  <Info size={16} className="text-indigo-600 shrink-0 mt-0.5" />
                  <div className="text-xs text-indigo-900 leading-snug space-y-1">
                    <p className="font-semibold">Abono general en revisión</p>
                    <p>
                      El comprobante del cliente se registró como{' '}
                      <strong>abono general del cliente</strong> (sin ligarlo a esta factura). Revísalo y aprueba en la
                      pestaña <strong>«En revisión»</strong>; al aprobarlo, el sistema aplicará el efectivo a facturas
                      pendientes (FIFO) y devolverá cualquier sobrante al saldo a favor del cliente.
                    </p>
                    <ReceiptPreview url={saleReceiptUrl} currency={cur} />
                  </div>
                </div>
              )}

              <div className="border-t border-dashed border-slate-200 pt-3 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-600 font-medium">Saldo pendiente (esta venta)</span>
                  <span className="font-bold text-amber-900 tabular-nums">{fmt(balanceDue, cur)}</span>
                </div>

                {balanceDue > 0.005 && showGeneralAbonoHint && (
                  <div className="flex items-start gap-2 p-3 bg-amber-50 ring-1 ring-amber-200 rounded-xl">
                    <AlertTriangle size={15} className="text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-800 leading-snug">
                      Esta venta puede seguir mostrando saldo hasta que el abono general sea aprobado y el efectivo se
                      aplique contra esta factura.
                    </p>
                  </div>
                )}

                {hasLegacyPendingBank && bankAmount + creditApplied > invoiceTotal + 0.005 && (
                  <div className="flex items-start gap-2 p-3 bg-emerald-50 ring-1 ring-emerald-200 rounded-xl">
                    <CheckCircle2 size={15} className="text-emerald-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-emerald-800 leading-snug">
                      {isPaymentOnly
                        ? 'Al aprobar el pago, el efectivo se aplicará a esta factura (y a otras pendientes si sobra); el excedente irá al saldo a favor del cliente.'
                        : 'Al activar, si el total cubre la factura, el sobrante pasará al saldo a favor del cliente (flujo legado consolidado).'}
                    </p>
                  </div>
                )}

                {isPaymentOnly && (pendingBank || showGeneralAbonoHint || (consolidated?.pending_review_payments?.length ?? 0) > 0) && (
                  <div className="flex items-start gap-2 p-3 bg-sky-50 ring-1 ring-sky-100 rounded-xl">
                    <Info size={16} className="text-sky-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-sky-900 leading-snug">
                      Esta venta ya tiene inventario entregado. Esta acción <strong>solo aprueba el cobro</strong>;
                      no reserva ni descuenta stock adicional.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 bg-slate-50/80 border-t border-slate-100">
          <button
            type="button"
            disabled={activating}
            onClick={onClose}
            className="px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-white rounded-xl ring-1 ring-slate-200 transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={activating || loading || !!error}
            onClick={onConfirm}
            className="inline-flex items-center gap-2 px-5 py-2 text-sm font-bold text-white
                       bg-emerald-600 hover:bg-emerald-700 rounded-xl shadow-sm
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {activating ? (
              <span className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
            ) : (
              <CheckCircle2 size={16} />
            )}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
