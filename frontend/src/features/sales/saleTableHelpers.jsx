/** Columnas tipo QuickBooks compartidas entre Ventas y detalle de cliente. */

import { Copy, Eye, Link } from 'lucide-react'
import {
  formatSaleLedgerDateParts,
  formatSaleTableDate,
} from '../../utils/datetime'

export { formatSaleLedgerDateParts, formatSaleTableDate }

export function formatSaleDocNo(id) {
  if (id == null || id === '') return '—'
  return String(id).padStart(4, '0')
}

/** Ventas que solo deben abrir el modal en consulta sin edición. */
export function saleOpensReadOnly(sale) {
  const st = String(sale?.status ?? '').toLowerCase().trim()
  return st === 'rejected' || st === 'cancelled' || st === 'annulled' || st === 'expired'
}

/** Origen API para rutas relativas (`/uploads/...`). */
export function salesApiOrigin() {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) {
    return String(import.meta.env.VITE_API_BASE_URL).replace(/\/$/, '')
  }
  return 'http://localhost:8000'
}

/** URL absoluta del portal de pago del cliente (SPA `/checkout/:token`). */
export function checkoutPortalUrl(paymentToken) {
  const t = String(paymentToken ?? '').trim()
  if (!t || typeof window === 'undefined') return ''
  const origin = String(window.location.origin || '').replace(/\/$/, '')
  return `${origin}/checkout/${t}`
}

/** Origen absoluto para rutas relativas del SPA (`/portal/...`, `/checkout/...`). */
export function absolutizePublicUrl(pathOrUrl) {
  const raw = String(pathOrUrl ?? '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  if (typeof window === 'undefined') return raw
  const origin = String(window.location.origin || '').replace(/\/$/, '')
  return `${origin}${raw.startsWith('/') ? raw : `/${raw}`}`
}

/**
 * URL pública para copiar desde una fila de recarga BaaS (pendientes / revisión).
 * Prioriza URLs explícitas, portal permanente del cliente y enlace legado por ``link_hash``.
 */
export function resolveRechargePaymentUrl(row) {
  if (!row || typeof row !== 'object') return ''

  for (const key of ['payment_url', 'checkout_url', 'portal_url', 'payment_link']) {
    const abs = absolutizePublicUrl(row[key])
    if (abs) return abs
  }

  const portalPath = String(row.portal_path ?? '').trim()
  if (portalPath) return absolutizePublicUrl(portalPath)

  const portalToken = String(
    row.client_portal_token ??
      row.portal_token ??
      row.payment_token ??
      row.client?.portal_token ??
      row.client?.payment_token ??
      '',
  ).trim()
  if (portalToken) return clientPortalPublicUrl(portalToken)

  const linkHash = String(row.link_hash ?? row.token ?? '').trim()
  if (linkHash) return absolutizePublicUrl(`/portal/recharge/${encodeURIComponent(linkHash)}`)

  return ''
}

function legacyExecCommandCopy(val) {
  const ta = document.createElement('textarea')
  ta.value = val
  ta.setAttribute('readonly', '')
  ta.setAttribute('aria-hidden', 'true')
  ta.contentEditable = 'true'
  ta.readOnly = true
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.width = '2em'
  ta.style.height = '2em'
  ta.style.padding = '0'
  ta.style.margin = '0'
  ta.style.border = 'none'
  ta.style.outline = 'none'
  ta.style.boxShadow = 'none'
  ta.style.background = 'transparent'
  ta.style.opacity = '0'
  ta.style.fontSize = '16px'
  ta.style.zIndex = '-1'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  ta.setSelectionRange(0, Math.max(val.length, 99999))
  let ok = false
  try {
    ok = document.execCommand('copy')
  } finally {
    document.body.removeChild(ta)
  }
  return ok
}

/**
 * Copia texto al portapapeles con fallback para Safari iOS
 * (navigator.clipboard suele fallar fuera del gesto de usuario o sin HTTPS estricto).
 */
export async function copyTextToClipboard(text) {
  const val = String(text ?? '')
  if (!val) throw new Error('Nada que copiar.')

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(val)
      return true
    } catch {
      // continuar con fallback clásico
    }
  }

  if (typeof document === 'undefined') throw new Error('Portapapeles no disponible.')

  if (legacyExecCommandCopy(val)) return true
  throw new Error('No se pudo copiar al portapapeles.')
}

/**
 * Copia o comparte un enlace. En móviles, si el portapapeles falla, usa Web Share API.
 * @returns {'copied' | 'shared'}
 */
export async function copyOrSharePaymentUrl(url, { shareTitle = 'Enlace de Pago' } = {}) {
  const val = String(url ?? '').trim()
  if (!val) throw new Error('Sin enlace de pago.')

  try {
    await copyTextToClipboard(val)
    return 'copied'
  } catch (clipErr) {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: shareTitle, url: val })
        return 'shared'
      } catch (shareErr) {
        if (shareErr?.name === 'AbortError') throw shareErr
      }
    }
    throw clipErr
  }
}

export async function copyCheckoutPortalLink(paymentToken) {
  const url = checkoutPortalUrl(paymentToken)
  if (!url) throw new Error('Sin token de enlace público.')
  await copyTextToClipboard(url)
}

/** Enlace SPA de autogestión del cliente: ``/portal/{portal_token}`` (mismo UUID que ``payment_token`` del cliente). */
export function clientPortalPublicUrl(portalToken) {
  const t = String(portalToken ?? '').trim()
  if (!t || typeof window === 'undefined') return ''
  const origin = String(window.location.origin || '').replace(/\/$/, '')
  return `${origin}/portal/${t}`
}

export async function copyClientPortalLink(portalToken) {
  const url = clientPortalPublicUrl(portalToken)
  if (!url) throw new Error('Sin enlace de portal.')
  await copyTextToClipboard(url)
}

/**
 * URL absoluta para cobro: prioriza el portal fijo del cliente (`/portal/{token}`) cuando la venta trae
 * ``client_portal_token``; si no, el checkout por venta (`/checkout/{payment_token}`).
 */
export function salePaymentPublicUrl(sale) {
  const portalTok = String(sale?.client_portal_token ?? sale?.client?.portal_token ?? '').trim()
  if (portalTok) return clientPortalPublicUrl(portalTok)
  return checkoutPortalUrl(sale?.payment_token)
}

/**
 * Copia al portapapeles el enlace público adecuado. Devuelve ``'portal'`` o ``'checkout'`` según cuál se usó.
 */
export async function copySalePaymentLink(sale) {
  const portalTok = String(sale?.client_portal_token ?? sale?.client?.portal_token ?? '').trim()
  if (portalTok) {
    await copyClientPortalLink(portalTok)
    return 'portal'
  }
  await copyCheckoutPortalLink(sale?.payment_token)
  return 'checkout'
}

/** Botón azul con icono para copiar enlace de pago (Ventas / recargas BaaS). */
export function CopyPaymentLinkButton({
  onClick,
  title = 'Copiar enlace del portal del cliente (permanente)',
  disabled = false,
  className = '',
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`checkout-pay-link-blink inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg
                 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap
                 bg-gradient-to-r from-sky-600 to-cyan-500 text-white
                 hover:from-sky-700 hover:to-cyan-600
                 shadow-sm border border-white/25 transition-[filter]
                 shrink-0 max-w-[200px] disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    >
      <Link size={14} strokeWidth={2.35} aria-hidden />
      <span className="truncate">Copiar enlace pagado</span>
      <Copy size={13} strokeWidth={2.35} aria-hidden />
    </button>
  )
}

/** URL absoluta del comprobante de pago (si existe). */
export function saleReceiptHref(sale) {
  const raw = sale?.payment_receipt ?? sale?.payment_receipt_url ?? sale?.receipt_url
  if (raw == null || raw === '') return null
  const s = String(raw).trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  if (/^\/chat-media/i.test(s)) {
    const cat = 'https://catalogo-vip.onrender.com'.replace(/\/$/, '')
    return s.startsWith('/') ? `${cat}${s}` : `${cat}/${s}`
  }
  const origin = salesApiOrigin()
  return `${origin}${s.startsWith('/') ? '' : '/'}${s}`
}

/** Insignia «Ver» para abrir el comprobante en nueva pestaña (Ventas / cliente). */
export function SaleReceiptProofLink({ sale }) {
  const href = saleReceiptHref(sale)
  if (!href) {
    return <span className="text-gray-400 text-sm tabular-nums select-none">—</span>
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold
                 bg-slate-100 text-slate-700 shadow-sm ring-1 ring-inset ring-slate-200/90
                 hover:bg-white hover:text-slate-900 hover:ring-slate-300 transition-colors"
      title="Ver comprobante"
      onClick={(e) => e.stopPropagation()}
    >
      <Eye size={13} className="shrink-0 opacity-90" aria-hidden strokeWidth={2} />
      Ver
    </a>
  )
}

export function SaleAmountCell({ sale }) {
  const localAmt = parseFloat(sale.local_amount ?? sale.amount)
  const usdAmt = parseFloat(sale.amount)
  const currency = sale.currency ?? 'USD'

  const localStr = new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(localAmt) ? localAmt : 0)

  const usdStr = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(usdAmt) ? usdAmt : 0)

  if (currency === 'USD') {
    return <span className="font-semibold text-gray-800">${usdStr} USD</span>
  }

  return (
    <div>
      <p className="font-semibold text-gray-800">
        {localStr} {currency}
      </p>
      <p className="text-xs text-green-600 font-medium">${usdStr} USD</p>
    </div>
  )
}

export function SaleListNotesCell({ notes }) {
  const raw = notes != null ? String(notes).trim() : ''
  const display = raw || '—'
  return (
    <span className="text-gray-700 max-w-full min-w-0 truncate block text-sm" title={raw || undefined}>
      {display}
    </span>
  )
}

/** Producto opcional arriba; nota (sale.notes) debajo en gris si hay producto. */
export function ClientDetailNotesCell({ sale }) {
  const raw = sale.notes != null ? String(sale.notes).trim() : ''
  const product = sale.product_name?.trim?.() ? sale.product_name.trim() : ''

  return (
    <div className="max-w-[280px]">
      {product ? (
        <div className="text-sm text-gray-600 truncate" title={product}>
          {product}
        </div>
      ) : null}
      <div
        className={`text-sm whitespace-pre-wrap break-words ${product ? 'text-gray-500 mt-0.5' : 'text-gray-800'}`}
        title={raw || undefined}
      >
        {raw || '—'}
      </div>
    </div>
  )
}

function rechargeMoneyFmt(n) {
  return new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0)
}

/** IMPORTE al estilo tabla Ventas para filas de ``WalletRechargeRequest`` (BaaS). */
export function RechargeAmountCell({ row }) {
  const cur = String(row?.recharge_currency || row?.currency || 'USD')
    .trim()
    .toUpperCase() || 'USD'
  const xr = Number(row?.recharge_exchange_rate ?? row?.exchange_rate ?? 1)
  const amt = Number(row?.total_amount ?? row?.amount_requested ?? row?.amount ?? 0)
  const paid = Number(row?.paid_amount ?? row?.amount_paid ?? 0)
  const pending = Number(row?.pending_amount ?? row?.balance_pending ?? 0)
  const rateOk = Number.isFinite(xr) && xr > 0
  const usdEquivalent = cur !== 'USD' && rateOk ? amt / xr : amt

  const showUsdEquivalent =
    cur !== 'USD' &&
    rateOk &&
    xr > 1.000001 &&
    Number.isFinite(usdEquivalent) &&
    Math.abs(usdEquivalent - amt) > 0.009

  const localStr = rechargeMoneyFmt(amt)

  const usdStr = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(usdEquivalent) ? usdEquivalent : 0)

  const showPending = pending > 0.009 && String(row?.status ?? '') !== 'approved'

  const totalBlock =
    cur === 'USD' ?
      <span className="font-semibold text-gray-800">${usdStr} USD</span>
    : (
      <div>
        <p className="font-semibold text-gray-800">
          {localStr} {cur}
        </p>
        {showUsdEquivalent ?
          <p className="text-xs text-green-600 font-medium">${usdStr} USD</p>
        : null}
      </div>
    )

  return (
    <div className="inline-block text-right">
      {totalBlock}
      {showPending ?
        <div className="text-[10px] font-semibold mt-1 tabular-nums leading-snug">
          <span className="text-amber-800">
            Pendiente {rechargeMoneyFmt(pending)} {cur}
          </span>
          {paid > 0.009 ?
            <span className="text-gray-500 font-normal">
              {' '}
              · Pagado {rechargeMoneyFmt(paid)}
            </span>
          : null}
          {Number(row?.surplus_credited) > 0.009 ?
            <span className="block text-emerald-700 font-medium">
              Exc. favor CxC +{rechargeMoneyFmt(Number(row.surplus_credited))}
            </span>
          : null}
        </div>
      : null}
    </div>
  )
}
