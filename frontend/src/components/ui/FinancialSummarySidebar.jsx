import {
  formatLinkedPaymentDate,
  formatNegativePaymentAmount,
} from '../../features/sales/components/SaleLinkedPaymentsList'
import { financialReceiptHref } from '../../lib/financialSummaryUtils'

/**
 * Panel derecho «Resumen financiero» compartido entre Ventas y BaaS.
 * Subtotal → desglose de pagos → (opcional) auto-aplicado → saldo pendiente.
 */
export default function FinancialSummarySidebar({
  subtotal = 0,
  currency = 'USD',
  linkedPayments = [],
  pendingReviewPayments = [],
  balanceDue,
  autoAppliedCredit = 0,
  subtotalLabel = 'Subtotal',
  subtotalSize = 'lg',
  apiOrigin = '',
  onOpenLinkedPayment,
  onOpenPendingReviewPayment,
  className = '',
}) {
  const approved = Array.isArray(linkedPayments) ? linkedPayments : []
  const pending = Array.isArray(pendingReviewPayments) ? pendingReviewPayments : []
  const subNum = Number(subtotal)
  const subDisplay = Number.isFinite(subNum) ? subNum : 0
  const balance =
    balanceDue != null && Number.isFinite(Number(balanceDue)) ?
      Math.max(0, Number(balanceDue))
    : Math.max(0, subDisplay)

  const autoCredit = Number(autoAppliedCredit)
  const showAutoCredit = Number.isFinite(autoCredit) && autoCredit > 1e-9

  const subtotalCls =
    subtotalSize === 'sm' ? 'text-sm font-bold' : 'text-lg font-semibold'

  const origin = String(apiOrigin || '').replace(/\/$/, '')

  return (
    <div className={`rounded-lg bg-slate-50 border border-slate-100 px-3 py-2.5 ${className}`.trim()}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide shrink-0">
          {subtotalLabel}
        </span>
        <span className={`${subtotalCls} text-slate-900 tabular-nums text-right`}>
          {subDisplay.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
          {currency}
        </span>
      </div>

      {approved.length > 0 ?
        <div className="mt-2 pt-2 border-t border-slate-200/80">
          <p className="text-[10px] font-semibold text-slate-600 uppercase tracking-wide mb-1.5">
            Desglose de pagos
          </p>
          <ul className="space-y-2" aria-label="Pagos aplicados">
            {approved.map((lp) => {
              const href = financialReceiptHref(lp.receipt_file_url, origin)
              const label =
                lp.payment_number ?
                  lp.payment_number
                : `Pago el ${formatLinkedPaymentDate(lp.date)}`
              return (
                <li
                  key={String(lp.payment_id)}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700"
                >
                  <button
                    type="button"
                    className="text-blue-600 hover:underline font-medium text-left"
                    onClick={() => onOpenLinkedPayment?.(lp)}
                  >
                    {lp.payment_number ? `${lp.payment_number} — aprobado` : label}
                  </button>
                  <span className="font-semibold tabular-nums text-slate-900 shrink-0">
                    {formatNegativePaymentAmount(lp.amount_applied, currency)}
                  </span>
                  {href ?
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-emerald-700 font-semibold hover:underline w-full sm:w-auto sm:ml-auto"
                    >
                      Ver comprobante
                    </a>
                  : null}
                </li>
              )
            })}
          </ul>
        </div>
      : null}

      {pending.length > 0 ?
        <div className="mt-2 pt-2 border-t border-dashed border-sky-200/80">
          <p className="text-[10px] font-semibold text-sky-800 uppercase tracking-wide mb-1.5">
            Desglose de pagos · comprobantes en revisión (portal)
          </p>
          <ul className="space-y-2">
            {pending.map((pr) => {
              const href = financialReceiptHref(pr.receipt_file_url, origin)
              const appliedRaw =
                pr.amount_applied_to_sale != null &&
                !Number.isNaN(parseFloat(String(pr.amount_applied_to_sale))) ?
                  parseFloat(String(pr.amount_applied_to_sale))
                : parseFloat(String(pr.amount)) || 0
              return (
                <li
                  key={String(pr.payment_id)}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700"
                >
                  <button
                    type="button"
                    className="text-blue-600 hover:underline font-medium text-left"
                    onClick={() => onOpenPendingReviewPayment?.(pr)}
                  >
                    {pr.payment_number || `Pago #${pr.payment_id}`} — en revisión
                  </button>
                  <span className="font-semibold tabular-nums text-sky-900 shrink-0">
                    −
                    {appliedRaw.toLocaleString('es-ES', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{' '}
                    {currency}
                  </span>
                  {href ?
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-emerald-700 font-semibold hover:underline w-full sm:w-auto sm:ml-auto"
                    >
                      Ver comprobante
                    </a>
                  : null}
                </li>
              )
            })}
          </ul>
        </div>
      : null}

      {showAutoCredit ?
        <div className="flex items-baseline justify-between gap-3 border-t border-slate-200/80 mt-2 pt-2">
          <span className="text-[11px] font-semibold text-emerald-800 uppercase tracking-wide">
            Pago auto-aplicado
          </span>
          <span className="text-base font-bold text-emerald-900 tabular-nums">
            −
            {autoCredit.toLocaleString('es-ES', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{' '}
            {currency}
          </span>
        </div>
      : null}

      <div className="flex items-baseline justify-between gap-3 border-t border-slate-200/80 mt-2 pt-2">
        <span className="text-[11px] font-semibold text-amber-800 uppercase tracking-wide">
          Saldo pendiente
        </span>
        <span className="text-base font-bold text-amber-900 tabular-nums">
          {balance.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
          {currency}
        </span>
      </div>
    </div>
  )
}
