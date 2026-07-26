/**
 * Muestra la cuenta bancaria / método que el cliente eligió al subir un comprobante en revisión.
 */

const PENDING_RECHARGE_KINDS = new Set([
  'receipt_under_review',
  'mixed_under_review',
  'credit_under_review',
])

export function pickPendingReviewDepositDestination({
  pendingReviewPayments = [],
  linkedPayments = [],
  rechargeRow = null,
} = {}) {
  const pending = Array.isArray(pendingReviewPayments) ? pendingReviewPayments : []
  const pr =
    pending.find(
      (p) =>
        p?.deposit_account_name ||
        p?.payment_method_name ||
        (p?.payment_method && String(p.payment_method).trim()),
    ) || pending[0]
  if (pr) {
    const depositAccountName =
      pr.deposit_account_name && String(pr.deposit_account_name).trim()
        ? String(pr.deposit_account_name).trim()
        : null
    const paymentMethodName =
      (pr.payment_method_name && String(pr.payment_method_name).trim()) ||
      (pr.payment_method && String(pr.payment_method).trim()) ||
      null
    if (depositAccountName || paymentMethodName) {
      return { depositAccountName, paymentMethodName }
    }
  }

  const linked = Array.isArray(linkedPayments) ? linkedPayments : []
  const lp = linked.find(
    (row) =>
      PENDING_RECHARGE_KINDS.has(String(row?.kind || '')) ||
      String(row?.status_label || '').toLowerCase().includes('revisión'),
  )
  if (lp) {
    const depositAccountName =
      lp.deposit_account_name && String(lp.deposit_account_name).trim()
        ? String(lp.deposit_account_name).trim()
        : null
    const paymentMethodName =
      lp.payment_method_name && String(lp.payment_method_name).trim()
        ? String(lp.payment_method_name).trim()
        : null
    if (depositAccountName || paymentMethodName) {
      return { depositAccountName, paymentMethodName }
    }
  }

  if (rechargeRow) {
    const depositAccountName =
      rechargeRow.portal_submitted_deposit_account_name &&
      String(rechargeRow.portal_submitted_deposit_account_name).trim()
        ? String(rechargeRow.portal_submitted_deposit_account_name).trim()
        : null
    const paymentMethodName =
      rechargeRow.portal_submitted_payment_method_name &&
      String(rechargeRow.portal_submitted_payment_method_name).trim()
        ? String(rechargeRow.portal_submitted_payment_method_name).trim()
        : null
    if (depositAccountName || paymentMethodName) {
      return { depositAccountName, paymentMethodName }
    }
  }

  return null
}

export default function ReportedDepositDestinationAlert({
  depositAccountName = null,
  paymentMethodName = null,
  className = '',
}) {
  const bank = depositAccountName && String(depositAccountName).trim()
  const method = paymentMethodName && String(paymentMethodName).trim()
  if (!bank && !method) return null

  return (
    <div
      className={`rounded-xl border border-emerald-200/90 bg-gradient-to-br from-emerald-50/95 to-sky-50/80 px-3.5 py-3 shadow-sm ${className}`.trim()}
      role="status"
      aria-live="polite"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-900/90">
        Depósito reportado en
      </p>
      {bank ? (
        <p className="mt-1.5 text-sm font-bold text-slate-900 leading-snug">{bank}</p>
      ) : (
        <p className="mt-1.5 text-sm font-medium text-slate-600 leading-snug">
          Cuenta no indicada en el comprobante
        </p>
      )}
      {method ? (
        <p className="mt-1 text-xs text-slate-700">
          <span className="font-semibold text-slate-800">Método:</span> {method}
        </p>
      ) : null}
      <p className="mt-2 text-[10px] text-emerald-900/75 leading-snug">
        Al aprobar, el asiento contable debitará esta cuenta bancaria y acreditará Cuentas por Cobrar.
      </p>
    </div>
  )
}
