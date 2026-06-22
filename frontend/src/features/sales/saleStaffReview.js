/**
 * Separa «Activar» (inventario + primera entrega) de «Aprobar Pago» (solo cobro CxC).
 * Preferir `staff_review_action` del API; el fallback cubre respuestas cacheadas.
 */

export function saleStaffReviewAction(sale) {
  if (!sale) return 'activate'
  const fromApi = sale.staff_review_action
  if (fromApi === 'approve_payment' || fromApi === 'activate') return fromApi
  if (sale.status === 'payment_submitted') {
    const paid = Number(sale.amount_paid) || 0
    const linked = Array.isArray(sale.linked_payments) ? sale.linked_payments.length : 0
    if (paid > 0.001 || linked > 0) return 'approve_payment'
  }
  return 'activate'
}

export function isPaymentApprovalOnly(sale) {
  return saleStaffReviewAction(sale) === 'approve_payment'
}

export function staffReviewPrimaryLabel(action) {
  return action === 'approve_payment' ? 'Aprobar Pago' : 'Activar'
}

export function staffReviewConfirmLabel(action) {
  return action === 'approve_payment' ? 'Confirmar y Aprobar Pago' : 'Confirmar y Activar'
}

export function staffReviewModalTitle(action) {
  return action === 'approve_payment' ? 'Revisar y Aprobar Pago' : 'Revisar y Activar Venta'
}

export function staffReviewSuccessToast(sale, action) {
  const who = sale?.client_name || 'cliente'
  return action === 'approve_payment'
    ? `Pago de ${who} aprobado correctamente.`
    : `Venta de ${who} activada correctamente.`
}
