import { normalizeCurrencyCode } from '../../../lib/currencyCode'

import { formatDateEcuador } from '../../../utils/datetime'

export function formatLinkedPaymentDate(iso) {
  return formatDateEcuador(iso)
}

export function formatNegativePaymentAmount(amount, currency) {
  const cur = normalizeCurrencyCode(currency || 'USD', 'USD')
  const n = Number(amount)
  const safe = Number.isFinite(n) ? n : 0
  try {
    const fmt = new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safe)
    return `-${fmt}`
  } catch {
    return `-${safe.toFixed(2)} ${cur}`
  }
}

/**
 * Lista de pagos CxC aplicados a la factura (estilo QuickBooks, debajo del subtotal).
 */
export default function SaleLinkedPaymentsList({ payments = [], currency = 'USD', onPaymentClick }) {
  const list = Array.isArray(payments) ? payments : []
  if (list.length === 0) return null

  return (
    <ul className="space-y-1 border-t border-slate-200/80 pt-2 mt-2" aria-label="Pagos aplicados">
      {list.map((lp) => (
        <li key={lp.payment_id} className="flex items-center justify-between gap-3 text-sm leading-snug">
          <button
            type="button"
            className="text-left text-blue-600 hover:text-blue-800 hover:underline font-medium cursor-pointer"
            onClick={() => onPaymentClick?.(lp)}
          >
            Pago el {formatLinkedPaymentDate(lp.date)}
          </button>
          <span className="shrink-0 tabular-nums text-slate-800 font-semibold">
            {formatNegativePaymentAmount(lp.amount_applied, currency)}
          </span>
        </li>
      ))}
    </ul>
  )
}
