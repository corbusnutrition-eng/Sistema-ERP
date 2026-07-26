import {
  formatLinkedPaymentDate,
  formatNegativePaymentAmount,
} from '../../features/sales/components/SaleLinkedPaymentsList'
import {
  DISCOUNT_TYPES,
  financialReceiptHref,
} from '../../lib/financialSummaryUtils'

const INLINE_INPUT_CLS =
  'h-7 w-[4.75rem] px-1.5 text-right text-sm tabular-nums border border-gray-200 rounded-md bg-white text-gray-900 shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-400 disabled:bg-gray-50 disabled:text-gray-500 disabled:cursor-not-allowed'

function DiscountTypeToggle({ value, onChange, disabled = false }) {
  return (
    <div
      className="inline-flex rounded-md border border-gray-200 overflow-hidden shrink-0 shadow-sm"
      role="group"
      aria-label="Tipo de descuento"
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange?.(DISCOUNT_TYPES.PERCENT)}
        className={`px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:opacity-50 ${
          value === DISCOUNT_TYPES.PERCENT ?
            'bg-gray-100 text-gray-900'
          : 'bg-white text-gray-500 hover:bg-gray-50'
        }`}
      >
        %
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange?.(DISCOUNT_TYPES.FIXED)}
        className={`px-2 py-0.5 text-[11px] font-semibold border-l border-gray-200 transition-colors disabled:opacity-50 ${
          value === DISCOUNT_TYPES.FIXED ?
            'bg-gray-100 text-gray-900'
          : 'bg-white text-gray-500 hover:bg-gray-50'
        }`}
      >
        $
      </button>
    </div>
  )
}

function SummaryRow({ label, value, valueClassName = '', children, className = '' }) {
  return (
    <div className={`flex items-center justify-end gap-3 w-full ${className}`.trim()}>
      <span className="text-sm text-gray-600 shrink-0">{label}</span>
      {children}
      <span
        className={`text-sm tabular-nums text-right min-w-[6.5rem] ${valueClassName || 'text-gray-900'}`.trim()}
      >
        {value}
      </span>
    </div>
  )
}

/**
 * Resumen financiero estilo QuickBooks: filas alineadas a la derecha, sin bloques de color.
 * Subtotal → descuento (%/$) → total → depósito → pagos vinculados → saldo pendiente.
 */
export default function FinancialSummarySidebar({
  subtotal = 0,
  discount = 0,
  total = null,
  currency = 'USD',
  linkedPayments = [],
  pendingReviewPayments = [],
  balanceDue,
  autoAppliedCredit = 0,
  subtotalLabel = 'Subtotal',
  totalLabel = 'Facturar en total',
  apiOrigin = '',
  onOpenLinkedPayment,
  onOpenPendingReviewPayment,
  className = '',
  discountInput = '',
  discountType = DISCOUNT_TYPES.FIXED,
  onDiscountInputChange,
  onDiscountTypeChange,
  showDiscountEditor = false,
  discountEditorDisabled = false,
  depositValue = '',
  onDepositChange,
  showDepositEditor = false,
  depositEditorDisabled = false,
  depositInputId,
  depositFooter = null,
}) {
  const approved = Array.isArray(linkedPayments) ? linkedPayments : []
  const pending = Array.isArray(pendingReviewPayments) ? pendingReviewPayments : []
  const subNum = Number(subtotal)
  const subDisplay = Number.isFinite(subNum) ? subNum : 0
  const discNum = Number(discount)
  const discDisplay = Number.isFinite(discNum) ? Math.max(0, discNum) : 0
  const totalDisplay =
    total != null && Number.isFinite(Number(total)) ?
      Math.max(0, Number(total))
    : Math.max(0, Math.round((subDisplay - discDisplay) * 100) / 100)
  const balance =
    balanceDue != null && Number.isFinite(Number(balanceDue)) ?
      Math.max(0, Number(balanceDue))
    : Math.max(0, totalDisplay)

  const autoCredit = Number(autoAppliedCredit)
  const showAutoCredit = Number.isFinite(autoCredit) && autoCredit > 1e-9
  const showDiscountRow = showDiscountEditor || discDisplay > 1e-9

  const origin = String(apiOrigin || '').replace(/\/$/, '')
  const fmtPlain = (n) => {
    const num = Number(n)
    const safe = Number.isFinite(num) ? num : 0
    return safe.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  const depositParsed = parseFloat(String(depositValue ?? '').trim().replace(',', '.'))
  const depositDisplayNum =
    Number.isFinite(depositParsed) && depositParsed >= 0 ? depositParsed : 0

  return (
    <div className={`w-full max-w-md ml-auto space-y-1.5 ${className}`.trim()}>
      <SummaryRow label={subtotalLabel} value={fmtPlain(subDisplay)} />

      {showDiscountRow ?
        <div className="flex items-center justify-end gap-2 w-full flex-wrap">
          <span className="text-sm text-gray-600 mr-auto sm:mr-0 shrink-0">Descuento</span>
          {showDiscountEditor ?
            <>
              <DiscountTypeToggle
                value={discountType}
                onChange={onDiscountTypeChange}
                disabled={discountEditorDisabled}
              />
              <input
                type="text"
                inputMode="decimal"
                value={discountInput ?? ''}
                onChange={(e) => onDiscountInputChange?.(e.target.value)}
                disabled={discountEditorDisabled}
                placeholder="0"
                className={INLINE_INPUT_CLS}
                aria-label={
                  discountType === DISCOUNT_TYPES.PERCENT ?
                    'Porcentaje de descuento'
                  : 'Monto de descuento'
                }
              />
            </>
          : null}
          <span className="text-sm tabular-nums text-right min-w-[6.5rem] text-gray-900">
            {discDisplay > 1e-9 ? `−${fmtPlain(discDisplay)}` : fmtPlain(0)}
          </span>
        </div>
      : null}

      <SummaryRow
        label={totalLabel}
        value={fmtPlain(totalDisplay)}
        valueClassName="font-semibold text-gray-900"
        className="pt-1.5 border-t border-gray-100"
      />

      {showDepositEditor || depositDisplayNum > 1e-9 ?
        <div className="flex items-center justify-end gap-2 w-full">
          <span className="text-sm text-gray-600 shrink-0">Depósito</span>
          {showDepositEditor ?
            <input
              id={depositInputId}
              type="text"
              inputMode="decimal"
              value={depositValue ?? ''}
              onChange={(e) => onDepositChange?.(e.target.value)}
              disabled={depositEditorDisabled}
              placeholder="0.00"
              className={INLINE_INPUT_CLS}
              aria-label="Importe del depósito"
            />
          : null}
          <span className="text-sm tabular-nums text-right min-w-[6.5rem] text-gray-900">
            {fmtPlain(depositDisplayNum)}
          </span>
        </div>
      : null}

      {depositFooter}

      {approved.length > 0 ?
        <div className="pt-2 space-y-1.5 w-full">
          <p className="text-[11px] text-gray-500 text-right">Pagos aplicados</p>
          <ul className="space-y-1" aria-label="Pagos aplicados">
            {approved.map((lp) => {
              const href = financialReceiptHref(lp.receipt_file_url, origin)
              const label =
                lp.payment_number ?
                  lp.payment_number
                : `Pago el ${formatLinkedPaymentDate(lp.date)}`
              return (
                <li
                  key={String(lp.payment_id)}
                  className="flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5 text-xs text-gray-600"
                >
                  <button
                    type="button"
                    className="text-blue-600 hover:underline font-medium text-right"
                    onClick={() => onOpenLinkedPayment?.(lp)}
                  >
                    {lp.payment_number ? `${lp.payment_number} — aprobado` : label}
                  </button>
                  <span className="font-medium tabular-nums text-gray-800 shrink-0 min-w-[6.5rem] text-right">
                    {formatNegativePaymentAmount(lp.amount_applied, currency)}
                  </span>
                  {href ?
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-emerald-700 font-medium hover:underline w-full text-right"
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
        <div className="pt-1 space-y-1.5 w-full">
          <p className="text-[11px] text-gray-500 text-right">Comprobantes en revisión</p>
          <ul className="space-y-1">
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
                  className="flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5 text-xs text-gray-600"
                >
                  <button
                    type="button"
                    className="text-blue-600 hover:underline font-medium text-right"
                    onClick={() => onOpenPendingReviewPayment?.(pr)}
                  >
                    {pr.payment_number || `Pago #${pr.payment_id}`} — en revisión
                  </button>
                  <span className="font-medium tabular-nums text-gray-800 shrink-0 min-w-[6.5rem] text-right">
                    −{fmtPlain(appliedRaw)}
                  </span>
                  {href ?
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-emerald-700 font-medium hover:underline w-full text-right"
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
        <SummaryRow
          label="Pago auto-aplicado"
          value={`−${fmtPlain(autoCredit)}`}
          valueClassName="text-gray-900"
        />
      : null}

      <SummaryRow
        label="Saldo pendiente"
        value={fmtPlain(balance)}
        valueClassName={
          balance > 1e-9 ? 'font-semibold text-amber-700' : 'font-medium text-gray-900'
        }
        className="pt-1.5 border-t border-gray-200"
      />
    </div>
  )
}
