/** Alertas visuales cuando el OCR del portal requiere revisión humana. */
export function pickOcrSecurityFlags(source) {
  if (!source) return { is_manually_edited: false, ai_confidence_score: null }
  return {
    is_manually_edited: Boolean(source.is_manually_edited),
    ai_confidence_score:
      source.ai_confidence_score != null && Number.isFinite(Number(source.ai_confidence_score))
        ? Number(source.ai_confidence_score)
        : null,
  }
}

/** True cuando la IA no pudo leer un monto válido del comprobante (portal). */
export function isIllegibleReceiptAi(aiResult) {
  if (!aiResult || aiResult._multi_currency) return false
  if (aiResult.is_readable) {
    const n = Number(aiResult.extracted_amount)
    if (Number.isFinite(n) && n > 0) return false
  }
  const conf = aiResult.confidence
  if (conf != null && Number(conf) === 0) return true
  return !aiResult.is_readable
}

const PENDING_REVIEW_KINDS = new Set([
  'receipt_under_review',
  'mixed_under_review',
  'credit_under_review',
])

/** Pago/comprobante en revisión dentro de linked_payments (BaaS o venta). */
export function pickPendingReviewLinkedPayment(linked) {
  const list = Array.isArray(linked) ? linked : []
  return (
    list.find(
      (p) =>
        PENDING_REVIEW_KINDS.has(String(p?.kind || '')) ||
        String(p?.status_label ?? '').toLowerCase().includes('revisión'),
    ) ?? null
  )
}

/**
 * Valor inicial del campo «Depósito declarado» al editar: solo el monto del pago en revisión
 * (incluye 0). No usa saldo pendiente ni subtotal de la orden.
 */
export function declaredDepositInputValueFromReview(source) {
  if (!source) return ''
  const pending =
    source.payment_id != null ? source : pickPendingReviewLinkedPayment(source.linked_payments)
  if (pending) {
    const raw = pending.amount_applied ?? pending.amount
    if (raw != null && Number.isFinite(Number(raw))) return String(Number(raw))
  }
  const declared = source.portal_declared_payment_amount
  if (declared != null && Number.isFinite(Number(declared))) return String(Number(declared))
  return ''
}

/** Fuente unificada para alertas OCR en modales de edición ERP. */
export function buildIllegibleCheckSource({
  row,
  pendingPayment,
  isManuallyEdited,
  aiConfidenceScore,
  declaredAmount,
}) {
  const pending = pendingPayment ?? pickPendingReviewLinkedPayment(row?.linked_payments)
  const pendingAmt = pending?.amount_applied ?? pending?.amount
  return {
    is_manually_edited: pending?.is_manually_edited ?? isManuallyEdited,
    ai_confidence_score: pending?.ai_confidence_score ?? aiConfidenceScore,
    portal_declared_payment_amount:
      pendingAmt ??
      declaredAmount ??
      row?.portal_declared_payment_amount,
    amount: pendingAmt,
  }
}

/** True cuando el registro en ERP no tiene monto declarado válido o confidence=0. */
export function isIllegibleDeclaredRecord(source) {
  if (!source) return false
  const conf = source.ai_confidence_score
  if (conf != null && Number(conf) === 0) return true
  let amt = source.portal_declared_payment_amount
  if (amt == null) amt = source.amount
  if (amt == null) amt = source.amount_applied
  if (amt == null) amt = source.amount_applied_to_sale
  if (amt == null || amt === '') return true
  const n = Number(amt)
  return !Number.isFinite(n) || n <= 0
}

export function IllegibleReceiptAlert({ className = '', layout = 'block' }) {
  const base =
    'inline-flex items-center rounded-md bg-orange-100 px-2.5 py-1.5 text-[11px] font-bold leading-snug text-orange-950 ring-2 ring-orange-300'
  return (
    <span className={layout === 'block' ? `${base} max-w-md ${className}` : `${base} ${className}`}>
      ⚠️ COMPROBANTE ILEGIBLE: La IA no detectó el monto. Revisa el documento e ingresa el valor
      manualmente antes de aprobar.
    </span>
  )
}

/** Toma el comprobante en revisión más reciente de una venta. */
export function pickOcrFlagsFromSale(sale) {
  const pending = Array.isArray(sale?.pending_review_payments) ? sale.pending_review_payments : []
  const withReceipt = pending.filter((p) => p?.receipt_file_url)
  const p = withReceipt[0] || pending[0]
  if (p) {
    return {
      ...pickOcrSecurityFlags(p),
      amount: p.amount,
    }
  }
  return pickOcrSecurityFlags(sale)
}

/** Toma flags del pago en revisión o de la solicitud BaaS. */
export function pickOcrFlagsFromRecharge(row) {
  const linked = Array.isArray(row?.linked_payments) ? row.linked_payments : []
  const pending = linked.filter((p) =>
    ['receipt_under_review', 'mixed_under_review', 'credit_under_review'].includes(String(p?.kind || '')),
  )
  const p = pending[pending.length - 1]
  if (p) {
    const pendingAmt = p.amount_applied ?? p.amount
    return {
      ...pickOcrSecurityFlags(p),
      portal_declared_payment_amount: pendingAmt ?? row?.portal_declared_payment_amount,
      amount: pendingAmt,
    }
  }
  return {
    ...pickOcrSecurityFlags(row),
    portal_declared_payment_amount: row?.portal_declared_payment_amount,
    amount: row?.portal_declared_payment_amount,
  }
}

export function appendOcrFormFields(formData, { isManuallyEdited, aiResult, illegibleSubmit = false }) {
  if (!formData) return
  if (illegibleSubmit) {
    formData.append('ai_confidence_score', '0')
    return
  }
  if (isManuallyEdited) formData.append('is_manually_edited', '1')
  const conf = aiResult?.confidence
  if (conf != null && Number.isFinite(Number(conf))) {
    formData.append('ai_confidence_score', String(Math.round(Number(conf))))
  }
}

export default function OcrSecurityBadges({
  is_manually_edited: manual,
  ai_confidence_score: confidence,
  declared_amount: declaredAmount,
  amount,
  portal_declared_payment_amount: portalDeclared,
  className = '',
  layout = 'column',
}) {
  const source = {
    is_manually_edited: manual,
    ai_confidence_score: confidence,
    portal_declared_payment_amount: portalDeclared ?? declaredAmount ?? amount,
    amount,
  }
  const showIllegible = isIllegibleDeclaredRecord(source)
  const showManual = Boolean(manual)
  const showLowConfidence =
    !showIllegible &&
    confidence != null &&
    Number.isFinite(Number(confidence)) &&
    Number(confidence) < 80
  if (!showManual && !showLowConfidence && !showIllegible) return null

  const wrapClass =
    layout === 'row'
      ? `flex flex-wrap items-center gap-2 ${className}`
      : `flex flex-col items-start gap-1.5 ${className}`

  return (
    <div className={wrapClass}>
      {showIllegible ? <IllegibleReceiptAlert layout="block" /> : null}
      {showManual ? (
        <span className="inline-flex items-center rounded-md bg-sky-100 px-2 py-0.5 text-[11px] font-semibold text-sky-900 ring-1 ring-sky-200">
          Editado por el cliente
        </span>
      ) : null}
      {showLowConfidence ? (
        <span className="inline-flex items-center rounded-md bg-red-600 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-white shadow-sm ring-2 ring-red-300">
          ⚠️ REVISAR MONTO - FOTO BORROSA
        </span>
      ) : null}
    </div>
  )
}
