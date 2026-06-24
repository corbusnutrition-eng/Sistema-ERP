import axios from 'axios'
import { useCallback, useEffect, useMemo, useRef, useState, Component, Fragment } from 'react'
import { useParams, Link } from 'react-router-dom'
import Select from 'react-select'
import { ArrowLeftRight, ChevronDown, ChevronsUp, Copy, Loader2, Link2, Pencil, Phone, Plus, Search, Tag, Trash2, X } from 'lucide-react'
import { formatDateTimeEcuador } from '../../utils/datetime'
import { clientPortalPublicUrl } from '../sales/saleTableHelpers'
import {
  mergePhoneParts,
  phoneCountrySelectOptions,
  splitPhoneParts,
  whatsappDigits,
} from '../../constants/phoneCountryCodes'
import { calculateExpirationStats } from '../inventory/screenPackageExpiration'
import CodigosRetiroWidget, { RetiroSuccessPanel } from './CodigosRetiroWidget'
import {
  extractRetiroMonto,
  isCodigosRetiroMethodId,
  isRetiroCompletadoMessage,
  normalizeRetiroPostMessageData,
  parseRetiroCompletadoPayload,
  resolvePortalClientLabelForRetiro,
  submitCodigosRetiroPortalPayment,
  requestCodigosRetiroInstantActivationCxc,
  paymentMethodNameById,
} from './codigosRetiroPayment'

function publicApi() {
  return axios.create({
    baseURL: (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/?$/, ''),
  })
}

/** Layout mobile-first del portal público (link de pago / autogestión). */
const PORTAL_PAGE_ROOT_CLASS =
  'portal-public-root min-h-screen w-full overflow-x-hidden bg-[linear-gradient(145deg,#0f0c29_0%,#1a1440_42%,#16324a_100%)] px-3 pb-12 pt-3 font-[DM_Sans,Inter,-apple-system,BlinkMacSystemFont,sans-serif] text-slate-50 md:px-4 md:pb-16 md:pt-4'

const PORTAL_PAGE_MAIN_CLASS = 'portal-public-main mx-auto w-full max-w-full md:max-w-lg'

const PORTAL_SECTION_SHELL_CLASS = 'portal-public-section w-full min-w-0'

const PORTAL_PAYMENT_SHELL_CLASS =
  'portal-payment-method-shell mb-3.5 w-full min-w-0 rounded-[20px] border border-white/10 bg-slate-900/55 p-3 md:mb-4 md:rounded-[22px] md:p-4'

const PORTAL_TOUCH_INPUT_CLASS =
  'w-full min-h-[44px] rounded-xl border border-white/15 bg-white/[0.06] px-3 py-2.5 text-sm text-slate-50 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50 touch-manipulation'

const PORTAL_TOUCH_BUTTON_CLASS =
  'inline-flex min-h-[44px] h-12 w-full items-center justify-center rounded-xl px-4 text-[15px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 touch-manipulation'

const PORTAL_TOUCH_BUTTON_PRIMARY_CLASS = `${PORTAL_TOUCH_BUTTON_CLASS} bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:from-violet-400 hover:to-fuchsia-400`

const PORTAL_WA_SVG = (
  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 fill-current" xmlns="http://www.w3.org/2000/svg" aria-hidden>
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.611-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
  </svg>
)

/** Formato legible para el badge de contacto del distribuidor padre (ej. +593 999 999 999). */
function formatPortalContactPhoneDisplay(phone) {
  const raw = String(phone || '').trim()
  if (!raw) return '—'
  const { dialCode, local } = splitPhoneParts(raw)
  if (!local) return dialCode
  let formattedLocal = local
  if (local.length === 9) {
    formattedLocal = `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`
  } else if (local.length > 4) {
    formattedLocal = local.replace(/(\d{3})(?=\d)/g, '$1 ').trim()
  }
  return `${dialCode} ${formattedLocal}`.trim()
}

/** Estilos oscuros para react-select en el portal público. */
const portalPaymentMethodSelectStyles = {
  control: (base, state) => ({
    ...base,
    background: 'transparent',
    borderColor: state.isFocused ? '#3b82f6' : '#374151',
    color: 'white',
    boxShadow: 'none',
    borderRadius: 12,
    minHeight: 48,
    '&:hover': { borderColor: '#3b82f6' },
  }),
  valueContainer: (base) => ({ ...base, padding: '2px 10px' }),
  singleValue: (base) => ({ ...base, color: 'white' }),
  menu: (base) => ({ ...base, background: '#1f2937', border: '1px solid #374151' }),
  menuPortal: (base) => ({ ...base, zIndex: 9999 }),
  option: (base, state) => ({
    ...base,
    backgroundColor: state.isFocused ? '#374151' : 'transparent',
    color: 'white',
    cursor: 'pointer',
    minHeight: 44,
    padding: '10px 12px',
    '&:active': { backgroundColor: '#4b5563' },
  }),
  input: (base) => ({ ...base, color: 'white' }),
  placeholder: (base) => ({ ...base, color: '#9ca3af' }),
  indicatorSeparator: (base) => ({ ...base, backgroundColor: '#4b5563' }),
  dropdownIndicator: (base) => ({ ...base, color: '#9ca3af', padding: '8px 10px' }),
}

function portalPaymentMethodOptions(methods) {
  return (Array.isArray(methods) ? methods : []).map((m) => ({
    value: String(m.id),
    label: m.name || `Método #${m.id}`,
  }))
}

function portalPaymentMethodSelectValue(methods, selectedId) {
  const idStr = selectedId != null && String(selectedId).trim() !== '' ? String(selectedId) : ''
  if (!idStr) return null
  return portalPaymentMethodOptions(methods).find((o) => o.value === idStr) ?? null
}

function formatMoney(amount, currency) {
  const n = typeof amount === 'number' ? amount : parseFloat(String(amount ?? 0).replace(',', '.'))
  if (Number.isNaN(n)) return '—'
  const cur =
    String(currency ?? 'USD')
      .trim()
      .toUpperCase()
      .slice(0, 10) || 'USD'
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${cur} ${n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
}

function portalSaleUnitPrice(product, assignedPricesMap, clientCurrency) {
  const pkgId = String(product?.package_catalog_id ?? '')
  const fromAssigned = assignedPricesMap?.[pkgId]
  const assignedNum = parseMoneyNum(fromAssigned)
  if (Number.isFinite(assignedNum) && assignedNum > 0) return assignedNum

  const local = parseMoneyNum(product?.precio_venta_local)
  if (Number.isFinite(local) && local > 0) return local

  const custom = parseMoneyNum(product?.custom_price)
  if (Number.isFinite(custom) && custom > 0) return custom

  return NaN
}

function parentPackageAcquisitionPrice(pkg, assignedPricesMap) {
  const pid = String(pkg?.package_catalog_id ?? '')
  const fromMap = parseMoneyNum(assignedPricesMap?.[pid])
  if (Number.isFinite(fromMap) && fromMap > 0) return fromMap

  const localFloor = parseMoneyNum(pkg?.parent_floor_price_local)
  if (Number.isFinite(localFloor) && localFloor > 0) return localFloor

  const legacyUsd = parseMoneyNum(pkg?.parent_floor_price_usd)
  return Number.isFinite(legacyUsd) && legacyUsd > 0 ? legacyUsd : 0
}

function portalProductCurrency(product, clientCurrency) {
  const raw = product?.currency ?? clientCurrency
  if (raw != null && String(raw).trim().length >= 3) {
    return String(raw).trim().toUpperCase().slice(0, 10)
  }
  return String(clientCurrency || 'USD')
    .trim()
    .toUpperCase()
    .slice(0, 10)
}

function parseMoneyNum(v) {
  if (v == null || v === '') return NaN
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  const s = String(v).replace(/\s/g, '').replace(',', '.')
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : NaN
}

function normalizeAutoPurchaseCredential(c) {
  if (!c || typeof c !== 'object') return null
  const username = String(c.username ?? c.iptv_username ?? '').trim()
  const password = String(c.password ?? c.iptv_password ?? '').trim()
  const screenStockId = c.screen_stock_id != null ? Number(c.screen_stock_id) : null
  return {
    screen_stock_id: Number.isFinite(screenStockId) ? screenStockId : null,
    username,
    password,
    hasCredentials: Boolean(username && password),
  }
}

function formatPortalScreenExpiry(isoDate) {
  const raw = String(isoDate ?? '').trim()
  if (!raw) return null
  try {
    const d = new Date(`${raw}T12:00:00`)
    if (Number.isNaN(d.getTime())) return raw
    return d.toLocaleDateString('es-EC', { day: '2-digit', month: 'short', year: 'numeric' })
  } catch {
    return raw
  }
}

/** Ticker de reloj local para recalcular vencimientos en vivo (cada minuto). */
function usePortalNowTicker(intervalMs = 60000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

/** Días restantes de una compra rastreada (misma lógica que Inventario IPTV). */
function resolveTrackedPurchaseDaysRemaining(item, referenceDate = new Date()) {
  const calc = calculateExpirationStats(
    item?.inventory_created_at,
    item?.inventory_package_raw || item?.package_name,
    referenceDate,
  )
  const days =
    calc?.diasRestantes ??
    (typeof item?.days_remaining === 'number' ? item.days_remaining : item?.days_until_expiration)
  return typeof days === 'number' && Number.isFinite(days) ? days : null
}

function trackedPurchaseCardKey(item) {
  return `tracked-${item?.sale_id}-${item?.screen_stock_id ?? 'pending'}`
}

/** Resumen compacto de vencimiento para la cabecera de la tarjeta. */
function TrackedPurchaseExpirySummary({ item }) {
  const now = usePortalNowTicker(60000)
  const days = useMemo(() => resolveTrackedPurchaseDaysRemaining(item, now), [item, now])

  if (days == null) {
    return <span className="text-[11px] font-medium text-slate-400">Sin vencimiento</span>
  }
  if (days <= 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-bold text-red-500">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden />
        Expirado
      </span>
    )
  }
  const colorClass = days > 3 ? 'text-green-500' : 'text-orange-500'
  const dotClass = days > 3 ? 'bg-green-500' : 'bg-orange-500'
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-bold tabular-nums ${colorClass}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
      Faltan: {days} días
    </span>
  )
}

/** Tarjeta colapsable de una compra rastreada en «Mis compras». */
function TrackedPurchaseCard({ item, expanded, onToggle }) {
  const customerName = String(item?.end_customer_name ?? '').trim() || '—'
  const customerPhone = String(item?.end_customer_phone ?? '').trim()
  const pkg = String(item?.package_name ?? 'Pantalla').trim() || 'Pantalla'
  const purchaseLabel = formatPortalAssignedAt(item?.purchase_date)
  const cardId = trackedPurchaseCardKey(item)

  return (
    <li className="overflow-hidden rounded-xl border border-emerald-500/25 bg-slate-950/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <button
        type="button"
        id={`${cardId}-hdr`}
        aria-expanded={expanded}
        aria-controls={`${cardId}-body`}
        onClick={onToggle}
        className="flex w-full cursor-pointer touch-manipulation items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] active:bg-white/[0.06]"
      >
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[10px] font-semibold uppercase tracking-wide text-emerald-200/70">
            Cliente final
          </p>
          <p className="mt-0.5 mb-0 truncate text-sm font-bold text-slate-50">{customerName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <TrackedPurchaseExpirySummary item={item} />
          <ChevronDown
            size={18}
            strokeWidth={2.25}
            aria-hidden
            className={`shrink-0 text-slate-400 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          />
        </div>
      </button>
      {expanded ? (
        <div
          id={`${cardId}-body`}
          role="region"
          aria-labelledby={`${cardId}-hdr`}
          className="border-t border-slate-600/35 bg-slate-900/45 px-4 pb-4 pt-3"
        >
          {customerPhone ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-300 tabular-nums">
                {formatPortalContactPhoneDisplay(customerPhone)}
              </span>
              <a
                href={`https://wa.me/${whatsappDigits(customerPhone)}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 rounded-lg border border-emerald-400/35 bg-emerald-950/40 px-2 py-1 text-[11px] font-semibold text-emerald-100 transition hover:bg-emerald-900/50"
                title="Escribir por WhatsApp"
              >
                <Phone size={12} aria-hidden />
                WhatsApp
              </a>
              <a
                href={`tel:${customerPhone.replace(/\s/g, '')}`}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-500/40 bg-slate-900/60 px-2 py-1 text-[11px] font-semibold text-slate-200 transition hover:bg-slate-800/70"
                title="Llamar"
              >
                Llamar
              </a>
            </div>
          ) : null}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div>
              <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Producto
              </p>
              <p className="mt-0.5 mb-0 text-sm font-semibold text-violet-100">{pkg}</p>
            </div>
            <div>
              <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Fecha de compra
              </p>
              <p className="mt-0.5 mb-0 text-sm text-slate-200">{purchaseLabel || '—'}</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
              FAC-{String(item?.sale_id ?? '').padStart(4, '0')}
            </span>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function formatPortalAssignedAt(iso) {
  const raw = String(iso ?? '').trim()
  if (!raw) return null
  try {
    return formatDateTimeEcuador(raw)
  } catch {
    return raw
  }
}

function PortalScreenCredentialRow({ label, value, flashKey, copyFlashKey, onCopy }) {
  const val = String(value ?? '').trim()
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[13px]">
      <span className="text-slate-400">{label}:</span>
      <span className="break-all font-semibold text-white">{val || '—'}</span>
      {val ? (
        <button
          type="button"
          onClick={() => void onCopy(val, flashKey)}
          className="inline-flex items-center rounded-md border border-white/15 bg-white/5 p-1 text-slate-300 transition hover:bg-white/10 hover:text-white"
          title={copyFlashKey === flashKey ? '¡Copiado!' : `Copiar ${label.toLowerCase()}`}
          aria-label={`Copiar ${label}`}
        >
          <Copy size={14} aria-hidden />
        </button>
      ) : null}
      {copyFlashKey === flashKey ? (
        <span className="text-[11px] font-medium text-emerald-300">¡Copiado!</span>
      ) : null}
    </div>
  )
}

const SUB_CLIENT_ACTION_BTN =
  'flex w-full items-center justify-center gap-1 rounded border py-1 px-1.5 text-[10px] leading-tight transition-colors md:inline-flex md:w-auto md:justify-center md:gap-1.5 md:rounded-md md:px-3 md:py-1.5 md:text-sm'

const MOBILE_ACTION_CARD_BASE =
  'flex min-w-0 flex-col items-center justify-center rounded-lg border border-gray-700 bg-gray-800/40 p-2 transition-colors hover:bg-gray-700/50 disabled:cursor-not-allowed disabled:opacity-40'

function SubClientMobileActionCards({
  subclient,
  portalUrl,
  copiedClientId,
  onCopyLink,
  onTransfer,
  onPrices,
  onEdit,
  onDelete,
  deleting,
}) {
  const clientId = Number(subclient?.id)
  const baasBalance = Number(subclient?.wallet_balance) || 0
  const canDelete = baasBalance <= 1e-9
  const isCopied = Number.isFinite(clientId) && copiedClientId === clientId
  const name = String(subclient?.name ?? subclient?.username ?? 'sub-cliente')

  const cards = [
    {
      key: 'edit',
      title: 'Editar',
      sub: 'Modificar datos del cliente',
      color: 'text-yellow-500',
      Icon: Pencil,
      onClick: () => onEdit?.(subclient),
      extraClass: '',
    },
    {
      key: 'transfer',
      title: 'Transferir',
      sub: 'Transferir saldo a distribuidores',
      color: 'text-emerald-500',
      Icon: ArrowLeftRight,
      onClick: () => onTransfer(subclient),
      extraClass: '',
    },
    {
      key: 'prices',
      title: 'Precios',
      sub: 'Asignar y gestionar precios',
      color: 'text-purple-500',
      Icon: Tag,
      onClick: () => void onPrices(subclient),
      extraClass: '',
    },
    {
      key: 'link',
      title: isCopied ? 'Copiado' : 'Link',
      sub: 'Compartir enlace del cliente',
      color: isCopied ? 'text-emerald-400' : 'text-blue-500',
      Icon: Link2,
      onClick: () => void onCopyLink?.(subclient),
      disabled: !portalUrl,
      extraClass: isCopied ? 'border-emerald-700/50 bg-emerald-950/25' : '',
    },
    {
      key: 'delete',
      title: deleting ? '…' : 'Eliminar',
      sub: 'Eliminar cliente de la lista',
      color: 'text-red-500',
      Icon: Trash2,
      onClick: () => {
        if (!canDelete) {
          window.alert('No puedes eliminar un sub-cliente que aún tiene fondos en su billetera.')
          return
        }
        onDelete?.(subclient)
      },
      disabled: !canDelete || deleting,
      extraClass: 'border-red-900/50',
    },
  ]

  return (
    <div className="border-t border-gray-700/50 bg-slate-900/30 px-1 pt-3 md:px-0">
      <div className="grid grid-cols-5 gap-1.5">
        {cards.map(({ key, title, sub, color, Icon, onClick, disabled, extraClass }) => (
          <button
            key={key}
            type="button"
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation()
              onClick?.()
            }}
            className={`${MOBILE_ACTION_CARD_BASE} ${extraClass}`}
            aria-label={`${title} — ${name}`}
            title={sub}
          >
            <Icon className={`mb-1 h-5 w-5 shrink-0 ${color}`} aria-hidden />
            <span className={`text-[10px] font-bold leading-tight ${color}`}>{title}</span>
            <span className="mt-0.5 text-center text-[8px] leading-tight text-gray-400">{sub}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function SubClientActionsCell({
  subclient,
  portalUrl,
  copiedClientId,
  onCopyLink,
  onTransfer,
  onPrices,
  onEdit,
  onDelete,
  deleting,
}) {
  const clientId = Number(subclient?.id)
  const baasBalance = Number(subclient?.wallet_balance) || 0
  const canDelete = baasBalance <= 1e-9
  const isCopied = Number.isFinite(clientId) && copiedClientId === clientId

  return (
    <div className="flex flex-col items-stretch gap-1 md:flex-row md:flex-wrap md:gap-2">
      <button
        type="button"
        onClick={() => onEdit?.(subclient)}
        className={`${SUB_CLIENT_ACTION_BTN} border-amber-400/40 bg-amber-950/20 text-amber-50 hover:border-amber-300/60 hover:bg-amber-900/40`}
        aria-label={`Editar ${String(subclient?.name ?? subclient?.username ?? 'sub-cliente')}`}
      >
        <span aria-hidden>✏️</span>
        <span className="whitespace-nowrap">Editar</span>
      </button>
      <button
        type="button"
        onClick={() => onTransfer(subclient)}
        className={`${SUB_CLIENT_ACTION_BTN} border-emerald-400/40 bg-emerald-950/25 text-emerald-50 hover:border-emerald-300/60 hover:bg-emerald-900/45`}
        aria-label={`Transferir saldo a ${String(subclient?.name ?? subclient?.username ?? 'sub-cliente')}`}
      >
        <ArrowLeftRight className="h-3 w-3 shrink-0" aria-hidden />
        <span className="whitespace-nowrap">Transferir</span>
      </button>
      <button
        type="button"
        onClick={() => void onPrices(subclient)}
        className={`${SUB_CLIENT_ACTION_BTN} border-violet-400/40 bg-violet-950/25 text-violet-50 hover:border-violet-300/60 hover:bg-violet-900/45`}
        aria-label={`Asignar precios a ${String(subclient?.name ?? subclient?.username ?? 'sub-cliente')}`}
      >
        <Tag className="h-3 w-3 shrink-0" aria-hidden />
        <span className="whitespace-nowrap">Precios</span>
      </button>
      {portalUrl ? (
        <button
          type="button"
          onClick={() => void onCopyLink?.(subclient)}
          className={`${SUB_CLIENT_ACTION_BTN} ${
            isCopied
              ? 'border-emerald-400/70 bg-emerald-950/45 text-emerald-100 shadow-[0_0_8px_rgba(52,211,153,0.22)]'
              : 'border-sky-400/40 bg-sky-950/20 text-sky-50 hover:border-sky-300/60 hover:bg-sky-900/40'
          }`}
          title={isCopied ? 'Enlace copiado' : portalUrl}
          aria-label={isCopied ? 'Enlace copiado' : 'Copiar enlace del portal'}
        >
          {!isCopied ? <Link2 className="h-3 w-3 shrink-0" aria-hidden /> : null}
          <span className="whitespace-nowrap">
            {isCopied ? '✅ Copiado' : 'Link'}
          </span>
        </button>
      ) : null}
      <button
        type="button"
        disabled={!canDelete || deleting}
        onClick={() => {
          if (!canDelete) {
            window.alert('No puedes eliminar un sub-cliente que aún tiene fondos en su billetera.')
            return
          }
          onDelete?.(subclient)
        }}
        className={`${SUB_CLIENT_ACTION_BTN} border-red-400/45 bg-red-950/30 text-red-50 hover:border-red-300/60 hover:bg-red-900/45 disabled:cursor-not-allowed disabled:opacity-40`}
        aria-label={`Eliminar ${String(subclient?.name ?? subclient?.username ?? 'sub-cliente')}`}
      >
        <span aria-hidden>🗑️</span>
        <span className="whitespace-nowrap">{deleting ? 'Eliminando…' : 'Eliminar'}</span>
      </button>
    </div>
  )
}

async function copyPortalText(text) {
  const val = String(text ?? '').trim()
  if (!val) return false
  try {
    await navigator.clipboard.writeText(val)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = val
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

function normalizeAutoPurchaseFeedback(res) {
  if (!res || typeof res !== 'object') return null
  const credentials = (Array.isArray(res.credentials) ? res.credentials : [])
    .map(normalizeAutoPurchaseCredential)
    .filter(Boolean)
  const flow = String(res.flow ?? '').trim()
  const fulfilled = flow === 'fulfilled'
  const credentialsMissing =
    res.credentials_missing === true ||
    (fulfilled &&
      (credentials.length === 0 || credentials.every((c) => !c.hasCredentials)))
  return {
    ...res,
    ok: res.ok !== false,
    flow,
    message: String(res.message ?? ''),
    credentials,
    credentialsMissing,
    fulfilled,
  }
}

const PORTAL_REVIEW_SUCCESS_MSG =
  'Tu pago/abono ha sido enviado y está en revisión por un operador.'

const PORTAL_RETIRO_INSTANT_SUCCESS_MSG =
  'Tu pedido fue activado. La deuda CxC quedó por el valor total de la factura; validaremos tu pago con el socio.'

const PORTAL_PAYMENT_REJECTED_MSG =
  'Tu último intento de pago no pudo ser procesado o el código fue marcado como no válido. Por favor, intenta enviar otro comprobante.'

const PORTAL_PAYMENT_BLOCKING_STATUSES = new Set(['pending_review', 'in_review', 'pending'])

function portalPaymentStatusNorm(status) {
  return String(status ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
}

function portalPaymentStatusIsRejected(status) {
  const st = portalPaymentStatusNorm(status)
  return st === 'rejected' || st === 'failed' || st === 'voided'
}

function portalPaymentStatusIsBlocking(status) {
  return PORTAL_PAYMENT_BLOCKING_STATUSES.has(portalPaymentStatusNorm(status))
}

function portalSaleClientPayments(sale) {
  return Array.isArray(sale?.client_payments) ? sale.client_payments : []
}

function portalPaymentEventLooksRejected(event) {
  const evSt = String(event?.status ?? '').toLowerCase()
  return (
    evSt.includes('fallido')
    || evSt.includes('rechaz')
    || evSt.includes('failed')
    || evSt.includes('no válido')
    || evSt.includes('no valido')
  )
}

function portalPaymentEventLooksApproved(event) {
  const evSt = String(event?.status ?? '').toLowerCase()
  return evSt === 'aprobado' || evSt.includes('approved') || evSt.includes('confirmado')
}

function portalPaymentEventIsRetiroActivation(event) {
  const evSt = String(event?.status ?? '').toLowerCase()
  return evSt.includes('activada') && (evSt.includes('códigos de retiro') || evSt.includes('codigos de retiro'))
}

/** Tras activación instantánea CxC, aguarda webhook del socio (sin pago CxC en BD aún). */
function portalSaleAwaitingRetiroWebhook(sale) {
  const events = Array.isArray(sale?.payment_events) ? sale.payment_events : []
  if (events.length === 0) return false

  let sawRetiroActivation = false
  for (const ev of events) {
    if (portalPaymentEventIsRetiroActivation(ev)) sawRetiroActivation = true
    if (portalPaymentEventLooksRejected(ev) || portalPaymentEventLooksApproved(ev)) {
      return false
    }
  }
  if (!sawRetiroActivation) return false

  const payments = portalSaleClientPayments(sale)
  if (payments.some((p) => portalPaymentStatusIsBlocking(p?.status))) return true
  if (payments.some((p) => portalPaymentStatusNorm(p?.status) === 'approved')) return false
  return payments.length === 0
}

function portalSaleHasBlockingPayment(sale) {
  if (portalSaleClientPayments(sale).some((p) => portalPaymentStatusIsBlocking(p?.status))) {
    return true
  }
  if (portalSaleAwaitingRetiroWebhook(sale)) return true
  const st = String(sale?.status ?? '').toLowerCase()
  if (st === 'payment_submitted') {
    return portalSaleClientPayments(sale).some((p) => portalPaymentStatusNorm(p?.status) === 'pending_review')
  }
  return false
}

function portalSaleLastPaymentRejected(sale) {
  const payments = portalSaleClientPayments(sale)
  if (payments.length > 0 && portalPaymentStatusIsRejected(payments[0]?.status)) {
    return true
  }
  const events = Array.isArray(sale?.payment_events) ? sale.payment_events : []
  if (events.length > 0) {
    const lastEv = events[events.length - 1]
    if (portalPaymentEventLooksRejected(lastEv)) return true
  }
  return false
}

function portalCanShowPayFormForSale(sale) {
  return portalSaleOpenBalance(sale) > 1e-9
}

function portalHasBlockingDebtPayment(data) {
  const pending = Array.isArray(data?.pending_debt_payments) ? data.pending_debt_payments : []
  if (pending.some((dp) => portalPaymentStatusIsBlocking(dp?.status))) return true
  return false
}

function portalLastClientPaymentRejected(data) {
  const rows = Array.isArray(data?.recent_client_payments) ? data.recent_client_payments : []
  if (rows.length > 0 && portalPaymentStatusIsRejected(rows[0]?.status)) return true
  return false
}

function portalRechargeHasPaymentsInReview(recharge) {
  const st = String(recharge?.status ?? '').toLowerCase()
  return st === 'in_review' || st === 'pending_review'
}

/** @deprecated Use portalRechargeHasPaymentsInReview for banners; form visibility uses open balance only. */
function portalRechargeHasBlockingPayment(recharge) {
  return portalRechargeHasPaymentsInReview(recharge)
}

function portalCanShowPayFormForRecharge(recharge) {
  return portalRechargeOpenBalance(recharge) > 1e-9
}

function portalRechargeLastPaymentRejected(recharge) {
  const st = String(recharge?.status ?? '').toLowerCase()
  return st === 'rejected' || st === 'failed'
}

function PortalPaymentsInReviewBanner({ message = PORTAL_REVIEW_SUCCESS_MSG }) {
  return (
    <div
      role="status"
      style={{
        marginBottom: 14,
        padding: '12px 14px',
        borderRadius: 14,
        background: 'rgba(34,197,94,0.12)',
        border: '1px solid rgba(52,211,153,0.35)',
        fontSize: 13,
        lineHeight: 1.55,
        color: '#bbf7d0',
      }}
    >
      {message}
    </div>
  )
}

function PortalPaymentRejectedBanner() {
  return (
    <div
      role="alert"
      style={{
        marginBottom: 14,
        padding: '12px 14px',
        borderRadius: 14,
        background: 'rgba(239,68,68,0.12)',
        border: '1px solid rgba(248,113,113,0.35)',
        fontSize: 13,
        lineHeight: 1.55,
        color: '#fecaca',
      }}
    >
      {PORTAL_PAYMENT_REJECTED_MSG}
    </div>
  )
}

/** Saldo abierto de una venta en el portal (prioriza balance_due del backend). */
function portalSaleOpenBalance(sale) {
  const bd = parseMoneyNum(sale?.balance_due)
  if (Number.isFinite(bd) && bd > 1e-9) return bd
  const total = saleInvoiceTotal(sale)
  const paid = Math.max(0, parseMoneyNum(sale?.amount_paid) || 0)
  return Math.max(0, Math.round((total - paid) * 100) / 100)
}

/** Saldo abierto de una recarga BaaS en el portal. */
function portalRechargeOpenBalance(r) {
  const bp = parseMoneyNum(r?.balance_pending)
  if (Number.isFinite(bp) && bp > 1e-9) return bp
  const req = parseMoneyNum(r?.amount_requested)
  const paid = Math.max(0, parseMoneyNum(r?.amount_paid) || 0)
  if (Number.isFinite(req) && req > 1e-9) return Math.max(0, Math.round((req - paid) * 100) / 100)
  return 0
}

/** Pedido cobrable en «Nuevos pedidos para pago»: cualquier venta con saldo pendiente > 0. */
function isPortalNewOrderSale(sale) {
  return portalSaleOpenBalance(sale) > 1e-9
}

/** Estado de formulario de pago por recarga BaaS (key = request id). */
function defaultRechargePayFormState() {
  return {
    method: '',
    account: '',
    amount: '',
    submitting: false,
    error: null,
    success: false,
    aiResult: null,
    analyzing: false,
    dragOver: false,
  }
}

function rechargePayFormFromMap(map, rechargeId) {
  const k = String(rechargeId)
  return map[k] ?? defaultRechargePayFormState()
}

function patchRechargePayForm(setter, rechargeId, patch) {
  const k = String(rechargeId)
  setter((prev) => ({
    ...prev,
    [k]: { ...rechargePayFormFromMap(prev, rechargeId), ...(typeof patch === 'function' ? patch(rechargePayFormFromMap(prev, rechargeId)) : patch) },
  }))
}

/** Recarga BaaS destacada en «Nuevos pedidos»: cualquier solicitud con saldo CxC vivo. */
function isPortalNewOrderWalletRecharge(r) {
  const open = portalRechargeOpenBalance(r)
  if (!(open > 1e-9)) return false
  const st = String(r?.status ?? '').toLowerCase()
  return st !== 'rejected' && st !== 'canceled'
}

/** Deuda real en «Saldo pendiente»: excluye pedidos abiertos del acordeón «Nuevos pedidos». */
function isPortalHistoricalDebtSale(sale) {
  if (isPortalNewOrderSale(sale)) return false
  const st = String(sale?.status ?? '').toLowerCase()
  if (st === 'pending') return false
  const bd = parseMoneyNum(sale?.balance_due)
  return Number.isFinite(bd) && bd > 1e-9
}

/**
 * Recarga BaaS en «Saldo pendiente»: activada con CxC vivo sin abonos parciales en curso.
 * Excluye ``pending`` / ``partially_paid`` (nuevos pedidos) e ``in_review``.
 */
function isPortalHistoricalDebtWalletRecharge(r) {
  if (isPortalNewOrderWalletRecharge(r)) return false
  const st = String(r?.status ?? '').toLowerCase()
  if (st === 'pending' || st === 'in_review') return false
  const bp = parseMoneyNum(r?.balance_pending)
  return Number.isFinite(bp) && bp > 1e-9
}

function filterHistoricalDebtSales(sales) {
  return (Array.isArray(sales) ? sales : []).filter(isPortalHistoricalDebtSale)
}

function filterHistoricalDebtRecharges(recharges) {
  return (Array.isArray(recharges) ? recharges : []).filter(isPortalHistoricalDebtWalletRecharge)
}

function absolutizeMediaUrl(u) {
  if (!u || typeof u !== 'string') return ''
  const t = u.trim()
  if (!t) return ''
  if (t.startsWith('http://') || t.startsWith('https://')) return t
  const base = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')
  return t.startsWith('/') ? `${base}${t}` : `${base}/${t}`
}

/** Normalización para comparar moneda IA vs cuenta (mismo criterio que backend: hasta 10 chars). */
function normalizePortalCurrency(c) {
  if (c == null || String(c).trim() === '') return ''
  return String(c).trim().toUpperCase().slice(0, 10).replace(/\s+/g, '')
}

function filterPortalAccountsByCurrency(accounts, currency) {
  const cur = normalizePortalCurrency(currency) || 'USD'
  const list = Array.isArray(accounts) ? accounts : []
  const filtered = list.filter((d) => normalizePortalCurrency(d?.currency) === cur)
  return filtered.length > 0 ? filtered : list
}

/** Árbol padre→hijas: prioriza métodos de la orden; luego asignación CRM del cliente. */
function buildPortalPaymentTree(data, rowMethods, rowAccounts, currency, rowTree) {
  const fromTree = Array.isArray(rowTree) ? rowTree : []
  if (fromTree.length > 0 && fromTree.some((m) => Array.isArray(m?.deposit_accounts))) {
    return fromTree
      .map((m) => ({
        id: Number(m?.id),
        name: m?.name ?? '',
        deposit_accounts: filterPortalAccountsByCurrency(m?.deposit_accounts, currency),
      }))
      .filter((m) => Number.isFinite(m.id) && (m.deposit_accounts?.length ?? 0) > 0)
  }

  const methods = Array.isArray(rowMethods) ? rowMethods : []
  if (methods.length > 0) {
    const accounts = filterPortalAccountsByCurrency(rowAccounts, currency)
    return methods
      .map((m) => {
        const methodId = Number(m?.id)
        const deposit_accounts = accounts.filter((d) => {
          const depPmId = d?.payment_method_id
          if (depPmId != null && String(depPmId).trim() !== '') {
            return String(depPmId) === String(methodId)
          }
          return false
        })
        return {
          id: methodId,
          name: m?.name ?? '',
          deposit_accounts,
        }
      })
      .filter((m) => Number.isFinite(m.id) && (m.deposit_accounts?.length ?? 0) > 0)
  }

  const assigned = data?.assigned_payment_methods
  if (Array.isArray(assigned) && assigned.length > 0) {
    const hasNested = assigned.some((m) => Array.isArray(m?.deposit_accounts))
    if (hasNested) {
      return assigned
        .map((m) => ({
          id: Number(m?.id),
          name: m?.name ?? '',
          deposit_accounts: filterPortalAccountsByCurrency(m?.deposit_accounts, currency),
        }))
        .filter((m) => Number.isFinite(m.id) && (m.deposit_accounts?.length ?? 0) > 0)
    }
  }

  return []
}

function portalParentMethods(tree) {
  return (Array.isArray(tree) ? tree : [])
    .filter((m) => (m.deposit_accounts?.length || 0) > 0)
    .map(({ id, name }) => ({ id, name }))
}

function portalAccountsForMethod(tree, methodId) {
  if (methodId == null || String(methodId).trim() === '') return []
  const node = (Array.isArray(tree) ? tree : []).find((m) => String(m.id) === String(methodId))
  return Array.isArray(node?.deposit_accounts) ? node.deposit_accounts : []
}

/** @deprecated Usar buildPortalPaymentTree + portalParentMethods */
function resolvePortalPaymentMethods(assignedGlobal, rowMethods) {
  if (Array.isArray(assignedGlobal) && assignedGlobal.length > 0) {
    if (assignedGlobal.some((m) => Array.isArray(m?.deposit_accounts))) {
      return portalParentMethods(assignedGlobal)
    }
    return assignedGlobal
  }
  return Array.isArray(rowMethods) ? rowMethods : []
}

/** @deprecated Usar portalAccountsForMethod sobre el árbol */
function resolvePortalDepositAccounts(assignedGlobal, rowAccounts, currency, methodId) {
  if (Array.isArray(assignedGlobal) && assignedGlobal.length > 0) {
    if (assignedGlobal.some((m) => Array.isArray(m?.deposit_accounts))) {
      return portalAccountsForMethod(assignedGlobal, methodId)
    }
    return filterPortalAccountsByCurrency(assignedGlobal, currency)
  }
  return filterPortalAccountsByCurrency(rowAccounts, currency)
}

/** Saldo a favor CxC en la moneda de la obligación (multimoneda). */
function portalCreditForCurrency(data, creditRows, currency) {
  const cur = normalizePortalCurrency(currency) || 'USD'
  const rows = Array.isArray(creditRows) ? creditRows : []
  const row = rows.find((r) => normalizePortalCurrency(r?.currency) === cur)
  if (row) return Math.max(0, parseMoneyNum(row?.amount) || 0)
  const legacyCur = normalizePortalCurrency(
    data?.credit_balance_currency || data?.available_credit_currency || data?.client?.credit_balance_currency,
  )
  const legacyAmt =
    parseMoneyNum(data?.available_credit) ||
    parseMoneyNum(data?.credit_balance) ||
    parseMoneyNum(data?.client?.available_credit) ||
    parseMoneyNum(data?.client?.credit_balance) ||
    0
  if (legacyCur === cur) return Math.max(0, legacyAmt)
  return 0
}

function portalCurrencyMismatchMessage(extractedCurrency, accountCurrency) {
  const ia = normalizePortalCurrency(extractedCurrency)
  const ac = normalizePortalCurrency(accountCurrency)
  if (!ia || !ac) return null
  if (ia === ac) return null
  return `❌ Moneda incorrecta: El recibo está en ${ia} pero la cuenta seleccionada acepta ${ac}.`
}

/**
 * Mensajes UX antes del botón: qué falta para enviar el abono a deuda (orden típico de llenado).
 * Devuelve texto destacado ("amber") o null si no aplican esas pendencias.
 */
function portalDebtPayMissingHint({
  submitting,
  debtPaymentMethodsLen,
  hasMethod,
  depAccountsLen,
  needsAccountPick,
  accountSelected,
  receiptCount,
  analyzing,
  paidOk,
  hasBlockingCurrencyError,
}) {
  if (submitting) return null
  if (debtPaymentMethodsLen === 0) {
    return '⚠️ No hay métodos de pago disponibles para enviar este abono; contacta al proveedor.'
  }
  if (!hasMethod) return '⚠️ Por favor, selecciona un método de pago arriba.'
  if (depAccountsLen === 0) {
    return '⚠️ No hay cuentas receptoras configuradas; contacta al proveedor antes de enviar.'
  }
  if (needsAccountPick && depAccountsLen > 1 && !String(accountSelected || '').trim()) {
    return '⚠️ Por favor, selecciona la cuenta en la que depositaste.'
  }
  if (receiptCount === 0) return '⚠️ Sube la foto o el PDF de tu comprobante.'
  if (analyzing) return '⚠️ Esperando a que la IA procese el importe del comprobante…'
  if (hasBlockingCurrencyError) return '⚠️ Corrige el error indicado más arriba antes de enviar.'
  if (!paidOk) {
    return '⚠️ No pudimos obtener un importe válido desde el recibo; prueba una imagen JPG o PNG más clara.'
  }
  return null
}

/**
 * Mensajes UX antes del botón: nuevo pedido (portal).
 * @param {boolean} paysOnlyWithCreditBalance — total en efectivo después de aplicar saldo a favor ≤ 0
 */
function portalNewOrderPayMissingHint({
  submitting,
  reservationExpired,
  paysOnlyWithCreditBalance,
  pmListLen,
  hasMethodId,
  needsDepositPick,
  depListLen,
  resolvedDepId,
  totalPayablePositive,
  fileArrLen,
  firstFileMime,
  isAnalyzing,
  paidOk,
  hasBlockingCurrencyError,
}) {
  if (submitting || reservationExpired) return null
  if (!totalPayablePositive) {
    return '⚠️ No hay importe pendiente por pagar en este pedido.'
  }
  if (paysOnlyWithCreditBalance) return null

  if (pmListLen === 0) {
    return '⚠️ No hay métodos de pago habilitados para este pedido; contacta al proveedor.'
  }
  if (!hasMethodId) return '⚠️ Por favor, selecciona un método de pago arriba.'
  if (needsDepositPick && depListLen === 0) {
    return '⚠️ No hay cuentas configuradas para recibir este pago; contacta al proveedor.'
  }
  if (needsDepositPick && depListLen > 1 && !String(resolvedDepId || '').trim()) {
    return '⚠️ Por favor, selecciona la cuenta donde depositaste.'
  }
  if (fileArrLen === 0) return '⚠️ Sube la foto o el PDF de tu comprobante.'
  if (isAnalyzing) return '⚠️ Esperando a que la IA procese el importe del comprobante…'
  if (hasBlockingCurrencyError) return '⚠️ Corrige el error indicado más arriba antes de enviar.'
  if (!paidOk) {
    if (/^application\/pdf$/i.test(firstFileMime || '')) {
      return '⚠️ Con solo PDF la IA no puede leer el importe; sube también una imagen JPG o PNG del mismo comprobante.'
    }
    return '⚠️ No pudimos detectar un importe en el comprobante. Asegúrate de que la imagen sea nítida.'
  }
  return null
}

/** Une resultados de /analyze-receipt (una imagen por comprobante en portal). */
function mergeReceiptAnalysisResults(parts) {
  const list = Array.isArray(parts) ? parts.filter(Boolean) : []
  const readable = list.filter(
    (r) => r?.is_readable && typeof r.extracted_amount === 'number' && Number.isFinite(r.extracted_amount) && r.extracted_amount > 0,
  )
  if (readable.length === 0) {
    const err = list.find((r) => r?._multi_currency || r?.is_readable === false)
    return {
      is_readable: false,
      extracted_amount: null,
      extracted_currency: null,
      amount_matches: null,
      expected_amount: list[0]?.expected_amount ?? null,
      expected_currency: list[0]?.expected_currency ?? null,
      _multi_currency: Boolean(list.some((x) => x?._multi_currency)),
    }
  }
  const curSet = new Set(readable.map((r) => normalizePortalCurrency(r.extracted_currency)).filter(Boolean))
  if (curSet.size > 1) {
    return {
      is_readable: false,
      extracted_amount: null,
      extracted_currency: readable[0]?.extracted_currency ?? null,
      amount_matches: null,
      expected_amount: readable[0]?.expected_amount ?? null,
      expected_currency: readable[0]?.expected_currency ?? null,
      _multi_currency: true,
    }
  }
  const first = readable[0]
  return {
    is_readable: true,
    extracted_amount: first.extracted_amount,
    extracted_currency: normalizePortalCurrency(first.extracted_currency) || first.extracted_currency,
    amount_matches: first.amount_matches ?? null,
    expected_amount: first.expected_amount ?? null,
    expected_currency: first.expected_currency ?? null,
  }
}

function revokeThumbnailList(urlArr) {
  if (!Array.isArray(urlArr)) return
  for (const u of urlArr) {
    if (u) {
      try {
        URL.revokeObjectURL(u)
      } catch {
        /* noop */
      }
    }
  }
}

function lineRowsForSale(sale) {
  if (Array.isArray(sale?.lines) && sale.lines.length > 0) return sale.lines
  if (Array.isArray(sale?.items) && sale.items.length > 0) return sale.items
  return []
}

/** Una línea: cantidad × precio (misma regla que el total de factura). */
function lineQtyPriceSubtotal(line) {
  if (line == null) return { qty: 1, rate: 0, subtotal: 0 }
  const qtyRaw = line.quantity ?? line.qty
  const unitRaw = line.price ?? line.unit_price ?? line.rate
  let qty = qtyRaw == null || qtyRaw === '' ? 1 : Number(qtyRaw)
  let rate = unitRaw == null || unitRaw === '' ? 0 : Number(unitRaw)
  if (!Number.isFinite(qty)) qty = parseMoneyNum(qtyRaw)
  if (!Number.isFinite(qty)) qty = 1
  if (!Number.isFinite(rate)) rate = parseMoneyNum(unitRaw)
  if (!Number.isFinite(rate)) rate = 0
  const subtotal = Math.round(qty * rate * 100) / 100
  return { qty, rate, subtotal }
}

/**
 * Total factura: si hay líneas, suma qty × precio unitario; si no, montos raíz del API.
 */
function saleInvoiceTotal(sale) {
  const rows = lineRowsForSale(sale)
  if (rows.length > 0) {
    const sum = rows.reduce((acc, line) => acc + lineQtyPriceSubtotal(line).subtotal, 0)
    return Math.round(sum * 100) / 100
  }
  for (const key of ['amount', 'total_amount', 'total', 'local_amount']) {
    const n = parseMoneyNum(sale?.[key])
    if (Number.isFinite(n)) return Math.round(n * 100) / 100
  }
  return 0
}

/** Referencia FAC-0042 → id 42 */
function parseLedgerFacSaleId(reference) {
  const m = String(reference ?? '').match(/^FAC-(\d+)$/i)
  if (!m) return NaN
  return Number(m[1])
}

function ledgerInvoiceSaleId(row) {
  if (row?.sale_id != null && row.sale_id !== '') {
    const n = Number(row.sale_id)
    if (Number.isFinite(n)) return n
  }
  return parseLedgerFacSaleId(row?.reference)
}

function ledgerPaymentTouchesSale(row, saleId) {
  const sid = Number(saleId)
  if (!Number.isFinite(sid)) return false
  const linked = Array.isArray(row?.linked_sale_ids)
    ? row.linked_sale_ids.map((x) => Number(x)).filter(Number.isFinite)
    : []
  if (linked.includes(sid)) return true
  const desc = String(row?.description ?? '')
  const meta = desc.match(/META_SALE_ID=(\d+)/)
  if (meta && Number(meta[1]) === sid) return true
  const origin = desc.match(/ORIGIN_SALE_REF=(\d+)/)
  if (origin && Number(origin[1]) === sid) return true
  return false
}

function portalLedgerSortTs(row) {
  const raw = row?.date
  if (!raw) return 0
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : 0
}

/** Facturas/pedidos con deuda histórica (excluye ``new_order_sales`` / ``pending`` inicial). */
function collectOpenDebtSales(data) {
  const lists = [
    data?.historical_debt_sales,
    data?.outstanding_sales,
    data?.pending_sales,
  ]
  const byId = new Map()
  for (const arr of lists) {
    if (!Array.isArray(arr)) continue
    for (const s of arr) {
      const bd = parseMoneyNum(s?.balance_due)
      if (!Number.isFinite(bd) || bd <= 1e-9) continue
      const id = Number(s.sale_id)
      if (!Number.isFinite(id)) continue
      const prev = byId.get(id)
      const taRaw = s?.invoice_created_at
      const ta = taRaw ? Date.parse(String(taRaw)) : NaN
      const tbRaw = prev?.invoice_created_at
      const tb = tbRaw ? Date.parse(String(tbRaw)) : NaN
      if (!prev || (Number.isFinite(ta) && (!Number.isFinite(tb) || ta >= tb))) {
        byId.set(id, s)
      }
    }
  }
  return [...byId.values()].sort((a, b) => {
    const da = a?.invoice_created_at ? Date.parse(String(a.invoice_created_at)) : 0
    const db = b?.invoice_created_at ? Date.parse(String(b.invoice_created_at)) : 0
    if (db !== da) return db - da
    return Number(b.sale_id) - Number(a.sale_id)
  })
}

/** Pagos aún no «aprobados» en CxC (visible solo desde eventos del pedido portal). */
function pendingReviewPaymentRowsFromSaleEvents(sale) {
  const evs = Array.isArray(sale?.payment_events) ? sale.payment_events : []
  const sid = Number(sale?.sale_id)
  const out = []
  for (let i = 0; i < evs.length; i += 1) {
    const ev = evs[i]
    const st = String(ev?.status ?? '')
    if (/aprobado/i.test(st)) continue
    const amt = parseMoneyNum(ev.amount)
    if (!Number.isFinite(amt) || amt < 1e-9) continue
    const iso = typeof ev.occurred_at === 'string' ? ev.occurred_at : null
    const curRaw = sale?.currency
    const cur =
      curRaw != null && String(curRaw).trim().length >= 3
        ? String(curRaw).trim().toUpperCase().slice(0, 10)
        : ev.currency != null && String(ev.currency).trim().length >= 3
          ? String(ev.currency).trim().toUpperCase().slice(0, 10)
          : 'USD'
    out.push({
      type: 'payment',
      date: iso,
      description: st ? `${st} (pedido portal)` : 'Movimiento de pago (pedido portal)',
      reference: `MOV-${Number.isFinite(sid) ? sid : '—'}-${i}`,
      amount: amt,
      currency: cur,
      status: st || 'Registrado',
      sale_id: null,
      linked_sale_ids: Number.isFinite(sid) ? [sid] : [],
    })
  }
  return out
}

/** Factura portal que aún no aparece en el ledger histórico (p. ej. pedido sin activar). */
function syntheticInvoiceLedgerRow(sale) {
  const sid = Number(sale?.sale_id)
  if (!Number.isFinite(sid)) return null
  const total = saleInvoiceTotal(sale)
  const rows = lineRowsForSale(sale)
  const bits = []
  if (rows.length > 0) {
    const names = rows.map((ln) => String(ln.description ?? ln.name ?? ln.product_name ?? '').trim()).filter(Boolean)
    if (names.length) bits.push(names.slice(0, 4).join(' · '))
  }
  const description =
    bits.length > 0 ? String(bits.join('')).slice(0, 260) : 'Factura / pedido con saldo pendiente'
  const st = String(sale?.status ?? '')
  let label = 'Factura pendiente'
  if (st === 'pending') label = 'Pedido pendiente de activación'
  else if (st === 'payment_submitted') label = 'En revisión (comprobante enviado)'
  else if (st === 'partially_paid') label = 'Pago parcial'
  const iso = sale?.invoice_created_at ? String(sale.invoice_created_at) : null
  const curRaw = sale?.currency
  const cur =
    curRaw != null && String(curRaw).trim().length >= 3
      ? String(curRaw).trim().toUpperCase().slice(0, 10)
      : 'USD'
  return {
    type: 'invoice',
    date: iso,
    description,
    reference: `FAC-${String(sid).padStart(4, '0')}`,
    amount: Math.round(total * 100) / 100,
    currency: cur,
    status: label,
    sale_id: sid,
    linked_sale_ids: [],
  }
}

/** Igual convención que el ERP (`REC-00023`). */
function walletRechargeLedgerRef(requestId) {
  const n = Number(requestId)
  if (!Number.isFinite(n) || n < 1) return 'REC—'
  return `REC-${String(Math.trunc(n)).padStart(5, '0')}`
}

/**
 * Suma saldos pendientes por moneda: facturas/pedidos (``balance_due``) +
 * solicitudes de recarga BaaS abiertas (``balance_pending``).
 */
function aggregateAllPendingDebtByCurrency(openDebtSalesSorted, walletRechargeRows) {
  const m = {}
  for (const s of filterHistoricalDebtSales(openDebtSalesSorted)) {
    const bd = parseMoneyNum(s?.balance_due)
    if (!Number.isFinite(bd) || bd <= 1e-9) continue
    const curRaw = s?.currency
    const cur =
      curRaw != null && String(curRaw).trim().length >= 3
        ? String(curRaw).trim().toUpperCase().slice(0, 10)
        : 'USD'
    m[cur] = (m[cur] || 0) + bd
  }
  for (const r of filterHistoricalDebtRecharges(walletRechargeRows)) {
    const bp = parseMoneyNum(r?.balance_pending)
    if (!Number.isFinite(bp) || bp <= 1e-9) continue
    const curRaw = r?.recharge_currency
    const cur =
      curRaw != null && String(curRaw).trim().length >= 3
        ? String(curRaw).trim().toUpperCase().slice(0, 10)
        : 'USD'
    m[cur] = (m[cur] || 0) + bp
  }
  return Object.keys(m)
    .sort()
    .map((currency) => ({ currency, amount: Math.round((m[currency] || 0) * 100) / 100 }))
}

/** Estado de cuenta mínimo para una recarga cuando no hay líneas en el ledger ERP. */
function syntheticRechargeLedgerRows(row) {
  const rid = Number(row?.id)
  if (!Number.isFinite(rid)) return []
  const cur =
    row?.recharge_currency != null && String(row.recharge_currency).trim().length >= 3
      ? String(row.recharge_currency).trim().toUpperCase().slice(0, 10)
      : 'USD'
  const total = Math.round(parseMoneyNum(row?.amount_requested) * 100) / 100
  const iso = row?.created_at ? String(row.created_at) : null
  const st = String(row?.status || '').toLowerCase()
  let statusLabel = 'Estado pendiente'
  if (st === 'pending') statusLabel = 'Pendiente de pago'
  else if (st === 'partially_paid') statusLabel = 'Pago parcial'
  else if (st === 'in_review') statusLabel = 'En revisión'
  else if (st === 'approved') statusLabel = 'Activado'
  else if (st === 'rejected') statusLabel = 'Rechazado'
  else if (row?.status) statusLabel = String(row.status)

  const refStr = walletRechargeLedgerRef(rid)
  return [
    {
      type: 'invoice',
      date: iso,
      description:
        total > 0
          ? `Recarga de saldo BaaS (importe total de la solicitud: ${total} ${cur}).`
          : 'Recarga de saldo BaaS.',
      reference: refStr,
      amount: total,
      currency: cur,
      status: statusLabel,
      sale_id: null,
      linked_sale_ids: [],
    },
  ]
}

function IconUploadCloud() {
  return (
    <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M7 18a4.6 4.6 0 0 1 0 -9 5 5 0 0 1 9.584 2" />
      <path d="M7 13a4 4 0 0 0 .585 7.957" />
      <path d="M12 12v9" />
      <path d="M9 16l3 -3 3 3" />
    </svg>
  )
}

/**
 * Tarjeta neón «Resumen del pedido» — misma estructura para ventas y recarga BaaS (portal).
 */
function PortalNeoOrderSummaryCard({
  pricingBreakdownSlot,
  headlineAmountFormatted,
  headlineCaption = 'Total a pagar',
  countdownMmSs,
  countdownUrgent = false,
  partialBadge,
  detailLinesSlot,
  footerText,
}) {
  return (
    <div className={`portal-order-summary-glow-wrap ${PORTAL_SECTION_SHELL_CLASS} mb-4 md:mb-6`}>
      <section className="portal-order-summary-card w-full min-w-0">
        <div className="portal-order-summary-circuit-overlay" aria-hidden />
        <div className="portal-order-summary-inner border-b border-white/10 px-3 pb-4 pt-4 md:px-5 md:pb-5 md:pt-5">
          <p className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Resumen del pedido
          </p>
          {pricingBreakdownSlot ?? null}
          <div className="flex min-w-0 items-start justify-between gap-3 sm:gap-4">
            <div className="min-w-0 flex-1 break-words">
              <p className="text-2xl font-semibold tracking-tight text-white break-words sm:text-3xl md:text-[2rem]">{headlineAmountFormatted}</p>
              <p className="mt-1.5 text-sm text-slate-400 break-words">{headlineCaption}</p>
            </div>
            <div className="portal-order-summary-hud shrink-0">
              {countdownMmSs ? (
                <span
                  className={`portal-order-summary-digits ${
                    countdownUrgent ? 'portal-order-summary-digits--urgent' : ''
                  }`}
                >
                  {countdownMmSs}
                </span>
              ) : null}
              {partialBadge ? (
                <span className="portal-order-summary-badge portal-order-summary-badge--partial">PARCIAL</span>
              ) : (
                <span className="portal-order-summary-digits--pending-status font-mono text-xs font-bold tracking-widest sm:text-sm">
                  PENDIENTE
                </span>
              )}
            </div>
          </div>
        </div>
        {detailLinesSlot ?? null}
        {footerText != null && String(footerText).trim() !== '' ? (
          <p className="portal-order-summary-inner break-words border-t border-white/10 px-3 pb-4 pt-3 text-xs text-slate-500 md:px-5">
            {footerText}
          </p>
        ) : null}
      </section>
    </div>
  )
}

/**
 * Acordeón neón oscuro (portal público): cabecera amplia táctil + panel con grid animado.
 * @param {'violet' | 'emerald' | 'sapphire'} accent
 */
function PortalNeoAccordion({
  sectionId,
  title,
  subtitle,
  headerAside,
  expanded,
  onToggle,
  accent = 'violet',
  children,
}) {
  const presets = {
    violet: {
      wrap: 'border-2 border-violet-400/45 bg-gradient-to-br from-[rgba(76,29,149,0.48)] via-[rgba(30,58,138,0.34)] to-[rgba(14,21,41,0.72)] shadow-[inset_0_1px_0_rgba(224,231,255,0.1),0_22px_48px_rgba(0,0,0,0.38)]',
      wash: 'bg-gradient-to-br from-violet-400/35 via-transparent to-cyan-400/20',
      title: 'text-violet-100',
      aside: 'text-fuchsia-100',
      divider: 'border-violet-300/22',
      chevron: 'text-violet-200',
    },
    emerald: {
      wrap: 'border border-emerald-400/38 bg-emerald-950/[0.2] shadow-[inset_0_1px_0_rgba(167,243,208,0.1),0_20px_48px_rgba(0,0,0,0.36)]',
      wash: 'bg-gradient-to-br from-emerald-400/26 via-transparent to-teal-500/16',
      title: 'text-emerald-100',
      aside: 'text-teal-100',
      divider: 'border-emerald-400/26',
      chevron: 'text-emerald-200',
    },
    sapphire: {
      wrap: 'border border-indigo-400/42 bg-gradient-to-br from-[rgba(30,27,112,0.42)] via-slate-950/60 to-[rgba(13,43,71,0.55)] shadow-[inset_0_1px_0_rgba(199,210,254,0.08),0_20px_48px_rgba(0,0,0,0.36)]',
      wash: 'bg-gradient-to-br from-indigo-400/28 via-transparent to-sky-500/18',
      title: 'text-indigo-100',
      aside: 'text-sky-100',
      divider: 'border-indigo-300/28',
      chevron: 'text-indigo-200',
    },
  }
  const p = presets[accent] ?? presets.violet

  return (
    <section className={`${PORTAL_SECTION_SHELL_CLASS} relative mb-4 overflow-hidden rounded-[20px] transition-all duration-300 md:mb-6 md:rounded-[22px] ${p.wrap}`}>
      <div aria-hidden className={`pointer-events-none absolute inset-0 rounded-[inherit] opacity-95 ${p.wash}`} />
      <button
        type="button"
        id={`${sectionId}-hdr`}
        aria-expanded={expanded}
        aria-controls={`${sectionId}-panel`}
        onClick={onToggle}
        className={`relative z-[1] flex min-h-[48px] w-full touch-manipulation flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-3.5 text-left transition-all duration-300 hover:bg-white/[0.055] active:bg-white/[0.085] focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/55 md:px-[18px] md:py-4 ${p.divider} border-b border-opacity-70`}
      >
        <div className="min-w-0 flex-1 pr-2">
          <p className={`m-0 break-words text-[11px] font-extrabold uppercase leading-tight tracking-[0.16em] ${p.title} sm:text-xs`}>{title}</p>
          {subtitle ?
            <p className="m-1.5 mb-0 break-words text-[13px] font-medium leading-snug text-slate-200/82">{subtitle}</p>
          : null}
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {headerAside != null &&
          (typeof headerAside === 'string' ? String(headerAside).length > 0 : true) ? (
            typeof headerAside === 'string' ? (
              <span
                title={headerAside}
                className={`max-w-[9.5rem] truncate whitespace-normal break-words text-right text-sm font-bold leading-snug sm:max-w-[16rem] sm:text-[16px] sm:leading-tight md:max-w-none ${p.aside} tabular-nums tracking-tight`}
              >
                {headerAside}
              </span>
            ) : (
              headerAside
            )
          ) : null}
          <ChevronDown
            aria-hidden
            size={22}
            strokeWidth={2.35}
            className={`mt-0.5 shrink-0 opacity-[0.92] transition-transform duration-300 ease-out ${p.chevron} ${expanded ? 'rotate-180' : ''}`}
          />
        </div>
      </button>
      <div
        id={`${sectionId}-panel`}
        role="region"
        aria-labelledby={`${sectionId}-hdr`}
        className={`relative z-[1] grid transition-all duration-300 ease-out ${expanded ? 'overflow-x-hidden overflow-y-visible' : 'overflow-hidden'}`}
        style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
      >
        <div className="min-h-0 min-w-0">
          <div className="px-3 pb-5 pt-4 transition-all duration-300 ease-out md:px-[18px] md:pb-6 md:pt-5">{children}</div>
        </div>
      </div>
    </section>
  )
}

function isAccountBlockedError(err) {
  return err?.response?.status === 403 && err?.response?.data?.detail === 'ACCOUNT_BLOCKED'
}

export default function ClientPortalPage() {
  return (
    <PortalPageErrorBoundary>
      <ClientPortalPageInner />
    </PortalPageErrorBoundary>
  )
}

class PortalPageErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className={PORTAL_PAGE_ROOT_CLASS}>
          <div className={`${PORTAL_PAGE_MAIN_CLASS} py-12`}>
            <div className="rounded-[20px] border border-red-400/35 bg-slate-900/85 px-4 py-7 text-center md:px-6 md:py-8">
            <p style={{ margin: 0, fontSize: 16, fontWeight: 650, color: '#fecaca' }}>
              No pudimos mostrar el portal en este momento.
            </p>
            <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.55, color: '#94a3b8' }}>
              Recarga la página. Si el problema continúa, contacta a tu proveedor.
            </p>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function ClientPortalPageInner() {
  const { token } = useParams()
  const api = useMemo(() => publicApi(), [])

  const [data, setData] = useState(null)
  const [cxcBalance, setCxcBalance] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [isBlocked, setIsBlocked] = useState(false)

  const [payMethodBySale, setPayMethodBySale] = useState({})
  const [payAccountBySale, setPayAccountBySale] = useState({})
  const [receiptFilesBySale, setReceiptFilesBySale] = useState({})
  const [thumbnailUrlsBySale, setThumbnailUrlsBySale] = useState({})
  const receiptFilesRef = useRef({})
  receiptFilesRef.current = receiptFilesBySale
  const [dragOverBySale, setDragOverBySale] = useState({})
  const [submittingSaleId, setSubmittingSaleId] = useState(null)
  const [submitErrorBySale, setSubmitErrorBySale] = useState({})
  const [successBySale, setSuccessBySale] = useState({})
  const [analyzingBySale, setAnalyzingBySale] = useState({})
  const [aiResultBySale, setAiResultBySale] = useState({})
  const [paidAmountBySale, setPaidAmountBySale] = useState({})

  // ── Debt payment form (abono CxC) ───────────────────────────────────────────
  const [debtForm, setDebtForm] = useState({
    method: '',
    account: '',
    amount: '',
    submitting: false,
    error: null,
    success: false,
    aiResult: null,
    analyzing: false,
    dragOver: false,
  })
  const [debtReceiptFiles, setDebtReceiptFiles] = useState([])
  const debtReceiptFilesRef = useRef([])
  debtReceiptFilesRef.current = debtReceiptFiles
  const [debtReceiptThumbUrls, setDebtReceiptThumbUrls] = useState([])

  /** Comprobantes por recarga BaaS (key = request id). */
  const [receiptFilesByRecharge, setReceiptFilesByRecharge] = useState({})
  const receiptFilesByRechargeRef = useRef({})
  receiptFilesByRechargeRef.current = receiptFilesByRecharge
  const [receiptThumbUrlsByRecharge, setReceiptThumbUrlsByRecharge] = useState({})
  const [rechargeFormById, setRechargeFormById] = useState({})
  const [payMethodByRecharge, setPayMethodByRecharge] = useState({})
  const [payAccountByRecharge, setPayAccountByRecharge] = useState({})

  const [portalClock, setPortalClock] = useState(0)

  /** Handler activo del widget Códigos de Retiro (prioridad: deuda → recarga → pedido). */
  const retiroSlotRef = useRef(null)
  const retiroInFlightRef = useRef(false)
  const [retiroSubmittingKey, setRetiroSubmittingKey] = useState(null)
  const [retiroSuccessByScope, setRetiroSuccessByScope] = useState(null)
  const featuredWalletRechargeRowRef = useRef(null)
  const newOrderWalletRechargesRef = useRef([])

  useEffect(() => {
    const onMessage = (event) => {
      if (!isRetiroCompletadoMessage(event)) return

      const normalized = normalizeRetiroPostMessageData(event.data)
      if (!normalized || normalized.tipo !== 'RETIRO_COMPLETADO') return

      const monto = extractRetiroMonto(normalized)
      if (!Number.isFinite(monto) || monto <= 0) {
        console.warn('[Portal] RETIRO_COMPLETADO sin monto válido (se continúa con activación):', normalized)
      }

      const handler = retiroSlotRef.current
      if (!handler) {
        console.warn('[Portal] RETIRO_COMPLETADO recibido sin formulario de pago activo.')
        return
      }
      if (retiroInFlightRef.current) return

      const payload = parseRetiroCompletadoPayload(normalized)
      retiroInFlightRef.current = true
      Promise.resolve(handler({ ...payload, monto }))
        .catch((err) => {
          console.error('[Portal] Error procesando RETIRO_COMPLETADO:', err)
        })
        .finally(() => {
          retiroInFlightRef.current = false
        })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  /** Acordeón «Estado de cuenta» (historial público). */
  const [ledgerOpen, setLedgerOpen] = useState(false)

  /** Paneles principales del portal (acordeones; billetera ya no usa acordeón). */
  const [isBaasOpen, setIsBaasOpen] = useState(true)
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false)
  const [isActiveScreensOpen, setIsActiveScreensOpen] = useState(false)
  const [activeScreensPage, setActiveScreensPage] = useState(1)
  const [isTrackedPurchasesOpen, setIsTrackedPurchasesOpen] = useState(false)
  const [trackedPurchases, setTrackedPurchases] = useState([])
  const [trackedPurchasesLoading, setTrackedPurchasesLoading] = useState(false)
  const [trackedPurchasesErr, setTrackedPurchasesErr] = useState(null)
  const [activeTab, setActiveTab] = useState('todos')
  const [misComprasPage, setMisComprasPage] = useState(1)
  const [expandedMisComprasKey, setExpandedMisComprasKey] = useState(null)
  const [accordionDebtOpen, setAccordionDebtOpen] = useState(true)
  const [accordionOrdersOpen, setAccordionOrdersOpen] = useState(true)
  const [copyFlashKey, setCopyFlashKey] = useState(null)

  /** Obligación enfocada: factura FAC-… o recarga REC-… (clave `sale:id` | `wr:id`). */
  const [ledgerFocusKey, setLedgerFocusKey] = useState('')

  /** Recargas saldo BaaS (portal público). */
  const [walletRecharges, setWalletRecharges] = useState([])
  const [walletRechargesErr, setWalletRechargesErr] = useState(null)
  const [walletRechargePatchById, setWalletRechargePatchById] = useState({})
  const [autoPurchaseProducts, setAutoPurchaseProducts] = useState([])
  const [autoPurchaseLoading, setAutoPurchaseLoading] = useState(false)
  const [autoPurchaseErr, setAutoPurchaseErr] = useState(null)
  const [autoPurchaseBusyId, setAutoPurchaseBusyId] = useState(null)
  const [autoPurchaseFeedback, setAutoPurchaseFeedback] = useState(null)
  const [autoPurchaseQtyByPackageId, setAutoPurchaseQtyByPackageId] = useState({})
  /** Detalle pendiente de confirmación antes de descontar saldo BaaS. */
  const [confirmingPurchase, setConfirmingPurchase] = useState(null)

  const [isResellerNetworkOpen, setIsResellerNetworkOpen] = useState(false)
  const [subClients, setSubClients] = useState([])
  const [subClientsLoading, setSubClientsLoading] = useState(false)
  const [subClientsErr, setSubClientsErr] = useState(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [activeFilter, setActiveFilter] = useState('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [expandedClientId, setExpandedClientId] = useState(null)
  const [deletingSubClientId, setDeletingSubClientId] = useState(null)
  const [copiedClientId, setCopiedClientId] = useState(null)
  const copySubClientLinkTimerRef = useRef(null)
  const [deleteSubClientTarget, setDeleteSubClientTarget] = useState(null)
  const [deleteSubClientStep, setDeleteSubClientStep] = useState('warn')
  const [deleteSubClientErr, setDeleteSubClientErr] = useState(null)
  const [portalNotifications, setPortalNotifications] = useState([])
  const [portalNotificationsLoading, setPortalNotificationsLoading] = useState(false)
  const [portalNotificationsErr, setPortalNotificationsErr] = useState(null)
  const [markingNotificationId, setMarkingNotificationId] = useState(null)
  const [createSubClientOpen, setCreateSubClientOpen] = useState(false)
  const [createSubClientBusy, setCreateSubClientBusy] = useState(false)
  const [createSubClientErr, setCreateSubClientErr] = useState(null)
  const [createSubClientForm, setCreateSubClientForm] = useState({
    username: '',
    email: '',
    name: '',
    phone: '',
  })
  const [createSubClientPackages, setCreateSubClientPackages] = useState([])
  const [createSubClientPackagesLoading, setCreateSubClientPackagesLoading] = useState(false)
  const [createSubClientPriceDraft, setCreateSubClientPriceDraft] = useState({})
  const [createSubClientPriceFieldErr, setCreateSubClientPriceFieldErr] = useState({})
  const [createSubClientInitialTransfer, setCreateSubClientInitialTransfer] = useState('')
  const [createSubClientInitialTransferErr, setCreateSubClientInitialTransferErr] = useState(null)
  const [createSubClientFormErrors, setCreateSubClientFormErrors] = useState([])
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false)
  const [transferStep, setTransferStep] = useState('form')
  const [transferTarget, setTransferTarget] = useState(null)
  const [transferAmount, setTransferAmount] = useState('')
  const [transferBusy, setTransferBusy] = useState(false)
  const [transferErr, setTransferErr] = useState(null)
  const [editSubClientOpen, setEditSubClientOpen] = useState(false)
  const [editSubClientTarget, setEditSubClientTarget] = useState(null)
  const [editSubClientBusy, setEditSubClientBusy] = useState(false)
  const [editSubClientErr, setEditSubClientErr] = useState(null)
  const [editSubClientForm, setEditSubClientForm] = useState({ name: '', email: '', phone: '' })
  const [pricingTarget, setPricingTarget] = useState(null)
  const [pricingRows, setPricingRows] = useState([])
  const [pricingLoading, setPricingLoading] = useState(false)
  const [pricingBusy, setPricingBusy] = useState(false)
  const [pricingErr, setPricingErr] = useState(null)
  const [pricingDraft, setPricingDraft] = useState({})
  const [contactModalOpen, setContactModalOpen] = useState(false)
  const [contactDialCode, setContactDialCode] = useState('+593')
  const [contactLocalNumber, setContactLocalNumber] = useState('')
  const [contactSaving, setContactSaving] = useState(false)
  const [contactErr, setContactErr] = useState(null)

  const phoneCountryOptions = useMemo(() => phoneCountrySelectOptions(), [])

  const collapseAllSections = useCallback(() => {
    setIsNotificationsOpen(false)
    setIsBaasOpen(false)
    setIsActiveScreensOpen(false)
    setIsTrackedPurchasesOpen(false)
    setIsResellerNetworkOpen(false)
    setAccordionDebtOpen(false)
    setAccordionOrdersOpen(false)
    setLedgerOpen(false)
    setExpandedMisComprasKey(null)
  }, [])

  const loadPortal = useCallback(async (opts = {}) => {
    const silent = Boolean(opts?.silent)
    if (!token) {
      setLoadError('Enlace incompleto.')
      setLoading(false)
      return
    }
    if (!silent) {
      setLoading(true)
      setLoadError(null)
    }
    try {
      const [portalRes, cxcRes] = await Promise.all([
        api.get(`/api/v1/portal/${token}`),
        api.get(`/api/v1/portal/${encodeURIComponent(token)}/cxc-balance`).catch(() => null),
      ])
      setData(portalRes.data)
      setCxcBalance(cxcRes?.data ?? null)
      setIsBlocked(false)
    } catch (err) {
      if (isAccountBlockedError(err)) {
        setIsBlocked(true)
        setLoadError(null)
        setData(null)
        setCxcBalance(null)
      } else if (!silent) {
        const d = err?.response?.data?.detail
        setLoadError(typeof d === 'string' ? d : 'No se pudo cargar el portal.')
        setData(null)
        setCxcBalance(null)
      }
    } finally {
      if (!silent) setLoading(false)
    }
  }, [api, token])

  const loadWalletRecharges = useCallback(async () => {
    if (!token) return
    setWalletRechargesErr(null)
    try {
      const { data: rows } = await api.get(`/api/v1/portal/${encodeURIComponent(token)}/recharges`)
      setWalletRecharges(Array.isArray(rows) ? rows : [])
    } catch (err) {
      const d = err?.response?.data?.detail
      setWalletRechargesErr(typeof d === 'string' ? d : 'No se pudieron cargar las solicitudes de recarga.')
      setWalletRecharges([])
    }
  }, [api, token])

  const loadAutoPurchaseCatalog = useCallback(async () => {
    if (!token) return
    setAutoPurchaseLoading(true)
    setAutoPurchaseErr(null)
    try {
      const { data: rows } = await api.get(
        `/api/v1/portal/${encodeURIComponent(token)}/auto-purchase/catalog`,
      )
      setAutoPurchaseProducts(Array.isArray(rows) ? rows : [])
    } catch (err) {
      const d = err?.response?.data?.detail
      setAutoPurchaseErr(typeof d === 'string' ? d : 'No se pudo cargar el catálogo de compra.')
      setAutoPurchaseProducts([])
    } finally {
      setAutoPurchaseLoading(false)
    }
  }, [api, token])

  const loadTrackedPurchases = useCallback(async () => {
    if (!token) return
    setTrackedPurchasesLoading(true)
    setTrackedPurchasesErr(null)
    try {
      const { data: rows } = await api.get(
        `/api/v1/portal/${encodeURIComponent(token)}/tracked-purchases`,
      )
      setTrackedPurchases(Array.isArray(rows) ? rows : [])
    } catch (err) {
      const d = err?.response?.data?.detail
      setTrackedPurchasesErr(typeof d === 'string' ? d : 'No se pudieron cargar tus compras con seguimiento.')
      setTrackedPurchases([])
    } finally {
      setTrackedPurchasesLoading(false)
    }
  }, [api, token])

  const loadSubClients = useCallback(async () => {
    if (!token) return
    setSubClientsLoading(true)
    setSubClientsErr(null)
    try {
      const { data: rows } = await api.get(`/api/v1/portal/${encodeURIComponent(token)}/sub-clients`)
      setSubClients(Array.isArray(rows) ? rows : [])
    } catch (err) {
      const d = err?.response?.data?.detail
      setSubClientsErr(typeof d === 'string' ? d : 'No se pudo cargar tu red de clientes.')
      setSubClients([])
    } finally {
      setSubClientsLoading(false)
    }
  }, [api, token])

  const loadPortalNotifications = useCallback(async () => {
    if (!token) return
    setPortalNotificationsLoading(true)
    setPortalNotificationsErr(null)
    try {
      const { data: rows } = await api.get(
        `/api/v1/portal/${encodeURIComponent(token)}/notifications`,
      )
      setPortalNotifications(Array.isArray(rows) ? rows : [])
    } catch (err) {
      const d = err?.response?.data?.detail
      setPortalNotificationsErr(typeof d === 'string' ? d : 'No se pudieron cargar las notificaciones.')
      setPortalNotifications([])
    } finally {
      setPortalNotificationsLoading(false)
    }
  }, [api, token])

  const markPortalNotificationRead = useCallback(
    async (notificationId) => {
      if (!token || !notificationId) return
      const nid = Number(notificationId)
      setMarkingNotificationId(nid)
      try {
        const { data } = await api.put(
          `/api/v1/portal/${encodeURIComponent(token)}/notifications/${nid}/read`,
        )
        setPortalNotifications((prev) => {
          if (!Array.isArray(prev)) return prev
          return prev.map((row) =>
            Number(row?.id) === nid ? { ...row, is_read: data?.is_read ?? true } : row,
          )
        })
      } catch (err) {
        const d = err?.response?.data?.detail
        window.alert(typeof d === 'string' ? d : 'No se pudo marcar como leída.')
      } finally {
        setMarkingNotificationId(null)
      }
    },
    [api, token],
  )

  const clientBaseCurrency = useMemo(() => {
    const fromClient = data?.client?.currency
    if (fromClient != null && String(fromClient).trim().length >= 3) {
      return String(fromClient).trim().toUpperCase().slice(0, 10)
    }
    const wb = data?.client?.wallet_balance_currency
    if (wb != null && String(wb).trim().length >= 3) {
      return String(wb).trim().toUpperCase().slice(0, 10)
    }
    return 'USD'
  }, [data?.client?.currency, data?.client?.wallet_balance_currency])

  const assignedPricesMap = useMemo(() => {
    const out = {}
    const fromHome = data?.precios_asignados
    if (fromHome && typeof fromHome === 'object') {
      for (const [key, val] of Object.entries(fromHome)) {
        const n = parseMoneyNum(val)
        if (Number.isFinite(n) && n > 0) out[String(key)] = n
      }
    }
    const rows = Array.isArray(data?.assigned_package_prices) ? data.assigned_package_prices : []
    for (const row of rows) {
      const pid = String(row?.package_catalog_id ?? '')
      const n = parseMoneyNum(row?.precio_venta_local)
      if (pid && Number.isFinite(n) && n > 0) out[pid] = n
    }
    for (const p of autoPurchaseProducts) {
      const pid = String(p?.package_catalog_id ?? '')
      const n = portalSaleUnitPrice(p, out, clientBaseCurrency)
      if (pid && Number.isFinite(n) && n > 0 && out[pid] == null) out[pid] = n
    }
    return out
  }, [
    data?.precios_asignados,
    data?.assigned_package_prices,
    autoPurchaseProducts,
    clientBaseCurrency,
  ])

  const validateCreateSubClientPrice = useCallback(
    (pkg, rawValue) => {
      const floor = parentPackageAcquisitionPrice(pkg, assignedPricesMap)
      const raw = String(rawValue ?? '').trim()
      if (!raw) return 'Precio obligatorio.'
      const price = parseMoneyNum(raw)
      if (!Number.isFinite(price) || price <= 0) return 'Ingresa un precio válido.'
      if (price + 1e-9 < floor) {
        return `El precio no puede ser menor a tu costo de adquisición de ${formatMoney(floor, clientBaseCurrency)}`
      }
      return null
    },
    [clientBaseCurrency, assignedPricesMap],
  )

  const parentBaasBalanceForCreate = useMemo(() => {
    const rows = data?.client?.wallet_balances_by_currency ?? data?.wallet_balances_by_currency ?? []
    const row = rows.find(
      (r) =>
        String(r?.currency || '')
          .trim()
          .toUpperCase()
          .slice(0, 10) === clientBaseCurrency,
    )
    if (row) return parseMoneyNum(row.amount) || 0
    const apiCur = String(data?.client?.wallet_balance_currency || '')
      .trim()
      .toUpperCase()
      .slice(0, 10)
    if (apiCur === clientBaseCurrency) {
      const n = parseMoneyNum(data?.client?.wallet_balance)
      return Number.isFinite(n) ? n : 0
    }
    return 0
  }, [data, clientBaseCurrency])

  const validateCreateSubClientInitialTransfer = useCallback(
    (rawValue, parentBalance = parentBaasBalanceForCreate) => {
      const raw = String(rawValue ?? '').trim()
      if (!raw) return 'La transferencia inicial es obligatoria.'
      const amt = parseMoneyNum(raw)
      if (!Number.isFinite(amt) || amt <= 0) return 'Ingresa un monto mayor a cero.'
      if (amt > parentBalance + 1e-9) {
        return `El monto no puede superar tu saldo BaaS (${formatMoney(parentBalance, clientBaseCurrency)}).`
      }
      return null
    },
    [parentBaasBalanceForCreate, clientBaseCurrency],
  )

  const collectCreateSubClientFormErrors = useCallback(() => {
    const errors = []
    const u = createSubClientForm.username.trim()
    const em = createSubClientForm.email.trim()
    if (!u) errors.push('Usuario IPTV obligatorio.')
    if (!em) errors.push('Email obligatorio.')

    if (createSubClientPackagesLoading) {
      errors.push('Espera a que carguen los paquetes autorizados.')
    } else if (createSubClientPackages.length === 0) {
      errors.push('No tienes paquetes autorizados para asignar precios.')
    }

    let missingAnyPrice = false
    for (const pkg of createSubClientPackages) {
      const pid = String(pkg?.package_catalog_id)
      const raw = String(createSubClientPriceDraft[pid] ?? '').trim()
      const pkgName = String(pkg?.display_name || pkg?.package_label || 'Paquete').trim() || 'Paquete'
      const floor = parentPackageAcquisitionPrice(pkg, assignedPricesMap)

      if (!raw) {
        missingAnyPrice = true
        continue
      }

      const price = parseMoneyNum(raw)
      if (!Number.isFinite(price) || price <= 0) {
        errors.push(`El precio de ${pkgName} no es válido.`)
      } else if (price + 1e-9 < floor) {
        errors.push(
          `El precio de ${pkgName} no puede ser menor a tu costo (${formatMoney(floor, clientBaseCurrency)}).`,
        )
      }
    }
    if (missingAnyPrice) {
      errors.push('Debes asignar un precio de venta para todos los paquetes.')
    }

    const transferRaw = String(createSubClientInitialTransfer ?? '').trim()
    if (!transferRaw) {
      errors.push('La transferencia inicial de saldo BaaS es obligatoria.')
    } else {
      const amt = parseMoneyNum(transferRaw)
      if (!Number.isFinite(amt) || amt <= 0) {
        errors.push('La transferencia inicial debe ser mayor a cero.')
      } else if (amt > parentBaasBalanceForCreate + 1e-9) {
        errors.push(
          `La transferencia no puede superar tu saldo BaaS (${formatMoney(parentBaasBalanceForCreate, clientBaseCurrency)}).`,
        )
      }
    }

    return errors
  }, [
    createSubClientForm.username,
    createSubClientForm.email,
    createSubClientPackages,
    createSubClientPackagesLoading,
    createSubClientPriceDraft,
    createSubClientInitialTransfer,
    parentBaasBalanceForCreate,
    clientBaseCurrency,
    assignedPricesMap,
  ])

  const handleCreateSubClientSubmit = useCallback(
    async (e) => {
      e.preventDefault()
      if (!token) return

      setCreateSubClientFormErrors([])
      const validationErrors = collectCreateSubClientFormErrors()
      if (validationErrors.length > 0) {
        setCreateSubClientFormErrors(validationErrors)
        return
      }

      const u = createSubClientForm.username.trim()
      const em = createSubClientForm.email.trim()
      const prices = createSubClientPackages.map((pkg) => ({
        package_catalog_id: Number(pkg.package_catalog_id),
        product_id: Number(pkg.product_id),
        custom_price: parseMoneyNum(createSubClientPriceDraft[String(pkg.package_catalog_id)]),
      }))
      const initialTransferAmount = parseMoneyNum(createSubClientInitialTransfer)

      setCreateSubClientBusy(true)
      setCreateSubClientErr(null)
      try {
        await api.post(`/api/v1/portal/${encodeURIComponent(token)}/sub-clients`, {
          username: u,
          email: em,
          name: createSubClientForm.name.trim() || null,
          phone: createSubClientForm.phone.trim() || null,
          prices,
          initial_transfer_amount: initialTransferAmount,
        })
        setCreateSubClientOpen(false)
        setCreateSubClientFormErrors([])
        setCurrentPage(1)
        await Promise.all([loadSubClients(), loadPortal({ silent: true })])
      } catch (err) {
        const d = err?.response?.data?.detail
        setCreateSubClientErr(typeof d === 'string' ? d : 'No se pudo crear el sub-cliente.')
      } finally {
        setCreateSubClientBusy(false)
      }
    },
    [
      api,
      token,
      collectCreateSubClientFormErrors,
      createSubClientForm,
      createSubClientPackages,
      createSubClientPriceDraft,
      createSubClientInitialTransfer,
      loadSubClients,
      loadPortal,
    ],
  )

  const openCreateSubClientModal = useCallback(async () => {
    if (!token) return
    setCreateSubClientErr(null)
    setCreateSubClientForm({ username: '', email: '', name: '', phone: '' })
    setCreateSubClientPriceDraft({})
    setCreateSubClientPriceFieldErr({})
    setCreateSubClientInitialTransfer('')
    setCreateSubClientInitialTransferErr(null)
    setCreateSubClientFormErrors([])
    setCreateSubClientPackages([])
    setCreateSubClientOpen(true)
    setCreateSubClientPackagesLoading(true)
    try {
      const { data: rows } = await api.get(
        `/api/v1/portal/${encodeURIComponent(token)}/selling-packages`,
      )
      const list = Array.isArray(rows) ? rows : []
      setCreateSubClientPackages(
        list.map((pkg) => {
          const pid = String(pkg?.package_catalog_id ?? '')
          const fromAssigned = parseMoneyNum(assignedPricesMap?.[pid])
          const localFromApi = parseMoneyNum(pkg?.parent_floor_price_local)
          const resolvedLocal =
            Number.isFinite(fromAssigned) && fromAssigned > 0
              ? fromAssigned
              : Number.isFinite(localFromApi) && localFromApi > 0
                ? localFromApi
                : null
          return resolvedLocal != null
            ? { ...pkg, parent_floor_price_local: resolvedLocal }
            : pkg
        }),
      )
      setCreateSubClientPriceDraft({})
    } catch (err) {
      const d = err?.response?.data?.detail
      setCreateSubClientErr(
        typeof d === 'string' ? d : 'No se pudieron cargar tus paquetes autorizados.',
      )
      setCreateSubClientPackages([])
    } finally {
      setCreateSubClientPackagesLoading(false)
    }
  }, [api, token, assignedPricesMap])

  const createSubClientCanSubmit = useMemo(() => {
    if (createSubClientBusy || createSubClientPackagesLoading) return false
    return createSubClientPackages.length > 0
  }, [createSubClientBusy, createSubClientPackages, createSubClientPackagesLoading])

  const openTransferModal = useCallback((subclient) => {
    if (!subclient) return
    setTransferErr(null)
    setTransferAmount('')
    setTransferStep('form')
    setTransferTarget(subclient)
    setIsTransferModalOpen(true)
  }, [])

  const closeTransferModal = useCallback(
    (force = false) => {
      if (!force && transferBusy) return
      setIsTransferModalOpen(false)
      setTransferTarget(null)
      setTransferErr(null)
      setTransferAmount('')
      setTransferStep('form')
    },
    [transferBusy],
  )

  const openEditSubClientModal = useCallback((subclient) => {
    if (!subclient) return
    setEditSubClientErr(null)
    setEditSubClientTarget(subclient)
    setEditSubClientForm({
      name: String(subclient?.name ?? '').trim(),
      email: String(subclient?.email ?? '').trim(),
      phone: String(subclient?.phone ?? '').trim(),
    })
    setEditSubClientOpen(true)
  }, [])

  const closeEditSubClientModal = useCallback(
    (force = false) => {
      if (!force && editSubClientBusy) return
      setEditSubClientOpen(false)
      setEditSubClientTarget(null)
      setEditSubClientErr(null)
      setEditSubClientForm({ name: '', email: '', phone: '' })
    },
    [editSubClientBusy],
  )

  useEffect(() => {
    return () => {
      if (copySubClientLinkTimerRef.current) clearTimeout(copySubClientLinkTimerRef.current)
    }
  }, [])

  const handleCopySubClientPortalLink = useCallback(async (subclient) => {
    const sid = Number(subclient?.id)
    const url = clientPortalPublicUrl(subclient?.portal_token)
    if (!url || !Number.isFinite(sid)) return
    let ok = false
    try {
      await navigator.clipboard.writeText(url)
      ok = true
    } catch {
      ok = await copyPortalText(url)
    }
    if (!ok) return
    setCopiedClientId(sid)
    if (copySubClientLinkTimerRef.current) clearTimeout(copySubClientLinkTimerRef.current)
    copySubClientLinkTimerRef.current = setTimeout(() => setCopiedClientId(null), 2000)
  }, [])

  const openDeleteSubClientModal = useCallback((subclient) => {
    if (!subclient) return
    const bal = Number(subclient?.wallet_balance) || 0
    if (bal > 1e-9) {
      window.alert('No puedes eliminar un sub-cliente que aún tiene fondos en su billetera.')
      return
    }
    setDeleteSubClientErr(null)
    setDeleteSubClientStep('warn')
    setDeleteSubClientTarget(subclient)
  }, [])

  const closeDeleteSubClientModal = useCallback(
    (force = false) => {
      if (!force && deletingSubClientId != null) return
      setDeleteSubClientTarget(null)
      setDeleteSubClientStep('warn')
      setDeleteSubClientErr(null)
    },
    [deletingSubClientId],
  )

  const executeDeleteSubClient = useCallback(async () => {
    if (!token || !deleteSubClientTarget?.id) return
    const sid = Number(deleteSubClientTarget.id)
    setDeletingSubClientId(sid)
    setDeleteSubClientErr(null)
    try {
      await api.delete(`/api/v1/portal/${encodeURIComponent(token)}/sub-clients/${sid}`)
      closeDeleteSubClientModal(true)
      await loadSubClients()
      setCurrentPage(1)
    } catch (err) {
      const d = err?.response?.data?.detail
      setDeleteSubClientErr(typeof d === 'string' ? d : 'No se pudo eliminar el sub-cliente.')
    } finally {
      setDeletingSubClientId(null)
    }
  }, [api, token, deleteSubClientTarget, closeDeleteSubClientModal, loadSubClients])

  const openPricesModal = useCallback(
    async (subclient) => {
      if (!token || !subclient?.id) return
      setPricingTarget(subclient)
      setPricingErr(null)
      setPricingLoading(true)
      setPricingRows([])
      setPricingDraft({})
      try {
        const { data: rows } = await api.get(
          `/api/v1/portal/${encodeURIComponent(token)}/assign-prices`,
          { params: { child_client_id: Number(subclient.id) } },
        )
        const list = Array.isArray(rows) ? rows : []
        setPricingRows(list)
        const draft = {}
        list.forEach((r) => {
          const pid = String(r?.package_catalog_id)
          const val = r?.child_custom_price ?? ''
          draft[pid] = val === '' || val == null ? '' : String(val)
        })
        setPricingDraft(draft)
      } catch (err) {
        const d = err?.response?.data?.detail
        setPricingErr(typeof d === 'string' ? d : 'No se pudo cargar la matriz de precios.')
      } finally {
        setPricingLoading(false)
      }
    },
    [api, token],
  )

  const executeConfirmedAutoPurchase = useCallback(async (options = {}) => {
    const pending = confirmingPurchase
    if (!pending || !token) return
    const pkgId = Number(pending.packageCatalogId)
    const qty = Math.max(1, Math.min(200, parseInt(String(pending.quantity ?? 1), 10) || 1))
    if (!Number.isFinite(pkgId)) return

    const withTracking = !options.noTracking && pending.step === 'tracking'
    let endCustomerName = null
    let endCustomerPhone = null
    if (withTracking) {
      endCustomerName = String(pending.endCustomerName ?? '').trim()
      endCustomerPhone = mergePhoneParts(
        pending.endCustomerDialCode ?? '+593',
        pending.endCustomerLocalNumber ?? '',
      )
      if (!endCustomerName) {
        setConfirmingPurchase((prev) =>
          prev ? { ...prev, trackingErr: 'Ingresa el nombre del cliente o usuario.' } : prev,
        )
        return
      }
      if (!endCustomerPhone || endCustomerPhone.length < 10) {
        setConfirmingPurchase((prev) =>
          prev ? { ...prev, trackingErr: 'Ingresa un número de teléfono válido.' } : prev,
        )
        return
      }
    }

    setAutoPurchaseBusyId(pkgId)
    setAutoPurchaseFeedback(null)
    try {
      const payload = { package_catalog_id: pkgId, quantity: qty }
      if (withTracking) {
        payload.end_customer_name = endCustomerName
        payload.end_customer_phone = endCustomerPhone
      }
      const { data: res } = await api.post(
        `/api/v1/portal/${encodeURIComponent(token)}/auto-purchase`,
        payload,
      )
      setConfirmingPurchase(null)
      setAutoPurchaseFeedback(normalizeAutoPurchaseFeedback(res))
      await loadPortal()
      await loadAutoPurchaseCatalog()
      if (isTrackedPurchasesOpen) await loadTrackedPurchases()
    } catch (err) {
      const d = err?.response?.data?.detail
      setConfirmingPurchase(null)
      setAutoPurchaseFeedback({
        ok: false,
        message: typeof d === 'string' ? d : 'No se pudo completar la compra.',
      })
    } finally {
      setAutoPurchaseBusyId(null)
    }
  }, [
    api,
    token,
    loadPortal,
    loadAutoPurchaseCatalog,
    confirmingPurchase,
    isTrackedPurchasesOpen,
    loadTrackedPurchases,
  ])

  useEffect(() => {
    loadPortal()
  }, [loadPortal])

  useEffect(() => {
    if (!token || loading || loadError || !data || isBlocked) return undefined
    loadWalletRecharges()
    loadAutoPurchaseCatalog()
    loadPortalNotifications()
    return undefined
  }, [
    token,
    loading,
    loadError,
    data,
    isBlocked,
    loadWalletRecharges,
    loadAutoPurchaseCatalog,
    loadPortalNotifications,
  ])

  useEffect(() => {
    if (!isResellerNetworkOpen || !token) return undefined
    void loadSubClients()
    return undefined
  }, [isResellerNetworkOpen, token, loadSubClients])

  useEffect(() => {
    if (!isTrackedPurchasesOpen || !token) return undefined
    void loadTrackedPurchases()
    return undefined
  }, [isTrackedPurchasesOpen, token, loadTrackedPurchases])

  useEffect(() => {
    if (loading || !data) return undefined
    const id = setInterval(() => setPortalClock((c) => c + 1), 1000)
    return () => clearInterval(id)
  }, [loading, data])

  const newOrderSales = Array.isArray(data?.new_order_sales) ? data.new_order_sales : []
  const historicalDebtSales = Array.isArray(data?.historical_debt_sales) ? data.historical_debt_sales : []
  const walletRechargesDisplay = useMemo(() => {
    const fromHome = Array.isArray(data?.outstanding_wallet_recharges) ? data.outstanding_wallet_recharges : []
    const fromFetch = Array.isArray(walletRecharges) ? walletRecharges : []
    const merged = new Map()
    for (const r of fromHome) {
      const id = Number(r?.id)
      if (Number.isFinite(id)) merged.set(id, r)
    }
    for (const r of fromFetch) {
      const id = Number(r?.id)
      if (Number.isFinite(id)) merged.set(id, r)
    }
    const base = [...merged.values()].sort((a, b) => {
      const ta = a?.created_at ? new Date(a.created_at).getTime() : 0
      const tb = b?.created_at ? new Date(b.created_at).getTime() : 0
      return tb - ta
    })
    return base.map((r) => {
      const pid = Number(r?.id)
      const patch = Number.isFinite(pid) ? walletRechargePatchById[pid] : null
      return {
        ...r,
        status: patch?.status ?? r.status,
      }
    })
  }, [data?.outstanding_wallet_recharges, walletRecharges, walletRechargePatchById])

  const ordersToShow = useMemo(
    () => newOrderSales.filter((s) => isPortalNewOrderSale(s)),
    [newOrderSales],
  )

  /** Todas las recargas BaaS abiertas en «Nuevos pedidos para pago». */
  const newOrderWalletRecharges = useMemo(() => {
    const xs = Array.isArray(walletRechargesDisplay) ? walletRechargesDisplay : []
    return xs.filter((r) => isPortalNewOrderWalletRecharge(r))
  }, [walletRechargesDisplay])

  newOrderWalletRechargesRef.current = newOrderWalletRecharges
  featuredWalletRechargeRowRef.current = newOrderWalletRecharges[0] ?? null

  useEffect(() => {
    if (!data) return

    const sales = [
      ...(Array.isArray(data.new_order_sales) ? data.new_order_sales : []),
      ...(Array.isArray(data.historical_debt_sales) ? data.historical_debt_sales : []),
      ...(Array.isArray(data.outstanding_sales) ? data.outstanding_sales : []),
    ]

    setSuccessBySale((prev) => {
      let changed = false
      const next = { ...prev }
      for (const sale of sales) {
        const sid = Number(sale?.sale_id)
        if (!Number.isFinite(sid)) continue
        if (prev[sid] && !portalSaleHasBlockingPayment(sale)) {
          delete next[sid]
          changed = true
        }
      }
      return changed ? next : prev
    })

    setRetiroSuccessByScope((prev) => {
      if (!prev?.scope) return prev
      if (prev.scope === 'debt') {
        return portalHasBlockingDebtPayment(data) ? prev : null
      }
      if (prev.scope === 'featured' || /^recharge:\d+$/.test(String(prev.scope))) {
        const m = /^recharge:(\d+)$/.exec(String(prev.scope))
        const fr =
          m ?
            (newOrderWalletRechargesRef.current || []).find((r) => Number(r.id) === Number(m[1]))
          : featuredWalletRechargeRowRef.current
        if (fr && portalRechargeHasBlockingPayment(fr)) return prev
        return null
      }
      const m = /^sale:(\d+)$/.exec(String(prev.scope))
      if (m) {
        const sid = Number(m[1])
        const sale = sales.find((s) => Number(s.sale_id) === sid)
        if (sale && portalSaleHasBlockingPayment(sale)) return prev
        return null
      }
      return prev
    })

    if (!portalHasBlockingDebtPayment(data)) {
      setDebtForm((p) => (p.success ? { ...p, success: false } : p))
    }

    for (const fr of newOrderWalletRechargesRef.current || []) {
      const rid = Number(fr?.id)
      if (!Number.isFinite(rid)) continue
      if (!portalRechargeHasBlockingPayment(fr)) {
        setRechargeFormById((prev) => {
          const cur = rechargePayFormFromMap(prev, rid)
          if (!cur.success) return prev
          return { ...prev, [String(rid)]: { ...cur, success: false } }
        })
      }
    }
  }, [data, newOrderWalletRecharges])

  useEffect(() => {
    if (!token || !data) return undefined
    const sales = [
      ...(Array.isArray(data.new_order_sales) ? data.new_order_sales : []),
      ...(Array.isArray(data.historical_debt_sales) ? data.historical_debt_sales : []),
    ]
    const rechargeAwaiting = (newOrderWalletRechargesRef.current || []).some(
      (r) => portalRechargeHasBlockingPayment(r) || rechargePayFormFromMap(rechargeFormById, r?.id).success,
    )
    const awaitingWebhook =
      Object.keys(successBySale).length > 0
      || Boolean(retiroSuccessByScope?.scope)
      || Boolean(debtForm.success)
      || rechargeAwaiting
      || sales.some((s) => portalSaleHasBlockingPayment(s))
      || portalHasBlockingDebtPayment(data)
    if (!awaitingWebhook) return undefined
    const id = setInterval(() => {
      void loadPortal({ silent: true })
    }, 15000)
    return () => clearInterval(id)
  }, [
    token,
    data,
    successBySale,
    retiroSuccessByScope,
    debtForm.success,
    rechargeFormById,
    newOrderWalletRecharges,
    loadPortal,
  ])

  const primaryNewOrder = ordersToShow[0] ?? null
  const hasNewOrders = ordersToShow.length > 0 || newOrderWalletRecharges.length > 0

  /** Saldo pendiente distinto del histórico (pedidos nuevos en portal). */
  const hasUnpaidNewOrderBalance = useMemo(() => {
    if (!Array.isArray(newOrderSales) || newOrderSales.length === 0) return false
    return newOrderSales.some((sale) => {
      const tot = saleInvoiceTotal(sale)
      const paid = Math.max(0, parseMoneyNum(sale?.amount_paid) || 0)
      return Math.round((tot - paid) * 100) / 100 > 1e-9
    })
  }, [newOrderSales])

  const portalCreditCurrencyLabel = useMemo(() => {
    const h0 =
      historicalDebtSales[0]?.currency ??
      ordersToShow[0]?.currency ??
      newOrderSales[0]?.currency
    const s = h0 != null ? String(h0).trim() : ''
    return s.length >= 3 ? s.toUpperCase().slice(0, 10) : 'USD'
  }, [historicalDebtSales, ordersToShow, newOrderSales])

  /** Saldo a favor CxC por moneda (anticipos / sobrepagos). */
  const creditRowsDisplay = useMemo(() => {
    if (!data) return []
    const raw =
      data.available_credit_by_currency ??
      data.credit_balances_by_currency ??
      data.client?.credit_balances_by_currency ??
      []
    if (Array.isArray(raw) && raw.length > 0) {
      return raw
        .map((row) => ({
          currency: String(row?.currency || 'USD').trim().toUpperCase().slice(0, 10),
          amount: parseMoneyNum(row?.amount) || 0,
        }))
        .filter((row) => row.amount > 1e-9)
    }
    const legacy = parseMoneyNum(data?.credit_balance) || 0
    if (legacy > 1e-9) {
      const cur =
        String(data?.credit_balance_currency || portalCreditCurrencyLabel || 'USD')
          .trim()
          .toUpperCase()
          .slice(0, 10) || 'USD'
      return [{ currency: cur, amount: legacy }]
    }
    return []
  }, [data, portalCreditCurrencyLabel])

  const clientCreditBalanceNum = useMemo(() => {
    if (creditRowsDisplay.length > 0) {
      return creditRowsDisplay.reduce((s, r) => s + (Number(r.amount) || 0), 0)
    }
    const legacy =
      parseMoneyNum(data?.available_credit) ||
      parseMoneyNum(data?.credit_balance) ||
      parseMoneyNum(data?.client?.available_credit) ||
      parseMoneyNum(data?.client?.credit_balance) ||
      0
    return legacy > 1e-9 ? legacy : 0
  }, [creditRowsDisplay, data])

  const showSaldoAFavorCard = clientCreditBalanceNum > 1e-9

  const totalCreditLabel = useMemo(() => {
    if (!data || creditRowsDisplay.length === 0) return ''
    if (creditRowsDisplay.length === 1) {
      const r = creditRowsDisplay[0]
      return formatMoney(r.amount, String(r.currency))
    }
    return creditRowsDisplay
      .map((r) => formatMoney(r.amount, String(r.currency)))
      .join(' · ')
  }, [data, creditRowsDisplay])

  const walletRowsDisplay = useMemo(() => {
    if (!data) return []
    const raw =
      data.client?.wallet_balances_by_currency ?? data.wallet_balances_by_currency ?? []
    if (Array.isArray(raw) && raw.length > 0) {
      return raw
        .map((row) => ({
          currency: String(row?.currency || 'USD')
            .trim()
            .toUpperCase()
            .slice(0, 10),
          amount: parseMoneyNum(row?.amount) || 0,
        }))
        .filter((row) => row.amount > 1e-9)
    }
    const legacy = parseMoneyNum(data?.client?.wallet_balance)
    if (legacy > 1e-9) {
      const cur =
        String(data?.client?.wallet_balance_currency || portalCreditCurrencyLabel || 'USD')
          .trim()
          .toUpperCase()
          .slice(0, 10) || 'USD'
      return [{ currency: cur, amount: legacy }]
    }
    return []
  }, [data, portalCreditCurrencyLabel])

  const portalWalletCurrencyLabel = useMemo(() => {
    const fromClient = data?.client?.currency
    if (fromClient != null && String(fromClient).trim().length >= 3) {
      return String(fromClient).trim().toUpperCase().slice(0, 10)
    }
    const openRecharge = filterHistoricalDebtRecharges(walletRechargesDisplay).find(
      (r) => parseMoneyNum(r?.balance_pending) > 1e-9,
    )
    if (openRecharge?.recharge_currency) {
      return String(openRecharge.recharge_currency).trim().toUpperCase().slice(0, 10)
    }
    const fromApi = data?.client?.wallet_balance_currency
    if (fromApi && String(fromApi).trim().length >= 3) {
      return String(fromApi).trim().toUpperCase().slice(0, 10)
    }
    if (walletRowsDisplay.length === 1) return walletRowsDisplay[0].currency
    if (walletRowsDisplay.length > 1) {
      return walletRowsDisplay.reduce((best, row) =>
        row.amount > best.amount ? row : best,
      ).currency
    }
    return clientBaseCurrency
  }, [walletRowsDisplay, walletRechargesDisplay, data, portalCreditCurrencyLabel, clientBaseCurrency])

  const clientWalletBalanceNum = useMemo(() => {
    const row = walletRowsDisplay.find((r) => r.currency === portalWalletCurrencyLabel)
    if (row) return row.amount
    const raw = data?.client?.wallet_balance
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    return parseMoneyNum(raw) || 0
  }, [walletRowsDisplay, portalWalletCurrencyLabel, data])

  const getClientWalletBalance = useCallback(
    (currency) => {
      const cur =
        String(currency || portalWalletCurrencyLabel || 'USD')
          .trim()
          .toUpperCase()
          .slice(0, 10) || 'USD'
      const row = walletRowsDisplay.find((r) => r.currency === cur)
      if (row) return row.amount
      if (cur === portalWalletCurrencyLabel) return clientWalletBalanceNum
      return 0
    },
    [walletRowsDisplay, portalWalletCurrencyLabel, clientWalletBalanceNum],
  )

  /** Facturas/recargas con saldo vivo (para elegir qué estado de cuenta ver). */
  const pendingLedgerObligations = useMemo(() => {
    if (!data) return []
    const openSalesSorted = filterHistoricalDebtSales(collectOpenDebtSales(data))
    const wr = filterHistoricalDebtRecharges(walletRechargesDisplay)
    const items = []
    for (const s of openSalesSorted) {
      const sid = Number(s.sale_id)
      const bd = parseMoneyNum(s.balance_due)
      if (!Number.isFinite(sid) || !Number.isFinite(bd) || bd <= 1e-9) continue
      const taRaw = s?.invoice_created_at
      const sortTs = taRaw ? Date.parse(String(taRaw)) : 0
      const curRaw = s?.currency
      const cur =
        curRaw != null && String(curRaw).trim().length >= 3
          ? String(curRaw).trim().toUpperCase().slice(0, 10)
          : 'USD'
      items.push({
        key: `sale:${sid}`,
        kind: 'sale',
        saleId: sid,
        saleRow: s,
        rechargeRow: null,
        sortTs: Number.isFinite(sortTs) ? sortTs : 0,
        summaryLabel: `Factura FAC-${String(sid).padStart(4, '0')}`,
        pendingAmount: bd,
        currency: cur,
      })
    }
    for (const r of wr) {
      const bp = parseMoneyNum(r?.balance_pending)
      const rid = Number(r?.id)
      if (!Number.isFinite(rid) || !Number.isFinite(bp) || bp <= 1e-9) continue
      const iso = r?.created_at ? String(r.created_at) : null
      const sortTs = iso ? Date.parse(iso) : 0
      const curRaw = r?.recharge_currency
      const cur =
        curRaw != null && String(curRaw).trim().length >= 3
          ? String(curRaw).trim().toUpperCase().slice(0, 10)
          : 'USD'
      items.push({
        key: `wr:${rid}`,
        kind: 'recharge',
        saleId: null,
        saleRow: null,
        rechargeRow: r,
        sortTs: Number.isFinite(sortTs) ? sortTs : 0,
        summaryLabel: `Recarga ${walletRechargeLedgerRef(rid)}`,
        pendingAmount: bp,
        currency: cur,
      })
    }
    items.sort((a, b) => b.sortTs - a.sortTs)
    return items
  }, [data, walletRechargesDisplay])

  useEffect(() => {
    if (!pendingLedgerObligations.length) {
      if (ledgerFocusKey !== '') setLedgerFocusKey('')
      return
    }
    if (!pendingLedgerObligations.some((o) => o.key === ledgerFocusKey)) {
      setLedgerFocusKey(pendingLedgerObligations[0].key)
    }
  }, [pendingLedgerObligations, ledgerFocusKey])

  const effectiveLedgerFocusKey =
    pendingLedgerObligations.find((o) => o.key === ledgerFocusKey)?.key ?? pendingLedgerObligations[0]?.key ?? ''

  const currentDebtPayObligation = useMemo(
    () =>
      pendingLedgerObligations.find((o) => o.key === effectiveLedgerFocusKey) ??
      pendingLedgerObligations[0] ??
      null,
    [pendingLedgerObligations, effectiveLedgerFocusKey],
  )

  const debtPaymentTree = useMemo(() => {
    const o = currentDebtPayObligation
    if (!o) return []
    const rowMethods =
      o.kind === 'recharge'
        ? o.rechargeRow?.allowed_payment_methods
        : o.saleRow?.allowed_payment_methods
    const rowAccounts =
      o.kind === 'recharge'
        ? o.rechargeRow?.allowed_deposit_accounts
        : o.saleRow?.allowed_deposit_accounts
    const rowTree =
      o.kind === 'recharge'
        ? o.rechargeRow?.payment_methods_tree
        : o.saleRow?.payment_methods_tree
    return buildPortalPaymentTree(data, rowMethods, rowAccounts, o.currency, rowTree)
  }, [currentDebtPayObligation, data])

  const debtPaymentMethods = useMemo(
    () => portalParentMethods(debtPaymentTree),
    [debtPaymentTree],
  )

  const debtPaymentAccounts = useMemo(
    () => portalAccountsForMethod(debtPaymentTree, debtForm.method),
    [debtPaymentTree, debtForm.method],
  )

  const debtCurrency = useMemo(() => {
    const o = currentDebtPayObligation
    if (!o?.currency) return 'USD'
    const s = String(o.currency).trim()
    return s.length >= 3 ? s.toUpperCase().slice(0, 10) : 'USD'
  }, [currentDebtPayObligation])

  const portalLedgerDisplay = useMemo(() => {
    if (!effectiveLedgerFocusKey || !data) return []

    if (effectiveLedgerFocusKey.startsWith('wr:')) {
      const rid = Number(effectiveLedgerFocusKey.slice(3))
      const row = (walletRechargesDisplay || []).find((w) => Number(w.id) === rid)
      if (!row) return []
      return syntheticRechargeLedgerRows(row)
        .map((ledgerRow) => ({
          ...ledgerRow,
          amount: typeof ledgerRow.amount === 'number' ? ledgerRow.amount : parseMoneyNum(ledgerRow.amount),
          linked_sale_ids: Array.isArray(ledgerRow.linked_sale_ids) ? ledgerRow.linked_sale_ids : [],
          sale_id: ledgerRow.sale_id != null ? Number(ledgerRow.sale_id) : null,
        }))
        .sort((a, b) => portalLedgerSortTs(b) - portalLedgerSortTs(a))
    }

    if (!effectiveLedgerFocusKey.startsWith('sale:')) return []
    const sid = Number(effectiveLedgerFocusKey.slice(5))
    if (!Number.isFinite(sid)) return []

    const openSorted = filterHistoricalDebtSales(collectOpenDebtSales(data))
    const focusPendingSaleForLedger = openSorted.find((s) => Number(s.sale_id) === sid) ?? null

    const raw = Array.isArray(data.ledger) ? data.ledger : []
    const filtered = raw.filter((row) => {
      if (row.type === 'invoice') return ledgerInvoiceSaleId(row) === sid
      if (row.type === 'payment') return ledgerPaymentTouchesSale(row, sid)
      return false
    })
    const normalized = filtered.map((row) => ({
      ...row,
      amount: typeof row.amount === 'number' ? row.amount : parseMoneyNum(row.amount),
      linked_sale_ids: Array.isArray(row.linked_sale_ids) ? row.linked_sale_ids : [],
      sale_id: row.sale_id != null ? Number(row.sale_id) : null,
    }))
    const hasLedgerInvoice = normalized.some((r) => r.type === 'invoice' && ledgerInvoiceSaleId(r) === sid)
    const synth =
      !hasLedgerInvoice && focusPendingSaleForLedger ? syntheticInvoiceLedgerRow(focusPendingSaleForLedger) : null
    const extras = focusPendingSaleForLedger ? pendingReviewPaymentRowsFromSaleEvents(focusPendingSaleForLedger) : []
    const merged = [...normalized]
    if (synth) merged.push(synth)
    merged.push(...extras)
    merged.sort((a, b) => portalLedgerSortTs(b) - portalLedgerSortTs(a))
    return merged
  }, [effectiveLedgerFocusKey, data, data?.ledger, walletRechargesDisplay])

  const showAccountLedgerSection = pendingLedgerObligations.length > 0

  const debtRowsDisplay = useMemo(() => {
    if (!data) return []
    const openSales = collectOpenDebtSales(data)
    return aggregateAllPendingDebtByCurrency(openSales, walletRechargesDisplay)
  }, [data, walletRechargesDisplay])

  /** Cliente de 1ª línea (sin ``parent_id``): único con CxC / pedidos de pago frente al admin. */
  const isDirectLineClient = useMemo(() => data?.client?.parent_id == null, [data?.client?.parent_id])

  const parentContactPhone = useMemo(
    () => String(data?.parent_contact_phone ?? '').trim() || null,
    [data?.parent_contact_phone],
  )

  const openContactModal = useCallback(() => {
    const ownContact = data?.client?.contact_phone ?? data?.client?.phone
    const parts = splitPhoneParts(ownContact)
    setContactDialCode(parts.dialCode)
    setContactLocalNumber(parts.local)
    setContactErr(null)
    setContactModalOpen(true)
  }, [data?.client?.contact_phone, data?.client?.phone])

  const handleSaveContact = useCallback(async () => {
    const fullPhone = mergePhoneParts(contactDialCode, contactLocalNumber)
    if (!fullPhone || fullPhone.length < 10) {
      setContactErr('Ingresa un número válido con código de país.')
      return
    }
    setContactSaving(true)
    setContactErr(null)
    try {
      const { data: res } = await api.patch(
        `/api/v1/portal/${encodeURIComponent(token)}/contact`,
        { phone: fullPhone },
      )
      const saved = String(res?.contact_phone ?? res?.phone ?? fullPhone).trim()
      setData((prev) =>
        prev
          ? {
              ...prev,
              client: { ...prev.client, contact_phone: saved },
            }
          : prev,
      )
      setContactModalOpen(false)
    } catch (err) {
      const d = err?.response?.data?.detail
      setContactErr(typeof d === 'string' ? d : 'No se pudo guardar el contacto.')
    } finally {
      setContactSaving(false)
    }
  }, [api, contactDialCode, contactLocalNumber, token])

  const showSaldoPendienteSection = useMemo(() => {
    if (!isDirectLineClient) return false
    if (debtRowsDisplay.some((r) => (Number(r?.amount) || 0) > 1e-9)) return true
    return pendingLedgerObligations.length > 0
  }, [debtRowsDisplay, pendingLedgerObligations.length, isDirectLineClient])

  const hasHistoricalDebt = showSaldoPendienteSection

  useEffect(() => {
    const k = currentDebtPayObligation?.key
    if (!k) return undefined
    setDebtReceiptThumbUrls((prev) => {
      revokeThumbnailList(prev)
      return []
    })
    setDebtReceiptFiles([])
    setDebtForm((p) => ({
      ...p,
      method: '',
      account: '',
      amount: '',
      error: null,
      success: false,
      aiResult: null,
      dragOver: false,
    }))
    return undefined
  }, [currentDebtPayObligation?.key])

  const totalDebtLabel = useMemo(() => {
    if (!data) return ''
    const rows = debtRowsDisplay
    const firstCur =
      debtRowsDisplay[0]?.currency && String(debtRowsDisplay[0].currency).trim().length >= 3
        ? String(debtRowsDisplay[0].currency).trim().toUpperCase().slice(0, 10)
        : portalCreditCurrencyLabel || 'USD'
    const cur0 = firstCur
    if (rows.length === 0) return formatMoney(0, cur0)
    if (rows.length === 1) {
      const r = rows[0]
      return formatMoney(r.amount, String(r.currency ?? cur0))
    }
    return rows.map((r) => `${formatMoney(r.amount, String(r.currency ?? 'USD'))}`).join(' · ')
  }, [data, debtRowsDisplay, portalCreditCurrencyLabel])

  const walletAccordionAside = useMemo(() => {
    if (walletRowsDisplay.length > 1) {
      return walletRowsDisplay
        .map((r) => formatMoney(r.amount, r.currency))
        .join(' · ')
    }
    return formatMoney(clientWalletBalanceNum, portalWalletCurrencyLabel)
  }, [walletRowsDisplay, clientWalletBalanceNum, portalWalletCurrencyLabel])

  const ACTIVE_SCREENS_PAGE_SIZE = 5
  const itemsPerPage = 5

  const filteredSubClients = useMemo(() => {
    const list = Array.isArray(subClients) ? subClients : []
    if (activeFilter === 'zeros') {
      return list.filter((sc) => (Number(sc?.wallet_balance) || 0) === 0)
    }
    return list
  }, [subClients, activeFilter])

  const filteredClients = useMemo(() => {
    const q = searchTerm.trim().toLowerCase()
    if (!q) return filteredSubClients
    return filteredSubClients.filter((sc) => {
      const name = String(sc?.name ?? '').toLowerCase()
      const user = String(sc?.username ?? '').toLowerCase()
      return name.includes(q) || user.includes(q)
    })
  }, [filteredSubClients, searchTerm])

  const sortedSubClients = useMemo(() => {
    const list = [...filteredClients]
    list.sort((a, b) => {
      const aCreated = a?.created_at ? new Date(a.created_at).getTime() : NaN
      const bCreated = b?.created_at ? new Date(b.created_at).getTime() : NaN
      if (Number.isFinite(aCreated) && Number.isFinite(bCreated)) {
        return bCreated - aCreated
      }
      return Number(b?.id) - Number(a?.id)
    })
    return list
  }, [filteredClients])

  const zeroBalanceSubClientCount = useMemo(
    () =>
      (Array.isArray(subClients) ? subClients : []).filter(
        (sc) => (Number(sc?.wallet_balance) || 0) === 0,
      ).length,
    [subClients],
  )

  const sortedPortalNotifications = useMemo(() => {
    if (!Array.isArray(portalNotifications)) return []
    return [...portalNotifications].sort((a, b) => {
      const ta = a?.created_at ? new Date(a.created_at).getTime() : 0
      const tb = b?.created_at ? new Date(b.created_at).getTime() : 0
      if (tb !== ta) return tb - ta
      return Number(b?.id ?? 0) - Number(a?.id ?? 0)
    })
  }, [portalNotifications])

  const visiblePortalNotifications = useMemo(
    () => sortedPortalNotifications.slice(0, 3),
    [sortedPortalNotifications],
  )

  const unreadCount = useMemo(
    () => visiblePortalNotifications.filter((n) => !n?.is_read).length,
    [visiblePortalNotifications],
  )

  const notificationsAccordionAside = useMemo(() => {
    if (unreadCount <= 0) return null
    return (
      <span className="inline-flex items-center gap-2">
        <span className="text-red-400 text-sm font-semibold">
          {unreadCount === 1 ? 'Nuevo mensaje' : 'Nuevos mensajes'}
        </span>
        <span
          aria-label={`${unreadCount} notificación${unreadCount !== 1 ? 'es' : ''} sin leer`}
          className="inline-flex min-w-[1.75rem] items-center justify-center rounded-full bg-red-600 px-2.5 py-0.5 text-xs font-bold tabular-nums text-white shadow-sm animate-pulse"
        >
          {unreadCount}
        </span>
      </span>
    )
  }, [unreadCount])

  const indexOfLastItem = currentPage * itemsPerPage
  const indexOfFirstItem = indexOfLastItem - itemsPerPage
  const currentSubClients = useMemo(
    () => sortedSubClients.slice(indexOfFirstItem, indexOfLastItem),
    [sortedSubClients, indexOfFirstItem, indexOfLastItem],
  )
  const totalSubClientPages = useMemo(
    () => Math.max(1, Math.ceil(sortedSubClients.length / itemsPerPage)),
    [sortedSubClients.length],
  )

  const activeScreens = useMemo(
    () => (Array.isArray(data?.active_screens) ? data.active_screens : []),
    [data?.active_screens],
  )

  const totalActivePages = useMemo(
    () => Math.max(1, Math.ceil(activeScreens.length / ACTIVE_SCREENS_PAGE_SIZE)),
    [activeScreens.length],
  )

  const paginatedActiveScreens = useMemo(() => {
    const start = (activeScreensPage - 1) * ACTIVE_SCREENS_PAGE_SIZE
    return activeScreens.slice(start, start + ACTIVE_SCREENS_PAGE_SIZE)
  }, [activeScreens, activeScreensPage])

  const misComprasNow = usePortalNowTicker(60000)

  const trackedPurchasesSeguimientoCount = useMemo(() => {
    const list = Array.isArray(trackedPurchases) ? trackedPurchases : []
    return list.filter((item) => {
      const days = resolveTrackedPurchaseDaysRemaining(item, misComprasNow)
      return days != null && days <= 5 && days > 0
    }).length
  }, [trackedPurchases, misComprasNow])

  const trackedPurchasesCaducadosCount = useMemo(() => {
    const list = Array.isArray(trackedPurchases) ? trackedPurchases : []
    return list.filter((item) => {
      const days = resolveTrackedPurchaseDaysRemaining(item, misComprasNow)
      return days != null && days <= 0
    }).length
  }, [trackedPurchases, misComprasNow])

  const filteredTrackedPurchases = useMemo(() => {
    const list = Array.isArray(trackedPurchases) ? trackedPurchases : []
    if (activeTab === 'todos') return list
    return list.filter((item) => {
      const days = resolveTrackedPurchaseDaysRemaining(item, misComprasNow)
      if (days == null) return false
      if (activeTab === 'seguimiento') return days <= 5 && days > 0
      if (activeTab === 'caducados') return days <= 0
      return true
    })
  }, [trackedPurchases, activeTab, misComprasNow])

  const MIS_COMPRAS_ITEMS_PER_PAGE = 5

  const totalMisComprasPages = useMemo(
    () => Math.max(1, Math.ceil(filteredTrackedPurchases.length / MIS_COMPRAS_ITEMS_PER_PAGE)),
    [filteredTrackedPurchases.length],
  )

  const paginatedMisCompras = useMemo(() => {
    const start = (misComprasPage - 1) * MIS_COMPRAS_ITEMS_PER_PAGE
    return filteredTrackedPurchases.slice(start, start + MIS_COMPRAS_ITEMS_PER_PAGE)
  }, [filteredTrackedPurchases, misComprasPage])

  const latestActiveScreen = useMemo(
    () => (activeScreens.length > 0 ? activeScreens[0] : null),
    [activeScreens],
  )

  /** BaaS: billetera, compra de pantallas y sub-clientes (no aplica a clientes solo con ventas normales). */
  const portalShowsBaasSection = useMemo(() => {
    if (!data) return false
    const walletRows = data?.client?.wallet_balances_by_currency ?? data?.wallet_balances_by_currency ?? []
    const hasWalletRows =
      Array.isArray(walletRows) && walletRows.some((r) => (parseMoneyNum(r?.amount) || 0) > 1e-9)
    const walletBal = parseMoneyNum(data?.client?.wallet_balance)
    const hasWalletBal = Number.isFinite(walletBal) && walletBal > 1e-9
    const hasRecharges = (walletRechargesDisplay?.length ?? 0) > 0
    const hasAutoCatalog = (autoPurchaseProducts?.length ?? 0) > 0
    const hasScreens = activeScreens.length > 0
    const hasSubClients = (subClients?.length ?? 0) > 0
    return hasWalletRows || hasWalletBal || hasRecharges || hasAutoCatalog || hasScreens || hasSubClients
  }, [data, walletRechargesDisplay, autoPurchaseProducts, activeScreens, subClients])

  const resellerNetworkAside = useMemo(
    () => (subClients.length > 0 ? String(subClients.length) : '0'),
    [subClients.length],
  )

  useEffect(() => {
    setActiveScreensPage((p) =>
      Math.min(p, Math.max(1, Math.ceil(activeScreens.length / ACTIVE_SCREENS_PAGE_SIZE) || 1)),
    )
  }, [activeScreens.length])

  useEffect(() => {
    setCurrentPage((p) => Math.min(p, totalSubClientPages))
  }, [totalSubClientPages])

  useEffect(() => {
    setCurrentPage(1)
    setExpandedClientId(null)
  }, [activeFilter, searchTerm])

  useEffect(() => {
    setExpandedClientId(null)
  }, [currentPage])

  useEffect(() => {
    setMisComprasPage(1)
    setExpandedMisComprasKey(null)
  }, [activeTab])

  useEffect(() => {
    setMisComprasPage((p) => Math.min(p, totalMisComprasPages))
  }, [totalMisComprasPages])

  const handleCopyScreenField = useCallback(async (text, flashKey) => {
    const ok = await copyPortalText(text)
    if (!ok) return
    setCopyFlashKey(flashKey)
    window.setTimeout(() => {
      setCopyFlashKey((prev) => (prev === flashKey ? null : prev))
    }, 2000)
  }, [])

  const newOrdersAccordionAside = useMemo(() => {
    const sidList = ordersToShow.filter((s) => Number.isFinite(Number(s?.sale_id)))
    const chunks = []
    if (sidList.length > 0 && primaryNewOrder) {
      const cur =
        primaryNewOrder.currency && String(primaryNewOrder.currency).trim().length >= 3
          ? String(primaryNewOrder.currency).trim().toUpperCase().slice(0, 10)
          : 'USD'
      const total = saleInvoiceTotal(primaryNewOrder)
      const label =
        sidList.length === 1
          ? `${formatMoney(total, cur)}`
          : `${sidList.length} pedidos · ${formatMoney(total, cur)}+`
      chunks.push(label)
    } else if (sidList.length > 0) {
      chunks.push(`${sidList.length} pedido${sidList.length !== 1 ? 's' : ''}`)
    }
    if (newOrderWalletRecharges.length > 0) {
      if (newOrderWalletRecharges.length === 1) {
        const r0 = newOrderWalletRecharges[0]
        const cur =
          r0.recharge_currency && String(r0.recharge_currency).trim().length >= 3
            ? String(r0.recharge_currency).trim().toUpperCase().slice(0, 10)
            : 'USD'
        const amt = parseMoneyNum(r0.amount_requested)
        chunks.push(`Recarga ${formatMoney(Number.isFinite(amt) ? amt : 0, cur)}`)
      } else {
        chunks.push(`${newOrderWalletRecharges.length} recargas`)
      }
    }
    if (!chunks.length) return ''
    return chunks.join(' · ')
  }, [ordersToShow, primaryNewOrder, newOrderWalletRecharges])

  useEffect(() => {
    if (!ordersToShow.length) return
    setPayMethodBySale((prev) => {
      const next = { ...prev }
      for (const sale of ordersToShow) {
        const sid = Number(sale.sale_id)
        if (!Number.isFinite(sid)) continue
        if (next[sid] != null && next[sid] !== '') continue
        const saleCur =
          sale.currency && String(sale.currency).trim().length >= 3
            ? String(sale.currency).trim().toUpperCase().slice(0, 10)
            : 'USD'
        const tree = buildPortalPaymentTree(
          data,
          sale?.allowed_payment_methods,
          sale?.allowed_deposit_accounts,
          saleCur,
          sale?.payment_methods_tree,
        )
        const methods = portalParentMethods(tree)
        if (methods[0]?.id != null) next[sid] = String(methods[0].id)
      }
      return next
    })
    setPayAccountBySale((prev) => {
      const next = { ...prev }
      for (const sale of ordersToShow) {
        const sid = Number(sale?.sale_id)
        if (!Number.isFinite(sid)) continue
        if (next[sid] != null && next[sid] !== '') continue
        const saleCur =
          sale?.currency && String(sale.currency).trim().length >= 3
            ? String(sale.currency).trim().toUpperCase().slice(0, 10)
            : 'USD'
        const tree = buildPortalPaymentTree(
          data,
          sale?.allowed_payment_methods,
          sale?.allowed_deposit_accounts,
          saleCur,
          sale?.payment_methods_tree,
        )
        const methods = portalParentMethods(tree)
        const methodId = methods[0]?.id
        const accs = portalAccountsForMethod(tree, methodId)
        if (accs.length === 1) next[sid] = String(accs[0].id)
      }
      return next
    })
  }, [ordersToShow, data])

  useEffect(() => {
    if (!newOrderWalletRecharges.length) return
    setPayMethodByRecharge((prev) => {
      const next = { ...prev }
      for (const r of newOrderWalletRecharges) {
        const rid = Number(r?.id)
        if (!Number.isFinite(rid)) continue
        if (next[rid] != null && next[rid] !== '') continue
        const cur =
          r.recharge_currency && String(r.recharge_currency).trim().length >= 3
            ? String(r.recharge_currency).trim().toUpperCase().slice(0, 10)
            : 'USD'
        const tree = buildPortalPaymentTree(
          data,
          r?.allowed_payment_methods,
          r?.allowed_deposit_accounts,
          cur,
          r?.payment_methods_tree,
        )
        const methods = portalParentMethods(tree)
        if (methods[0]?.id != null) next[rid] = String(methods[0].id)
      }
      return next
    })
    setPayAccountByRecharge((prev) => {
      const next = { ...prev }
      for (const r of newOrderWalletRecharges) {
        const rid = Number(r?.id)
        if (!Number.isFinite(rid)) continue
        if (next[rid] != null && next[rid] !== '') continue
        const cur =
          r.recharge_currency && String(r.recharge_currency).trim().length >= 3
            ? String(r.recharge_currency).trim().toUpperCase().slice(0, 10)
            : 'USD'
        const tree = buildPortalPaymentTree(
          data,
          r?.allowed_payment_methods,
          r?.allowed_deposit_accounts,
          cur,
          r?.payment_methods_tree,
        )
        const methods = portalParentMethods(tree)
        const methodId = next[rid] || prev[rid] || methods[0]?.id
        const accs = portalAccountsForMethod(tree, methodId)
        if (accs.length === 1) next[rid] = String(accs[0].id)
      }
      return next
    })
  }, [newOrderWalletRecharges, data])

  /** Si la cuenta guardada no pertenece al método seleccionado, limpiarla (evita envíos inconsistentes). */
  useEffect(() => {
    if (!ordersToShow?.length) return undefined
    setPayAccountBySale((prev) => {
      let next = null
      for (const sale of ordersToShow) {
        const sid = Number(sale?.sale_id)
        if (!Number.isFinite(sid)) continue
        const selected = prev[sid]
        if (selected == null || selected === '') continue
        const saleCur =
          sale?.currency && String(sale.currency).trim().length >= 3
            ? String(sale.currency).trim().toUpperCase().slice(0, 10)
            : 'USD'
        const tree = buildPortalPaymentTree(
          data,
          sale?.allowed_payment_methods,
          sale?.allowed_deposit_accounts,
          saleCur,
          sale?.payment_methods_tree,
        )
        const methodId = payMethodBySale[sid]
        if (methodId == null || String(methodId).trim() === '') continue
        const accs = portalAccountsForMethod(tree, methodId)
        if (!accs.some((a) => String(a.id) === String(selected))) {
          if (!next) next = { ...prev }
          next[sid] = accs.length === 1 ? String(accs[0].id) : ''
        }
      }
      return next ?? prev
    })
    return undefined
  }, [ordersToShow, data, payMethodBySale])

  /** Si la IA detectó moneda distinta a la cuenta de depósito, borra el importe declarado automáticamente. */
  useEffect(() => {
    if (!newOrderSales?.length) return undefined
    setPaidAmountBySale((prev) => {
      let next = { ...prev }
      let changed = false
      for (const sale of newOrderSales) {
        const sid = Number(sale.sale_id)
        if (!Number.isFinite(sid)) continue
        const saleCur =
          sale?.currency && String(sale.currency).trim().length >= 3
            ? String(sale.currency).trim().toUpperCase().slice(0, 10)
            : 'USD'
        const tree = buildPortalPaymentTree(
          data,
          sale?.allowed_payment_methods,
          sale?.allowed_deposit_accounts,
          saleCur,
          sale?.payment_methods_tree,
        )
        const methodId = payMethodBySale[sid]
        const depList = portalAccountsForMethod(tree, methodId)
        const rid = payAccountBySale[sid] || (depList.length === 1 ? String(depList[0]?.id ?? '') : '')
        const sel = depList.find((d) => String(d.id) === String(rid))
        const ia = aiResultBySale[sid]
        const msg = portalCurrencyMismatchMessage(ia?.extracted_currency, sel?.currency)
        if (msg && String(next[sid] ?? '').trim() !== '') {
          next[sid] = ''
          changed = true
        }
      }
      return changed ? next : prev
    })
    return undefined
  }, [newOrderSales, payAccountBySale, payMethodBySale, aiResultBySale, data])

  /** Abono histórico: si la cuenta de depósito no coincide con la moneda IA, limpia el importe detectado. */
  useEffect(() => {
    setDebtForm((prev) => {
      const depDebtResolved =
        prev.account || (debtPaymentAccounts[0]?.id != null ? String(debtPaymentAccounts[0].id) : '')
      const sel = debtPaymentAccounts.find((d) => String(d.id) === String(depDebtResolved))
      const msg = portalCurrencyMismatchMessage(prev.aiResult?.extracted_currency, sel?.currency)
      if (!msg || !String(prev.amount ?? '').trim()) return prev
      return { ...prev, amount: '' }
    })
  }, [debtForm.account, debtForm.aiResult, debtPaymentAccounts])

  const analyzeReceiptWithAI = useCallback(
    async (saleId, files, expectedAmount, expectedCurrency) => {
      const images = Array.isArray(files)
        ? files.filter((file) => /^image\/(jpeg|png)$/i.test(file?.type || ''))
        : []
      setAnalyzingBySale((p) => ({ ...p, [saleId]: true }))
      setAiResultBySale((p) => ({ ...p, [saleId]: null }))
      try {
        if (images.length === 0) {
          const mergedNone = mergeReceiptAnalysisResults([])
          setAiResultBySale((p) => ({ ...p, [saleId]: mergedNone }))
          setPaidAmountBySale((p) => ({ ...p, [saleId]: '' }))
        } else {
          const parts = []
          /* eslint-disable no-await-in-loop */
          for (const file of images.slice(0, 1)) {
            const fd = new FormData()
            fd.append('receipt_image', file)
            if (expectedAmount != null) fd.append('expected_amount', String(expectedAmount))
            if (expectedCurrency) fd.append('expected_currency', String(expectedCurrency))
            try {
              const { data } = await api.post('/api/v1/portal/analyze-receipt', fd)
              parts.push(data)
            } catch {
              parts.push({ is_readable: false })
            }
          }
          /* eslint-enable no-await-in-loop */
          const merged = mergeReceiptAnalysisResults(parts)
          setAiResultBySale((p) => ({ ...p, [saleId]: merged }))
          if (merged.is_readable && merged.extracted_amount > 0) {
            setPaidAmountBySale((p) => ({
              ...p,
              [saleId]: String(merged.extracted_amount),
            }))
          } else {
            setPaidAmountBySale((p) => ({ ...p, [saleId]: '' }))
          }
        }
      } catch {
        setAiResultBySale((p) => ({ ...p, [saleId]: { is_readable: false, _error: true } }))
        setPaidAmountBySale((p) => ({ ...p, [saleId]: '' }))
      } finally {
        setAnalyzingBySale((p) => ({ ...p, [saleId]: false }))
      }
    },
    [api],
  )

  function replaceReceiptsForSale(saleId, nextFiles, expectedAmount, expectedCurrency) {
    const capped = Array.isArray(nextFiles) ? nextFiles.filter(Boolean).slice(0, 1) : []
    setThumbnailUrlsBySale((prev) => {
      const old = prev[saleId]
      if (Array.isArray(old)) revokeThumbnailList(old)
      const urls =
        capped.length ?
          capped.map((f) => (/^image\/(jpeg|png)$/i.test(f?.type || '') ? URL.createObjectURL(f) : null))
        : []
      return capped.length ? { ...prev, [saleId]: urls } : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== String(saleId)))
    })
    if (capped.length) setReceiptFilesBySale((prev) => ({ ...prev, [saleId]: capped }))
    else
      setReceiptFilesBySale((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([k]) => k !== String(saleId))),
      )
    setSubmitErrorBySale((p) => ({ ...p, [saleId]: null }))
    setAiResultBySale((p) => ({ ...p, [saleId]: null }))
    setPaidAmountBySale((p) => ({ ...p, [saleId]: '' }))
    if (capped.length)
      analyzeReceiptWithAI(saleId, capped, expectedAmount, expectedCurrency)
  }

  function pickReceipt(saleId, list, expectedAmount, expectedCurrency) {
    const incomingRaw = [...(list || [])].filter(Boolean)
    const ok = incomingRaw.filter(
      (f) =>
        /^image\/(jpeg|png)$/i.test(f.type || '') ||
        /^application\/pdf$/i.test(f.type || ''),
    )
    if (!ok.length && incomingRaw.length) {
      setSubmitErrorBySale((p) => ({
        ...p,
        [saleId]: 'Solo JPG, PNG o PDF (un comprobante).',
      }))
      return
    }
    const next = ok.slice(0, 1)

    if (incomingRaw.length !== ok.length) {
      setSubmitErrorBySale((p) => ({
        ...p,
        [saleId]: 'Formato no válido. Usa JPG, PNG o PDF (un solo archivo).',
      }))
    }

    if (!next.length) return
    replaceReceiptsForSale(saleId, next, expectedAmount, expectedCurrency)
  }

  function removeReceiptFileAt(saleId, index, saleTotalForAi, saleCurrencyForAi) {
    const existing = [...(receiptFilesBySale[saleId] || [])]
    existing.splice(index, 1)
    replaceReceiptsForSale(saleId, existing, saleTotalForAi, saleCurrencyForAi)
  }

  const submitPayment = useCallback(
    async (sale) => {
      const sid = Number(sale.sale_id)
      const openPrincipal = portalSaleOpenBalance(sale)
      if (!(openPrincipal > 1e-9)) {
        setSubmitErrorBySale((p) => ({
          ...p,
          [sid]: 'Este pedido no tiene saldo pendiente por cubrir.',
        }))
        return
      }

      const saleCur =
        sale.currency && String(sale.currency).trim().length >= 3
          ? String(sale.currency).trim().toUpperCase().slice(0, 10)
          : 'USD'
      const cbClient = portalCreditForCurrency(data, creditRowsDisplay, saleCur)
      const creditApplyPreview = Math.min(cbClient, openPrincipal)
      const depositDueAfterCredit = Math.max(
        0,
        Math.round((openPrincipal - creditApplyPreview) * 100) / 100,
      )

      const paysOnlyWithCredit =
        depositDueAfterCredit <= 1e-9 && creditApplyPreview > 1e-9 && openPrincipal > 1e-9

      const dep = payAccountBySale[sid]
      const files = receiptFilesBySale[sid]
      const fileList = Array.isArray(files) ? files.filter(Boolean).slice(0, 1) : []
      const pm = payMethodBySale[sid]
      const salePayTree = buildPortalPaymentTree(
        data,
        sale?.allowed_payment_methods,
        sale?.allowed_deposit_accounts,
        saleCur,
        sale?.payment_methods_tree,
      )
      const accs = portalAccountsForMethod(salePayTree, pm)
      const needsDep = accs.length > 0

      const postSuccess = async () => {
        setSuccessBySale((p) => ({ ...p, [sid]: true }))
        revokeThumbnailList(thumbnailUrlsBySale[sid])
        setThumbnailUrlsBySale((p) =>
          Object.fromEntries(Object.entries(p).filter(([k]) => k !== String(sid))),
        )
        setReceiptFilesBySale((p) =>
          Object.fromEntries(Object.entries(p).filter(([k]) => k !== String(sid))),
        )
        setPaidAmountBySale((p) => {
          const n = { ...p }
          delete n[sid]
          return n
        })
        await loadPortal()
      }

      if (paysOnlyWithCredit) {
        setSubmittingSaleId(sid)
        setSubmitErrorBySale((p) => ({ ...p, [sid]: null }))
        try {
          const fd = new FormData()
          fd.append('payment_intent', 'new_order')
          fd.append('sale_id', String(sid))
          fd.append('use_credit_balance', '1')
          fd.append('pay_with_credit', '1')
          await api.post(`/api/v1/portal/${token}/payments`, fd)
          await postSuccess()
        } catch (err) {
          const serverDetail = err?.response?.data?.detail
          const serverMsg =
            typeof serverDetail === 'string'
              ? serverDetail
              : typeof err?.response?.data === 'string'
                ? err.response.data
                : null
          const httpStatus = err?.response?.status
          const msg = serverMsg
            || (httpStatus ? `Error ${httpStatus}: No se pudo aplicar el saldo a favor.` : 'No se pudo enviar el pago con saldo a favor.')
          console.error('[Portal] Error al aplicar saldo:', httpStatus, err?.response?.data)
          setSubmitErrorBySale((p) => ({ ...p, [sid]: msg }))
        } finally {
          setSubmittingSaleId(null)
        }
        return
      }

      if (!pm) {
        setSubmitErrorBySale((p) => ({ ...p, [sid]: 'Elige un método de pago.' }))
        return
      }
      if (needsDep && !dep) {
        setSubmitErrorBySale((p) => ({
          ...p,
          [sid]: 'Elige la cuenta donde realizaste el depósito.',
        }))
        return
      }
      if (!fileList.length) {
        setSubmitErrorBySale((p) => ({
          ...p,
          [sid]: 'Adjunta el comprobante (imagen o PDF).',
        }))
        return
      }
      const allowedPm = portalParentMethods(salePayTree)
      const allowedPmIds = new Set(allowedPm.map((m) => Number(m.id)))
      if (allowedPmIds.size && !allowedPmIds.has(Number(pm))) {
        setSubmitErrorBySale((p) => ({ ...p, [sid]: 'Método de pago no permitido para este pedido.' }))
        return
      }
      const allowedAccIds = new Set(accs.map((a) => Number(a.id)))
      if (allowedAccIds.size && dep && !allowedAccIds.has(Number(dep))) {
        setSubmitErrorBySale((p) => ({ ...p, [sid]: 'Cuenta no permitida para este pedido.' }))
        return
      }

      const paidStr = String(paidAmountBySale[sid] ?? '').trim().replace(',', '.')
      const paidParsed = parseFloat(paidStr)
      if (!Number.isFinite(paidParsed) || paidParsed <= 0) {
        setSubmitErrorBySale((p) => ({
          ...p,
          [sid]: 'La IA no pudo detectar un importe válido en el comprobante. Sube una imagen JPG o PNG nítida.',
        }))
        return
      }

      setSubmittingSaleId(sid)
      setSubmitErrorBySale((p) => ({ ...p, [sid]: null }))
      try {
        const depId = dep || (accs[0] ? String(accs[0].id) : '')
        if (!depId) {
          setSubmitErrorBySale((p) => ({ ...p, [sid]: 'Elige la cuenta donde realizaste el depósito.' }))
          setSubmittingSaleId(null)
          return
        }
        const fd = new FormData()
        fd.append('payment_intent', 'new_order')
        fd.append('sale_id', String(sid))
        fd.append('payment_method_id', String(pm))
        fd.append('deposit_account_id', depId)
        fd.append('receipt_file', fileList[0])
        fd.append('paid_amount', String(paidParsed))
        if (creditApplyPreview > 1e-9) {
          fd.append('apply_credit_balance', '1')
          fd.append('use_credit_balance', '1')
        }
        await api.post(`/api/v1/portal/${token}/payments`, fd)
        await postSuccess()
      } catch (err) {
        // Extraer el mensaje real del servidor (detail de FastAPI, o texto plano)
        const serverDetail = err?.response?.data?.detail
        const serverMsg =
          typeof serverDetail === 'string'
            ? serverDetail
            : typeof err?.response?.data === 'string'
              ? err.response.data
              : null
        const httpStatus = err?.response?.status
        const msg = serverMsg
          || (httpStatus ? `Error ${httpStatus}: No se pudo enviar el comprobante.` : 'No se pudo enviar el comprobante. Verifica tu conexión e inténtalo de nuevo.')
        console.error('[Portal] Error al enviar pago:', httpStatus, err?.response?.data)
        setSubmitErrorBySale((p) => ({ ...p, [sid]: msg }))
      } finally {
        setSubmittingSaleId(null)
      }
    },
    [
      api,
      creditRowsDisplay,
      data,
      loadPortal,
      payAccountBySale,
      payMethodBySale,
      paidAmountBySale,
      receiptFilesBySale,
      thumbnailUrlsBySale,
      token,
    ],
  )

  const submitPaymentWithCredit = useCallback(
    async (sale) => {
      const sid = Number(sale.sale_id)
      const saleCur =
        sale.currency && String(sale.currency).trim().length >= 3
          ? String(sale.currency).trim().toUpperCase().slice(0, 10)
          : 'USD'
      const cbClient = portalCreditForCurrency(data, creditRowsDisplay, saleCur)
      if (!(cbClient > 1e-9)) {
        setSubmitErrorBySale((p) => ({ ...p, [sid]: 'No tienes saldo a favor en la moneda de este pedido.' }))
        return
      }
      setSubmittingSaleId(sid)
      setSubmitErrorBySale((p) => ({ ...p, [sid]: null }))
      try {
        const fd = new FormData()
        fd.append('payment_intent', 'new_order')
        fd.append('sale_id', String(sid))
        fd.append('use_credit_balance', '1')
        fd.append('pay_with_credit', '1')
        await api.post(`/api/v1/portal/${token}/payments`, fd)
        setSuccessBySale((p) => ({ ...p, [sid]: true }))
        await loadPortal()
      } catch (err) {
        const serverDetail = err?.response?.data?.detail
        const msg =
          typeof serverDetail === 'string'
            ? serverDetail
            : 'No se pudo aplicar el saldo a favor a este pedido.'
        setSubmitErrorBySale((p) => ({ ...p, [sid]: msg }))
      } finally {
        setSubmittingSaleId(null)
      }
    },
    [api, creditRowsDisplay, data, loadPortal, token],
  )

  const analyzeDebtReceiptWithAI = useCallback(
    async (files, expectedAmount, expectedCurrency) => {
      const images = Array.isArray(files)
        ? files.filter((file) => /^image\/(jpeg|png)$/i.test(file?.type || ''))
        : []
      setDebtForm((p) => ({ ...p, analyzing: true, aiResult: null }))
      try {
        if (images.length === 0) {
          const merged = mergeReceiptAnalysisResults([])
          setDebtForm((p) => ({
            ...p,
            aiResult: merged,
            amount: '',
          }))
        } else {
          const parts = []
          for (const img of images.slice(0, 1)) {
            const fd = new FormData()
            fd.append('receipt_image', img)
            if (expectedAmount != null) fd.append('expected_amount', String(expectedAmount))
            if (expectedCurrency) fd.append('expected_currency', String(expectedCurrency))
            try {
              const { data } = await api.post('/api/v1/portal/analyze-receipt', fd)
              parts.push(data)
            } catch {
              parts.push({ is_readable: false })
            }
          }
          const merged = mergeReceiptAnalysisResults(parts)
          setDebtForm((p) => ({
            ...p,
            aiResult: merged,
            amount: merged.is_readable && merged.extracted_amount > 0 ? String(merged.extracted_amount) : '',
          }))
        }
      } catch {
        setDebtForm((p) => ({ ...p, aiResult: { is_readable: false, _error: true }, amount: '' }))
      } finally {
        setDebtForm((p) => ({ ...p, analyzing: false }))
      }
    },
    [api],
  )

  function replaceDebtReceiptFiles(nextFiles, expectedAmount, expectedCurrency) {
    const capped =
      Array.isArray(nextFiles) && nextFiles.length ? nextFiles.filter(Boolean).slice(0, 1) : []
    setDebtReceiptThumbUrls((prev) => {
      revokeThumbnailList(prev)
      if (!capped.length) return []
      return capped.map((f) => (/^image\/(jpeg|png)$/i.test(f?.type || '') ? URL.createObjectURL(f) : null))
    })
    setDebtReceiptFiles(capped.length ? capped : [])
    setDebtForm((p) => ({ ...p, error: null, aiResult: null, amount: '' }))
    if (capped.length)
      analyzeDebtReceiptWithAI(capped, expectedAmount, expectedCurrency)
  }

  function pickDebtReceipt(fileList) {
    const incomingRaw = [...(fileList || [])].filter(Boolean)
    const ok = incomingRaw.filter(
      (f) =>
        /^image\/(jpeg|png)$/i.test(f.type || '') || /^application\/pdf$/i.test(f.type || ''),
    )
    if (!ok.length && incomingRaw.length) {
      setDebtForm((p) => ({ ...p, error: 'Solo JPG, PNG o PDF (un comprobante).' }))
      return
    }
    const next = ok.slice(0, 1)
    if (incomingRaw.length !== ok.length)
      setDebtForm((p) => ({
        ...p,
        error: 'Formato no válido. Usa JPG, PNG o PDF (un solo archivo).',
      }))
    if (!next.length) return
    const expected = currentDebtPayObligation?.pendingAmount ?? null
    replaceDebtReceiptFiles(next, expected, debtCurrency)
  }

  function removeDebtReceiptAt(idx) {
    const next = [...debtReceiptFiles]
    next.splice(idx, 1)
    const expected = currentDebtPayObligation?.pendingAmount ?? null
    replaceDebtReceiptFiles(next, expected, debtCurrency)
  }

  // Submit debt payment: abono factura o comprobante recarga (según obligación seleccionada en el menú ledger)
  const submitDebtPayment = useCallback(async () => {
    const ob = currentDebtPayObligation
    if (!ob) {
      setDebtForm((p) => ({
        ...p,
        error:
          'Selecciona primero una deuda en «Saldo pendiente» (menú «Ver estado y movimientos de», si está visible) para enviar el comprobante.',
      }))
      return
    }
    const { method, account, amount, aiResult } = debtForm
    const receiptList = [...debtReceiptFiles].slice(0, 1).filter(Boolean)
    if (!method) {
      setDebtForm((p) => ({ ...p, error: 'Elige un método de pago.' }))
      return
    }
    const depId = account || (debtPaymentAccounts[0] ? String(debtPaymentAccounts[0].id) : '')
    if (!depId) {
      setDebtForm((p) => ({ ...p, error: 'Elige la cuenta donde realizaste el depósito.' }))
      return
    }
    const allowedPmIds = new Set(debtPaymentMethods.map((m) => Number(m.id)))
    if (allowedPmIds.size && !allowedPmIds.has(Number(method))) {
      setDebtForm((p) => ({ ...p, error: 'Método de pago no permitido para esta deuda.' }))
      return
    }
    const allowedAccIds = new Set(debtPaymentAccounts.map((a) => Number(a.id)))
    if (allowedAccIds.size && !allowedAccIds.has(Number(depId))) {
      setDebtForm((p) => ({ ...p, error: 'Cuenta de depósito no permitida para esta deuda.' }))
      return
    }
    const selDebt = debtPaymentAccounts.find((d) => String(d.id) === String(depId))
    const amt = parseFloat(String(amount).trim())
    const debtMm = portalCurrencyMismatchMessage(aiResult?.extracted_currency, selDebt?.currency)
    if (debtMm) {
      setDebtForm((p) => ({ ...p, error: debtMm }))
      return
    }
    if (aiResult?._multi_currency) {
      setDebtForm((p) => ({
        ...p,
        error:
          'No pudimos interpretar una moneda clara del comprobante; prueba una imagen JPG o PNG legible.',
      }))
      return
    }
    if (!Number.isFinite(amt) || amt <= 0) {
      setDebtForm((p) => ({ ...p, error: 'Esperamos el importe detectado por IA en tus comprobantes.' }))
      return
    }
    if (!receiptList.length) {
      setDebtForm((p) => ({ ...p, error: 'Adjunta el comprobante (imagen o PDF).' }))
      return
    }
    setDebtForm((p) => ({ ...p, submitting: true, error: null }))
    try {
      const fd = new FormData()
      fd.append('payment_intent', 'abono')
      fd.append('payment_method_id', String(method))
      fd.append('deposit_account_id', depId)
      fd.append('receipt_file', receiptList[0])
      fd.append('paid_amount', String(amt))
      fd.append('currency', debtCurrency)
      if (ob.kind === 'recharge') {
        const rid = Number(ob.rechargeRow?.id)
        fd.append('portal_debt_kind', 'wallet_recharge')
        fd.append('portal_wallet_recharge_id', String(rid))
        fd.append('id_erp', String(rid))
      } else {
        fd.append('portal_debt_kind', 'sale')
        fd.append('portal_sale_id', String(ob.saleId))
      }
      await api.post(`/api/v1/portal/${token}/payments`, fd)
      if (ob.kind === 'recharge') {
        const rid = Number(ob.rechargeRow?.id)
        if (Number.isFinite(rid)) {
          setWalletRechargePatchById((prev) => ({ ...prev, [rid]: { status: 'in_review' } }))
        }
      }
      setDebtReceiptThumbUrls((prev) => {
        revokeThumbnailList(prev)
        return []
      })
      setDebtReceiptFiles([])
      setDebtForm((p) => ({ ...p, success: true, amount: '', aiResult: null }))
      await loadPortal()
    } catch (err) {
      const d = err?.response?.data?.detail
      setDebtForm((p) => ({ ...p, error: typeof d === 'string' ? d : 'No se pudo enviar el abono.' }))
    } finally {
      setDebtForm((p) => ({ ...p, submitting: false }))
    }
  }, [
    currentDebtPayObligation,
    debtForm,
    debtPaymentAccounts,
    debtPaymentMethods,
    debtReceiptFiles,
    debtCurrency,
    api,
    token,
    loadPortal,
  ])

  const submitDebtPaymentWithCredit = useCallback(async () => {
    const ob = currentDebtPayObligation
    if (!ob) {
      setDebtForm((p) => ({
        ...p,
        error: 'Selecciona primero una deuda en «Saldo pendiente» para usar tu saldo a favor.',
      }))
      return
    }
    const cb = portalCreditForCurrency(data, creditRowsDisplay, ob.currency)
    if (!(cb > 1e-9)) {
      setDebtForm((p) => ({
        ...p,
        error: 'No tienes saldo a favor en la moneda de esta deuda.',
      }))
      return
    }
    setDebtForm((p) => ({ ...p, submitting: true, error: null }))
    try {
      const fd = new FormData()
        fd.append('payment_intent', 'abono')
        fd.append('use_credit_balance', '1')
        fd.append('pay_with_credit', '1')
      fd.append('currency', debtCurrency)
      if (ob.kind === 'recharge') {
        const rid = Number(ob.rechargeRow?.id)
        fd.append('portal_debt_kind', 'wallet_recharge')
        fd.append('portal_wallet_recharge_id', String(rid))
        fd.append('id_erp', String(rid))
      } else {
        fd.append('portal_debt_kind', 'sale')
        fd.append('portal_sale_id', String(ob.saleId))
      }
      await api.post(`/api/v1/portal/${token}/payments`, fd)
      if (ob.kind === 'recharge') {
        const rid = Number(ob.rechargeRow?.id)
        if (Number.isFinite(rid)) {
          setWalletRechargePatchById((prev) => ({ ...prev, [rid]: { status: 'in_review' } }))
        }
      }
      setDebtForm((p) => ({ ...p, success: true, amount: '', aiResult: null }))
      await loadPortal()
      await loadWalletRecharges()
    } catch (err) {
      const d = err?.response?.data?.detail
      setDebtForm((p) => ({
        ...p,
        error: typeof d === 'string' ? d : 'No se pudo aplicar el saldo a favor.',
      }))
    } finally {
      setDebtForm((p) => ({ ...p, submitting: false }))
    }
  }, [
    api,
    creditRowsDisplay,
    currentDebtPayObligation,
    data,
    debtCurrency,
    loadPortal,
    loadWalletRecharges,
    token,
  ])

  /** Cruce universal de saldo a favor: venta o recarga BaaS (pedido nuevo o deuda histórica). */
  const applyPortalOpenOrderCredit = useCallback(
    async ({ kind, sale, rechargeRow, paymentIntent = 'new_order' }) => {
      if (kind === 'sale' && sale) {
        if (paymentIntent === 'new_order') {
          return submitPaymentWithCredit(sale)
        }
        const ob = currentDebtPayObligation
        if (!ob || ob.kind !== 'sale' || Number(ob.saleId) !== Number(sale.sale_id)) {
          setDebtForm((p) => ({
            ...p,
            error: 'Selecciona esta venta en «Saldo pendiente» para aplicar saldo a favor.',
          }))
          return
        }
        return submitDebtPaymentWithCredit()
      }
      if (kind === 'recharge' && rechargeRow) {
        const rid = Number(rechargeRow.id)
        if (!Number.isFinite(rid)) {
          throw new Error('Identificador de recarga inválido.')
        }
        const cur =
          rechargeRow.recharge_currency != null && String(rechargeRow.recharge_currency).trim().length >= 3
            ? String(rechargeRow.recharge_currency).trim().toUpperCase().slice(0, 10)
            : 'USD'
        const cb = portalCreditForCurrency(data, creditRowsDisplay, cur)
        if (!(cb > 1e-9)) {
          throw new Error('No tienes saldo a favor en la moneda de esta recarga.')
        }
        if (paymentIntent === 'abono') {
          const ob = currentDebtPayObligation
          if (!ob || ob.kind !== 'recharge' || Number(ob.rechargeRow?.id) !== rid) {
            setDebtForm((p) => ({
              ...p,
              error: 'Selecciona esta recarga en «Saldo pendiente» para aplicar saldo a favor.',
            }))
            return
          }
          return submitDebtPaymentWithCredit()
        }
        const fd = new FormData()
        fd.append('use_credit_balance', '1')
        fd.append('pay_with_credit', '1')
        fd.append('id_erp', String(rid))
        await api.post(
          `/api/v1/portal/${encodeURIComponent(token)}/recharges/${encodeURIComponent(String(rid))}/pay`,
          fd,
        )
        setWalletRechargePatchById((prev) => ({
          ...prev,
          [rid]: { status: 'in_review' },
        }))
        await loadWalletRecharges()
        await loadPortal()
        return
      }
      throw new Error('Tipo de orden no reconocido para saldo a favor.')
    },
    [
      api,
      creditRowsDisplay,
      currentDebtPayObligation,
      data,
      loadPortal,
      loadWalletRecharges,
      submitDebtPaymentWithCredit,
      submitPaymentWithCredit,
      token,
    ],
  )

  const analyzeRechargeReceiptWithAI = useCallback(
    async (rechargeId, files, expectedAmount, expectedCurrency) => {
      const rid = Number(rechargeId)
      if (!Number.isFinite(rid)) return
      const images = Array.isArray(files)
        ? files.filter((file) => /^image\/(jpeg|png)$/i.test(file?.type || ''))
        : []
      patchRechargePayForm(setRechargeFormById, rid, { analyzing: true, aiResult: null })
      try {
        if (images.length === 0) {
          const merged = mergeReceiptAnalysisResults([])
          patchRechargePayForm(setRechargeFormById, rid, {
            aiResult: merged,
            amount: '',
          })
        } else {
          const parts = []
          for (const img of images.slice(0, 1)) {
            const fd = new FormData()
            fd.append('receipt_image', img)
            if (expectedAmount != null) fd.append('expected_amount', String(expectedAmount))
            if (expectedCurrency) fd.append('expected_currency', String(expectedCurrency))
            try {
              const { data: aiData } = await api.post('/api/v1/portal/analyze-receipt', fd)
              parts.push(aiData)
            } catch {
              parts.push({ is_readable: false })
            }
          }
          const merged = mergeReceiptAnalysisResults(parts)
          patchRechargePayForm(setRechargeFormById, rid, {
            aiResult: merged,
            amount: merged.is_readable && merged.extracted_amount > 0 ? String(merged.extracted_amount) : '',
          })
        }
      } catch {
        patchRechargePayForm(setRechargeFormById, rid, {
          aiResult: { is_readable: false, _error: true },
          amount: '',
        })
      } finally {
        patchRechargePayForm(setRechargeFormById, rid, { analyzing: false })
      }
    },
    [api],
  )

  const replaceRechargeReceiptFiles = useCallback(
    (rechargeId, row, nextFiles) => {
      const rid = Number(rechargeId)
      if (!Number.isFinite(rid)) return
      const capped =
        Array.isArray(nextFiles) && nextFiles.length ? nextFiles.filter(Boolean).slice(0, 1) : []
      setReceiptThumbUrlsByRecharge((prev) => {
        revokeThumbnailList(prev[rid] || [])
        return {
          ...prev,
          [rid]: capped.length
            ? capped.map((f) => (/^image\/(jpeg|png)$/i.test(f?.type || '') ? URL.createObjectURL(f) : null))
            : [],
        }
      })
      setReceiptFilesByRecharge((prev) => ({ ...prev, [rid]: capped.length ? capped : [] }))
      patchRechargePayForm(setRechargeFormById, rid, { error: null, aiResult: null, amount: '' })
      if (capped.length) {
        const cur =
          row?.recharge_currency && String(row.recharge_currency).trim().length >= 3
            ? String(row.recharge_currency).trim().toUpperCase().slice(0, 10)
            : 'USD'
        void analyzeRechargeReceiptWithAI(rid, capped, parseMoneyNum(row?.amount_requested), cur)
      }
    },
    [analyzeRechargeReceiptWithAI],
  )

  const submitRechargePayment = useCallback(
    async (row) => {
      if (!row) return
      const rid = Number(row.id)
      if (!Number.isFinite(rid)) {
        patchRechargePayForm(setRechargeFormById, rid, { error: 'Identificador de recarga inválido.' })
        return
      }
      const pendingBal = parseMoneyNum(row.balance_pending)
      if (!(portalCanShowPayFormForRecharge(row) && pendingBal > 1e-9)) {
        patchRechargePayForm(setRechargeFormById, rid, {
          error: 'Esta solicitud no tiene saldo pendiente por cubrir o no admite nuevos comprobantes.',
        })
        return
      }

      const form = rechargePayFormFromMap(rechargeFormById, rid)
      const effectiveMethod = form.method || payMethodByRecharge[rid] || ''
      const receiptList = [...(receiptFilesByRecharge[rid] || [])].slice(0, 1).filter(Boolean)
      const cur =
        row?.recharge_currency && String(row.recharge_currency).trim().length >= 3
          ? String(row.recharge_currency).trim().toUpperCase().slice(0, 10)
          : 'USD'
      const payTree = buildPortalPaymentTree(
        data,
        row?.allowed_payment_methods,
        row?.allowed_deposit_accounts,
        cur,
        row?.payment_methods_tree,
      )
      const pmList = portalParentMethods(payTree)
      const depList = portalAccountsForMethod(payTree, effectiveMethod)

      if (!effectiveMethod) {
        patchRechargePayForm(setRechargeFormById, rid, { error: 'Elige un método de pago.' })
        return
      }
      const depId = form.account || payAccountByRecharge[rid] || (depList[0]?.id != null ? String(depList[0].id) : '')
      if (!depId) {
        patchRechargePayForm(setRechargeFormById, rid, { error: 'Elige la cuenta donde realizaste el depósito.' })
        return
      }
      const allowedPmIds = new Set(pmList.map((m) => Number(m.id)))
      if (allowedPmIds.size && !allowedPmIds.has(Number(effectiveMethod))) {
        patchRechargePayForm(setRechargeFormById, rid, { error: 'Método de pago no permitido para esta recarga.' })
        return
      }
      const allowedAccIds = new Set(depList.map((a) => Number(a.id)))
      if (allowedAccIds.size && !allowedAccIds.has(Number(depId))) {
        patchRechargePayForm(setRechargeFormById, rid, { error: 'Cuenta de depósito no permitida para esta recarga.' })
        return
      }
      const selAcc = depList.find((d) => String(d.id) === String(depId))
      const amt = parseFloat(String(form.amount).trim().replace(',', '.'))
      const featMm = portalCurrencyMismatchMessage(form.aiResult?.extracted_currency, selAcc?.currency)
      if (featMm) {
        patchRechargePayForm(setRechargeFormById, rid, { error: featMm })
        return
      }
      if (form.aiResult?._multi_currency) {
        patchRechargePayForm(setRechargeFormById, rid, {
          error:
            'No pudimos interpretar una moneda clara del comprobante; prueba una imagen JPG o PNG legible.',
        })
        return
      }
      if (!Number.isFinite(amt) || amt <= 0) {
        patchRechargePayForm(setRechargeFormById, rid, {
          error: 'Esperamos el importe detectado por IA en tu comprobante.',
        })
        return
      }
      if (!receiptList.length) {
        patchRechargePayForm(setRechargeFormById, rid, { error: 'Adjunta el comprobante (imagen o PDF).' })
        return
      }
      patchRechargePayForm(setRechargeFormById, rid, { submitting: true, error: null })
      try {
        const fd = new FormData()
        fd.append('file', receiptList[0])
        fd.append('payment_method_id', String(effectiveMethod))
        fd.append('deposit_account_id', depId)
        fd.append('paid_amount', String(amt))
        fd.append('id_erp', String(rid))
        const featCreditAvail = portalCreditForCurrency(data, creditRowsDisplay, cur)
        const featOpen = portalRechargeOpenBalance(row)
        const featCreditApply = Math.min(featCreditAvail, Math.max(0, featOpen))
        if (featCreditApply > 1e-9) {
          fd.append('apply_credit_balance', '1')
          fd.append('use_credit_balance', '1')
        }
        await api.post(
          `/api/v1/portal/${encodeURIComponent(token)}/recharges/${encodeURIComponent(String(rid))}/pay`,
          fd,
        )
        setWalletRechargePatchById((prev) => ({ ...prev, [rid]: { status: 'in_review' } }))
        setReceiptThumbUrlsByRecharge((prev) => {
          revokeThumbnailList(prev[rid] || [])
          return { ...prev, [rid]: [] }
        })
        setReceiptFilesByRecharge((prev) => ({ ...prev, [rid]: [] }))
        patchRechargePayForm(setRechargeFormById, rid, { success: true, amount: '', aiResult: null })
        await loadWalletRecharges()
        await loadPortal()
      } catch (err) {
        const d = err?.response?.data?.detail
        patchRechargePayForm(setRechargeFormById, rid, {
          error: typeof d === 'string' ? d : 'No se pudo enviar el comprobante para esta recarga.',
        })
      } finally {
        patchRechargePayForm(setRechargeFormById, rid, { submitting: false })
      }
    },
    [
      rechargeFormById,
      receiptFilesByRecharge,
      payMethodByRecharge,
      payAccountByRecharge,
      data,
      creditRowsDisplay,
      api,
      token,
      loadPortal,
      loadWalletRecharges,
    ],
  )

  const submitRechargeWithCredit = useCallback(
    async (row) => {
      if (!row) {
        return
      }
      const rid = Number(row.id)
      patchRechargePayForm(setRechargeFormById, rid, { submitting: true, error: null })
      try {
        await applyPortalOpenOrderCredit({ kind: 'recharge', rechargeRow: row, paymentIntent: 'new_order' })
        patchRechargePayForm(setRechargeFormById, rid, { success: true, amount: '', aiResult: null })
      } catch (err) {
        const d = err?.response?.data?.detail
        patchRechargePayForm(setRechargeFormById, rid, {
          error: typeof d === 'string' ? d : err?.message || 'No se pudo aplicar el saldo a favor a la recarga.',
        })
      } finally {
        patchRechargePayForm(setRechargeFormById, rid, { submitting: false })
      }
    },
    [applyPortalOpenOrderCredit],
  )

  const isDebtRetiroMethod = isCodigosRetiroMethodId(debtPaymentMethods, debtForm.method)

  const handleDebtRetiroCompletado = useCallback(
    async (payload) => {
      const ob = currentDebtPayObligation
      if (!ob) return
      const { monto, receiptUrl, codigo } = payload
      if (!Number.isFinite(monto) || monto <= 0) {
        setDebtForm((p) => ({ ...p, error: 'El widget no devolvió un importe válido.' }))
        return
      }
      if (!receiptUrl) {
        setDebtForm((p) => ({ ...p, error: 'El widget no devolvió la URL del comprobante.' }))
        return
      }
      const method = debtForm.method
      const depId = debtForm.account || (debtPaymentAccounts[0] ? String(debtPaymentAccounts[0].id) : '')
      if (!method || !depId) {
        setDebtForm((p) => ({ ...p, error: 'Selecciona método y cuenta de retiro antes de continuar.' }))
        return
      }
      setRetiroSubmittingKey('debt')
      setDebtForm((p) => ({ ...p, submitting: true, error: null, success: false }))
      try {
        await submitCodigosRetiroPortalPayment(api, token, {
          paymentIntent: 'abono',
          paymentMethodId: method,
          depositAccountId: depId,
          paidAmount: monto,
          currency: debtCurrency,
          receiptUrl,
          portalDebtKind: ob.kind === 'recharge' ? 'wallet_recharge' : 'sale',
          portalSaleId: ob.kind === 'sale' ? ob.saleId : undefined,
          portalWalletRechargeId: ob.kind === 'recharge' ? ob.rechargeRow?.id : undefined,
          notes: codigo ? `codigo_retiro=${codigo}` : undefined,
        })
        if (ob.kind === 'recharge') {
          const rid = Number(ob.rechargeRow?.id)
          if (Number.isFinite(rid)) {
            setWalletRechargePatchById((prev) => ({ ...prev, [rid]: { status: 'in_review' } }))
          }
        }
        setDebtReceiptFiles([])
        setDebtForm((p) => ({ ...p, success: true, amount: '', aiResult: null }))
        setRetiroSuccessByScope({ scope: 'debt', monto, currency: debtCurrency })
        await loadPortal()
      } catch (err) {
        const d = err?.response?.data?.detail
        setDebtForm((p) => ({
          ...p,
          error: typeof d === 'string' ? d : 'No se pudo registrar el pago con códigos de retiro.',
        }))
      } finally {
        setRetiroSubmittingKey(null)
        setDebtForm((p) => ({ ...p, submitting: false }))
      }
    },
    [
      api,
      currentDebtPayObligation,
      debtCurrency,
      debtForm.account,
      debtForm.method,
      debtPaymentAccounts,
      loadPortal,
      token,
    ],
  )

  const handleRechargeRetiroCompletado = useCallback(
    async (row, payload) => {
      if (!row) return
      const rid = Number(row.id)
      if (!Number.isFinite(rid)) return
      const { monto, receiptUrl, codigo } = payload
      if (!Number.isFinite(monto) || monto <= 0) {
        patchRechargePayForm(setRechargeFormById, rid, { error: 'El widget no devolvió un importe válido.' })
        return
      }
      if (!receiptUrl) {
        patchRechargePayForm(setRechargeFormById, rid, { error: 'El widget no devolvió la URL del comprobante.' })
        return
      }
      const form = rechargePayFormFromMap(rechargeFormById, rid)
      const cur =
        row?.recharge_currency && String(row.recharge_currency).trim().length >= 3
          ? String(row.recharge_currency).trim().toUpperCase().slice(0, 10)
          : 'USD'
      const payTree = buildPortalPaymentTree(
        data,
        row?.allowed_payment_methods,
        row?.allowed_deposit_accounts,
        cur,
        row?.payment_methods_tree,
      )
      const depList = portalAccountsForMethod(payTree, form.method || payMethodByRecharge[rid])
      const method = form.method
      const depId = form.account || (depList[0]?.id != null ? String(depList[0].id) : '')
      if (!method || !depId) {
        patchRechargePayForm(setRechargeFormById, rid, {
          error: 'Selecciona método y cuenta de retiro antes de continuar.',
        })
        return
      }
      const retiroScope = `recharge:${rid}`
      setRetiroSubmittingKey(retiroScope)
      patchRechargePayForm(setRechargeFormById, rid, { submitting: true, error: null, success: false })
      try {
        await submitCodigosRetiroPortalPayment(api, token, {
          paymentIntent: 'abono',
          paymentMethodId: method,
          depositAccountId: depId,
          paidAmount: monto,
          currency: cur,
          receiptUrl,
          portalDebtKind: 'wallet_recharge',
          portalWalletRechargeId: rid,
          notes: codigo ? `codigo_retiro=${codigo}` : undefined,
        })
        setWalletRechargePatchById((prev) => ({ ...prev, [rid]: { status: 'in_review' } }))
        setReceiptFilesByRecharge((prev) => ({ ...prev, [rid]: [] }))
        patchRechargePayForm(setRechargeFormById, rid, { success: true, amount: '', aiResult: null })
        setRetiroSuccessByScope({ scope: retiroScope, monto, currency: cur })
        await loadWalletRecharges()
        await loadPortal()
      } catch (err) {
        const d = err?.response?.data?.detail
        patchRechargePayForm(setRechargeFormById, rid, {
          error: typeof d === 'string' ? d : 'No se pudo registrar el pago con códigos de retiro.',
        })
      } finally {
        setRetiroSubmittingKey(null)
        patchRechargePayForm(setRechargeFormById, rid, { submitting: false })
      }
    },
    [api, data, payMethodByRecharge, rechargeFormById, loadPortal, loadWalletRecharges, token],
  )

  const submitSaleRetiroFromWidget = useCallback(
    async (sale, payload) => {
      const sid = Number(sale.sale_id)
      const saleCur =
        sale.currency && String(sale.currency).trim().length >= 3
          ? String(sale.currency).trim().toUpperCase().slice(0, 10)
          : 'USD'

      const salePayTree = buildPortalPaymentTree(
        data,
        sale?.allowed_payment_methods,
        sale?.allowed_deposit_accounts,
        saleCur,
        sale?.payment_methods_tree,
      )
      const pmList = portalParentMethods(salePayTree)
      const selectedMethodId = payMethodBySale[sid]
      const isSelectedCodigosRetiro = isCodigosRetiroMethodId(pmList, selectedMethodId)

      if (!isSelectedCodigosRetiro) {
        console.warn('[portal] instant-activation-cxc omitido: método de pago distinto a Códigos de Retiro', {
          saleId: sid,
          selectedMethodId,
          selectedMethodName: paymentMethodNameById(pmList, selectedMethodId),
        })
        return
      }

      setRetiroSubmittingKey(`sale:${sid}`)
      setSubmittingSaleId(sid)
      setSubmitErrorBySale((p) => ({ ...p, [sid]: null }))
      try {
        await requestCodigosRetiroInstantActivationCxc(api, token, sid, selectedMethodId)
        setSuccessBySale((p) => ({ ...p, [sid]: true }))
        setRetiroSuccessByScope({
          scope: `sale:${sid}`,
          monto: Number.isFinite(payload?.monto) ? payload.monto : undefined,
          currency: saleCur,
        })
        await loadPortal()
      } catch (err) {
        const requestUrl = err?.config?.url
          ? `${String(err.config.baseURL || import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')}${err.config.url}`
          : null
        console.error('[portal] instant-activation-cxc failed', {
          saleId: sid,
          referenciaExterna: sid,
          portalToken: token,
          apiBaseURL: err?.config?.baseURL ?? import.meta.env.VITE_API_BASE_URL ?? null,
          requestUrl,
          message: err?.message,
          code: err?.code,
          name: err?.name,
          responseStatus: err?.response?.status ?? null,
          responseData: err?.response?.data ?? null,
          isNetworkError: !err?.response && Boolean(err?.request),
          stack: err?.stack,
          error: err,
        })
        if (err?.response?.status === 409) {
          setSuccessBySale((p) => ({ ...p, [sid]: true }))
          setRetiroSuccessByScope({
            scope: `sale:${sid}`,
            monto: Number.isFinite(payload?.monto) ? payload.monto : undefined,
            currency: saleCur,
          })
          await loadPortal()
          return
        }
        const d = err?.response?.data?.detail
        setSubmitErrorBySale((p) => ({
          ...p,
          [sid]:
            typeof d === 'string'
              ? d
              : 'No se pudo activar el pedido. Verifica tu conexión e inténtalo de nuevo.',
        }))
      } finally {
        setRetiroSubmittingKey(null)
        setSubmittingSaleId(null)
      }
    },
    [api, data, loadPortal, payMethodBySale, token],
  )

  useEffect(() => {
    if (isDebtRetiroMethod && currentDebtPayObligation) {
      retiroSlotRef.current = handleDebtRetiroCompletado
      return () => {
        if (retiroSlotRef.current === handleDebtRetiroCompletado) retiroSlotRef.current = null
      }
    }
    for (const fr of newOrderWalletRecharges) {
      const rid = Number(fr?.id)
      if (!Number.isFinite(rid)) continue
      const frCur =
        fr?.recharge_currency && String(fr.recharge_currency).trim().length >= 3
          ? String(fr.recharge_currency).trim().toUpperCase().slice(0, 10)
          : 'USD'
      const tree = buildPortalPaymentTree(
        data,
        fr?.allowed_payment_methods,
        fr?.allowed_deposit_accounts,
        frCur,
        fr?.payment_methods_tree,
      )
      const pmList = portalParentMethods(tree)
      const mid = payMethodByRecharge[rid] ?? rechargePayFormFromMap(rechargeFormById, rid).method
      if (isCodigosRetiroMethodId(pmList, mid)) {
        const handler = (payload) => handleRechargeRetiroCompletado(fr, payload)
        retiroSlotRef.current = handler
        return () => {
          if (retiroSlotRef.current === handler) retiroSlotRef.current = null
        }
      }
    }
    for (const sale of ordersToShow) {
      const sid = Number(sale?.sale_id)
      if (!Number.isFinite(sid)) continue
      const saleCur =
        sale.currency && String(sale.currency).trim().length >= 3
          ? String(sale.currency).trim().toUpperCase().slice(0, 10)
          : 'USD'
      const tree = buildPortalPaymentTree(
        data,
        sale?.allowed_payment_methods,
        sale?.allowed_deposit_accounts,
        saleCur,
        sale?.payment_methods_tree,
      )
      const pmList = portalParentMethods(tree)
      const mid = payMethodBySale[sid]
      if (isCodigosRetiroMethodId(pmList, mid)) {
        const handler = (payload) => submitSaleRetiroFromWidget(sale, payload)
        retiroSlotRef.current = handler
        return () => {
          if (retiroSlotRef.current === handler) retiroSlotRef.current = null
        }
      }
    }
    retiroSlotRef.current = null
    return undefined
  }, [
    currentDebtPayObligation,
    data,
    newOrderWalletRecharges,
    handleDebtRetiroCompletado,
    handleRechargeRetiroCompletado,
    isDebtRetiroMethod,
    ordersToShow,
    payMethodByRecharge,
    payMethodBySale,
    rechargeFormById,
    submitSaleRetiroFromWidget,
  ])

  if (loading) {
    return (
      <div className={PORTAL_PAGE_ROOT_CLASS}>
        <div className={PORTAL_PAGE_MAIN_CLASS}>
          <div className="rounded-[20px] border border-white/10 bg-white/[0.06] px-4 py-10 text-center md:px-5">
            <Loader2 className="animate-spin mx-auto mb-3 text-violet-300" size={36} aria-hidden />
            <p className="m-0 opacity-72">Cargando tu cuenta…</p>
          </div>
        </div>
      </div>
    )
  }

  if (isBlocked) {
    return (
      <div className={`${PORTAL_PAGE_ROOT_CLASS} flex min-h-screen items-center justify-center`}>
        <div className={`${PORTAL_PAGE_MAIN_CLASS} w-full py-8`}>
        <div
          className="w-full rounded-[20px] border border-red-400/35 bg-white/[0.06] px-4 py-10 text-center shadow-[0_24px_48px_rgba(0,0,0,0.35)] md:px-6"
        >
          <div className="text-5xl mb-5" aria-hidden>
            🔒
          </div>
          <h1 className="text-xl font-bold text-white mb-3">Cuenta Suspendida</h1>
          <p className="text-sm leading-relaxed text-slate-300">
            Por favor, contacta a tu administrador para más información.
          </p>
        </div>
        </div>
      </div>
    )
  }

  if (loadError || !data) {
    return (
      <div className={PORTAL_PAGE_ROOT_CLASS}>
        <div className={`${PORTAL_PAGE_MAIN_CLASS} pt-8 md:pt-12`}>
          <div className="rounded-[22px] border border-red-400/35 bg-red-950/20 px-4 py-6 text-center md:px-6">
            <h1 className="text-lg font-semibold text-white mb-2">Portal de cliente</h1>
            <p className="text-sm text-red-200 break-words">{loadError || 'No disponible.'}</p>
            <Link
              to="/login"
              className={`${PORTAL_TOUCH_BUTTON_CLASS} mt-6 bg-white/10 text-white hover:bg-white/15`}
            >
              Acceso interno
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const clientName = resolvePortalClientLabelForRetiro(data?.client)

  const cxcTotalAmount = parseMoneyNum(cxcBalance?.total)
  const cxcTotalCurrency =
    String(cxcBalance?.currency || data?.client?.currency || 'USD')
      .trim()
      .toUpperCase()
      .slice(0, 10) || 'USD'
  const showCxcDebtBanner = Number.isFinite(cxcTotalAmount) && cxcTotalAmount > 1e-9

  const showUnifiedAbonoPayShell = pendingLedgerObligations.length > 0
  /** Formularios de nuevos pedidos visibles cuando hay elementos en esta sección (sin selector previo). */
  const showNewOrderForms = hasNewOrders && isDirectLineClient

  // ── Debt payment form helper ───────────────────────────────────────────────
  const debtFormCard = (title = 'Subir comprobante de abono') => {
    const obligationReady = Boolean(currentDebtPayObligation)
    const isDebtRetiro = isCodigosRetiroMethodId(debtPaymentMethods, debtForm.method)
    const selectedPendingLabel =
      currentDebtPayObligation ?
        formatMoney(currentDebtPayObligation.pendingAmount, currentDebtPayObligation.currency)
      : '—'
    const depDebtResolved =
      debtForm.account || (debtPaymentAccounts[0]?.id != null ? String(debtPaymentAccounts[0].id) : '')
    const selectedDebtAccount = debtPaymentAccounts.find((d) => String(d.id) === String(depDebtResolved))
    const debtMismatchMsg = portalCurrencyMismatchMessage(
      debtForm.aiResult?.extracted_currency,
      selectedDebtAccount?.currency,
    )
    const debtMultiMsg =
      debtForm.aiResult?._multi_currency ?
        'No pudimos interpretar una moneda clara del comprobante; prueba otra foto legible.'
      : null
    const debtPaidOk = Number.isFinite(parseFloat(String(debtForm.amount ?? '').trim().replace(',', '.')))
      ? parseFloat(String(debtForm.amount ?? '').trim().replace(',', '.'))
      : NaN
    const debtDisableBtn =
      debtForm.submitting ||
      !obligationReady ||
      !debtForm.method ||
      (isDebtRetiro
        ? debtPaymentMethods.length === 0 || debtPaymentAccounts.length === 0
        : debtReceiptFiles.length === 0 ||
          !Number.isFinite(debtPaidOk) ||
          !(debtPaidOk > 0) ||
          Boolean(debtMismatchMsg || debtMultiMsg)) ||
      debtPaymentMethods.length === 0 ||
      debtPaymentAccounts.length === 0

    const debtUxHint = portalDebtPayMissingHint({
      submitting: debtForm.submitting,
      debtPaymentMethodsLen: debtPaymentMethods.length,
      hasMethod: Boolean(String(debtForm.method || '').trim()),
      depAccountsLen: debtPaymentAccounts.length,
      needsAccountPick: debtPaymentAccounts.length > 1,
      accountSelected: debtForm.account,
      receiptCount: debtReceiptFiles.length,
      analyzing: debtForm.analyzing,
      paidOk: Number.isFinite(debtPaidOk) && debtPaidOk > 0,
      hasBlockingCurrencyError: Boolean(debtMismatchMsg || debtMultiMsg),
    })
    const debtCreditAvail = obligationReady
      ? portalCreditForCurrency(data, creditRowsDisplay, currentDebtPayObligation.currency)
      : 0
    const debtCreditApplyPreview = obligationReady
      ? Math.min(debtCreditAvail, Number(currentDebtPayObligation.pendingAmount) || 0)
      : 0
    const showDebtCreditBtn = obligationReady && debtCreditAvail > 1e-9
    const debtPaymentBlocking = portalHasBlockingDebtPayment(data)
    const debtObligationSale =
      currentDebtPayObligation?.kind === 'sale'
        ? [...historicalDebtSales, ...(data?.outstanding_sales ?? []), ...(data?.new_order_sales ?? [])].find(
            (s) => Number(s.sale_id) === Number(currentDebtPayObligation.saleId),
          )
        : null
    const debtShowReviewSuccess =
      (debtForm.success || retiroSuccessByScope?.scope === 'debt') && debtPaymentBlocking
    const debtLastPaymentRejected =
      !debtPaymentBlocking
      && (portalLastClientPaymentRejected(data)
        || (debtObligationSale ? portalSaleLastPaymentRejected(debtObligationSale) : false))

    return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-[13px] font-bold tracking-[0.04em] text-sky-100/90">{title}</p>

      {debtLastPaymentRejected ? <PortalPaymentRejectedBanner /> : null}

        {!obligationReady ?
        <p className="m-0 rounded-xl border border-amber-500/35 bg-amber-950/25 px-3 py-2.5 text-center text-[13px] leading-relaxed text-amber-100">
          Por favor, selecciona primero una deuda en «Saldo pendiente» (menú «Ver estado y movimientos de», si está visible) para
          realizar un pago con comprobante.
        </p>
      : (
        <p className="m-0 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] text-slate-200">
          Vas a pagar:{' '}
          <strong className="text-white">{currentDebtPayObligation.summaryLabel}</strong>
          {' — '}
          <span className="tabular-nums font-semibold text-emerald-200">{selectedPendingLabel} pendientes</span>
        </p>
      )}

      {showDebtCreditBtn ? (
        <>
          <button
            type="button"
            disabled={debtForm.submitting}
            onClick={submitDebtPaymentWithCredit}
            className={`${PORTAL_TOUCH_BUTTON_CLASS} border border-emerald-400/45 bg-emerald-950/35 text-emerald-50 shadow-lg outline-none ring-2 ring-transparent hover:bg-emerald-950/50 focus-visible:ring-emerald-400/60`}
          >
            {debtForm.submitting
              ? 'Aplicando saldo a favor…'
              : `Pagar con mi Saldo a Favor (hasta ${formatMoney(debtCreditApplyPreview, currentDebtPayObligation.currency)})`}
          </button>
          <p className="m-0 text-center text-[11px] uppercase tracking-wide text-slate-400/80">
            — o paga con transferencia y comprobante —
          </p>
        </>
      ) : null}

      <div className={`${PORTAL_PAYMENT_SHELL_CLASS} mb-3`}>
        <label
          htmlFor="portal-debt-payment-method"
          className="mb-2 block text-[11px] uppercase tracking-[0.07em] text-white/55"
        >
          Método de pago
        </label>
        <Select
          inputId="portal-debt-payment-method"
          classNamePrefix="portal-rs"
          options={portalPaymentMethodOptions(debtPaymentMethods)}
          value={portalPaymentMethodSelectValue(debtPaymentMethods, debtForm.method)}
          onChange={(selectedOption) =>
            setDebtForm((p) => ({
              ...p,
              method: selectedOption ? String(selectedOption.value) : '',
              account: '',
            }))
          }
          isDisabled={!obligationReady || debtPaymentMethods.length === 0}
          isClearable={false}
          placeholder="Seleccionar…"
          styles={portalPaymentMethodSelectStyles}
          menuPortalTarget={typeof document !== 'undefined' ? document.body : null}
          menuPosition="fixed"
        />
      </div>

      {/* Account */}
      {debtPaymentAccounts.length > 1 && (
        <>
          <label
            htmlFor="portal-debt-deposit-account"
            className="mb-2 block text-[11px] uppercase tracking-[0.07em] text-white/55"
          >
            Cuenta donde depositaste
          </label>
          <select
            id="portal-debt-deposit-account"
            disabled={!obligationReady || debtPaymentAccounts.length <= 1}
            value={debtForm.account}
            onChange={(e) => {
              const depVal = e.target.value
              setDebtForm((p) => ({ ...p, account: depVal }))
              const filesNow = debtReceiptFilesRef.current
              const expected = currentDebtPayObligation?.pendingAmount ?? null
              if (filesNow?.length) analyzeDebtReceiptWithAI(filesNow, expected, debtCurrency)
            }}
            className={`${PORTAL_TOUCH_INPUT_CLASS} mb-3`}
          >
            <option value="" disabled>Seleccionar cuenta…</option>
            {debtPaymentAccounts.map((d) => (
              <option key={d.id} value={String(d.id)}>{d.bank_name}{d.account_number ? ` · ${d.account_number}` : ''}</option>
            ))}
          </select>
        </>
      )}
      {debtPaymentAccounts.length === 1 && (
        <div style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 12, fontSize: 13 }}>
          <p style={{ margin: 0, fontWeight: 700 }}>{debtPaymentAccounts[0].bank_name}</p>
          {debtPaymentAccounts[0].account_number && (
            <p style={{ margin: '4px 0 0', opacity: 0.75 }}>Nº: {debtPaymentAccounts[0].account_number}</p>
          )}
        </div>
      )}

      {/* Receipt upload o widget Códigos de Retiro */}
      {isDebtRetiro ? (
        debtShowReviewSuccess ? (
          <RetiroSuccessPanel
            message={PORTAL_REVIEW_SUCCESS_MSG}
            monto={retiroSuccessByScope?.scope === 'debt' ? retiroSuccessByScope.monto : undefined}
            currency={debtCurrency}
          />
        ) : (
          <>
            <CodigosRetiroWidget
              clientName={clientName}
              referenciaExterna={
                currentDebtPayObligation?.kind === 'sale'
                  ? currentDebtPayObligation.saleId
                  : undefined
              }
            />
            {retiroSubmittingKey === 'debt' || debtForm.submitting ? (
              <p style={{ margin: '12px 0 0', fontSize: 13, color: '#93c5fd', textAlign: 'center' }}>
                Registrando tu pago en revisión…
              </p>
            ) : (
              <p style={{ margin: '12px 0 0', fontSize: 12, color: 'rgba(148,163,184,0.95)', textAlign: 'center' }}>
                Sube la foto y confirma los datos en el formulario de verificación. Al finalizar enviaremos tu pago a
                revisión.
              </p>
            )}
          </>
        )
      ) : (
      <div className="portal-receipt-upload-glow-wrap mb-3 w-full min-w-0 rounded-2xl border border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.6)] md:mb-4">
        <section className="portal-receipt-upload-card w-full min-w-0">
          <div className="portal-receipt-upload-circuit-overlay" aria-hidden />
          <div className="portal-order-summary-inner px-3 pb-4 pt-4 md:px-5 md:pb-5 md:pt-5">
            <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.06em] text-green-300">
              Comprobante
            </p>
            <p className="mb-4 text-[13px] text-slate-200/90">Sube el comprobante de pago (JPG/PNG/PDF).</p>
            <div
              role="presentation"
              className={`cursor-pointer rounded-2xl border border-dashed px-5 py-6 text-center transition-colors duration-200 ${
                debtForm.dragOver
                  ? 'border-green-400/65 bg-black/45 text-green-50'
                  : 'border-white/25 bg-black/35 text-slate-100'
              }`}
              onDragOver={(e) => {
                e.preventDefault()
                setDebtForm((p) => ({ ...p, dragOver: true }))
              }}
              onDragLeave={() => setDebtForm((p) => ({ ...p, dragOver: false }))}
              onDrop={(e) => {
                e.preventDefault()
                setDebtForm((p) => ({ ...p, dragOver: false }))
                pickDebtReceipt(e.dataTransfer.files)
              }}
              onClick={() => document.getElementById('debt-rcv').click()}
            >
              <input
                type="file"
                id="debt-rcv"
                accept="image/jpeg,image/png,application/pdf"
                style={{ display: 'none' }}
                onChange={(e) => pickDebtReceipt(e.target.files)}
              />
              <span className={`inline-flex justify-center ${debtForm.dragOver ? 'text-green-200' : 'text-green-100'}`}>
                <IconUploadCloud />
              </span>
              <p className="mt-2 text-[13px] text-slate-50">
                Arrastra tu cupón aquí y tócalo para elegir
              </p>
            </div>
            {debtReceiptFiles.length ? (
              <div className="mt-4 flex w-full flex-wrap items-center justify-center gap-3">
                {debtReceiptFiles.map((df, fi) => {
                  const thumb = debtReceiptThumbUrls[fi]
                  const isPdf = /^application\/pdf$/i.test(df?.type || '')
                  return (
                    <div key={`debt-thumb-${fi}-${df.lastModified}-${df.name}`} className="relative">
                      {isPdf || !thumb ?
                        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-black/35 text-[10px] font-bold uppercase text-green-100">
                          PDF
                        </div>
                      : <img
                          src={thumb}
                          alt=""
                          className="h-14 w-14 shrink-0 rounded-lg border border-green-400/35 object-cover"
                        />}
                      <button
                        type="button"
                        aria-label="Quitar archivo"
                        className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white shadow hover:bg-red-500"
                        onClick={(evt) => {
                          evt.preventDefault()
                          evt.stopPropagation()
                          removeDebtReceiptAt(fi)
                        }}
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        </section>
      </div>
      )}

      {!isDebtRetiro ? (
      <>
      <label style={{ display: 'block', fontSize: 11, opacity: 0.55, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
        Importe detectado por IA (referencia: {selectedPendingLabel} · {currentDebtPayObligation?.summaryLabel ?? '—'})
      </label>
      <input
        type="number"
        readOnly
        required
        min="0.01"
        step="0.01"
        placeholder="—"
        value={debtForm.amount}
        className="mb-2 w-full rounded-xl border border-white/18 bg-gray-950/55 px-4 py-3 text-[15px] text-fuchsia-50 opacity-80 cursor-not-allowed box-border"
      />
      {debtMultiMsg ? (
        <p className="mb-2 text-[13px] font-semibold leading-relaxed text-red-300">{`❌ ${debtMultiMsg}`}</p>
      ) : null}
      {debtMismatchMsg ? (
        <p className="mb-2 text-[13px] font-semibold leading-relaxed text-red-300">{debtMismatchMsg}</p>
      ) : null}

      {/* AI feedback */}
      {debtForm.analyzing && <p style={{ margin: '0 0 10px', fontSize: 13, color: '#93c5fd', textAlign: 'center' }}>Analizando comprobante con IA… 🤖</p>}
      {!debtForm.analyzing && debtForm.aiResult && (
        debtForm.aiResult.is_readable
          ? <p style={{ margin: '0 0 10px', fontSize: 13, color: '#86efac', textAlign: 'center' }}>
              ✅ Se detectaron {String(debtForm.aiResult.extracted_currency || debtCurrency)}{' '}
              {(() => {
                const raw = debtForm.aiResult.extracted_amount
                const n =
                  typeof raw === 'number' && Number.isFinite(raw)
                    ? raw
                    : parseMoneyNum(raw)
                return Number.isFinite(n) ? n.toFixed(2) : '—'
              })()}
            </p>
          : <p style={{ margin: '0 0 10px', fontSize: 13, color: '#fca5a5', textAlign: 'center' }}>❌ No pudimos leer el monto. Verifica la imagen.</p>
      )}
      </>
      ) : null}

      {debtForm.error && <p style={{ margin: '0 0 10px', fontSize: 13, color: '#fecaca', textAlign: 'center' }}>{debtForm.error}</p>}
      {debtShowReviewSuccess && (
        <p style={{ margin: '0 0 10px', fontSize: 13, color: '#86efac', textAlign: 'center' }}>
          ✅ {PORTAL_REVIEW_SUCCESS_MSG}
        </p>
      )}

      {debtUxHint && !isDebtRetiro ?
        <p className="mb-3 px-1 text-center text-sm font-medium leading-relaxed text-amber-400">{debtUxHint}</p>
      : null}

      {!isDebtRetiro ? (
      <button
        type="button"
        disabled={debtDisableBtn}
        onClick={submitDebtPayment}
        className="w-full rounded-xl border-0 px-4 py-[14px] text-[15px] font-semibold leading-tight text-slate-900 shadow-lg outline-none ring-2 ring-transparent ring-offset-0 transition hover:brightness-[1.02] focus-visible:ring-violet-400/70 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
        style={{
          background: 'linear-gradient(90deg,#a5b4fc,#c4b5fd,#67e8f9)',
        }}
      >
        {debtForm.submitting ? 'Enviando…' : 'Enviar comprobante de pago'}
      </button>
      ) : null}
    </div>
    )
  }

  return (
    <div className={PORTAL_PAGE_ROOT_CLASS}>
      <div className={`${PORTAL_PAGE_MAIN_CLASS} relative`}>
        {parentContactPhone ? (
          <a
            href={`https://wa.me/${whatsappDigits(parentContactPhone)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mb-3 inline-flex max-w-[min(100%,22rem)] flex-col items-start justify-center rounded-lg border border-indigo-500/40 bg-indigo-900/40 px-2.5 py-1.5 shadow-[0_4px_14px_rgba(0,0,0,0.22)] backdrop-blur-sm transition-colors hover:bg-indigo-800/60 md:absolute md:left-0 md:top-0 md:z-20 md:mb-0"
            title={`WhatsApp: ${formatPortalContactPhoneDisplay(parentContactPhone)}`}
          >
            <div className="flex flex-row items-center gap-1.5">
              {PORTAL_WA_SVG}
              <span className="text-xs font-bold text-indigo-200">Contacto</span>
            </div>
            <span className="mt-0.5 text-[10px] tracking-wide tabular-nums text-indigo-300">
              {formatPortalContactPhoneDisplay(parentContactPhone)}
            </span>
          </a>
        ) : null}
        <p className={`mb-2 text-center text-[11px] font-semibold uppercase tracking-[0.22em] text-white/45 ${parentContactPhone ? 'md:pt-10' : ''}`}>
          Autogestión
        </p>
        <h1 className="m-0 mb-1.5 text-center text-2xl font-extrabold leading-tight tracking-tight md:text-[1.65rem]">
          Hola, <span className="text-sky-300 break-words">{clientName}</span>
        </h1>
        {data?.client?.email ? (
          <p className="mb-3 break-all text-center text-sm text-white/60 md:mb-4">{String(data.client.email)}</p>
        ) : (
          <div className="mb-3 md:mb-4" />
        )}

        <div className="mb-3 flex w-full justify-end px-1">
          <button
            type="button"
            onClick={collapseAllSections}
            className="flex cursor-pointer items-center gap-1.5 rounded-full border border-indigo-800/50 bg-indigo-950/50 px-3 py-1.5 text-xs text-indigo-300 transition-all hover:bg-indigo-900/80"
          >
            <ChevronsUp className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Minimizar todo
          </button>
        </div>

        <PortalNeoAccordion
          sectionId="portal-acc-notifications"
          title="📬 MIS NOTIFICACIONES"
          headerAside={notificationsAccordionAside}
          accent="sapphire"
          expanded={isNotificationsOpen}
          onToggle={() => setIsNotificationsOpen((o) => !o)}
        >
          <style>{`
            .portal-notif-html strong,
            .portal-notif-html b {
              font-weight: 700;
            }
            .portal-notif-html em,
            .portal-notif-html i {
              font-style: italic;
            }
            .portal-notif-html u {
              text-decoration: underline;
            }
            .portal-notif-html p {
              margin: 0 0 0.65em;
            }
            .portal-notif-html p:last-child {
              margin-bottom: 0;
            }
            .portal-notif-html ul {
              list-style: disc;
              margin: 0.35em 0 0.65em 1.25em;
              padding: 0;
            }
            .portal-notif-html ol {
              list-style: decimal;
              margin: 0.35em 0 0.65em 1.25em;
              padding: 0;
            }
          `}</style>
          {isNotificationsOpen ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] text-slate-400/90">Bandeja de mensajes del administrador</span>
                <button
                  type="button"
                  onClick={() => void loadPortalNotifications()}
                  disabled={portalNotificationsLoading}
                  className="shrink-0 rounded-lg border border-slate-500/40 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:bg-slate-800/60 disabled:opacity-45"
                >
                  Actualizar
                </button>
              </div>

              {portalNotificationsLoading ? (
                <p className="m-0 flex items-center gap-2 text-sm text-slate-400">
                  <Loader2 size={15} className="animate-spin" />
                  Cargando notificaciones…
                </p>
              ) : portalNotificationsErr ? (
                <p className="m-0 text-sm text-red-300">{portalNotificationsErr}</p>
              ) : portalNotifications.length === 0 ? (
                <p className="m-0 text-sm text-slate-400/90">No tienes mensajes en tu bandeja.</p>
              ) : (
                <>
                  <ul className="m-0 list-none space-y-3 p-0">
                    {visiblePortalNotifications.map((row) => {
                      const isRead = Boolean(row?.is_read)
                      const nid = Number(row?.id)
                      const createdLabel = row?.created_at
                        ? new Date(row.created_at).toLocaleString('es-EC', {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })
                        : '—'
                      return (
                        <li
                          key={`portal-notif-${nid}`}
                          className={`rounded-xl border px-3 py-2.5 transition ${
                            !row?.is_read
                              ? 'border-orange-500 bg-orange-500/20 shadow-[0_0_15px_rgba(249,115,22,0.5)]'
                              : 'border-gray-700 bg-gray-800/50 opacity-60'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p
                                className={`m-0 font-bold text-lg leading-snug ${
                                  isRead ? 'text-slate-400' : 'text-white'
                                }`}
                              >
                                {String(row?.title ?? 'Sin título')}
                              </p>
                              <p
                                className={`m-0 mt-0.5 text-[11px] tabular-nums ${
                                  isRead ? 'text-slate-500' : 'text-orange-100/90'
                                }`}
                              >
                                {createdLabel}
                              </p>
                            </div>
                            {!isRead ? (
                              <button
                                type="button"
                                disabled={markingNotificationId === nid}
                                onClick={() => void markPortalNotificationRead(nid)}
                                className="shrink-0 rounded-md border border-orange-400/60 bg-orange-950/50 px-2 py-1 text-[10px] font-semibold text-orange-50 hover:bg-orange-900/60 disabled:opacity-50"
                              >
                                {markingNotificationId === nid ? '…' : 'Marcar como leído'}
                              </button>
                            ) : null}
                          </div>
                          <div
                            className={`portal-notif-html m-0 mt-2 text-[13px] leading-relaxed ${
                              isRead ? 'text-slate-500' : 'text-slate-100'
                            }`}
                            dangerouslySetInnerHTML={{ __html: String(row?.message ?? '') }}
                          />
                        </li>
                      )
                    })}
                  </ul>
                  {sortedPortalNotifications.length > 3 ? (
                    <p className="m-0 text-center text-[11px] text-slate-500/90">
                      Mostrando los 3 mensajes más recientes de {sortedPortalNotifications.length}.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </PortalNeoAccordion>
        {showCxcDebtBanner ? (
          <div
            role="alert"
            className="mb-3 w-full min-w-0 rounded-2xl border-2 border-red-500 px-3 py-4 text-center shadow-[0_0_28px_rgba(239,68,68,0.45)] md:mb-4 md:px-4"
            style={{
              background: 'linear-gradient(180deg, rgba(127,29,29,0.95) 0%, rgba(69,10,10,0.98) 100%)',
            }}
          >
            <p className="m-0 text-[15px] font-extrabold leading-snug tracking-wide text-red-50 sm:text-base">
              ⚠️ TIENES UN SALDO PENDIENTE DE {formatMoney(cxcTotalAmount, cxcTotalCurrency)}
            </p>
            <p className="m-0 mt-2 text-[12px] font-medium leading-relaxed text-red-100/95 sm:text-[13px]">
              Tu cuenta tiene facturas con pagos parciales o fallidos. Regulariza tu saldo para evitar la
              suspensión del servicio.
            </p>
          </div>
        ) : null}
        {isDirectLineClient ? (
        <PortalNeoAccordion
          sectionId="portal-acc-orders"
          title="NUEVOS PEDIDOS PARA PAGO"
          subtitle="Pedidos y recargas con saldo pendiente (incluye abonos parciales con saldo a favor)"
          headerAside={newOrdersAccordionAside}
          accent="sapphire"
          expanded={accordionOrdersOpen}
          onToggle={() => setAccordionOrdersOpen((o) => !o)}
        >
        <div className="rounded-[18px] border border-indigo-400/35 bg-gradient-to-br from-slate-950/70 to-indigo-950/35 p-[14px] transition-all duration-300 shadow-[inset_0_1px_0_rgba(199,210,254,0.07),0_14px_40px_rgba(0,0,0,0.28)]">

        {showNewOrderForms && newOrderWalletRecharges.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32, marginBottom: 28 }}>
          {newOrderWalletRecharges.map((fr) => {
            const frId = Number(fr.id)
            if (!Number.isFinite(frId)) return null
            const rechargeForm = rechargePayFormFromMap(rechargeFormById, frId)
            const setRechargeForm = (patch) => patchRechargePayForm(setRechargeFormById, frId, patch)
            const rechargeReceiptFiles = receiptFilesByRecharge[frId] || []
            const rechargeReceiptThumbUrls = receiptThumbUrlsByRecharge[frId] || []
            const refStr = walletRechargeLedgerRef(frId)
            const cur =
              fr?.recharge_currency && String(fr.recharge_currency).trim().length >= 3
                ? String(fr.recharge_currency).trim().toUpperCase().slice(0, 10)
                : 'USD'
            const payTree = buildPortalPaymentTree(
              data,
              fr?.allowed_payment_methods,
              fr?.allowed_deposit_accounts,
              cur,
              fr?.payment_methods_tree,
            )
            const rechargePaymentMethods = portalParentMethods(payTree)
            const methodForDeps = rechargeForm.method || payMethodByRecharge[frId] || ''
            const rechargeDepositAccounts = portalAccountsForMethod(payTree, methodForDeps)
            const isRechargeRetiroMethod = isCodigosRetiroMethodId(rechargePaymentMethods, methodForDeps)
            const retiroScope = `recharge:${frId}`
            const amountReq = parseMoneyNum(fr.amount_requested)
            const pend = parseMoneyNum(fr.balance_pending)
            const featPaid = Math.max(0, parseMoneyNum(fr?.amount_paid) || 0)
            const isFeatPartial = featPaid > 1e-9 && pend > 1e-9
            const showPayForm = portalCanShowPayFormForRecharge(fr)
            const featLastPaymentRejected = portalRechargeLastPaymentRejected(fr)
            const featPaymentsInReview = portalRechargeHasPaymentsInReview(fr)
            const featShowReviewBanner =
              (rechargeForm.success || featPaymentsInReview) && showPayForm
            const rechargeDepResolved =
              rechargeForm.account ||
              payAccountByRecharge[frId] ||
              (rechargeDepositAccounts[0]?.id != null ? String(rechargeDepositAccounts[0].id) : '')
            const selectedRechargeAcc = rechargeDepositAccounts.find((d) => String(d.id) === String(rechargeDepResolved))
            const needsDepositPickFeat = rechargeDepositAccounts.length > 0
            const featMismatchMsg = portalCurrencyMismatchMessage(
              rechargeForm.aiResult?.extracted_currency,
              selectedRechargeAcc?.currency,
            )
            const featMultiMsg =
              rechargeForm.aiResult?._multi_currency ?
                'No pudimos interpretar una moneda clara del comprobante; prueba otra foto legible.'
              : null
            const featPaidOk = Number.isFinite(
              parseFloat(String(rechargeForm.amount ?? '').trim().replace(',', '.')),
            )
              ? parseFloat(String(rechargeForm.amount ?? '').trim().replace(',', '.'))
              : NaN
            const featDisableBtn =
              rechargeForm.submitting ||
              !showPayForm ||
              rechargePaymentMethods.length === 0 ||
              rechargeDepositAccounts.length === 0 ||
              !String(rechargeForm.method || methodForDeps || '').trim() ||
              (needsDepositPickFeat && rechargeDepositAccounts.length > 1 && !String(rechargeDepResolved || '').trim()) ||
              !(pend > 1e-9) ||
              (isRechargeRetiroMethod
                ? false
                : rechargeReceiptFiles.length === 0 ||
                  !Number.isFinite(featPaidOk) ||
                  !(featPaidOk > 0) ||
                  Boolean(featMismatchMsg || featMultiMsg))
            const dragOverFeat = Boolean(rechargeForm.dragOver)
            const headlineAmt =
              isFeatPartial ? pend
              : Number.isFinite(amountReq) && amountReq > 1e-9 ? amountReq
              : pend > 1e-9 ? pend
              : 0
            const headlineCaption =
              pend > 1e-9 ? 'Saldo restante a pagar'
              : isFeatPartial ? 'Saldo pendiente'
              : 'Total a pagar'
            const featUxHint = portalNewOrderPayMissingHint({
              submitting: rechargeForm.submitting,
              reservationExpired: false,
              paysOnlyWithCreditBalance: false,
              pmListLen: rechargePaymentMethods.length,
              hasMethodId: Boolean(String(rechargeForm.method || methodForDeps || '').trim()),
              needsDepositPick: needsDepositPickFeat,
              depListLen: rechargeDepositAccounts.length,
              resolvedDepId: rechargeDepResolved,
              totalPayablePositive: pend > 1e-9,
              fileArrLen: rechargeReceiptFiles.length,
              firstFileMime: rechargeReceiptFiles[0]?.type || '',
              isAnalyzing: rechargeForm.analyzing,
              paidOk: Number.isFinite(featPaidOk) && featPaidOk > 0,
              hasBlockingCurrencyError: Boolean(featMismatchMsg || featMultiMsg),
            })
            const featCreditAvail = portalCreditForCurrency(data, creditRowsDisplay, cur)
            const featCreditApply = Math.min(featCreditAvail, Math.max(0, pend))
            const showFeatCreditBtn = showPayForm && featCreditAvail > 1e-9

            const pickRechargeReceipt = (fileList) => {
              const incomingRaw = [...(fileList || [])].filter(Boolean)
              const ok = incomingRaw.filter(
                (f) =>
                  /^image\/(jpeg|png)$/i.test(f.type || '') || /^application\/pdf$/i.test(f.type || ''),
              )
              if (!ok.length && incomingRaw.length) {
                setRechargeForm({ error: 'Solo JPG, PNG o PDF (un comprobante).' })
                return
              }
              const next = ok.slice(0, 1)
              if (incomingRaw.length !== ok.length) {
                setRechargeForm({ error: 'Formato no válido. Usa JPG, PNG o PDF (un solo archivo).' })
              }
              if (!next.length) return
              replaceRechargeReceiptFiles(frId, fr, next)
            }

            const removeRechargeReceiptAt = (idx) => {
              const next = [...rechargeReceiptFiles]
              next.splice(idx, 1)
              replaceRechargeReceiptFiles(frId, fr, next)
            }

            return (
              <div key={`new-order-recharge-${frId}`} style={{ marginTop: 12 }}>
                {!showPayForm ? (
                  <p
                    style={{
                      margin: 0,
                      padding: '12px 14px',
                      borderRadius: 14,
                      background: 'rgba(251,191,36,0.1)',
                      border: '1px solid rgba(251,191,36,0.28)',
                      fontSize: 13,
                      lineHeight: 1.5,
                      color: '#fef3c7',
                    }}
                  >
                    {pend <= 1e-9 ?
                      <>Esta solicitud no tiene saldo pendiente por cubrir.</>
                    : featLastPaymentRejected ?
                      <>
                        {PORTAL_PAYMENT_REJECTED_MSG} Si el saldo sigue pendiente, puedes enviar un nuevo comprobante
                        abajo.
                      </>
                    : <>
                        No es posible enviar un comprobante en el estado actual de esta solicitud. Si necesitas ayuda,
                        contacta a tu distribuidor.
                      </>}
                  </p>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      void submitRechargePayment(fr)
                    }}
                    style={{ display: 'flex', flexDirection: 'column', gap: 0 }}
                  >
                    {featShowReviewBanner ? (
                      <PortalPaymentsInReviewBanner message="Recibimos tu comprobante. Puedes enviar abonos adicionales mientras quede saldo pendiente." />
                    ) : null}
                    {featLastPaymentRejected ? <PortalPaymentRejectedBanner /> : null}
                    <PortalNeoOrderSummaryCard
                      headlineAmountFormatted={formatMoney(headlineAmt, cur)}
                      headlineCaption={headlineCaption}
                      countdownMmSs={null}
                      detailLinesSlot={
                        <div className="portal-order-summary-inner divide-y divide-white/10">
                          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-5 py-4">
                            <div className="min-w-0">
                              <p className="text-[15px] font-semibold leading-snug text-white">Recarga de saldo BaaS</p>
                              <p className="mt-1 text-xs leading-relaxed text-slate-500">Referencia #{refStr}</p>
                            </div>
                            <p className="pt-0.5 text-right text-[15px] font-semibold tabular-nums text-slate-100">
                              {formatMoney(isFeatPartial && Number.isFinite(amountReq) ? amountReq : headlineAmt, cur)}
                            </p>
                          </div>
                          {isFeatPartial ? (
                            <>
                              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-5 py-3 text-sm">
                                <span className="text-slate-400">Abono aplicado</span>
                                <span className="tabular-nums font-medium text-emerald-300">
                                  −{formatMoney(featPaid, cur)}
                                </span>
                              </div>
                              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-5 py-3 text-sm">
                                <span className="font-medium text-slate-200">Saldo pendiente</span>
                                <span className="tabular-nums font-semibold text-white">{formatMoney(pend, cur)}</span>
                              </div>
                            </>
                          ) : null}
                        </div>
                      }
                      footerText={`Referencia #${refStr}`}
                    />

                    {showFeatCreditBtn ? (
                      <>
                        <button
                          type="button"
                          disabled={rechargeForm.submitting}
                          onClick={() => void submitRechargeWithCredit(fr)}
                          className="mb-3 w-full rounded-2xl border border-emerald-400/45 bg-emerald-950/35 px-4 py-3.5 text-[15px] font-bold leading-tight text-emerald-50 outline-none transition hover:bg-emerald-950/50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {rechargeForm.submitting
                            ? 'Aplicando saldo a favor…'
                            : `Pagar con mi Saldo a Favor (hasta ${formatMoney(featCreditApply, cur)})`}
                        </button>
                        <p className="m-0 mb-3 text-center text-[11px] uppercase tracking-wide text-slate-400/80">
                          — o paga con transferencia y comprobante —
                        </p>
                      </>
                    ) : null}

                    <section className={PORTAL_PAYMENT_SHELL_CLASS}>
                      <label
                        htmlFor={`recharge-baas-pm-${frId}`}
                        className="mb-2.5 block text-xs uppercase tracking-[0.06em] text-white/50"
                      >
                        Método de pago
                      </label>
                      <Select
                        inputId={`recharge-baas-pm-${frId}`}
                        classNamePrefix="portal-rs"
                        options={portalPaymentMethodOptions(rechargePaymentMethods)}
                        value={portalPaymentMethodSelectValue(
                          rechargePaymentMethods,
                          rechargeForm.method || methodForDeps,
                        )}
                        onChange={(selectedOption) => {
                          const mid = selectedOption ? String(selectedOption.value) : ''
                          setRechargeForm({ method: mid, account: '' })
                          setPayMethodByRecharge((p) => ({ ...p, [frId]: mid }))
                          setPayAccountByRecharge((p) => ({ ...p, [frId]: '' }))
                        }}
                        isDisabled={rechargePaymentMethods.length === 0}
                        isClearable={false}
                        placeholder="Seleccionar…"
                        styles={portalPaymentMethodSelectStyles}
                        menuPortalTarget={typeof document !== 'undefined' ? document.body : null}
                        menuPosition="fixed"
                      />
                      {rechargePaymentMethods.length === 0 ?
                        <p style={{ margin: '12px 0 0', fontSize: 13, color: '#fbbf24', opacity: 0.92 }}>
                          No hay métodos de pago habilitados para esta recarga.
                        </p>
                      : null}
                    </section>

                    {needsDepositPickFeat ? (
                      <section className={PORTAL_PAYMENT_SHELL_CLASS}>
                        <p className="m-0 mb-1 text-xs uppercase tracking-[0.06em] text-white/50">
                          Cuenta donde depositar
                        </p>
                        <p style={{ margin: '0 0 12px', fontSize: 12, opacity: 0.55, lineHeight: 1.45 }}>
                          Cuentas habilitadas por el proveedor para esta solicitud.
                        </p>
                        {rechargeDepositAccounts.length === 0 ?
                          <p style={{ margin: 0, fontSize: 14, color: '#fbbf24', lineHeight: 1.45 }}>
                            No hay cuentas configuradas. Contacta al proveedor.
                          </p>
                        : rechargeDepositAccounts.length === 1 ?
                          rechargeDepositAccounts.map((d) => (
                            <div
                              key={d.id}
                              style={{
                                padding: '14px',
                                borderRadius: 14,
                                background: 'rgba(255,255,255,0.06)',
                                border: '1px solid rgba(255,255,255,0.1)',
                                fontSize: 14,
                                lineHeight: 1.55,
                              }}
                            >
                              <p style={{ margin: 0, fontWeight: 700 }}>{d.bank_name}</p>
                              {d.account_number ?
                                <p style={{ margin: '8px 0 0', fontVariantNumeric: 'tabular-nums', opacity: 0.92 }}>
                                  Nº cuenta / referencia: <strong>{d.account_number}</strong>
                                </p>
                              : null}
                              <p style={{ margin: '8px 0 0', fontSize: 12, opacity: 0.55 }}>Moneda: {d.currency}</p>
                            </div>
                          ))
                        : (
                          <>
                            <label
                              htmlFor={`recharge-baas-dep-${frId}`}
                              style={{ display: 'block', fontSize: 12, opacity: 0.55, marginBottom: 8 }}
                            >
                              Elige la cuenta donde transferiste:
                            </label>
                            <select
                              id={`recharge-baas-dep-${frId}`}
                              value={rechargeForm.account}
                              required
                              onChange={(ev) => {
                                const depVal = ev.target.value
                                setRechargeForm({ account: depVal })
                                setPayAccountByRecharge((p) => ({ ...p, [frId]: depVal }))
                                const filesNow = receiptFilesByRecharge[frId] || []
                                if (filesNow.length) {
                                  void analyzeRechargeReceiptWithAI(
                                    frId,
                                    filesNow,
                                    parseMoneyNum(fr.amount_requested),
                                    cur,
                                  )
                                }
                              }}
                              className={PORTAL_TOUCH_INPUT_CLASS}
                            >
                              <option value="" disabled>
                                Seleccionar cuenta…
                              </option>
                              {rechargeDepositAccounts.map((d) => (
                                <option key={d.id} value={String(d.id)}>
                                  {d.bank_name}
                                  {d.account_number ? ` · ${d.account_number}` : ''}
                                </option>
                              ))}
                            </select>
                          </>
                        )}
                      </section>
                    ) : null}

                    {isRechargeRetiroMethod ? (
                      <>
                        {(retiroSuccessByScope?.scope === retiroScope || rechargeForm.success) &&
                        showPayForm ? (
                          <RetiroSuccessPanel
                            message="Pedido activado. Puedes enviar abonos adicionales mientras quede saldo pendiente."
                            monto={
                              retiroSuccessByScope?.scope === retiroScope ? retiroSuccessByScope.monto : undefined
                            }
                            currency={cur}
                          />
                        ) : null}
                        <CodigosRetiroWidget clientName={clientName} referenciaExterna={frId} />
                        {retiroSubmittingKey === retiroScope || rechargeForm.submitting ? (
                          <p style={{ margin: '12px 0 0', fontSize: 13, color: '#93c5fd', textAlign: 'center' }}>
                            Registrando tu pago…
                          </p>
                        ) : (
                          <p style={{ margin: '12px 0 0', fontSize: 12, color: 'rgba(148,163,184,0.95)', textAlign: 'center' }}>
                            Sube la foto y confirma los datos en el formulario de verificación. Al finalizar activaremos
                            tu recarga y podrás enviar abonos adicionales si queda saldo.
                          </p>
                        )}
                      </>
                    ) : (
                    <>
                    <div className="portal-receipt-upload-glow-wrap mb-4 rounded-2xl border border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.6)]">
                      <section
                        className="portal-receipt-upload-card"
                        onDragOver={(e) => {
                          e.preventDefault()
                          setRechargeForm({ dragOver: true })
                        }}
                        onDragLeave={() => setRechargeForm({ dragOver: false })}
                        onDrop={(e) => {
                          e.preventDefault()
                          setRechargeForm({ dragOver: false })
                          pickRechargeReceipt(e.dataTransfer.files)
                        }}
                      >
                        <div className="portal-receipt-upload-circuit-overlay" aria-hidden />
                        <div className="portal-order-summary-inner px-5 pb-5 pt-5">
                          <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.06em] text-green-300">
                            Comprobante
                          </p>
                          <p className="mb-4 text-[13px] text-slate-200/90">
                            Sube el comprobante de pago (JPG/PNG/PDF). Puedes declarar un importe mayor al saldo
                            pendiente; el excedente quedará como saldo a favor tras la revisión.
                          </p>
                          <input
                            type="file"
                            accept="image/jpeg,image/png,application/pdf"
                            id={`recharge-rcv-${frId}`}
                            style={{ display: 'none' }}
                            onChange={(e) => pickRechargeReceipt(e.target.files)}
                          />
                          <label
                            htmlFor={`recharge-rcv-${frId}`}
                            className={`flex cursor-pointer flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed px-5 py-6 text-center transition-colors duration-200 ${
                              dragOverFeat ?
                                'border-green-400/65 bg-black/45 text-green-50'
                              : 'border-white/25 bg-black/35 text-slate-100'
                            }`}
                          >
                            <span className={dragOverFeat ? 'text-green-200' : 'text-green-100'}>
                              <IconUploadCloud />
                            </span>
                            <span className="text-[14px] font-semibold text-slate-50">
                              Arrastra tu cupón aquí y tócalo para elegir
                            </span>
                          </label>
                          {rechargeReceiptFiles.length ?
                            <div className="mt-4 flex w-full flex-wrap items-center justify-center gap-3">
                              {rechargeReceiptFiles.map((df, fi) => {
                                const thumb = rechargeReceiptThumbUrls[fi]
                                const isPdf = /^application\/pdf$/i.test(df?.type || '')
                                return (
                                  <div key={`recharge-thumb-${frId}-${fi}-${df.lastModified}-${df.name}`} className="relative">
                                    {isPdf || !thumb ?
                                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-black/35 text-[10px] font-bold uppercase text-green-100">
                                        PDF
                                      </div>
                                    : (
                                      <img
                                        src={thumb}
                                        alt=""
                                        className="h-14 w-14 shrink-0 rounded-lg border border-green-400/35 object-cover"
                                      />
                                    )}
                                    <button
                                      type="button"
                                      aria-label="Quitar archivo"
                                      className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white shadow hover:bg-red-500"
                                      onClick={(evt) => {
                                        evt.preventDefault()
                                        evt.stopPropagation()
                                        removeRechargeReceiptAt(fi)
                                      }}
                                    >
                                      ×
                                    </button>
                                  </div>
                                )
                              })}
                            </div>
                          : null}
                        </div>
                      </section>
                    </div>

                    <div style={{ marginBottom: 12 }}>
                      <label
                        style={{
                          display: 'block',
                          fontSize: 11,
                          opacity: 0.6,
                          letterSpacing: '0.07em',
                          textTransform: 'uppercase',
                          marginBottom: 6,
                        }}
                      >
                        ¿Cuánto pagaste en tu depósito? ({cur})
                      </label>
                      <p style={{ margin: '0 0 8px', fontSize: 12, opacity: 0.65 }}>
                        Este importe solo se completa con la IA al leer el comprobante.
                      </p>
                      <input
                        type="number"
                        readOnly
                        required
                        min="0.01"
                        step="0.01"
                        placeholder="—"
                        value={rechargeForm.amount}
                        className="w-full rounded-xl border border-white/18 bg-gray-950/55 px-4 py-3 text-[15px] text-fuchsia-50 opacity-80 cursor-not-allowed box-border"
                      />
                      {featMultiMsg ?
                        <p className="mt-2 mb-0 text-[13px] font-medium leading-relaxed text-red-300">{`❌ ${featMultiMsg}`}</p>
                      : null}
                      {featMismatchMsg ?
                        <p className="mt-2 mb-0 text-[13px] font-medium leading-relaxed text-red-300">{featMismatchMsg}</p>
                      : null}
                    </div>

                    {rechargeForm.analyzing ?
                      <p
                        style={{
                          margin: '0 0 12px',
                          fontSize: 13,
                          color: '#93c5fd',
                          textAlign: 'center',
                          lineHeight: 1.5,
                        }}
                      >
                        Analizando comprobante con IA… 🤖
                      </p>
                    : rechargeForm.aiResult != null ?
                      rechargeForm.aiResult.is_readable ?
                        (() => {
                          const detectedAmt = rechargeForm.aiResult.extracted_amount
                          const detectedCur = rechargeForm.aiResult.extracted_currency || cur
                          return (
                            <p
                              style={{
                                margin: '0 0 12px',
                                fontSize: 13,
                                color: '#93c5fd',
                                textAlign: 'center',
                                lineHeight: 1.5,
                              }}
                            >
                              💡 Detectamos {detectedCur}{' '}
                              {detectedAmt?.toLocaleString('es-ES', { minimumFractionDigits: 2 })}. Al aprobarse,
                              cualquier diferencia se ajustará automáticamente como saldo pendiente o saldo a favor.
                            </p>
                          )
                        })()
                      : (
                        <p
                          style={{
                            margin: '0 0 12px',
                            fontSize: 13,
                            color: '#fca5a5',
                            textAlign: 'center',
                            lineHeight: 1.5,
                          }}
                        >
                          ❌ No pudimos leer el monto. Verifica la imagen.
                        </p>
                      )
                    : null}
                    </>
                    )}

                    {rechargeForm.error ?
                      <p
                        style={{
                          margin: '0 0 12px',
                          fontSize: 14,
                          color: '#fecaca',
                          textAlign: 'center',
                          lineHeight: 1.4,
                        }}
                      >
                        {rechargeForm.error}
                      </p>
                    : null}

                    {featUxHint && !isRechargeRetiroMethod ?
                      <p className="mb-3 px-1 text-center text-sm font-medium leading-relaxed text-amber-400">
                        {featUxHint}
                      </p>
                    : null}

                    {!isRechargeRetiroMethod ? (
                    <button
                      type="submit"
                      disabled={featDisableBtn}
                      className="w-full rounded-2xl border-0 px-4 py-4 text-[16px] font-bold leading-tight text-slate-900 outline-none ring-2 ring-transparent ring-offset-0 transition hover:brightness-[1.03] focus-visible:ring-indigo-400/70 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
                      style={{
                        background: 'linear-gradient(90deg,#c4b5fd,#67e8f9,#a5b4fc)',
                        boxShadow: '0 18px 40px rgba(99,102,241,0.35)',
                      }}
                    >
                      {rechargeForm.submitting ? 'Enviando…' : 'Enviar comprobante de esta recarga'}
                    </button>
                    ) : null}
                  </form>
                )}
              </div>
            )
          })}
          </div>
        ) : null}

        {showNewOrderForms && ordersToShow.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32, marginTop: newOrderWalletRecharges.length > 0 ? 20 : 0 }}>
            {ordersToShow
              .filter((sale) => Number.isFinite(Number(sale?.sale_id)))
              .map((sale) => {
                const sid = Number(sale.sale_id)
                const saleCurrency =
                  sale.currency && String(sale.currency).trim().length >= 3
                    ? String(sale.currency).trim().toUpperCase().slice(0, 10)
                    : 'USD'
                const saleTotal = saleInvoiceTotal(sale)
                const salePaid = Math.max(0, parseMoneyNum(sale?.amount_paid) || 0)
                const saleBalance = portalSaleOpenBalance(sale)
                const isPartiallyPaid = String(sale.status ?? '').toLowerCase() === 'partially_paid'
                const displayTotal = isPartiallyPaid ? saleBalance : saleTotal
                const invoiceOpenPrincipal = saleBalance

                const clientCreditAvail = portalCreditForCurrency(data, creditRowsDisplay, saleCurrency)
                const creditAppliedToOrder = Math.min(clientCreditAvail, Math.max(0, invoiceOpenPrincipal))
                const totalAfterCredit = Math.max(
                  0,
                  Math.round((invoiceOpenPrincipal - creditAppliedToOrder) * 100) / 100,
                )
                const paysOnlyWithCredit =
                  totalAfterCredit <= 1e-9 && creditAppliedToOrder > 1e-9 && invoiceOpenPrincipal > 1e-9

                /** Monto esperado en el depósito (para IA/comprobante). 0 cuando solo saldo a favor. */
                const aiExpectedDeposit = paysOnlyWithCredit ? 0 : totalAfterCredit

                const linesRaw = lineRowsForSale(sale)
                const methodId = payMethodBySale[sid] ?? ''
                const depositAccountId = payAccountBySale[sid] ?? ''
                const salePayTree = buildPortalPaymentTree(
                  data,
                  sale?.allowed_payment_methods,
                  sale?.allowed_deposit_accounts,
                  saleCurrency,
                  sale?.payment_methods_tree,
                )
                const pmList = portalParentMethods(salePayTree)
                const isSaleRetiro = isCodigosRetiroMethodId(pmList, methodId)
                const depList = portalAccountsForMethod(salePayTree, methodId)
                const needsDepositPick = depList.length > 0
                const showReviewBanner =
                  (successBySale[sid] || portalSaleHasBlockingPayment(sale)) && saleBalance > 1e-9
                const canShowPayForm = portalCanShowPayFormForSale(sale)
                const lastPaymentRejected = portalSaleLastPaymentRejected(sale)
                void portalClock
                let reservationRemainSec = null
                if (sale.expires_at) {
                  const endMs = new Date(sale.expires_at).getTime()
                  if (!Number.isNaN(endMs)) {
                    reservationRemainSec = Math.max(0, Math.floor((endMs - Date.now()) / 1000))
                  }
                }
                const reservationExpired = Boolean(sale.expires_at && reservationRemainSec === 0)
                const cdMm =
                  sale.expires_at != null && reservationRemainSec != null
                    ? String(Math.floor(reservationRemainSec / 60)).padStart(2, '0')
                    : null
                const cdSs =
                  sale.expires_at != null && reservationRemainSec != null
                    ? String(reservationRemainSec % 60).padStart(2, '0')
                    : null
                const countdownUrgent =
                  reservationRemainSec != null &&
                  reservationRemainSec > 0 &&
                  reservationRemainSec <= 120
                const dragOver = Boolean(dragOverBySale[sid])
                const receiptFiles = receiptFilesBySale[sid]
                const fileArr = Array.isArray(receiptFiles) ? receiptFiles.filter(Boolean) : []
                const thumbUrlsRaw = thumbnailUrlsBySale[sid]
                const thumbUrls = Array.isArray(thumbUrlsRaw) ? thumbUrlsRaw : []
                const resolvedDepId =
                  depositAccountId || (depList.length === 1 ? String(depList[0]?.id ?? '') : '')
                const selectedDepositAccount =
                  depList.find((d) => String(d.id) === String(resolvedDepId)) ??
                  (depList.length === 1 ? depList[0] : undefined)
                const isAnalyzing = Boolean(analyzingBySale[sid])
                const aiResult = aiResultBySale[sid] ?? null
                const currencyMismatchAlert = portalCurrencyMismatchMessage(
                  aiResult?.extracted_currency,
                  selectedDepositAccount?.currency,
                )
                const multiCurrencyAiAlert =
                  aiResult?._multi_currency ?
                    '❌ No pudimos interpretar una moneda clara del comprobante; prueba una imagen JPG o PNG legible.'
                  : null

                const paidStrTrim = String(paidAmountBySale[sid] ?? '').trim().replace(',', '.')
                const paidParsedInline = parseFloat(paidStrTrim)
                // Solo requiere que la IA haya detectado un importe > 0 — sin validación de monto exacto.
                // Cualquier diferencia se ajusta automáticamente al aprobar (vuelto → credit_balance).
                const paidOkMixed =
                  Number.isFinite(paidParsedInline) && paidParsedInline > 0
                const paidOk = paysOnlyWithCredit ? true : paidOkMixed
                const hasOpenBalance = saleBalance > 1e-9
                const disablePay =
                  !hasOpenBalance
                  || reservationExpired
                  || paysOnlyWithCredit ?
                    submittingSaleId === sid
                  : isSaleRetiro ?
                    submittingSaleId === sid
                    || pmList.length === 0
                    || !String(methodId || '').trim()
                    || (needsDepositPick && depList.length > 0 && !resolvedDepId)
                  : submittingSaleId === sid
                    || pmList.length === 0
                    || !String(methodId || '').trim()
                    || (needsDepositPick && depList.length > 0 && !resolvedDepId)
                    || fileArr.length === 0
                    || !paidOk
                    || Boolean(currencyMismatchAlert || multiCurrencyAiAlert)

                const newOrderUxHint = portalNewOrderPayMissingHint({
                  submitting: submittingSaleId === sid,
                  reservationExpired,
                  paysOnlyWithCreditBalance: paysOnlyWithCredit,
                  pmListLen: pmList.length,
                  hasMethodId: Boolean(String(methodId || '').trim()),
                  needsDepositPick,
                  depListLen: depList.length,
                  resolvedDepId,
                  totalPayablePositive: hasOpenBalance,
                  fileArrLen: fileArr.length,
                  firstFileMime: fileArr[0]?.type || '',
                  isAnalyzing,
                  paidOk,
                  hasBlockingCurrencyError: Boolean(currencyMismatchAlert || multiCurrencyAiAlert),
                })

                return (
                  <div key={sid}>
                    {reservationExpired ? (
                      <div
                        style={{
                          padding: '22px 18px',
                          borderRadius: 22,
                          background: 'rgba(185,28,28,0.18)',
                          border: '1px solid rgba(248,113,113,0.38)',
                          textAlign: 'center',
                        }}
                      >
                        <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#fecaca', lineHeight: 1.55 }}>
                          Esta orden ha caducado. Contacta al administrador para reactivarla.
                        </p>
                      </div>
                    ) : !canShowPayForm && !reservationExpired ? (
                      <div
                        style={{
                          padding: '22px 18px',
                          borderRadius: 22,
                          background: 'rgba(148,163,184,0.12)',
                          border: '1px solid rgba(148,163,184,0.28)',
                          textAlign: 'center',
                        }}
                      >
                        <p style={{ margin: 0, fontSize: 15, fontWeight: 650, color: '#cbd5e1', lineHeight: 1.55 }}>
                          {portalSaleOpenBalance(sale) <= 1e-9 ?
                            'Este pedido no tiene saldo pendiente por cubrir.'
                          : 'No es posible enviar un comprobante en el estado actual de este pedido.'}
                        </p>
                      </div>
                    ) : (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault()
                          submitPayment(sale)
                        }}
                        style={{ display: 'flex', flexDirection: 'column', gap: 0 }}
                      >
                        {showReviewBanner ? (
                          <PortalPaymentsInReviewBanner message="Recibimos tu comprobante. Puedes enviar abonos adicionales mientras quede saldo pendiente." />
                        ) : null}
                        {lastPaymentRejected ? <PortalPaymentRejectedBanner /> : null}
                        <PortalNeoOrderSummaryCard
                          pricingBreakdownSlot={
                            creditAppliedToOrder > 1e-9 ? (
                              <div className="mb-4 space-y-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-3 text-sm">
                                <div className="flex justify-between gap-3 tabular-nums text-slate-200">
                                  <span className="text-slate-400">Subtotal de la factura</span>
                                  <span>{formatMoney(invoiceOpenPrincipal, saleCurrency)}</span>
                                </div>
                                <div className="flex justify-between gap-3 tabular-nums font-semibold text-emerald-300">
                                  <span>Saldo a favor aplicado</span>
                                  <span>-{formatMoney(creditAppliedToOrder, saleCurrency)}</span>
                                </div>
                                <div className="flex justify-between gap-3 border-t border-white/10 pt-2 text-base font-semibold tabular-nums text-white">
                                  <span>Total a pagar</span>
                                  <span>{formatMoney(totalAfterCredit, saleCurrency)}</span>
                                </div>
                              </div>
                            ) : null
                          }
                          headlineAmountFormatted={formatMoney(
                            creditAppliedToOrder > 1e-9 ? totalAfterCredit : invoiceOpenPrincipal,
                            saleCurrency,
                          )}
                          headlineCaption="Total a pagar"
                          countdownMmSs={sale.expires_at && cdMm != null ? `${cdMm}:${cdSs}` : null}
                          countdownUrgent={countdownUrgent}
                          partialBadge={isPartiallyPaid}
                          detailLinesSlot={
                            linesRaw.length > 0 ? (
                              <div className="portal-order-summary-inner divide-y divide-white/10">
                                {linesRaw.map((ln, i) => {
                                  const { qty, rate, subtotal: amt } = lineQtyPriceSubtotal(ln)
                                  const desc =
                                    (ln.description && String(ln.description).trim()) || 'Concepto'
                                  return (
                                    <div
                                      key={i}
                                      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-5 py-4"
                                    >
                                      <div className="min-w-0">
                                        <p className="text-[15px] font-semibold leading-snug text-white">{desc}</p>
                                        <p className="mt-1 text-xs leading-relaxed text-slate-500">
                                          Cantidad{' '}
                                          {qty.toLocaleString('es-ES', { maximumFractionDigits: 4 })} · Precio unit.{' '}
                                          {formatMoney(rate, saleCurrency)}
                                        </p>
                                      </div>
                                      <p className="pt-0.5 text-right text-[15px] font-semibold tabular-nums text-slate-100">
                                        {formatMoney(amt, saleCurrency)}
                                      </p>
                                    </div>
                                  )
                                })}
                              </div>
                            ) : null
                          }
                          footerText={`Referencia #${String(sid).padStart(4, '0')}`}
                        />

                        {paysOnlyWithCredit ? (
                          <section
                            style={{
                              padding: '18px',
                              marginBottom: 14,
                              borderRadius: 22,
                              background: 'rgba(52,211,153,0.12)',
                              border: '1px solid rgba(52,211,153,0.35)',
                            }}
                          >
                            <p style={{ margin: 0, fontSize: 14, fontWeight: 650, color: '#bbf7d0', lineHeight: 1.55 }}>
                              Este pedido se cubrirá íntegramente con tu{' '}
                              <strong style={{ fontWeight: 750 }}>saldo a favor</strong>; no necesitas método de depósito
                              ni comprobante físico.
                            </p>
                          </section>
                        ) : (
                          <section className={PORTAL_PAYMENT_SHELL_CLASS}>
                            <label
                              htmlFor={`pm-${sid}`}
                              className="mb-2.5 block text-xs uppercase tracking-[0.06em] text-white/50"
                            >
                              Método de pago
                            </label>
                            <Select
                              inputId={`pm-${sid}`}
                              classNamePrefix="portal-rs"
                              options={portalPaymentMethodOptions(pmList)}
                              value={portalPaymentMethodSelectValue(pmList, methodId)}
                              onChange={(selectedOption) => {
                                const nextMethod = selectedOption ? String(selectedOption.value) : ''
                                setPayMethodBySale((p) => ({ ...p, [sid]: nextMethod }))
                                setPayAccountBySale((p) => {
                                  const n = { ...p }
                                  const accsForMethod = portalAccountsForMethod(salePayTree, nextMethod)
                                  if (accsForMethod.length === 1) n[sid] = String(accsForMethod[0].id)
                                  else n[sid] = ''
                                  return n
                                })
                              }}
                              isDisabled={pmList.length === 0}
                              isClearable={false}
                              placeholder="Seleccionar…"
                              styles={portalPaymentMethodSelectStyles}
                              menuPortalTarget={typeof document !== 'undefined' ? document.body : null}
                              menuPosition="fixed"
                            />
                            {pmList.length === 0 ? (
                              <p style={{ margin: '12px 0 0', fontSize: 13, color: '#fbbf24', opacity: 0.92 }}>
                                No hay métodos de pago habilitados para este pedido. Solicita al proveedor que marque
                                métodos permitidos en la venta.
                              </p>
                            ) : null}
                          </section>
                        )}

                        {!paysOnlyWithCredit && needsDepositPick ? (
                          <section className={PORTAL_PAYMENT_SHELL_CLASS}>
                            <p className="m-0 mb-1 text-xs uppercase tracking-[0.06em] text-white/50">
                              Cuenta donde depositar
                            </p>
                            <p style={{ margin: '0 0 12px', fontSize: 12, opacity: 0.55, lineHeight: 1.45 }}>
                              Cuentas habilitadas por el proveedor para esta venta.
                            </p>
                            {depList.length === 0 ? (
                              <p style={{ margin: 0, fontSize: 14, color: '#fbbf24', lineHeight: 1.45 }}>
                                No hay cuentas configuradas. Contacta al proveedor.
                              </p>
                            ) : depList.length === 1 ? (
                              depList.map((d) => (
                                <div
                                  key={d.id}
                                  style={{
                                    padding: '14px',
                                    borderRadius: 14,
                                    background: 'rgba(255,255,255,0.06)',
                                    border: '1px solid rgba(255,255,255,0.1)',
                                    fontSize: 14,
                                    lineHeight: 1.55,
                                  }}
                                >
                                  <p style={{ margin: 0, fontWeight: 700 }}>{d.bank_name}</p>
                                  {d.account_number ? (
                                    <p style={{ margin: '8px 0 0', fontVariantNumeric: 'tabular-nums', opacity: 0.92 }}>
                                      Nº cuenta / referencia: <strong>{d.account_number}</strong>
                                    </p>
                                  ) : null}
                                  <p style={{ margin: '8px 0 0', fontSize: 12, opacity: 0.55 }}>Moneda: {d.currency}</p>
                                </div>
                              ))
                            ) : (
                              <>
                                <label
                                  htmlFor={`depacc-${sid}`}
                                  style={{ display: 'block', fontSize: 12, opacity: 0.55, marginBottom: 8 }}
                                >
                                  Elige la cuenta donde transferiste:
                                </label>
                                <select
                                  id={`depacc-${sid}`}
                                  value={depositAccountId}
                                  required={needsDepositPick}
                                  onChange={(ev) => {
                                    const depVal = ev.target.value
                                    setPayAccountBySale((p) => ({ ...p, [sid]: depVal }))
                                    const filesNow = receiptFilesRef.current[sid]
                                    analyzeReceiptWithAI(
                                      sid,
                                      filesNow?.length ? filesNow : [],
                                      aiExpectedDeposit,
                                      saleCurrency,
                                    )
                                  }}
                                  className={PORTAL_TOUCH_INPUT_CLASS}
                                >
                                  <option value="" disabled>
                                    Seleccionar cuenta…
                                  </option>
                                  {depList.map((d) => (
                                    <option key={d.id} value={String(d.id)}>
                                      {d.bank_name}
                                      {d.account_number ? ` · ${d.account_number}` : ''}
                                    </option>
                                  ))}
                                </select>
                              </>
                            )}
                          </section>
                        ) : null}

                        {!paysOnlyWithCredit ? (
                          isSaleRetiro ? (
                            <>
                              {(retiroSuccessByScope?.scope === `sale:${sid}` ||
                                successBySale[sid] ||
                                portalSaleAwaitingRetiroWebhook(sale)) &&
                              saleBalance > 1e-9 ? (
                                <RetiroSuccessPanel
                                  message="Pedido activado. Puedes enviar abonos adicionales mientras quede saldo pendiente."
                                  title="Pedido activado"
                                  monto={
                                    retiroSuccessByScope?.scope === `sale:${sid}`
                                      ? retiroSuccessByScope.monto
                                      : undefined
                                  }
                                  currency={saleCurrency}
                                />
                              ) : null}
                              <CodigosRetiroWidget clientName={clientName} referenciaExterna={sid} />
                              {retiroSubmittingKey === `sale:${sid}` || submittingSaleId === sid ? (
                                <p style={{ margin: '12px 0 0', fontSize: 13, color: '#93c5fd', textAlign: 'center' }}>
                                  Activando tu pedido…
                                </p>
                              ) : (
                                <p style={{ margin: '12px 0 0', fontSize: 12, color: 'rgba(148,163,184,0.95)', textAlign: 'center' }}>
                                  Sube la foto y confirma los datos en el formulario de verificación. Al enviar,
                                  activaremos tu pedido y podrás enviar abonos adicionales si queda saldo.
                                </p>
                              )}
                            </>
                          ) : (
                        <div className="portal-receipt-upload-glow-wrap mb-4 rounded-2xl border border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.6)]">
                          <section
                            className="portal-receipt-upload-card"
                            onDragOver={(e) => {
                              e.preventDefault()
                              setDragOverBySale((p) => ({ ...p, [sid]: true }))
                            }}
                            onDragLeave={() => setDragOverBySale((p) => ({ ...p, [sid]: false }))}
                            onDrop={(e) => {
                              e.preventDefault()
                              setDragOverBySale((p) => ({ ...p, [sid]: false }))
                              pickReceipt(sid, e.dataTransfer.files, aiExpectedDeposit, saleCurrency)
                            }}
                          >
                            <div className="portal-receipt-upload-circuit-overlay" aria-hidden />
                            <div className="portal-order-summary-inner px-5 pb-5 pt-5">
                              <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.06em] text-green-300">
                                Comprobante
                              </p>
                              <p className="mb-4 text-[13px] text-slate-200/90">
                                {creditAppliedToOrder > 1e-9 ? (
                                  <>
                                    Transfiere y sube solo la{' '}
                                    <strong>diferencia que resta después de aplicar tu saldo a favor</strong> ({' '}
                                    {formatMoney(totalAfterCredit, saleCurrency)} ).
                                  </>
                                ) : (
                                  <>
                                    Sube el comprobante de pago (JPG/PNG/PDF). Puedes declarar un importe mayor al
                                    saldo pendiente; el excedente quedará como saldo a favor tras la revisión.
                                  </>
                                )}
                              </p>
                              <input
                                type="file"
                                accept="image/jpeg,image/png,application/pdf"
                                id={`rcv-${sid}`}
                                style={{ display: 'none' }}
                                onChange={(e) => pickReceipt(sid, e.target.files, aiExpectedDeposit, saleCurrency)}
                              />
                              <label
                                htmlFor={`rcv-${sid}`}
                                className={`flex cursor-pointer flex-col items-center justify-center gap-2.5 rounded-2xl border border-dashed px-5 py-6 text-center transition-colors duration-200 ${
                                  dragOver
                                    ? 'border-green-400/65 bg-black/45 text-green-50'
                                    : 'border-white/25 bg-black/35 text-slate-100'
                                }`}
                              >
                                <span className={dragOver ? 'text-green-200' : 'text-green-100'}>
                                  <IconUploadCloud />
                                </span>
                                <span className="text-[14px] font-semibold text-slate-50">
                                  Arrastra tu cupón aquí y tócalo para elegir
                                </span>
                              </label>
                              {fileArr.length ? (
                                <div className="mt-4 flex w-full flex-wrap items-center justify-center gap-3">
                                  {fileArr.map((f, fi) => {
                                    const thumb = thumbUrls[fi]
                                    const isPdf = /^application\/pdf$/i.test(f?.type || '')
                                    return (
                                      <div key={`${sid}-${fi}-${f.lastModified}-${f.name}`} className="relative">
                                        {isPdf || !thumb ? (
                                          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-black/35 text-[10px] font-bold uppercase text-green-100">
                                            PDF
                                          </div>
                                        ) : (
                                          <img
                                            src={thumb}
                                            alt=""
                                            className="h-14 w-14 shrink-0 rounded-lg border border-green-400/35 object-cover"
                                          />
                                        )}
                                        <button
                                          type="button"
                                          aria-label="Quitar archivo"
                                          className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-xs font-bold text-white shadow hover:bg-red-500"
                                          onClick={(evt) => {
                                            evt.preventDefault()
                                            evt.stopPropagation()
                                            removeReceiptFileAt(sid, fi, aiExpectedDeposit, saleCurrency)
                                          }}
                                        >
                                          ×
                                        </button>
                                      </div>
                                    )
                                  })}
                                </div>
                              ) : null}
                            </div>
                          </section>
                        </div>
                          )
                        ) : null}

                        {!paysOnlyWithCredit && !isSaleRetiro ? (
                          <>
                        <div style={{ marginBottom: 12 }}>
                          <label
                            style={{
                              display: 'block',
                              fontSize: 11,
                              opacity: 0.6,
                              letterSpacing: '0.07em',
                              textTransform: 'uppercase',
                              marginBottom: 6,
                            }}
                          >
                            {creditAppliedToOrder > 1e-9
                              ? `Importe depositado (${saleCurrency}), solo la diferencia`
                              : `¿Cuánto pagaste en tu depósito? (${saleCurrency})`}
                          </label>
                          <p style={{ margin: '0 0 8px', fontSize: 12, opacity: 0.65 }}>
                            {creditAppliedToOrder > 1e-9
                              ? <>La IA validará contra {formatMoney(totalAfterCredit, saleCurrency)} después de usar tu saldo a favor.</>
                              : <>Este importe solo se completa con la IA al leer el comprobante.</>}
                          </p>
                          <input
                            type="number"
                            readOnly
                            min="0.01"
                            step="0.01"
                            required
                            placeholder="—"
                            value={paidAmountBySale[sid] ?? ''}
                            className="w-full rounded-xl border border-white/18 bg-gray-950/55 px-4 py-3 text-[15px] text-fuchsia-50 opacity-80 cursor-not-allowed box-border"
                            style={{
                              MozAppearance: 'textfield',
                            }}
                          />
                          {multiCurrencyAiAlert ? (
                            <p className="mt-2 mb-0 text-[13px] font-medium leading-relaxed text-red-300">
                              {multiCurrencyAiAlert}
                            </p>
                          ) : null}
                          {currencyMismatchAlert ? (
                            <p className="mt-2 mb-0 text-[13px] font-medium leading-relaxed text-red-300">
                              {currencyMismatchAlert}
                            </p>
                          ) : null}
                        </div>

                        {isAnalyzing ? (
                          <p
                            style={{
                              margin: '0 0 12px',
                              fontSize: 13,
                              color: '#93c5fd',
                              textAlign: 'center',
                              lineHeight: 1.5,
                            }}
                          >
                            Analizando comprobante con IA… 🤖
                          </p>
                        ) : aiResult != null ? (
                          (() => {
                            if (!aiResult.is_readable) {
                              return (
                                <p
                                  style={{
                                    margin: '0 0 12px',
                                    fontSize: 13,
                                    color: '#fca5a5',
                                    textAlign: 'center',
                                    lineHeight: 1.5,
                                  }}
                                >
                                  ❌ No pudimos leer el monto. Verifica la imagen.
                                </p>
                              )
                            }
                            const detectedAmt = aiResult.extracted_amount
                            const detectedCur = aiResult.extracted_currency || saleCurrency
                            // Mensaje informativo unificado: monto detectado + ajuste automático.
                            // Sin importar si coincide o no con el esperado — el backend lo gestiona.
                            return (
                              <p
                                style={{
                                  margin: '0 0 12px',
                                  fontSize: 13,
                                  color: '#93c5fd',
                                  textAlign: 'center',
                                  lineHeight: 1.5,
                                }}
                              >
                                💡 Detectamos {detectedCur}{' '}
                                {detectedAmt?.toLocaleString('es-ES', { minimumFractionDigits: 2 })}.
                                Al aprobarse, cualquier diferencia se ajustará automáticamente como Saldo
                                Pendiente o se guardará como nuevo Saldo a Favor.
                              </p>
                            )
                          })()
                        ) : null}
                          </>
                        ) : null}

                        {submitErrorBySale[sid] ? (
                          <p
                            style={{
                              margin: '0 0 12px',
                              fontSize: 14,
                              color: '#fecaca',
                              textAlign: 'center',
                              lineHeight: 1.4,
                            }}
                          >
                            {submitErrorBySale[sid]}
                          </p>
                        ) : null}

                        {newOrderUxHint && !isSaleRetiro ?
                          <p className="mb-3 px-1 text-center text-sm font-medium leading-relaxed text-amber-400">
                            {newOrderUxHint}
                          </p>
                        : null}

                        {clientCreditAvail > 1e-9 && !paysOnlyWithCredit && !reservationExpired && canShowPayForm ? (
                          <button
                            type="button"
                            disabled={submittingSaleId === sid}
                            onClick={() =>
                              applyPortalOpenOrderCredit({ kind: 'sale', sale, paymentIntent: 'new_order' })
                            }
                            className="mb-3 w-full rounded-2xl border border-emerald-400/45 bg-emerald-950/35 px-4 py-3.5 text-[15px] font-bold leading-tight text-emerald-50 outline-none transition hover:bg-emerald-950/50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {submittingSaleId === sid
                              ? 'Aplicando saldo a favor…'
                              : `Pagar con mi Saldo a Favor (hasta ${formatMoney(Math.min(clientCreditAvail, invoiceOpenPrincipal), saleCurrency)})`}
                          </button>
                        ) : null}

                        {!paysOnlyWithCredit && !isSaleRetiro ? (
                        <button
                          type="submit"
                          disabled={disablePay}
                          className="w-full rounded-2xl border-0 px-4 py-4 text-[16px] font-bold leading-tight text-slate-900 outline-none ring-2 ring-transparent ring-offset-0 transition hover:brightness-[1.03] focus-visible:ring-indigo-400/70 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
                          style={{
                            background: 'linear-gradient(90deg,#c4b5fd,#67e8f9,#a5b4fc)',
                            boxShadow: '0 18px 40px rgba(99,102,241,0.35)',
                          }}
                        >
                          {submittingSaleId === sid ? 'Enviando…' : 'Enviar pago con comprobante'}
                        </button>
                        ) : !paysOnlyWithCredit && isSaleRetiro ? null : (
                        <button
                          type="submit"
                          disabled={disablePay}
                          className="w-full rounded-2xl border-0 px-4 py-4 text-[16px] font-bold leading-tight text-slate-900 outline-none ring-2 ring-transparent ring-offset-0 transition hover:brightness-[1.03] focus-visible:ring-indigo-400/70 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
                          style={{
                            background: 'linear-gradient(90deg,#6ee7b7,#34d399,#a7f3d0)',
                            boxShadow: '0 18px 40px rgba(16,185,129,0.35)',
                          }}
                        >
                          {submittingSaleId === sid ? 'Aplicando…' : 'Pagar con mi Saldo a Favor'}
                        </button>
                        )}
                      </form>
                    )}

                    {/* Payment history for this sale */}
                    {Array.isArray(sale.payment_events) && sale.payment_events.length > 0 && (
                      <section
                        style={{
                          marginTop: 14,
                          padding: '14px 16px',
                          borderRadius: 18,
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                        }}
                      >
                        <p style={{ margin: '0 0 10px', fontSize: 11, opacity: 0.5, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                          Historial de pagos
                        </p>
                        {(sale?.payment_events ?? []).map((ev, idx) => {
                          let dt = '—'
                          dt = formatDateTimeEcuador(ev?.occurred_at)
                          const isApproved = String(ev?.status ?? '').toLowerCase().includes('aprob')
                          const evList = sale?.payment_events ?? []
                          return (
                            <div
                              key={idx}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 8,
                                padding: '8px 0',
                                borderBottom: idx < evList.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                                fontSize: 13,
                              }}
                            >
                              <span style={{ opacity: 0.65, flexShrink: 0 }}>{dt}</span>
                              <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                                {formatMoney(ev?.amount, ev?.currency || saleCurrency)}
                              </span>
                              <span
                                style={{
                                  fontSize: 11,
                                  padding: '3px 9px',
                                  borderRadius: 999,
                                  fontWeight: 700,
                                  flexShrink: 0,
                                  background: isApproved ? 'rgba(34,197,94,0.15)' : 'rgba(251,191,36,0.15)',
                                  color: isApproved ? '#86efac' : '#fcd34d',
                                }}
                              >
                                {ev?.status ?? '—'}
                              </span>
                            </div>
                          )
                        })}
                      </section>
                    )}
                  </div>
                )
              })}
          </div>
        ) : !hasNewOrders ? (
          <p className="m-0 rounded-xl border border-white/12 bg-black/20 px-4 py-8 text-center text-[13px] leading-relaxed text-slate-400/95">
            No hay nuevos pedidos para pagar en este momento.
          </p>
        ) : null}

        </div>
        </PortalNeoAccordion>
        ) : null}
        <PortalNeoAccordion
          sectionId="portal-acc-baas"
          title="MI BILLETERA"
          headerAside={walletAccordionAside || '—'}
          accent="violet"
          expanded={isBaasOpen}
          onToggle={() => setIsBaasOpen((o) => !o)}
        >
          {isBaasOpen ? (
            portalShowsBaasSection ? (
            <div className="space-y-5">
              <p className="m-0 text-[13px] font-medium leading-snug text-slate-200/88">
                Tu saldo actual
                {walletRowsDisplay.length > 1 ? (
                  <span className="block mt-1 text-[12px] text-violet-100/90 tabular-nums">
                    {walletRowsDisplay.map((r) => formatMoney(r.amount, r.currency)).join(' · ')}
                  </span>
                ) : (
                  <span className="block mt-1 text-lg font-bold tabular-nums text-violet-50">
                    {formatMoney(clientWalletBalanceNum, portalWalletCurrencyLabel)}
                  </span>
                )}
              </p>

              {latestActiveScreen ? (
                <div
                  className="rounded-2xl border border-cyan-400/35 p-5 transition-all duration-300"
                  style={{
                    background: 'rgba(34,211,238,0.08)',
                    boxShadow: '0 12px 32px rgba(0,0,0,0.22)',
                  }}
                  aria-label="Última pantalla asignada"
                >
                  <p className="m-0 text-[11px] font-extrabold uppercase leading-tight tracking-[0.14em] text-cyan-100/95 sm:text-xs">
                    Última pantalla asignada
                  </p>
                  <p className="mt-2 mb-0 text-sm font-bold text-slate-50">
                    {String(latestActiveScreen?.package_name ?? 'Pantalla').trim() || 'Pantalla'}
                  </p>
                  {formatPortalAssignedAt(latestActiveScreen?.assigned_at) ? (
                    <p className="mt-1 mb-0 text-xs text-slate-400">
                      Asignada:{' '}
                      <span className="font-medium text-cyan-100/90">
                        {formatPortalAssignedAt(latestActiveScreen.assigned_at)}
                      </span>
                    </p>
                  ) : null}
                  <div className="mt-3 space-y-2">
                    <PortalScreenCredentialRow
                      label="Usuario"
                      value={latestActiveScreen?.username}
                      flashKey={`latest-user-${latestActiveScreen?.screen_stock_id}`}
                      copyFlashKey={copyFlashKey}
                      onCopy={handleCopyScreenField}
                    />
                    <PortalScreenCredentialRow
                      label="Contraseña"
                      value={latestActiveScreen?.password}
                      flashKey={`latest-pass-${latestActiveScreen?.screen_stock_id}`}
                      copyFlashKey={copyFlashKey}
                      onCopy={handleCopyScreenField}
                    />
                  </div>
                  {!String(latestActiveScreen?.username ?? '').trim() &&
                  !String(latestActiveScreen?.password ?? '').trim() ? (
                    <p className="mt-2 mb-0 text-xs text-amber-200/85">
                      Pantalla activa sin credenciales en bodega. Contacta a soporte.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div
                className="rounded-2xl border border-violet-500/35 p-5 transition-all duration-300"
                style={{
                  background: 'rgba(139,92,246,0.12)',
                  boxShadow: '0 14px 40px rgba(0,0,0,0.28)',
                }}
                aria-label="Comprar pantallas"
              >
                <div className="mb-4">
                  <p className="m-0 text-[11px] font-extrabold uppercase leading-tight tracking-[0.14em] text-cyan-100/95 sm:text-xs">
                    Comprar pantallas
                  </p>
                  <p className="m-1.5 mb-0 text-[12px] font-medium leading-snug text-slate-200/75">
                    Catálogo Flujo completo — los productos sin precio requieren asignación por tu distribuidor
                  </p>
                </div>

                {autoPurchaseLoading ? (
                  <p className="m-0 text-sm text-violet-100/75 flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin" />
                    Cargando catálogo…
                  </p>
                ) : autoPurchaseErr ? (
                  <p className="m-0 text-sm text-red-200">{autoPurchaseErr}</p>
                ) : autoPurchaseProducts.length === 0 ? (
                  <p className="m-0 text-sm text-slate-300/65">
                    No hay productos Flujo activos en el catálogo en este momento.
                  </p>
                ) : (
                  <ul className="m-0 p-0 list-none space-y-3">
                    {autoPurchaseProducts.map((p) => {
                      const pkgId = Number(p?.package_catalog_id)
                      const cur = portalProductCurrency(p, clientBaseCurrency)
                      const unitPrice = portalSaleUnitPrice(p, assignedPricesMap, clientBaseCurrency)
                      const hasAssignedPrice = Number.isFinite(unitPrice) && unitPrice > 0
                      const stock = Number(p?.free_stock ?? 0)
                      const isOutOfStock = stock <= 0
                      const qty = Math.max(
                        1,
                        Math.min(200, parseInt(String(autoPurchaseQtyByPackageId[String(pkgId)] ?? '1'), 10) || 1),
                      )
                      const lineTotal = hasAssignedPrice ? unitPrice * qty : NaN
                      const canAfford =
                        hasAssignedPrice &&
                        Number.isFinite(lineTotal) &&
                        getClientWalletBalance(cur) + 1e-9 >= lineTotal
                      const busy = autoPurchaseBusyId === pkgId
                      const purchaseLocked = busy || confirmingPurchase != null || autoPurchaseBusyId != null
                      return (
                        <li
                          key={`ap-${pkgId}`}
                          className="flex flex-col rounded-xl border border-violet-300/25 bg-slate-950/30 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                        >
                          <p className="mb-4 w-full text-center text-lg font-bold leading-snug text-violet-50">
                            {String(p?.name ?? '—')}
                          </p>

                          {hasAssignedPrice ? (
                            <div className="flex w-full flex-row items-center justify-between gap-2">
                              <div className="flex min-w-0 flex-col gap-1">
                                <p className="m-0 text-xs leading-snug text-slate-300/80">
                                  Stock:{' '}
                                  <span
                                    className={`text-xl font-bold tabular-nums ${
                                      isOutOfStock ? 'text-red-500' : 'text-green-500'
                                    }`}
                                  >
                                    {stock}
                                  </span>
                                </p>
                                <p className="m-0 text-xs leading-snug text-slate-300/80">
                                  Precio:{' '}
                                  <span className="font-medium tabular-nums text-fuchsia-100">
                                    {formatMoney(unitPrice, cur)}
                                  </span>
                                </p>
                              </div>

                              <div className="flex shrink-0 flex-row items-center gap-2">
                                <label className="flex flex-col items-center gap-0.5 text-[11px] text-slate-300">
                                  Cant.
                                  <input
                                    type="number"
                                    min={1}
                                    max={200}
                                    value={qty}
                                    disabled={isOutOfStock || purchaseLocked}
                                    onChange={(e) => {
                                      const v = e.target.value
                                      setAutoPurchaseQtyByPackageId((prev) => ({
                                        ...prev,
                                        [String(pkgId)]: v,
                                      }))
                                    }}
                                    className="min-h-[40px] w-14 rounded-lg border border-violet-400/35 bg-slate-900/70 px-1.5 py-1.5 text-sm text-violet-50 tabular-nums touch-manipulation"
                                  />
                                </label>
                                <button
                                  type="button"
                                  disabled={isOutOfStock || !canAfford || purchaseLocked}
                                  onClick={() =>
                                    setConfirmingPurchase({
                                      packageCatalogId: pkgId,
                                      packageName: String(p?.name ?? '—'),
                                      quantity: qty,
                                      unitPrice,
                                      totalPrice: lineTotal,
                                      currency: cur,
                                      step: 'choose',
                                      endCustomerName: '',
                                      endCustomerDialCode: '+593',
                                      endCustomerLocalNumber: '',
                                      trackingErr: null,
                                    })
                                  }
                                  className={
                                    isOutOfStock
                                      ? `${PORTAL_TOUCH_BUTTON_CLASS} !w-auto shrink-0 bg-gray-500 px-3 text-xs font-bold opacity-60 cursor-not-allowed sm:px-4 sm:text-sm`
                                      : `${PORTAL_TOUCH_BUTTON_PRIMARY_CLASS} !w-auto shrink-0 px-3 text-xs font-bold sm:px-4 sm:text-sm`
                                  }
                                >
                                  {busy ? 'Procesando…' : isOutOfStock ? 'Agotado' : 'Comprar'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex w-full flex-row items-center justify-between gap-2">
                              <div className="flex min-w-0 flex-col gap-1">
                                <p className="m-0 text-xs leading-snug text-slate-300/80">
                                  Stock:{' '}
                                  <span
                                    className={`text-xl font-bold tabular-nums ${
                                      isOutOfStock ? 'text-red-500' : 'text-green-500'
                                    }`}
                                  >
                                    {stock}
                                  </span>
                                </p>
                              </div>
                              <p className="m-0 max-w-[10rem] shrink-0 text-right text-[11px] leading-snug text-amber-200/90">
                                Contacta a tu distribuidor para habilitar y asignar precios a este producto.
                              </p>
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}

                {autoPurchaseProducts.some((p) => {
                  const pkgId = Number(p?.package_catalog_id)
                  const pCur = portalProductCurrency(p, clientBaseCurrency)
                  const unitPrice = portalSaleUnitPrice(p, assignedPricesMap, clientBaseCurrency)
                  if (!Number.isFinite(unitPrice) || unitPrice <= 0) return false
                  const qty = Math.max(
                    1,
                    Math.min(200, parseInt(String(autoPurchaseQtyByPackageId[String(pkgId)] ?? '1'), 10) || 1),
                  )
                  const total = unitPrice * qty
                  return Number.isFinite(total) && getClientWalletBalance(pCur) + 1e-9 < total
                }) ? (
                  <p className="mt-4 mb-0 text-xs text-amber-200/90">
                    Algunos paquetes requieren más saldo del disponible ({walletAccordionAside}).
                  </p>
                ) : null}

                {autoPurchaseFeedback ? (
                  <div
                    className={`mt-4 rounded-xl border px-3 py-2.5 text-sm leading-relaxed ${
                      autoPurchaseFeedback?.ok === false
                        ? 'border-red-400/40 bg-red-950/40 text-red-100'
                        : 'border-emerald-400/40 bg-emerald-950/35 text-emerald-50'
                    }`}
                  >
                    <p className="m-0 font-semibold">{String(autoPurchaseFeedback?.message ?? '')}</p>
                    {autoPurchaseFeedback?.fulfilled && autoPurchaseFeedback?.credentialsMissing ? (
                      <p className="mt-2 mb-0 rounded-lg border border-amber-400/35 bg-amber-950/40 px-3 py-2 text-xs text-amber-100">
                        Pantalla asignada, pero faltan credenciales en bodega. Contacta a soporte.
                      </p>
                    ) : null}
                    {Array.isArray(autoPurchaseFeedback?.credentials) &&
                    autoPurchaseFeedback.credentials.some((c) => c?.hasCredentials) ? (
                      <ul className="mt-3 mb-0 pl-0 list-none space-y-2 text-sm">
                        {autoPurchaseFeedback.credentials.map((c, idx) =>
                          c?.hasCredentials ? (
                            <li
                              key={`cred-${c?.screen_stock_id ?? idx}`}
                              className="rounded-xl border border-slate-600/50 bg-slate-950/80 px-4 py-3 shadow-inner"
                            >
                              {autoPurchaseFeedback.credentials.length > 1 ? (
                                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                                  Pantalla {idx + 1}
                                </p>
                              ) : null}
                              <div className="space-y-1.5 font-mono text-[13px]">
                                <div>
                                  <span className="text-slate-400">Usuario: </span>
                                  <strong className="font-bold text-white">{c.username}</strong>
                                </div>
                                <div>
                                  <span className="text-slate-400">Contraseña: </span>
                                  <strong className="font-bold text-white">{c.password}</strong>
                                </div>
                              </div>
                            </li>
                          ) : null,
                        )}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            ) : (
              <p className="m-0 text-sm leading-relaxed text-slate-400/90">
                Esta sección aplica cuando tienes billetera BaaS, recargas o pantallas Flujo activas.
              </p>
            )
          ) : null}
        </PortalNeoAccordion>
        <PortalNeoAccordion
          sectionId="portal-acc-tracked-purchases"
          title="MIS COMPRAS"
          subtitle="Seguimiento de clientes finales y vencimiento de pantallas"
          headerAside={
            trackedPurchases.length > 0 ? (
              <span
                className="inline-flex min-h-[1.75rem] min-w-[1.75rem] items-center justify-center rounded-full border border-emerald-300/45 bg-emerald-500/20 px-2 text-xs font-extrabold tabular-nums text-emerald-50 shadow-[0_0_12px_rgba(52,211,153,0.25)]"
                title={`${trackedPurchases.length} compra${trackedPurchases.length === 1 ? '' : 's'} con seguimiento`}
              >
                {trackedPurchases.length}
              </span>
            ) : (
              '0'
            )
          }
          accent="emerald"
          expanded={isTrackedPurchasesOpen}
          onToggle={() => {
            setIsTrackedPurchasesOpen((o) => {
              const next = !o
              if (next) void loadTrackedPurchases()
              return next
            })
          }}
        >
          {isTrackedPurchasesOpen ? (
            <div className="space-y-3">
              {trackedPurchasesLoading ? (
                <p className="m-0 flex items-center gap-2 text-sm text-slate-300">
                  <Loader2 size={16} className="animate-spin" />
                  Cargando compras…
                </p>
              ) : trackedPurchasesErr ? (
                <p className="m-0 text-sm text-red-200">{trackedPurchasesErr}</p>
              ) : trackedPurchases.length === 0 ? (
                <p className="m-0 text-sm text-slate-400/85">
                  Aún no tienes compras con seguimiento de cliente. Al confirmar una compra, elige
                  «Comprar con seguimiento al cliente» para registrar nombre y teléfono.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2 border-b border-slate-600/35 pb-3">
                    <button
                      type="button"
                      onClick={() => setActiveTab('todos')}
                      className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                        activeTab === 'todos'
                          ? 'border border-emerald-400/50 bg-emerald-500/25 text-emerald-50'
                          : 'border border-slate-600/50 bg-slate-900/50 text-slate-300 hover:bg-slate-800/60'
                      }`}
                    >
                      Todos
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('seguimiento')}
                      className={`inline-flex items-center gap-1 rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                        activeTab === 'seguimiento'
                          ? 'border border-amber-400/50 bg-amber-500/20 text-amber-50'
                          : 'border border-slate-600/50 bg-slate-900/50 text-slate-300 hover:bg-slate-800/60'
                      }`}
                    >
                      Seguimiento
                      {trackedPurchasesSeguimientoCount > 0 ? (
                        <span className="inline-flex min-w-[1.125rem] items-center justify-center rounded-full bg-amber-400/25 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-amber-100">
                          {trackedPurchasesSeguimientoCount}
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('caducados')}
                      className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                        activeTab === 'caducados'
                          ? 'border border-red-400/50 bg-red-500/20 text-red-50'
                          : 'border border-slate-600/50 bg-slate-900/50 text-slate-300 hover:bg-slate-800/60'
                      }`}
                    >
                      Caducados
                      {trackedPurchasesCaducadosCount > 0 ? (
                        <span className="ml-1.5 tabular-nums text-[10px] opacity-90">
                          ({trackedPurchasesCaducadosCount})
                        </span>
                      ) : null}
                    </button>
                  </div>
                  {filteredTrackedPurchases.length === 0 ? (
                    <p className="m-0 py-6 text-center text-sm text-slate-400/80">
                      {activeTab === 'seguimiento'
                        ? 'No hay clientes con vencimiento próximo a 5 días.'
                        : activeTab === 'caducados'
                          ? 'No hay compras caducadas en este momento.'
                          : 'No hay compras para mostrar.'}
                    </p>
                  ) : (
                <>
                <ul className="m-0 list-none space-y-3 p-0">
                  {paginatedMisCompras.map((item) => {
                    const key = trackedPurchaseCardKey(item)
                    return (
                      <TrackedPurchaseCard
                        key={key}
                        item={item}
                        expanded={expandedMisComprasKey === key}
                        onToggle={() =>
                          setExpandedMisComprasKey((prev) => (prev === key ? null : key))
                        }
                      />
                    )
                  })}
                </ul>
                {totalMisComprasPages > 1 ? (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-600/35 pt-4">
                    <button
                      type="button"
                      disabled={misComprasPage <= 1}
                      onClick={() => setMisComprasPage((p) => Math.max(1, p - 1))}
                      className="rounded-lg border border-slate-500/40 bg-slate-900/60 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800/70 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Anterior
                    </button>
                    <span className="text-xs font-medium text-slate-300 tabular-nums">
                      Página {misComprasPage} de {totalMisComprasPages}
                    </span>
                    <button
                      type="button"
                      disabled={misComprasPage >= totalMisComprasPages}
                      onClick={() =>
                        setMisComprasPage((p) => Math.min(totalMisComprasPages, p + 1))
                      }
                      className="rounded-lg border border-slate-500/40 bg-slate-900/60 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800/70 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Siguiente
                    </button>
                  </div>
                ) : null}
                </>
                  )}
                </>
              )}
            </div>
          ) : null}
        </PortalNeoAccordion>
        <PortalNeoAccordion
          sectionId="portal-acc-reseller-network"
          title="MI RED DE DISTRIBUIDORES"
          subtitle="Crea sub-clientes, transfiere saldo BaaS y asigna precios"
          headerAside={resellerNetworkAside}
          accent="violet"
          expanded={isResellerNetworkOpen}
          onToggle={() => setIsResellerNetworkOpen((o) => !o)}
        >
          {isResellerNetworkOpen ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void openCreateSubClientModal()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-violet-400/40 bg-violet-500/20 px-4 py-2.5 text-sm font-bold text-violet-50 transition hover:bg-violet-500/30"
                >
                  <Plus size={16} aria-hidden />
                  Crear Sub-cliente
                </button>
                <button
                  type="button"
                  onClick={() => void loadSubClients()}
                  disabled={subClientsLoading}
                  className="rounded-lg border border-slate-500/40 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800/50 disabled:opacity-45"
                >
                  Actualizar lista
                </button>
                <button
                  type="button"
                  onClick={openContactModal}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-950/30 px-3 py-2 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-900/40"
                >
                  <Phone size={14} aria-hidden />
                  Contacto
                </button>
              </div>

              {subClientsLoading ? (
                <p className="m-0 flex items-center gap-2 text-sm text-slate-300">
                  <Loader2 size={16} className="animate-spin" />
                  Cargando red…
                </p>
              ) : subClientsErr ? (
                <p className="m-0 text-sm text-red-200">{subClientsErr}</p>
              ) : subClients.length === 0 ? (
                <p className="m-0 text-sm text-slate-400/85">
                  Aún no tienes sub-clientes. Crea el primero para revender pantallas con tu propia red.
                </p>
              ) : (
                <div className="rounded-xl border border-slate-600/40">
                  <div className="flex flex-wrap items-center gap-2 border-b border-slate-600/35 px-3 py-3">
                    <button
                      type="button"
                      onClick={() => setActiveFilter('all')}
                      className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                        activeFilter === 'all'
                          ? 'border border-violet-400/50 bg-violet-500/25 text-violet-50'
                          : 'border border-slate-600/50 bg-slate-900/50 text-slate-300 hover:bg-slate-800/60'
                      }`}
                    >
                      Todos
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveFilter('zeros')}
                      className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                        activeFilter === 'zeros'
                          ? 'border border-amber-400/50 bg-amber-500/20 text-amber-50'
                          : 'border border-slate-600/50 bg-slate-900/50 text-slate-300 hover:bg-slate-800/60'
                      }`}
                    >
                      Seguimiento clientes
                      {zeroBalanceSubClientCount > 0 ? (
                        <span className="ml-1.5 tabular-nums text-[10px] opacity-90">
                          ({zeroBalanceSubClientCount})
                        </span>
                      ) : null}
                    </button>
                  </div>
                  <div className="relative mb-4 px-3 pt-3">
                    <Search
                      size={16}
                      className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-indigo-400"
                      aria-hidden
                    />
                    <input
                      type="search"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      placeholder="Buscar por nombre o usuario…"
                      className="w-full rounded-lg border border-indigo-800/50 bg-indigo-950/30 py-2 pl-10 pr-4 text-sm text-indigo-100 placeholder-indigo-400 transition-colors focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                  {filteredClients.length === 0 ? (
                    <p className="m-0 px-3 pb-4 text-sm text-slate-400/85">
                      {searchTerm.trim()
                        ? 'No se encontraron clientes que coincidan con la búsqueda.'
                        : 'No hay sub-clientes con saldo BaaS en cero en este momento.'}
                    </p>
                  ) : (
                    <>
                  <div className="w-full">
                    <table className="w-full table-fixed text-[11px] md:text-sm">
                      <thead>
                        <tr className="border-b border-slate-600/40 bg-slate-950/60 text-left text-[10px] font-bold uppercase tracking-wide text-slate-400 md:text-[11px]">
                          <th className="w-1/3 px-1 py-1.5 text-left md:w-1/4 md:px-4 md:py-2">Cliente</th>
                          <th className="w-1/3 px-1 py-1.5 text-left md:w-1/4 md:px-4 md:py-2">Usuario</th>
                          <th className="w-1/3 px-1 py-1.5 text-left md:w-2/4 md:px-4 md:py-2">Saldo</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700/40">
                        {currentSubClients.map((sc) => {
                          const sid = Number(sc?.id)
                          const label = String(sc?.name ?? sc?.username ?? '—').trim() || '—'
                          const user = String(sc?.username ?? '—').trim() || '—'
                          const bal = Number(sc?.wallet_balance) || 0
                          const scCur = String(sc?.currency ?? clientBaseCurrency)
                            .trim()
                            .toUpperCase()
                            .slice(0, 10)
                          const portalUrl = clientPortalPublicUrl(sc?.portal_token)
                          const isExpanded = expandedClientId === sid
                          const toggleExpanded = () =>
                            setExpandedClientId((prev) => (prev === sid ? null : sid))
                          return (
                            <Fragment key={`sc-${sid}`}>
                              <tr
                                role="button"
                                tabIndex={0}
                                aria-expanded={isExpanded}
                                onClick={toggleExpanded}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    toggleExpanded()
                                  }
                                }}
                                className="cursor-pointer bg-slate-950/35 transition-colors hover:bg-white/5"
                              >
                                <td className="w-1/3 px-1 py-1.5 text-left align-top md:w-1/4 md:px-4 md:py-2">
                                  <span className="block break-words font-semibold leading-snug text-slate-50" title={label}>
                                    {label}
                                  </span>
                                </td>
                                <td className="w-1/3 px-1 py-1.5 text-left align-top md:w-1/4 md:px-4 md:py-2">
                                  <span
                                    className="block break-all font-mono text-[10px] leading-snug text-cyan-100/90 md:text-xs"
                                    title={user}
                                  >
                                    {user}
                                  </span>
                                </td>
                                <td className="w-1/3 px-1 py-1.5 text-left align-top md:w-2/4 md:px-4 md:py-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <span
                                      className="inline-flex rounded-md border border-green-700 bg-green-900/30 px-2 py-1 text-[10px] font-bold tabular-nums text-green-400 md:border-0 md:bg-transparent md:p-0 md:text-sm md:font-semibold md:text-fuchsia-100"
                                    >
                                      {formatMoney(bal, scCur)}
                                    </span>
                                    <ChevronDown
                                      aria-hidden
                                      size={18}
                                      strokeWidth={2.25}
                                      className={`shrink-0 text-slate-400 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                                    />
                                  </div>
                                </td>
                              </tr>
                              {isExpanded ? (
                                <tr className="bg-slate-950/25">
                                  <td colSpan={3} className="px-2 pb-3 pt-0 md:px-4">
                                    <div className="md:hidden">
                                      <SubClientMobileActionCards
                                        subclient={sc}
                                        portalUrl={portalUrl}
                                        copiedClientId={copiedClientId}
                                        onCopyLink={handleCopySubClientPortalLink}
                                        onTransfer={openTransferModal}
                                        onPrices={openPricesModal}
                                        onEdit={openEditSubClientModal}
                                        onDelete={openDeleteSubClientModal}
                                        deleting={deletingSubClientId === sid}
                                      />
                                    </div>
                                    <div className="hidden border-t border-slate-700/40 pt-3 md:block">
                                      <SubClientActionsCell
                                        subclient={sc}
                                        portalUrl={portalUrl}
                                        copiedClientId={copiedClientId}
                                        onCopyLink={handleCopySubClientPortalLink}
                                        onTransfer={openTransferModal}
                                        onPrices={openPricesModal}
                                        onEdit={openEditSubClientModal}
                                        onDelete={openDeleteSubClientModal}
                                        deleting={deletingSubClientId === sid}
                                      />
                                    </div>
                                  </td>
                                </tr>
                              ) : null}
                            </Fragment>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-600/35 px-3 py-3">
                    <button
                      type="button"
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      className="rounded-lg border border-slate-500/40 bg-slate-900/60 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800/70 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Anterior
                    </button>
                    <span className="text-xs font-medium text-slate-300 tabular-nums">
                      Página {currentPage} de {Math.ceil(sortedSubClients.length / itemsPerPage) || 1}
                    </span>
                    <button
                      type="button"
                      disabled={currentPage >= totalSubClientPages}
                      onClick={() => setCurrentPage((p) => Math.min(totalSubClientPages, p + 1))}
                      className="rounded-lg border border-slate-500/40 bg-slate-900/60 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800/70 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Siguiente
                    </button>
                  </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </PortalNeoAccordion>
        <PortalNeoAccordion
          sectionId="portal-acc-active-screens"
          title="MIS PANTALLAS ACTIVAS"
          subtitle="Credenciales de tus compras ya activadas"
          headerAside={
            activeScreens.length > 0 ? (
              <span
                className="inline-flex min-h-[1.75rem] min-w-[1.75rem] items-center justify-center rounded-full border border-cyan-300/45 bg-cyan-500/20 px-2 text-xs font-extrabold tabular-nums text-cyan-50 shadow-[0_0_12px_rgba(34,211,238,0.25)]"
                title={`${activeScreens.length} pantalla${activeScreens.length === 1 ? '' : 's'} activa${activeScreens.length === 1 ? '' : 's'}`}
              >
                {activeScreens.length}
              </span>
            ) : (
              '0'
            )
          }
          accent="sapphire"
          expanded={isActiveScreensOpen}
          onToggle={() => {
            setIsActiveScreensOpen((o) => {
              const next = !o
              if (next) void loadPortal({ silent: true })
              return next
            })
          }}
        >
          {isActiveScreensOpen ? (
            <div className="space-y-3">
              {activeScreens.length === 0 ? (
                <p className="m-0 text-sm text-slate-400/80">Aún no tienes pantallas activas.</p>
              ) : (
                <>
                  <ul className="m-0 list-none space-y-3 p-0">
                    {paginatedActiveScreens.map((scr) => {
                      const sid = Number(scr?.screen_stock_id)
                      const saleId = Number(scr?.sale_id)
                      const pkg = String(scr?.package_name ?? 'Pantalla').trim() || 'Pantalla'
                      const user = String(scr?.username ?? '').trim()
                      const pass = String(scr?.password ?? '').trim()
                      const assignedLabel = formatPortalAssignedAt(scr?.assigned_at)
                      const expLabel = formatPortalScreenExpiry(scr?.expiration_date)
                      const userKey = `user-${sid}`
                      const passKey = `pass-${sid}`
                      return (
                        <li
                          key={`active-scr-${sid}-${saleId}`}
                          className="rounded-xl border border-slate-600/45 bg-slate-950/75 px-4 py-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="m-0 text-sm font-bold text-slate-50">{pkg}</p>
                              {assignedLabel ? (
                                <p className="mt-1 mb-0 text-xs text-cyan-200/80">
                                  Asignada: <span className="font-medium text-cyan-50">{assignedLabel}</span>
                                </p>
                              ) : null}
                              {expLabel ? (
                                <p className="mt-1 mb-0 text-xs text-slate-400">
                                  Vence: <span className="text-slate-200">{expLabel}</span>
                                </p>
                              ) : null}
                            </div>
                            <span className="shrink-0 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                              FAC-{String(saleId).padStart(4, '0')}
                            </span>
                          </div>
                          <div className="mt-3 space-y-2">
                            <PortalScreenCredentialRow
                              label="Usuario"
                              value={user}
                              flashKey={userKey}
                              copyFlashKey={copyFlashKey}
                              onCopy={handleCopyScreenField}
                            />
                            <PortalScreenCredentialRow
                              label="Contraseña"
                              value={pass}
                              flashKey={passKey}
                              copyFlashKey={copyFlashKey}
                              onCopy={handleCopyScreenField}
                            />
                          </div>
                          {!user && !pass ? (
                            <p className="mt-2 mb-0 text-xs text-amber-200/85">
                              Pantalla activa sin credenciales en bodega. Contacta a soporte.
                            </p>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                  {totalActivePages > 1 ? (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-600/35 pt-4">
                      <button
                        type="button"
                        disabled={activeScreensPage <= 1}
                        onClick={() => setActiveScreensPage((p) => Math.max(1, p - 1))}
                        className="rounded-lg border border-slate-500/40 bg-slate-900/60 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800/70 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Anterior
                      </button>
                      <span className="text-xs font-medium text-slate-300 tabular-nums">
                        Página {activeScreensPage} de {totalActivePages}
                      </span>
                      <button
                        type="button"
                        disabled={activeScreensPage >= totalActivePages}
                        onClick={() =>
                          setActiveScreensPage((p) => Math.min(totalActivePages, p + 1))
                        }
                        className="rounded-lg border border-slate-500/40 bg-slate-900/60 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800/70 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Siguiente
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </PortalNeoAccordion>
        {showSaldoAFavorCard ? (
        <section
          aria-label="Saldo a favor"
          className={`${PORTAL_SECTION_SHELL_CLASS} relative mb-4 overflow-hidden rounded-[20px] border-2 border-emerald-400/45 shadow-[inset_0_1px_0_rgba(167,243,208,0.12),0_22px_48px_rgba(0,0,0,0.38)] transition-all duration-300 md:mb-6 md:rounded-[22px]`}
          style={{
            background: 'linear-gradient(145deg, rgba(6,78,59,0.52), rgba(16,185,129,0.22), rgba(14,21,41,0.72))',
          }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-[inherit] bg-gradient-to-br from-emerald-400/30 via-transparent to-teal-400/18 opacity-95"
          />
          <div className="relative z-[1] flex min-h-[48px] touch-manipulation flex-wrap items-center justify-between gap-x-4 gap-y-3 px-3 py-3.5 md:px-[18px] md:py-4">
            <div className="min-w-0 flex-1 pr-2">
              <p className="m-0 text-[11px] font-extrabold uppercase leading-tight tracking-[0.16em] text-emerald-100 sm:text-xs">
                SALDO A FAVOR
              </p>
              <p className="m-1.5 mb-0 text-[13px] font-medium leading-snug text-slate-200/88">
                Anticipos y sobrepagos disponibles para pagar pedidos o deudas
              </p>
            </div>
            <span
              className="max-w-[12rem] shrink-0 whitespace-normal text-right text-lg font-extrabold leading-tight tracking-tight text-emerald-50 tabular-nums sm:max-w-[16rem] sm:text-[22px]"
              title={totalCreditLabel}
            >
              {totalCreditLabel}
            </span>
          </div>
        </section>
        ) : null}
        {showSaldoPendienteSection ? (
        <PortalNeoAccordion
          sectionId="portal-acc-debt"
          title="SALDO PENDIENTE"
          subtitle="Facturas, recargas BaaS y abonos"
          headerAside={totalDebtLabel || '—'}
          accent="emerald"
          expanded={accordionDebtOpen}
          onToggle={() => setAccordionDebtOpen((o) => !o)}
        >
        <div
          className="rounded-2xl border border-emerald-500/35 p-5 transition-all duration-300"
          style={{
            background: 'rgba(16,185,129,0.12)',
            boxShadow: '0 14px 40px rgba(0,0,0,0.28)',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 16,
            }}
          >
            <div style={{ flex: '1 1 200px', minWidth: 0 }}>
              <p style={{ margin: '0 0 6px', fontSize: 12, opacity: 0.65, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Saldo pendiente por pagar
              </p>
              <p style={{ margin: 0, fontSize: 30, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{totalDebtLabel}</p>
              {creditRowsDisplay.length > 0 ? (
                <p
                  style={{
                    margin: '10px 0 0',
                    padding: '10px 12px',
                    borderRadius: 12,
                    background: 'rgba(16,185,129,0.22)',
                    border: '1px solid rgba(52,211,153,0.45)',
                    fontSize: 14,
                    fontWeight: 600,
                    lineHeight: 1.45,
                    color: '#a7f3d0',
                  }}
                >
                  Saldo a favor disponible:{' '}
                  <span style={{ fontVariantNumeric: 'tabular-nums', color: '#ecfdf5' }}>
                    {totalCreditLabel}
                  </span>
                  {' '}(Aplicable a futuras compras)
                </p>
              ) : null}
              {creditRowsDisplay.length > 1 ? (
                <ul style={{ margin: '10px 0 0', padding: 0, listStyle: 'none', fontSize: 14, opacity: 0.88 }}>
                  {creditRowsDisplay.map((r) => (
                    <li key={`credit-${String(r.currency)}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <span>{String(r.currency)} a favor</span>
                      <span style={{ fontWeight: 600 }}>{formatMoney(r.amount, String(r.currency))}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {debtRowsDisplay.length > 1 ? (
                <ul style={{ margin: '12px 0 0', padding: 0, listStyle: 'none', fontSize: 14, opacity: 0.88 }}>
                  {debtRowsDisplay.map((r) => (
                    <li key={String(r.currency)} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                      <span>{String(r.currency)}</span>
                      <span style={{ fontWeight: 600 }}>{formatMoney(r.amount, String(r.currency))}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
          <p style={{ margin: '14px 0 0', fontSize: 12, opacity: 0.55, lineHeight: 1.45 }}>
            Incluye facturas/pedidos con saldo pendiente y recargas BaaS con importe pendiente por cubrir.{' '}
            {hasHistoricalDebt && !hasNewOrders
              ? 'Los abonos de facturas y los comprobantes de recarga se revisan antes de aplicarse.'
              : hasNewOrders && !hasHistoricalDebt
                ? 'Los pedidos nuevos se pagan desde «NUEVOS PEDIDOS PARA PAGO». Las recargas con saldo pendiente pueden abonarse aquí mediante «Abono a deuda pendiente».'
                : '«NUEVOS PEDIDOS PARA PAGO» muestra pedidos y recargas con saldo pendiente, incluidos abonos parciales. Aquí tienes tu estado de cuenta, deuda histórica y el formulario «Abono a deuda pendiente».'}
          </p>
          {walletRechargesErr ?
            <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.45, color: '#fecaca' }}>{walletRechargesErr}</p>
          : null}

          {showAccountLedgerSection ?
            <>
              {pendingLedgerObligations.length > 1 ?
                <div className="mt-4 flex flex-col gap-1">
                  <label htmlFor="portal-ledger-obligation-select" className="text-[11px] uppercase tracking-wide text-emerald-200/55">
                    Ver estado y movimientos de
                  </label>
                  <select
                    id="portal-ledger-obligation-select"
                    className={`${PORTAL_TOUCH_INPUT_CLASS} mt-2`}
                    value={effectiveLedgerFocusKey}
                    onChange={(e) => setLedgerFocusKey(e.target.value)}
                    className="w-full rounded-xl border border-emerald-500/25 bg-slate-950/60 px-3 py-2.5 text-[13px] font-medium text-emerald-50 outline-none ring-0 focus:border-emerald-400/50"
                  >
                    {pendingLedgerObligations.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.summaryLabel} — {formatMoney(o.pendingAmount, o.currency)} pendiente
                      </option>
                    ))}
                  </select>
                </div>
              : null}
              <button
                type="button"
                aria-expanded={ledgerOpen}
                onClick={() => setLedgerOpen((o) => !o)}
                className={`${PORTAL_TOUCH_BUTTON_CLASS} mt-4 border border-emerald-500/30 bg-emerald-950/20 text-[13px] font-medium text-emerald-50/95 hover:bg-emerald-950/35`}
              >
                <span className="text-base leading-none" aria-hidden>
                  ⬇️
                </span>
                <span>
                  Ver estado y movimientos —{' '}
                  <span className="tabular-nums">
                    {(pendingLedgerObligations.find((o) => o.key === effectiveLedgerFocusKey) ?? pendingLedgerObligations[0])
                      ?.summaryLabel ?? '—'}
                  </span>
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 opacity-80 transition-transform duration-300 ${ledgerOpen ? 'rotate-180' : ''}`}
                  aria-hidden
                />
              </button>

              <div
                className={`grid overflow-hidden transition-all duration-300 ease-out ${ledgerOpen ? 'mt-4 grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
              >
                <div className="min-h-0">
                  {!ledgerOpen ? null : portalLedgerDisplay.length === 0 ?
                    <p className="m-0 rounded-xl border border-white/10 bg-black/25 px-4 py-8 text-center text-[13px] text-slate-400">
                      No hay movimientos públicos para esta consulta todavía (cuando registres pagos o abonos aparecerán aquí).
                    </p>
                  : (
                    <div className="max-h-[min(28rem,calc(100vh-220px))] overflow-y-auto rounded-xl border border-white/10 bg-black/22 px-3 py-3 sm:px-4">
                      <ul className="m-0 list-none space-y-0 pl-3">
                        {portalLedgerDisplay.map((row, idx) => {
                          const isPayment = row.type === 'payment'
                          const amt = parseMoneyNum(row.amount)
                          const cur = row.currency ? String(row.currency).trim().toUpperCase().slice(0, 10) : 'USD'
                          const looksLikeRecarga = /^REC-/i.test(String(row.reference ?? ''))
                          const label =
                            row.type === 'invoice' ? looksLikeRecarga ? 'Recarga BaaS' : 'Factura / venta' : 'Abono / pago'
                          const dt = row.date ? formatDateTimeEcuador(row.date) : '—'
                          const amountLine = isPayment
                            ? (
                                <span className="text-[15px] font-bold tabular-nums text-emerald-400">
                                  + {formatMoney(amt, cur)}
                                </span>
                              )
                            : (
                                <span className="text-[15px] font-semibold tabular-nums text-rose-200/90">
                                  {formatMoney(amt, cur)}
                                </span>
                              )
                          return (
                            <li
                              key={`${row.reference}-${row.date}-${idx}`}
                              className="relative border-l border-white/15 py-3 pl-4 pr-1 first:pt-0 last:pb-1"
                            >
                              <div className="absolute left-0 top-[1.35rem] h-2 w-2 -translate-x-[5px] rounded-full bg-emerald-400/80" />
                              <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
                                  <p className="m-0 mt-0.5 text-[14px] font-bold text-sky-100">{row.reference}</p>
                                  <p className="m-0 mt-1 text-[12px] leading-snug text-slate-300/90">{row.description}</p>
                                  <p className="m-0 mt-1 text-[11px] text-slate-500">{dt}</p>
                                </div>
                                <div className="shrink-0 text-right">{amountLine}</div>
                              </div>
                              <p className="m-0 mt-1.5 text-[11px] text-slate-500">{row.status}</p>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </>
          : null}

          {showUnifiedAbonoPayShell ?
            <div className="mt-6 border-t border-emerald-500/25 pt-5">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-100/85">
                Abono a deuda pendiente
              </p>
              <p className="mb-4 text-[13px] leading-relaxed text-slate-300/92">
                Sube aquí tu comprobante para la opción marcada más arriba (factura o recarga). Un operador lo aplicará en
                el ERP usando la referencia que enviamos junto al archivo.
              </p>
              <div className="portal-order-summary-glow-wrap mb-0">
                <section className="portal-order-summary-card">
                  <div className="portal-order-summary-inner px-4 pb-4 pt-4 sm:px-5">{debtFormCard()}</div>
                </section>
              </div>
            </div>
          : null}

          {Array.isArray(data?.pending_debt_payments) && data.pending_debt_payments.filter((dp) => dp?.status === 'pending_review').length > 0 ? (
          <section
            className="mt-5 transition-all duration-300"
            style={{
              padding: '16px 18px',
              borderRadius: 22,
              background: 'rgba(251,191,36,0.08)',
              border: '1px solid rgba(251,191,36,0.25)',
            }}
          >
            <p style={{ margin: '0 0 10px', fontSize: 12, opacity: 0.65, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
              Abonos en revisión
            </p>
            {(data?.pending_debt_payments ?? []).filter((dp) => dp?.status === 'pending_review').map((dp, idx) => (
              <div
                key={dp?.id ?? `pending-dp-${idx}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 0',
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                  fontSize: 14,
                }}
              >
                <span>{dp.created_at ? new Date(dp.created_at).toLocaleDateString('es-ES') : '—'}</span>
                <span style={{ fontWeight: 700 }}>{formatMoney(parseMoneyNum(dp.amount), String(dp.currency || 'USD'))}</span>
                <span style={{ fontSize: 12, color: '#fcd34d', padding: '4px 10px', borderRadius: 999, background: 'rgba(251,191,36,0.15)' }}>
                  En revisión
                </span>
              </div>
            ))}
          </section>
          ) : null}
        </div>
        </PortalNeoAccordion>
        ) : null}

        <p style={{ marginTop: 28, textAlign: 'center', fontSize: 12, opacity: 0.35 }}>
          Este enlace es permanente: puedes volver cuando quieras para ver cambios en tu cuenta.
        </p>
      </div>

      {confirmingPurchase ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="auto-purchase-confirm-title"
        >
          <button
            type="button"
            aria-label="Cerrar confirmación"
            className="absolute inset-0 bg-slate-950/72 backdrop-blur-sm"
            onClick={() => {
              if (autoPurchaseBusyId == null) setConfirmingPurchase(null)
            }}
          />
          <div
            className="relative z-10 w-full max-w-md rounded-2xl border border-violet-400/35 px-5 py-6 shadow-[0_24px_64px_rgba(0,0,0,0.55)]"
            style={{
              background: 'linear-gradient(160deg, rgba(30,27,75,0.97), rgba(15,23,42,0.98))',
            }}
          >
            <h2
              id="auto-purchase-confirm-title"
              className="m-0 text-lg font-extrabold tracking-tight text-violet-50"
            >
              Confirmar compra
            </h2>
            <p className="mt-3 mb-0 text-sm leading-relaxed text-slate-200/90">
              ¿Estás seguro de que deseas adquirir{' '}
              <strong className="font-bold text-white tabular-nums">
                {confirmingPurchase.quantity}
              </strong>{' '}
              pantalla{confirmingPurchase.quantity === 1 ? '' : 's'} de{' '}
              <strong className="font-bold text-violet-100">{confirmingPurchase.packageName}</strong>{' '}
              por un total de{' '}
              <strong className="font-bold text-fuchsia-100 tabular-nums">
                {Number.isFinite(confirmingPurchase.totalPrice)
                  ? formatMoney(confirmingPurchase.totalPrice, confirmingPurchase.currency || clientBaseCurrency)
                  : '—'}
              </strong>
              ?
            </p>
            <p className="mt-3 mb-0 text-xs leading-relaxed text-amber-200/85">
              Este valor se descontará automáticamente de tu Billetera BaaS.
            </p>
            {confirmingPurchase.step === 'tracking' ? (
              <div className="mt-5 space-y-3 rounded-xl border border-violet-400/25 bg-slate-950/60 p-4">
                <p className="m-0 text-xs font-semibold uppercase tracking-wide text-violet-200/80">
                  Datos del cliente final
                </p>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-300">
                    Nombre del cliente o usuario
                  </label>
                  <input
                    type="text"
                    value={confirmingPurchase.endCustomerName ?? ''}
                    onChange={(e) =>
                      setConfirmingPurchase((prev) =>
                        prev
                          ? { ...prev, endCustomerName: e.target.value, trackingErr: null }
                          : prev,
                      )
                    }
                    placeholder="Ej. Juan Pérez"
                    className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2.5 text-sm text-white"
                    autoComplete="name"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-300">
                    Número de teléfono
                  </label>
                  <div className="mb-2">
                    <Select
                      options={phoneCountryOptions}
                      value={
                        phoneCountryOptions.find(
                          (o) => o.value === (confirmingPurchase.endCustomerDialCode ?? '+593'),
                        ) ?? phoneCountryOptions[0]
                      }
                      onChange={(opt) =>
                        setConfirmingPurchase((prev) =>
                          prev
                            ? { ...prev, endCustomerDialCode: opt?.value ?? '+593', trackingErr: null }
                            : prev,
                        )
                      }
                      isSearchable
                      filterOption={(option, input) => {
                        const q = String(input || '').trim().toLowerCase()
                        if (!q) return true
                        const hay = String(option.searchText ?? option.label ?? '').toLowerCase()
                        return hay.includes(q)
                      }}
                      styles={portalPaymentMethodSelectStyles}
                      placeholder="Buscar país…"
                      className="text-sm"
                      classNamePrefix="portal-track-phone-country"
                    />
                  </div>
                  <div className="flex gap-2">
                    <span className="inline-flex shrink-0 items-center rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm font-mono text-violet-200 tabular-nums">
                      {confirmingPurchase.endCustomerDialCode ?? '+593'}
                    </span>
                    <input
                      type="tel"
                      inputMode="numeric"
                      value={confirmingPurchase.endCustomerLocalNumber ?? ''}
                      onChange={(e) =>
                        setConfirmingPurchase((prev) =>
                          prev
                            ? {
                                ...prev,
                                endCustomerLocalNumber: e.target.value.replace(/[^\d\s-]/g, ''),
                                trackingErr: null,
                              }
                            : prev,
                        )
                      }
                      placeholder="999999999"
                      className="min-w-0 flex-1 rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white tabular-nums"
                      autoComplete="tel-national"
                    />
                  </div>
                </div>
                {confirmingPurchase.trackingErr ? (
                  <p className="m-0 text-xs text-red-300">{confirmingPurchase.trackingErr}</p>
                ) : null}
              </div>
            ) : null}
            <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                disabled={autoPurchaseBusyId != null}
                onClick={() => setConfirmingPurchase(null)}
                className="rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Cancelar
              </button>
              {confirmingPurchase.step === 'tracking' ? (
                <>
                  <button
                    type="button"
                    disabled={autoPurchaseBusyId != null}
                    onClick={() =>
                      setConfirmingPurchase((prev) =>
                        prev ? { ...prev, step: 'choose', trackingErr: null } : prev,
                      )
                    }
                    className="rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Volver
                  </button>
                  <button
                    type="button"
                    disabled={autoPurchaseBusyId != null}
                    onClick={() => void executeConfirmedAutoPurchase()}
                    className="rounded-xl px-4 py-2.5 text-sm font-bold transition-colors disabled:opacity-45 disabled:cursor-not-allowed bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:from-violet-400 hover:to-fuchsia-400"
                  >
                    {autoPurchaseBusyId != null ? 'Procesando…' : 'Confirmar compra y guardar cliente'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={autoPurchaseBusyId != null}
                    onClick={() =>
                      setConfirmingPurchase((prev) => (prev ? { ...prev, step: 'tracking' } : prev))
                    }
                    className="rounded-xl bg-green-500 px-4 py-2.5 text-sm font-bold text-slate-950 shadow-[0_0_15px_rgba(34,197,94,0.4)] transition-all hover:bg-green-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Comprar con seguimiento al cliente
                  </button>
                  <button
                    type="button"
                    disabled={autoPurchaseBusyId != null}
                    onClick={() => void executeConfirmedAutoPurchase({ noTracking: true })}
                    className="rounded-xl px-4 py-2.5 text-sm font-bold transition-colors disabled:opacity-45 disabled:cursor-not-allowed bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:from-violet-400 hover:to-fuchsia-400"
                  >
                    {autoPurchaseBusyId != null ? 'Procesando…' : 'Comprar sin seguimiento al cliente'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {createSubClientOpen ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Cerrar"
            className="absolute inset-0 bg-slate-950/72 backdrop-blur-sm"
            onClick={() => !createSubClientBusy && setCreateSubClientOpen(false)}
          />
          <div className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-violet-400/35 bg-slate-900 shadow-2xl">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-700/50 px-5 py-4">
              <div>
                <h2 className="m-0 text-lg font-extrabold text-violet-50">Crear Sub-cliente</h2>
                <p className="m-1 mb-0 text-xs text-slate-400">
                  Precios obligatorios, margen protegido y recarga BaaS inicial en una sola operación.
                </p>
              </div>
              <button
                type="button"
                disabled={createSubClientBusy}
                onClick={() => setCreateSubClientOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleCreateSubClientSubmit}>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
                <label className="block text-xs font-semibold text-slate-300">
                  Usuario IPTV <span className="text-red-300">*</span>
                  <input
                    type="text"
                    value={createSubClientForm.username}
                    onChange={(ev) =>
                      setCreateSubClientForm((p) => ({ ...p, username: ev.target.value }))
                    }
                    className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
                    autoComplete="off"
                  />
                </label>
                <label className="block text-xs font-semibold text-slate-300">
                  Email <span className="text-red-300">*</span>
                  <input
                    type="email"
                    value={createSubClientForm.email}
                    onChange={(ev) =>
                      setCreateSubClientForm((p) => ({ ...p, email: ev.target.value }))
                    }
                    className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
                  />
                </label>
                <label className="block text-xs font-semibold text-slate-300">
                  Nombre completo (opcional)
                  <input
                    type="text"
                    value={createSubClientForm.name}
                    onChange={(ev) =>
                      setCreateSubClientForm((p) => ({ ...p, name: ev.target.value }))
                    }
                    className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
                  />
                </label>
                <label className="block text-xs font-semibold text-slate-300">
                  Teléfono (opcional)
                  <input
                    type="tel"
                    value={createSubClientForm.phone}
                    onChange={(ev) =>
                      setCreateSubClientForm((p) => ({ ...p, phone: ev.target.value }))
                    }
                    className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
                  />
                </label>

                <label className="block text-xs font-semibold text-slate-300">
                  Transferencia Inicial de Saldo BaaS ({clientBaseCurrency}) <span className="text-red-300">*</span>
                  <input
                    type="number"
                    step="0.01"
                    max={parentBaasBalanceForCreate > 0 ? parentBaasBalanceForCreate : undefined}
                    placeholder="0.00"
                    value={createSubClientInitialTransfer}
                    onChange={(ev) => {
                      const v = ev.target.value
                      setCreateSubClientInitialTransfer(v)
                      setCreateSubClientInitialTransferErr(
                        validateCreateSubClientInitialTransfer(v) || null,
                      )
                    }}
                    onBlur={(ev) => {
                      setCreateSubClientInitialTransferErr(
                        validateCreateSubClientInitialTransfer(ev.target.value) || null,
                      )
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white tabular-nums"
                  />
                </label>
                <p className="m-0 text-xs text-slate-400 leading-relaxed">
                  Este monto se descontará de tu billetera actual (Saldo disponible:{' '}
                  <span className="font-semibold tabular-nums text-emerald-200">
                    {formatMoney(parentBaasBalanceForCreate, clientBaseCurrency)}
                  </span>
                  ).
                </p>
                {createSubClientInitialTransferErr ? (
                  <p className="m-0 text-xs text-red-300">{createSubClientInitialTransferErr}</p>
                ) : null}

                <div className="border-t border-slate-700/50 pt-3">
                  <p className="m-0 text-xs font-bold uppercase tracking-wide text-violet-200/90">
                    Precios de venta (obligatorios)
                  </p>
                  {createSubClientPackagesLoading ? (
                    <p className="mt-2 flex items-center gap-2 text-sm text-slate-300">
                      <Loader2 size={16} className="animate-spin" />
                      Cargando paquetes autorizados…
                    </p>
                  ) : createSubClientPackages.length === 0 ? (
                    <p className="mt-2 text-sm text-amber-200/90">
                      No tienes paquetes Flujo autorizados. Solicita tu matriz de precios al administrador
                      antes de crear sub-clientes.
                    </p>
                  ) : (
                    <ul className="mt-3 list-none space-y-3 p-0">
                      {createSubClientPackages.map((pkg) => {
                        const pid = String(pkg?.package_catalog_id)
                        const costoAdquisicionReal = parentPackageAcquisitionPrice(pkg, assignedPricesMap)
                        const fieldErr =
                          createSubClientPriceFieldErr[pid]
                          || validateCreateSubClientPrice(pkg, createSubClientPriceDraft[pid])
                        return (
                          <li
                            key={`create-price-${pid}`}
                            className="rounded-xl border border-slate-600/45 bg-slate-950/60 px-3 py-3"
                          >
                            <p className="m-0 text-sm font-semibold text-slate-50">{pkg?.display_name}</p>
                            <p className="mt-1 mb-2 text-xs text-amber-200/90">
                              Tu costo de adquisición:{' '}
                              <span className="font-semibold tabular-nums">
                                {formatMoney(costoAdquisicionReal, clientBaseCurrency)}
                              </span>
                            </p>
                            <label className="block text-xs text-slate-400">
                              Precio de venta ({clientBaseCurrency}) <span className="text-red-300">*</span>
                              <input
                                type="number"
                                min={costoAdquisicionReal > 0 ? costoAdquisicionReal : 0}
                                step="0.01"
                                placeholder="0.00"
                                value={createSubClientPriceDraft[pid] ?? ''}
                                onChange={(ev) => {
                                  const v = ev.target.value
                                  setCreateSubClientPriceDraft((prev) => ({ ...prev, [pid]: v }))
                                  setCreateSubClientPriceFieldErr((prev) => ({
                                    ...prev,
                                    [pid]: validateCreateSubClientPrice(pkg, v) || undefined,
                                  }))
                                }}
                                onBlur={(ev) => {
                                  const v = ev.target.value
                                  setCreateSubClientPriceFieldErr((prev) => ({
                                    ...prev,
                                    [pid]: validateCreateSubClientPrice(pkg, v) || undefined,
                                  }))
                                }}
                                className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white tabular-nums"
                              />
                            </label>
                            {fieldErr ? (
                              <p className="mt-1.5 mb-0 text-xs text-red-300">{fieldErr}</p>
                            ) : null}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>

                {createSubClientErr ? (
                  <p className="m-0 text-sm text-red-200">{createSubClientErr}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-col gap-3 border-t border-slate-700/50 px-5 py-4">
                {createSubClientFormErrors.length > 0 ? (
                  <div
                    className="rounded-lg border border-red-300 bg-red-100 px-3 py-2.5 text-red-500"
                    role="alert"
                  >
                    <p className="m-0 text-xs font-semibold uppercase tracking-wide">Revisa el formulario</p>
                    <ul className="mt-1.5 mb-0 list-disc pl-4 text-sm space-y-1">
                      {createSubClientFormErrors.map((msg, idx) => (
                        <li key={`create-sub-err-${idx}`}>{msg}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={createSubClientBusy}
                  onClick={() => setCreateSubClientOpen(false)}
                  className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-200"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={createSubClientBusy || !createSubClientCanSubmit}
                  className="rounded-xl bg-violet-500 px-4 py-2 text-sm font-bold text-white hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {createSubClientBusy ? 'Guardando…' : 'Crear sub-cliente'}
                </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {deleteSubClientTarget ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Cerrar"
            className="absolute inset-0 bg-slate-950/72 backdrop-blur-sm"
            onClick={() => closeDeleteSubClientModal()}
            disabled={deletingSubClientId != null}
          />
          <div
            className={`relative z-10 w-full max-w-md rounded-2xl border px-5 py-6 shadow-2xl ${
              deleteSubClientStep === 'critical'
                ? 'border-red-500/50 bg-gradient-to-b from-red-950/40 to-slate-900'
                : 'border-amber-400/35 bg-slate-900'
            }`}
          >
            {deleteSubClientStep === 'critical' ? (
              <>
                <h2 className="m-0 text-lg font-extrabold text-red-100">Eliminación permanente</h2>
                <p className="mt-4 text-sm leading-relaxed text-red-50/95">
                  🚨 ¡Atención! Esta acción es irreversible y se perderá el acceso al portal de este
                  cliente. Para confirmar la eliminación definitiva, haz clic en el botón de abajo.
                </p>
                <p className="mt-3 rounded-lg border border-red-500/30 bg-red-950/35 px-3 py-2 text-sm text-red-100">
                  Cliente:{' '}
                  <strong className="text-white">
                    {String(
                      deleteSubClientTarget?.username ??
                        deleteSubClientTarget?.name ??
                        '—',
                    ).trim() || '—'}
                  </strong>
                </p>
                {deleteSubClientErr ? (
                  <p className="mt-3 text-sm text-red-200">{deleteSubClientErr}</p>
                ) : null}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={deletingSubClientId != null}
                    onClick={() => {
                      setDeleteSubClientErr(null)
                      setDeleteSubClientStep('warn')
                    }}
                    className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-200 disabled:opacity-50"
                  >
                    Volver
                  </button>
                  <button
                    type="button"
                    disabled={deletingSubClientId != null}
                    onClick={() => void executeDeleteSubClient()}
                    className="rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white shadow-[0_0_20px_rgba(220,38,38,0.35)] hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {deletingSubClientId != null
                      ? 'Eliminando…'
                      : 'Confirmar eliminación permanente'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="m-0 text-lg font-extrabold text-amber-100">Eliminar sub-cliente</h2>
                <p className="mt-4 text-sm leading-relaxed text-slate-200">
                  ⚠️ ¿Estás seguro de que deseas eliminar a{' '}
                  <strong className="text-white">
                    {String(
                      deleteSubClientTarget?.username ?? deleteSubClientTarget?.name ?? '—',
                    ).trim() || '—'}
                  </strong>{' '}
                  de tu red de clientes?
                </p>
                {deleteSubClientErr ? (
                  <p className="mt-3 text-sm text-red-200">{deleteSubClientErr}</p>
                ) : null}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => closeDeleteSubClientModal()}
                    className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-200"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteSubClientErr(null)
                      setDeleteSubClientStep('critical')
                    }}
                    className="rounded-xl border border-amber-400/45 bg-amber-500/20 px-4 py-2 text-sm font-bold text-amber-50 hover:bg-amber-500/30"
                  >
                    Sí, continuar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {isTransferModalOpen && transferTarget ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Cerrar"
            className="absolute inset-0 bg-slate-950/72 backdrop-blur-sm"
            onClick={closeTransferModal}
          />
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-emerald-400/35 bg-slate-900 px-5 py-6 shadow-2xl">
            {transferStep === 'confirm' ? (
              <>
                <h2 className="m-0 text-lg font-extrabold text-amber-100">Confirmar transferencia</h2>
                <p className="mt-4 text-sm leading-relaxed text-slate-200">
                  ⚠️ ¿Estás seguro de transferir{' '}
                  <strong className="text-white tabular-nums">
                    {formatMoney(parseMoneyNum(transferAmount), clientBaseCurrency)}
                  </strong>{' '}
                  a{' '}
                  <strong className="text-white">
                    {String(transferTarget?.name ?? transferTarget?.username ?? '—')}
                  </strong>
                  ?
                </p>
                {transferErr ? <p className="mt-3 text-sm text-red-200">{transferErr}</p> : null}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={transferBusy}
                    onClick={() => {
                      setTransferErr(null)
                      setTransferStep('form')
                    }}
                    className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-200"
                  >
                    Volver
                  </button>
                  <button
                    type="button"
                    disabled={transferBusy}
                    onClick={async () => {
                      if (!token || !transferTarget?.id) return
                      const amt = parseMoneyNum(transferAmount)
                      setTransferBusy(true)
                      setTransferErr(null)
                      try {
                        await api.post(`/api/v1/portal/${encodeURIComponent(token)}/transfer`, {
                          child_client_id: Number(transferTarget.id),
                          amount: amt,
                        })
                        closeTransferModal(true)
                        await Promise.all([loadPortal({ silent: true }), loadSubClients()])
                      } catch (err) {
                        const d = err?.response?.data?.detail
                        setTransferErr(typeof d === 'string' ? d : 'No se pudo completar la transferencia.')
                      } finally {
                        setTransferBusy(false)
                      }
                    }}
                    className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {transferBusy ? 'Transfiriendo…' : 'Sí, confirmar transferencia'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="m-0 text-lg font-extrabold text-emerald-50">💸 Transferir saldo BaaS</h2>
                <p className="mt-2 text-sm text-slate-300">
                  Destino:{' '}
                  <strong className="text-white">
                    {String(transferTarget?.name ?? transferTarget?.username ?? '—')}
                  </strong>
                </p>
                <p className="mt-2 rounded-lg border border-emerald-400/25 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-100">
                  Tu saldo BaaS disponible:{' '}
                  <strong className="tabular-nums text-emerald-50">
                    {formatMoney(getClientWalletBalance(clientBaseCurrency), clientBaseCurrency)}
                  </strong>
                </p>
                <label className="mt-4 block text-xs font-semibold text-slate-300">
                  Monto a transferir ({clientBaseCurrency})
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={transferAmount}
                    onChange={(ev) => setTransferAmount(ev.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white tabular-nums"
                  />
                </label>
                {transferErr ? <p className="mt-2 text-sm text-red-200">{transferErr}</p> : null}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={transferBusy}
                    onClick={closeTransferModal}
                    className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-200"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={transferBusy}
                    onClick={() => {
                      const amt = parseMoneyNum(transferAmount)
                      if (!Number.isFinite(amt) || amt <= 0) {
                        setTransferErr('Ingresa un monto válido mayor a cero.')
                        return
                      }
                      if (getClientWalletBalance(clientBaseCurrency) + 1e-9 < amt) {
                        setTransferErr(
                          `El monto no puede superar tu saldo BaaS (${formatMoney(getClientWalletBalance(clientBaseCurrency), clientBaseCurrency)}).`,
                        )
                        return
                      }
                      setTransferErr(null)
                      setTransferStep('confirm')
                    }}
                    className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    Continuar
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {editSubClientOpen && editSubClientTarget ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Cerrar"
            className="absolute inset-0 bg-slate-950/72 backdrop-blur-sm"
            onClick={closeEditSubClientModal}
          />
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-amber-400/35 bg-slate-900 px-5 py-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="m-0 text-lg font-extrabold text-amber-50">✏️ Editar sub-cliente</h2>
                <p className="mt-1 mb-0 text-xs text-slate-400">
                  Usuario IPTV:{' '}
                  <span className="font-mono text-slate-200">{editSubClientTarget?.username ?? '—'}</span>
                </p>
              </div>
              <button
                type="button"
                disabled={editSubClientBusy}
                onClick={closeEditSubClientModal}
                className="rounded-lg p-1 text-slate-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>
            <form
              className="mt-4 space-y-3"
              onSubmit={async (e) => {
                e.preventDefault()
                if (!token || !editSubClientTarget?.id) return
                const em = editSubClientForm.email.trim()
                if (!em) {
                  setEditSubClientErr('El email es obligatorio.')
                  return
                }
                setEditSubClientBusy(true)
                setEditSubClientErr(null)
                try {
                  await api.put(
                    `/api/v1/portal/${encodeURIComponent(token)}/sub-clients/${Number(editSubClientTarget.id)}`,
                    {
                      name: editSubClientForm.name.trim() || null,
                      email: em,
                      phone: editSubClientForm.phone.trim() || null,
                    },
                  )
                  closeEditSubClientModal(true)
                  await loadSubClients()
                } catch (err) {
                  const d = err?.response?.data?.detail
                  setEditSubClientErr(typeof d === 'string' ? d : 'No se pudo actualizar el sub-cliente.')
                } finally {
                  setEditSubClientBusy(false)
                }
              }}
            >
              <label className="block text-xs font-semibold text-slate-300">
                Nombre
                <input
                  type="text"
                  value={editSubClientForm.name}
                  onChange={(ev) => setEditSubClientForm((p) => ({ ...p, name: ev.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
                />
              </label>
              <label className="block text-xs font-semibold text-slate-300">
                Email <span className="text-red-300">*</span>
                <input
                  type="email"
                  required
                  value={editSubClientForm.email}
                  onChange={(ev) => setEditSubClientForm((p) => ({ ...p, email: ev.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
                />
              </label>
              <label className="block text-xs font-semibold text-slate-300">
                Teléfono
                <input
                  type="tel"
                  value={editSubClientForm.phone}
                  onChange={(ev) => setEditSubClientForm((p) => ({ ...p, phone: ev.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white"
                />
              </label>
              {editSubClientErr ? <p className="m-0 text-sm text-red-200">{editSubClientErr}</p> : null}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={editSubClientBusy}
                  onClick={closeEditSubClientModal}
                  className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-200"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={editSubClientBusy}
                  className="rounded-xl bg-amber-600 px-4 py-2 text-sm font-bold text-white hover:bg-amber-500 disabled:opacity-50"
                >
                  {editSubClientBusy ? 'Guardando…' : 'Guardar cambios'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {pricingTarget ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Cerrar"
            className="absolute inset-0 bg-slate-950/72 backdrop-blur-sm"
            onClick={() => !pricingBusy && setPricingTarget(null)}
          />
          <div className="relative z-10 flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-violet-400/35 bg-slate-900 shadow-2xl">
            <div className="shrink-0 border-b border-slate-700/50 px-5 py-4">
              <h2 className="m-0 text-lg font-extrabold text-violet-50">🏷️ Asignar precios</h2>
              <p className="mt-1 mb-0 text-sm text-slate-300">
                {String(pricingTarget?.name ?? pricingTarget?.username ?? '—')} — paquetes que tú puedes
                vender
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {pricingLoading ? (
                <p className="m-0 flex items-center gap-2 text-sm text-slate-300">
                  <Loader2 size={16} className="animate-spin" />
                  Cargando paquetes…
                </p>
              ) : pricingRows.length === 0 ? (
                <p className="m-0 text-sm text-slate-400">
                  No tienes paquetes Flujo autorizados por el administrador. Solicita tu matriz de precios
                  primero.
                </p>
              ) : (
                <ul className="m-0 list-none space-y-3 p-0">
                  {pricingRows.map((row) => {
                    const pid = String(row?.package_catalog_id)
                    const floor = Number(row?.parent_floor_price_usd) || 0
                    return (
                      <li
                        key={`price-${pid}`}
                        className="rounded-xl border border-slate-600/45 bg-slate-950/60 px-3 py-3"
                      >
                        <p className="m-0 text-sm font-semibold text-slate-50">{row?.display_name}</p>
                        <p className="mt-1 mb-2 text-xs text-slate-400">
                          Tu costo (tarifa admin):{' '}
                          <span className="font-semibold text-amber-200 tabular-nums">
                            {formatMoney(floor, clientBaseCurrency)}
                          </span>
                          {' — '}
                          el precio del sub-cliente no puede ser menor.
                        </p>
                        <label className="block text-xs text-slate-400">
                          Precio de venta ({clientBaseCurrency})
                          <input
                            type="number"
                            min={floor}
                            step="0.01"
                            value={pricingDraft[pid] ?? ''}
                            onChange={(ev) =>
                              setPricingDraft((p) => ({ ...p, [pid]: ev.target.value }))
                            }
                            placeholder={floor > 0 ? String(floor) : '0.00'}
                            className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white tabular-nums"
                          />
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
              {pricingErr ? <p className="mt-3 text-sm text-red-200">{pricingErr}</p> : null}
            </div>
            <div className="shrink-0 flex justify-end gap-2 border-t border-slate-700/50 px-5 py-4">
              <button
                type="button"
                disabled={pricingBusy}
                onClick={() => setPricingTarget(null)}
                className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-200"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={pricingBusy || pricingLoading}
                onClick={async () => {
                  if (!token || !pricingTarget?.id) return
                  const items = []
                  for (const row of pricingRows) {
                    const pid = String(row?.package_catalog_id)
                    const raw = String(pricingDraft[pid] ?? '').trim()
                    if (!raw) continue
                    const price = parseMoneyNum(raw)
                    const floor = Number(row?.parent_floor_price_usd) || 0
                    if (!Number.isFinite(price) || price <= 0) continue
                    if (price + 1e-9 < floor) {
                      setPricingErr(
                        `El precio no puede ser menor a tu costo de adquisición de ${formatMoney(floor, clientBaseCurrency)}`,
                      )
                      return
                    }
                    items.push({
                      package_catalog_id: Number(row.package_catalog_id),
                      product_id: Number(row.product_id),
                      custom_price: price,
                    })
                  }
                  if (items.length === 0) {
                    setPricingErr('Ingresa al menos un precio válido.')
                    return
                  }
                  setPricingBusy(true)
                  setPricingErr(null)
                  try {
                    await api.post(`/api/v1/portal/${encodeURIComponent(token)}/assign-prices`, {
                      child_client_id: Number(pricingTarget.id),
                      items,
                    })
                    setPricingTarget(null)
                  } catch (err) {
                    const d = err?.response?.data?.detail
                    setPricingErr(typeof d === 'string' ? d : 'No se pudieron guardar los precios.')
                  } finally {
                    setPricingBusy(false)
                  }
                }}
                className="rounded-xl bg-violet-500 px-4 py-2 text-sm font-bold text-white hover:bg-violet-400 disabled:opacity-50"
              >
                {pricingBusy ? 'Guardando…' : 'Guardar precios'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {contactModalOpen ? (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Cerrar"
            className="absolute inset-0 bg-slate-950/72 backdrop-blur-sm"
            onClick={() => !contactSaving && setContactModalOpen(false)}
          />
          <div className="relative z-10 w-full max-w-md rounded-2xl border border-emerald-400/35 bg-slate-900 shadow-2xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-700/50 px-5 py-4">
              <div>
                <h2 className="m-0 text-lg font-extrabold text-emerald-50">Contacto de soporte</h2>
                <p className="m-1 mb-0 text-xs text-slate-400">
                  Tu número aparecerá en el portal de tus sub-clientes directos para WhatsApp.
                </p>
              </div>
              <button
                type="button"
                disabled={contactSaving}
                onClick={() => setContactModalOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-300">País / código</label>
                <Select
                  options={phoneCountryOptions}
                  value={phoneCountryOptions.find((o) => o.value === contactDialCode) ?? phoneCountryOptions[0]}
                  onChange={(opt) => setContactDialCode(opt?.value ?? '+593')}
                  isSearchable
                  filterOption={(option, input) => {
                    const q = String(input || '').trim().toLowerCase()
                    if (!q) return true
                    const hay = String(option.searchText ?? option.label ?? '').toLowerCase()
                    return hay.includes(q)
                  }}
                  styles={portalPaymentMethodSelectStyles}
                  placeholder="Buscar país…"
                  className="text-sm"
                  classNamePrefix="portal-contact-country"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-300">Número móvil</label>
                <div className="flex gap-2">
                  <span className="inline-flex shrink-0 items-center rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm font-mono text-emerald-200 tabular-nums">
                    {contactDialCode}
                  </span>
                  <input
                    type="tel"
                    inputMode="numeric"
                    value={contactLocalNumber}
                    onChange={(e) => setContactLocalNumber(e.target.value.replace(/[^\d\s-]/g, ''))}
                    placeholder="999999999"
                    className="min-w-0 flex-1 rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white tabular-nums"
                    autoComplete="tel-national"
                  />
                </div>
              </div>
              {mergePhoneParts(contactDialCode, contactLocalNumber) ? (
                <p className="m-0 text-xs text-slate-400">
                  Vista previa:{' '}
                  <span className="font-mono font-semibold text-emerald-200">
                    {mergePhoneParts(contactDialCode, contactLocalNumber)}
                  </span>
                </p>
              ) : null}
              {contactErr ? <p className="m-0 text-sm text-red-300">{contactErr}</p> : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-700/50 px-5 py-4">
              <button
                type="button"
                disabled={contactSaving}
                onClick={() => setContactModalOpen(false)}
                className="rounded-xl border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-45"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={contactSaving}
                onClick={() => void handleSaveContact()}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-45"
              >
                {contactSaving ? (
                  <>
                    <Loader2 size={14} className="animate-spin" aria-hidden />
                    Guardando…
                  </>
                ) : (
                  <>
                    {PORTAL_WA_SVG}
                    Guardar contacto
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
