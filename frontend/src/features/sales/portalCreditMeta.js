/**
 * Identify portal client payments settled only with «saldo a favor» — no uploaded receipt file.
 * Backend stores META_CRE_RESV / PARTE_EFECTIVO markers in ClientPayment.notes.
 */
export function isPortalSaldoCrossSinComprobante({ receiptFileUrlOrPath, notes } = {}) {
  if (receiptFileUrlOrPath != null && String(receiptFileUrlOrPath).trim() !== '') return false
  const n = String(notes ?? '')
  if (!n.includes('META_CRE_RESV=')) return false
  const m = n.match(/PARTE_EFECTIVO=\s*([\d.]+)/i)
  if (!m) return true
  const cash = Number.parseFloat(m[1])
  return !Number.isFinite(cash) || cash <= 0.001
}

export function parsePortalCreditAppliedAmount(notes) {
  const n = String(notes ?? '')
  const m = n.match(/PARTE_SALDO_FAVOR=\s*([\d.]+)/i)
  if (!m) return null
  const v = Number.parseFloat(m[1])
  return Number.isFinite(v) ? v : null
}

/** Notas de ClientPayment del portal que ya referencian una factura (META / destino / ref. origen). */
export function portalPaymentNotesLinkedToSale(notes) {
  const n = String(notes ?? '')
  return (
    /\bMETA_SALE_ID\s*=\s*\d+/i.test(n) ||
    /\bPORTAL_DEBT_TARGET_SALE_ID\s*=\s*\d+/i.test(n) ||
    /\bORIGIN_SALE_REF\s*=\s*\d+/i.test(n) ||
    /\bIS_INITIAL_SALE_PAYMENT\s*=/i.test(n)
  )
}

/** Abono suelto en bandeja «En revisión» (no encapsulado en fila de venta). */
export function isStandaloneReviewPayment(payment) {
  if (!payment) return false
  if (payment.encapsulated_in_sale_review === true) return false
  return !portalPaymentNotesLinkedToSale(payment.notes)
}
