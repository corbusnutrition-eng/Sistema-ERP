import { normalizeCurrencyCode } from './currencyCode'

const DEFAULT_API_ORIGIN = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

/** URL absoluta de un comprobante (ventas / BaaS / CxC). */
export function financialReceiptHref(raw, apiOrigin = DEFAULT_API_ORIGIN) {
  const p = String(raw ?? '').trim()
  if (!p) return null
  if (/^https?:\/\//i.test(p)) return p
  const origin = String(apiOrigin || DEFAULT_API_ORIGIN).replace(/\/$/, '')
  return `${origin}${p.startsWith('/') ? '' : '/'}${p}`
}

/**
 * Convierte ``linked_payments`` de una solicitud BaaS al shape del resumen de ventas.
 */
export function financialSummaryFromRechargeLinkedPayments(rawLinked = []) {
  const linkedPayments = []
  const pendingReviewPayments = []
  const list = Array.isArray(rawLinked) ? rawLinked : []

  for (const lp of list) {
    const receipt = lp.receipt_file_url || lp.receipt_url || null
    const isPending =
      lp.kind === 'receipt_under_review' ||
      String(lp.status_label || '').toLowerCase().includes('revisión')

    if (isPending) {
      const amt = Number(lp.amount_applied ?? lp.amount ?? 0)
      pendingReviewPayments.push({
        payment_id: lp.payment_id ?? `wr-pr-${lp.wallet_transaction_id ?? 'x'}`,
        payment_number: lp.payment_number || 'Comprobante en revisión',
        amount: Number.isFinite(amt) ? amt : 0,
        currency: lp.currency || 'USD',
        receipt_file_url: receipt,
        amount_applied_to_sale: Number.isFinite(amt) ? amt : 0,
      })
    } else {
      const applied = Number(lp.amount_applied ?? lp.amount ?? 0)
      linkedPayments.push({
        payment_id: lp.payment_id ?? lp.wallet_transaction_id ?? `wr-${lp.occurred_at ?? 'x'}`,
        payment_number: lp.payment_number || (lp.wallet_transaction_id ? `Abono #${lp.wallet_transaction_id}` : 'Pago'),
        date: lp.occurred_at ?? lp.date ?? null,
        amount_applied: Number.isFinite(applied) ? applied : 0,
        receipt_file_url: receipt,
      })
    }
  }

  return { linkedPayments, pendingReviewPayments }
}

/** Saldo pendiente = subtotal − abonos aprobados (misma lógica que ventas en edición). */
export function computeBalanceDueFromPayments(subtotal, linkedPayments = [], pendingReviewPayments = []) {
  const total = Number(subtotal)
  const base = Number.isFinite(total) ? total : 0
  const approvedSum = (Array.isArray(linkedPayments) ? linkedPayments : []).reduce(
    (acc, lp) => acc + (Number.parseFloat(String(lp.amount_applied)) || 0),
    0,
  )
  const pendingSum = (Array.isArray(pendingReviewPayments) ? pendingReviewPayments : []).reduce(
    (acc, pr) => acc + (Number.parseFloat(String(pr.amount_applied_to_sale ?? pr.amount)) || 0),
    0,
  )
  return Math.max(0, Math.round((base - approvedSum) * 100) / 100)
}

export function formatFinancialMoney(amount, currency = 'USD') {
  const cur = normalizeCurrencyCode(currency || 'USD', 'USD')
  const n = Number(amount)
  const safe = Number.isFinite(n) ? n : 0
  return `${safe.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`
}
