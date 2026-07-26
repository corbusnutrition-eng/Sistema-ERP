/** Montos de recarga BaaS en el portal: ``amount_requested`` = neto CxC; bruto = neto + descuento. */

export function parsePortalMoney(v) {
  if (v == null || v === '') return NaN
  const n = typeof v === 'number' ? v : parseFloat(String(v).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

export function portalRechargeDiscount(row) {
  const d = parsePortalMoney(row?.discount)
  return Number.isFinite(d) && d > 1e-9 ? Math.round(d * 100) / 100 : 0
}

/** Neto a pagar (CxC) — coincide con ``amount_requested`` del backend. */
export function portalRechargeNet(row) {
  const n = parsePortalMoney(row?.amount_requested)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

/** Importe bruto solicitado (producto virtual antes de descuento pasarela). */
export function portalRechargeGross(row) {
  const net = portalRechargeNet(row)
  const disc = portalRechargeDiscount(row)
  if (disc > 1e-9) return Math.round((net + disc) * 100) / 100
  const gross = parsePortalMoney(row?.gross_amount ?? row?.subtotal)
  if (Number.isFinite(gross) && gross > 1e-9) return Math.round(gross * 100) / 100
  return net
}
