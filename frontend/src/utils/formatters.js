/**
 * Traduce códigos técnicos del backend en etiquetas legibles para tablas y listados.
 */

const PORTAL_RECEIPT_PENDING_REVIEW_RE = /PORTAL_RECEIPT_PENDING_REVIEW(?:=(\d+))?/gi
const PORTAL_RECEIPT_PENDING_RE = /PORTAL_RECEIPT_PENDING(?!_REVIEW)(?:=(\d+))?/gi

function portalReceiptPendingReviewLabel(countRaw) {
  const n = Number.parseInt(String(countRaw ?? '1'), 10)
  const count = Number.isFinite(n) && n > 0 ? n : 1
  return count > 1 ? `${count} Comprobantes en revisión` : 'Comprobante en revisión'
}

function portalReceiptPendingLabel(countRaw) {
  const n = Number.parseInt(String(countRaw ?? '1'), 10)
  const count = Number.isFinite(n) && n > 0 ? n : 1
  return count > 1 ? `${count} Pagos pendientes del cliente` : 'Esperando pago del cliente'
}

/** Limpia separadores sobrantes tras reemplazar fragmentos técnicos. */
function tidyFormattedNote(text) {
  return String(text ?? '')
    .replace(/\s*[·•|]\s*[·•|]\s*/g, ' · ')
    .replace(/^\s*[·•|]\s*/g, '')
    .replace(/\s*[·•|]\s*$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * Convierte notas de sistema (marcadores META/PORTAL_*) a texto amigable en español.
 * Las frases humanas conocidas se conservan; solo se traducen los códigos técnicos.
 */
export function formatSystemNote(note) {
  if (note == null) return ''
  const raw = String(note).trim()
  if (!raw) return ''

  let out = raw

  out = out.replace(PORTAL_RECEIPT_PENDING_REVIEW_RE, (_match, count) =>
    portalReceiptPendingReviewLabel(count),
  )

  out = out.replace(PORTAL_RECEIPT_PENDING_RE, (_match, count) =>
    portalReceiptPendingLabel(count),
  )

  out = out
    .replace(/META_RETIRO_INSTANT_CXC=1/gi, 'Activación instantánea · CxC pendiente')
    .replace(/META_RETIRO_WEBHOOK=1/gi, 'Confirmado por webhook de retiro')

  return tidyFormattedNote(out) || raw
}
