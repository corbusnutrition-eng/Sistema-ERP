import api from '../../api/axios'
import { pickPendingReviewLinkedPayment } from '../../components/OcrSecurityBadges'
import { isPaymentApprovalOnly } from './saleStaffReview'

/** True cuando la transacción padre ya fue activada y el comprobante es un abono CxC. */
export function isSubsequentCxcAbonoForSale(sale) {
  if (!sale) return false
  if (sale.staff_review_action === 'approve_payment') return true
  if (String(sale.status ?? '') === 'partially_paid') return true
  return isPaymentApprovalOnly(sale)
}

/** True cuando la recarga ya entregó producto virtual y el comprobante es un abono CxC. */
export function isSubsequentCxcAbonoForRecharge(row) {
  if (!row) return false
  if (row.staff_review_action === 'approve_payment') return true
  const st = String(row.status ?? '').toLowerCase()
  if (st !== 'in_review') return false
  const paid = Number(row.amount_paid ?? 0)
  if (Number.isFinite(paid) && paid > 1e-6) return true
  const surplus = Number(row.surplus_credited ?? 0)
  return Number.isFinite(surplus) && surplus > 1e-6
}

export function pickSalePendingReviewPayment(sale) {
  const pending = Array.isArray(sale?.pending_review_payments) ? sale.pending_review_payments : []
  if (pending.length > 0) return pending[0]
  const linked = pickPendingReviewLinkedPayment(sale?.linked_payments)
  if (linked?.payment_id != null) return linked
  return null
}

export function pickRechargePendingReviewPayment(row) {
  return pickPendingReviewLinkedPayment(row?.linked_payments)
}

export function buildReceivePaymentPrefill(payment, extra = {}) {
  if (!payment) return null
  const pid = payment.payment_id ?? payment.id
  const depositId =
    payment.liquid_deposit_account_id ??
    payment.deposit_account_id ??
    extra.depositAccountId ??
    null
  return {
    paymentId: pid,
    paymentNumber: payment.payment_number,
    clientId: payment.client_id ?? extra.clientId,
    amount: payment.amount ?? payment.amount_applied,
    currency: payment.currency ?? extra.currency,
    receiptUrl: payment.receipt_file_url ?? payment.receipt_url,
    depositAccountId: depositId,
    referenceNumber: payment.reference_number,
    notes: payment.notes,
    paymentDate: payment.created_at ?? payment.occurred_at ?? extra.paymentDate,
    ...extra,
  }
}

/** Resuelve el ClientPayment completo (GET /payments/{id}) si hace falta. */
export async function resolveClientPaymentForReview(paymentRef) {
  if (!paymentRef) return null
  const pid = paymentRef.payment_id ?? paymentRef.id
  if (pid == null) return paymentRef
  const hasDetail =
    paymentRef.receipt_file_url != null
    || paymentRef.deposit_account_id != null
    || paymentRef.liquid_deposit_account_id != null
    || paymentRef.status != null
  if (hasDetail && paymentRef.amount != null) {
    return { ...paymentRef, id: pid, payment_id: pid }
  }
  const { data } = await api.get(`/api/v1/payments/${pid}`)
  return data
}

export async function openReceivePaymentForSaleAbono(sale, openReceivePayment, afterSave) {
  const ref = pickSalePendingReviewPayment(sale)
  if (!ref?.payment_id && !ref?.id) {
    window.alert('No hay un pago en revisión vinculado a esta venta.')
    return false
  }
  try {
    const payment = await resolveClientPaymentForReview(ref)
    openReceivePayment(
      afterSave,
      buildReceivePaymentPrefill(payment, { clientId: sale.client_id }),
    )
    return true
  } catch {
    window.alert('No se pudo cargar el pago en revisión.')
    return false
  }
}

export async function openReceivePaymentForRechargeAbono(row, openReceivePayment, afterSave) {
  const ref = pickRechargePendingReviewPayment(row)
  if (!ref?.payment_id) {
    window.alert('No hay un pago en revisión vinculado a esta recarga.')
    return false
  }
  try {
    const payment = await resolveClientPaymentForReview(ref)
    openReceivePayment(
      afterSave,
      buildReceivePaymentPrefill(payment, {
        clientId: row.client_id,
        depositAccountId:
          ref.deposit_account_id ?? row.portal_submitted_deposit_account_id ?? null,
      }),
    )
    return true
  } catch {
    window.alert('No se pudo cargar el pago en revisión.')
    return false
  }
}
