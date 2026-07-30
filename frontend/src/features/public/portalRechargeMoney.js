/** Montos de recarga BaaS en el portal: ``amount_requested`` = neto CxC fiat; crédito billetera en USD. */

const PORTAL_WALLET_DISPLAY_CURRENCY = 'USD'

export function formatPortalWalletMoney(amount) {
  const n = typeof amount === 'number' ? amount : parseFloat(String(amount ?? 0).replace(',', '.'))
  if (Number.isNaN(n)) return '—'
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: PORTAL_WALLET_DISPLAY_CURRENCY,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${PORTAL_WALLET_DISPLAY_CURRENCY} ${n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
}

export function parsePortalMoney(v) {
  if (v == null || v === '') return NaN
  const n = typeof v === 'number' ? v : parseFloat(String(v).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

export function portalRechargeDiscount(row) {
  const d = parsePortalMoney(row?.discount)
  return Number.isFinite(d) && d > 1e-9 ? Math.round(d * 100) / 100 : 0
}

/** Neto a pagar (CxC fiat) — coincide con ``amount_requested`` del backend. */
export function portalRechargeNet(row) {
  const n = parsePortalMoney(row?.amount_requested)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

/** Saldo BaaS bruto a acreditar en USD. */
export function portalRechargeWalletCreditUsd(row) {
  const direct = parsePortalMoney(row?.wallet_credit_usd ?? row?.amount_usd)
  if (Number.isFinite(direct) && direct > 1e-9) return Math.round(direct * 100) / 100

  const cur = String(row?.recharge_currency ?? row?.currency ?? 'USD')
    .trim()
    .toUpperCase()
  const grossFiat = portalRechargeGross(row)
  if (cur !== 'USD' && grossFiat > 1e-9) {
    const xr = parsePortalMoney(row?.recharge_exchange_rate ?? row?.exchange_rate)
    if (Number.isFinite(xr) && xr > 1e-9) {
      return Math.round((grossFiat / xr) * 100) / 100
    }
  }
  return grossFiat
}

/** Importe bruto solicitado en moneda de cobro (antes de descuento pasarela). */
export function portalRechargeGross(row) {
  const net = portalRechargeNet(row)
  const disc = portalRechargeDiscount(row)
  if (disc > 1e-9) return Math.round((net + disc) * 100) / 100
  const gross = parsePortalMoney(row?.gross_amount ?? row?.subtotal)
  if (Number.isFinite(gross) && gross > 1e-9) return Math.round(gross * 100) / 100
  return net
}
