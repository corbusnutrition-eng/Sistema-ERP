import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import {
  X,
  AlertTriangle,
  DollarSign,
  RefreshCw,
  Package,
  FileText,
  Trash2,
  Eye,
  ChevronDown,
  Link as LinkIcon,
  Copy,
} from 'lucide-react'
import api from '../../../api/axios'
import { useModal } from '../../../context/ModalContext'
import { useInventoryData } from '../../../context/InventoryDataContext'
import SearchableSelect from '../../../components/ui/SearchableSelect'
import TagsManagerPanel from '../../tags/TagsManagerPanel'
import SaleQBTagsCreatable from './SaleQBTagsCreatable'
import NuevaVentaInvoiceSection from './NuevaVentaInvoiceSection'
import FinancialSummarySidebar from '../../../components/ui/FinancialSummarySidebar'
import OcrSecurityBadges, {
  pickOcrSecurityFlags,
  IllegibleReceiptAlert,
  isIllegibleDeclaredRecord,
  buildIllegibleCheckSource,
} from '../../../components/OcrSecurityBadges'
import { calculateExpirationStats } from '../../inventory/screenPackageExpiration'
import {
  packageCatalogOrderedForSale,
} from '../../inventory/components/InventorySummaryCards'
import { SALES_CURRENCIES } from '../salesCurrencies'
import { currencyFromLastSelectedDepositIds } from '../../../lib/accountCurrencyCascade'
import useExchangeRateForCurrency from '../../../hooks/useExchangeRateForCurrency'
import { salesApiOrigin, copySalePaymentLink } from '../saleTableHelpers'
import { normalizeCurrencyCode } from '../../../lib/currencyCode'
import { formatShortDateEcuador } from '../../../utils/datetime'
import Swal from 'sweetalert2'

const formatShortDate = formatShortDateEcuador

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Tras POST de venta «crédito por pantalla»: credenciales asignadas desde bodega (FIFO o explícitas). */
async function alertScreenStockSaleCredentialsFromResponse(data) {
  if (!data || typeof data !== 'object') return
  const ch = String(data.inventory_channel ?? '').trim()
  const deliveries =
    Array.isArray(data.screen_stock_delivery) && data.screen_stock_delivery.length > 0
      ? data.screen_stock_delivery
      : null
  if (ch !== 'screen_stock' && !deliveries) return

  const productLabel = String(data.product_name ?? '').trim() || '—'
  const fallbackUser = String(data.iptv_username ?? '').trim() || ''
  const fallbackPass = String(data.iptv_password ?? '').trim() || ''

  const credentialRows =
    deliveries && deliveries.length
      ? deliveries.map((d, i) => ({
          idx: deliveries.length > 1 ? i + 1 : null,
          user: String(d?.iptv_username ?? '').trim() || fallbackUser || '—',
          pass: String(d?.iptv_password ?? '').trim() || fallbackPass || '—',
        }))
      : [{ idx: null, user: fallbackUser || '—', pass: fallbackPass || '—' }]

  const credBlocks = credentialRows
    .map(({ idx, user, pass }) => {
      const title = idx != null ? `Pantalla ${idx}` : 'Credenciales (FIFO)'
      return `
        <div class="rounded-lg border border-amber-200 bg-amber-50/90 px-3 py-3 text-left mt-2 first:mt-0">
          <p class="text-xs font-semibold uppercase tracking-wide text-amber-900">${escHtml(title)}</p>
          <dl class="mt-2 space-y-1.5 text-sm">
            <div class="flex flex-col gap-0.5">
              <dt class="text-[11px] font-medium text-slate-500 uppercase">Usuario</dt>
              <dd class="font-mono font-semibold text-slate-900 break-all select-all">${escHtml(user)}</dd>
            </div>
            <div class="flex flex-col gap-0.5">
              <dt class="text-[11px] font-medium text-slate-500 uppercase">Contraseña</dt>
              <dd class="font-mono font-semibold text-slate-900 break-all select-all">${escHtml(pass)}</dd>
            </div>
          </dl>
        </div>
      `
    })
    .join('')

  const html = `
    <div class="text-left space-y-2">
      <p class="text-sm text-slate-600"><span class="font-medium text-slate-800">Producto:</span> ${escHtml(productLabel)}</p>
      <p class="text-xs text-slate-500 leading-snug">La preventa quedó <strong class="text-slate-700">reservada</strong>. Envíe al cliente estas credenciales desde bodega (FIFO):</p>
      ${credBlocks}
    </div>
  `

  await Swal.fire({
    icon: 'success',
    title: 'Venta reservada con éxito',
    width: '32rem',
    html,
    confirmButtonText: 'Aceptar',
    allowOutsideClick: false,
  })
}

const SERVICE_EMPTY = ''
const FULL_CREDITS_VALUE = '__FULL_CREDITS__'
/** Venta por pantalla suelta: paquete + fila elegida en tabla (sin FIFO automático). */
const DETAIL_SCREENS_VALUE = '__DETAIL_SCREENS__'
/** Venta pendiente: se crea pantalla en bodega y se asigna al confirmar Registrar venta. */
const DRAFT_PENDING_SCREEN = '__DRAFT_PENDING_SCREEN__'
/** Acción UX: dispara modal global de recarga (no es un ítem vendible). */
const RECHARGE_SCREENS_ACTION = '__OPEN_RECHARGE_SCREENS__'

function NewTransactionClassModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave(e) {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    setSaving(true)
    setError('')
    try {
      const { data } = await api.post('/api/v1/classes/', { name: n })
      onCreated?.(data)
      onClose?.()
    } catch (err) {
      const d = err?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'No se pudo guardar la clase.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/45" aria-label="Cerrar" onClick={() => !saving && onClose()} />
      <div className="relative w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-gray-100 p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-900">Nueva clase contable</h3>
          <button type="button" className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100" onClick={() => !saving && onClose()}>
            <X size={16} />
          </button>
        </div>
        <form onSubmit={handleSave} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Nombre de la clase</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
              placeholder="Ej. Mayorista"
            />
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              className="px-3 py-2 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim()}
              className="px-3 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg disabled:opacity-50"
            >
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** Replica backend `_weighted_avg_cost_per_credit_usd` sobre cuentas full del proveedor. */
function weightedAvgCostPerCreditUsd(accounts, provider) {
  const p = (provider || '').trim()
  let num = 0
  let den = 0
  for (const a of Array.isArray(accounts) ? accounts : []) {
    if (String(a.service_type ?? '').trim().toLowerCase() !== 'full') continue
    if (String(a.provider_name ?? '').trim() !== p) continue
    const cs = Number(a.credits_spent) || 0
    const cp = Number(a.cost_per_credit)
    if (cs <= 0 || !Number.isFinite(cp) || cp <= 0) continue
    num += cs * cp
    den += cs
  }
  if (den <= 0) return null
  return num / den
}


/** Etiqueta del combobox de cliente (sin email). */
function saleClientComboLabel(c, mode) {
  if (!c) return ''
  return mode === 'nombre'
    ? String(c.full_name || c.name || 'Sin nombre')
    : String(c.iptv_username || c.username || 'Sin usuario IPTV')
}

/** Fila desde ``GET /users?role=client`` — proxy listar-clientes Render o usuario portal ERP según ``source``. */
function mapUnifiedClientUserApiRow(u) {
  if (!u || u.id == null) return null
  const fromRenderCatalog = String(u.source ?? '').trim() === 'render_listar_clientes'
  const id = Number(u.id)
  if (!Number.isFinite(id) || id < 1) return null
  const email = String(u.email ?? '').trim()
  const iptv = String(u.iptv_username ?? '').trim()
  const name = String(u.name ?? '').trim() || email || `Cliente #${id}`
  const username = iptv || (email.includes('@') ? email.split('@')[0] : `u${id}`)
  return {
    id,
    name,
    full_name: name,
    email,
    username,
    iptv_username: iptv || username,
    last_iptv_username: iptv || undefined,
    last_iptv_password: undefined,
    __saleBinding: fromRenderCatalog ? 'portal_render_catalog' : 'portal_user',
  }
}

/** Payload de venta: exactamente uno entre ``client_id``, ``user_id`` o ``catalog_render_email``. */
function buildSaleClientBindingPayload(pickedPortalUser, clientIdRaw) {
  const c = String(clientIdRaw ?? '').trim()
  if (pickedPortalUser?.__saleBinding === 'portal_render_catalog') {
    const em = String(pickedPortalUser.email ?? '')
      .trim()
      .toLowerCase()
    if (em && em.includes('@')) return { catalog_render_email: em }
    return {}
  }
  if (pickedPortalUser?.id != null) {
    const uid = Number(pickedPortalUser.id)
    if (Number.isFinite(uid) && uid >= 1) return { user_id: uid }
  }
  if (c) {
    const n = Number(c)
    if (Number.isFinite(n) && n >= 1) return { client_id: n }
  }
  return {}
}

function isPortalUnifiedBinding(b) {
  return b === 'portal_user' || b === 'portal_render_catalog'
}

function formatLotCreationColumn(row) {
  const batch = String(row?.batch_id ?? '').trim()
  const created = formatShortDate(row?.created_at)
  if (batch.length >= 8) return `${batch.slice(0, 8)}… · ${created}`
  if (batch) return `${batch.slice(0, 12)} · ${created}`
  return created
}

function formatExpirationForPackage(packageName, createdAt) {
  const s = calculateExpirationStats(createdAt, packageName, new Date())
  if (!s?.fechaExpiracionEfectiva) return '—'
  return s.fechaExpiracionEfectiva.toLocaleDateString('es-ES', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

function logSaleSubmitError(err, context) {
  const req = err?.config
  const fullUrl =
    req?.baseURL != null && req?.url != null
      ? `${String(req.baseURL).replace(/\/$/, '')}${String(req.url)}`
      : req?.url

  console.error('Error detallado de red / venta:', {
    context,
    message: err?.message,
    code: err?.code,
    name: err?.name,
    responseStatus: err?.response?.status,
    responseData: err?.response?.data,
    requestMethod: req?.method?.toUpperCase(),
    requestURL: fullUrl,
    isAxiosError: err?.isAxiosError,
    isNetworkError:
      !err?.response && (err?.message === 'Network Error' || err?.code === 'ERR_NETWORK'),
  })
}

/** Credenciales en respuesta API (snake_case; tolerancia camelCase si algún proxy las transforma). */
export function screenStockIptvUsername(row) {
  if (!row || typeof row !== 'object') return ''
  const raw = row.iptv_username ?? row.iptvUsername
  if (raw == null) return ''
  return String(raw).trim()
}

export function screenStockIptvPassword(row) {
  if (!row || typeof row !== 'object') return ''
  const raw = row.iptv_password ?? row.iptvPassword
  if (raw == null) return ''
  return String(raw).trim()
}

function CurrencyFlag({ code }) {
  const cur = SALES_CURRENCIES.find((c) => c.code === code)
  return cur ? <span className="mr-1">{cur.flag}</span> : null
}

function fkOrNull(raw) {
  const t = String(raw ?? '').trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 1 ? n : null
}

/** Primera clase por orden de líneas (denormalizada en cabecera API). */
function primaryTransactionClassFromLines(rows) {
  if (!Array.isArray(rows)) return null
  for (const li of rows) {
    const c = fkOrNull(li.transaction_class_id ?? li.clase_id)
    if (c != null) return c
  }
  return null
}

function mergeInvoiceLineMeta(lines, invoiceLinesApi, opts = {}) {
  const skipCredencialesPorBodega = Boolean(opts?.autoWarehouseCredentials)
  const il = Array.isArray(invoiceLinesApi) ? invoiceLinesApi : []
  if (!il.length || !Array.isArray(lines)) return lines
  return lines.map((row, i) => {
    if (!row || typeof row !== 'object') row = emptySaleLine()
    const meta = il[i]
    if (!meta || typeof meta !== 'object') return row
    const tcRaw = meta.transaction_class_id ?? meta.clase_id
    const tc =
      tcRaw != null && tcRaw !== ''
        ? String(tcRaw)
        : row.transaction_class_id
    const desc =
      meta.description != null && String(meta.description).trim() !== ''
        ? String(meta.description).trim()
        : row.description
    if (skipCredencialesPorBodega) {
      return {
        ...row,
        transaction_class_id: tc,
        clase_id: tc,
        asignar_credenciales: false,
        cred_panel_expandido: false,
        iptv_usuario: '',
        iptv_password: '',
        description: desc,
      }
    }
    const tu = meta.iptv_username ?? meta.iptv_usuario
    const tp = meta.iptv_password
    const tuStr = tu != null ? String(tu).trim() : ''
    const tpStr = tp != null ? String(tp).trim() : ''
    const hasCreds = Boolean(tuStr || tpStr)
    return {
      ...row,
      transaction_class_id: tc,
      clase_id: tc,
      asignar_credenciales: hasCreds,
      cred_panel_expandido: Boolean(hasCreds),
      iptv_usuario: tuStr,
      iptv_password: tpStr,
      description: desc,
    }
  })
}

/** Payload API `invoice_lines` (SaleInvoiceLineItem). */
function buildInvoiceLinesPayload(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map((li) => {
    const qty = parseFloat(String(li.qty ?? '').replace(',', '.'))
    const rate = parseFloat(String(li.rate ?? '').replace(',', '.'))
    const cls = fkOrNull(li.transaction_class_id ?? li.clase_id)
    const row = {
      description: String(li.description ?? '').trim() || null,
      qty: Number.isFinite(qty) ? qty : null,
      rate: Number.isFinite(rate) ? rate : null,
      transaction_class_id: cls,
    }
    if (li.asignar_credenciales) {
      const u = String(li.iptv_usuario ?? '').trim()
      const p = String(li.iptv_password ?? '').trim()
      if (u) row.iptv_username = u
      if (p) row.iptv_password = p
    }
    const pk = String(li.productKey ?? '').trim()
    if (
      pk &&
      pk !== 'draft:pending' &&
      pk !== '__loading_inv' &&
      (pk.startsWith('cn:') ||
        pk.startsWith('fc:') ||
        pk.startsWith('cp|') ||
        pk.startsWith('ss:'))
    ) {
      row.inventory_option_key = pk
      row.line_inventory_kind =
        pk.startsWith('cn:') || pk.startsWith('fc:') ? 'full_credits' : 'screen_stock'
    }
    return row
  })
}

/** Memoria de credenciales «crédito normal» (alias API + campos legados). */
function pickClientNormalCreditCreds(clientRow) {
  if (!clientRow) return { user: '', pass: '' }
  const user = String(
    clientRow.last_normal_credit_username ??
      clientRow.lastNormalCreditUsername ??
      clientRow.last_iptv_username ??
      clientRow.lastIptvUsername ??
      '',
  ).trim()
  const pass = String(
    clientRow.last_normal_credit_password ??
      clientRow.lastNormalCreditPassword ??
      clientRow.last_iptv_password ??
      clientRow.lastIptvPassword ??
      '',
  ).trim()
  return { user, pass }
}

/** Payload API multilínea homogéneo (`SaleOperationLine`). */
function buildSaleOperationLinesPayload(rows) {
  if (!Array.isArray(rows)) return []
  const out = []
  for (const li of rows) {
    const pk = String(li.productKey ?? '').trim()
    if (!pk || pk === '__loading_inv' || pk === 'draft:pending') continue
    const qty = parseFloat(String(li.qty ?? '').replace(',', '.'))
    const rate = parseFloat(String(li.rate ?? '').replace(',', '.'))
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(rate) || rate < 0) continue
    const cls = fkOrNull(li.transaction_class_id ?? li.clase_id)
    const row = {
      inventory_option_key: pk,
      qty,
      rate,
      description: String(li.description ?? '').trim() || null,
    }
    if (cls != null) row.clase_id = cls
    if (li.asignar_credenciales) {
      const u = String(li.iptv_usuario ?? '').trim()
      const p = String(li.iptv_password ?? '').trim()
      if (u) row.iptv_username = u
      if (p) row.iptv_password = p
    }
    if (pk.startsWith('cn:')) {
      const nid = parseInt(pk.slice(3), 10)
      if (Number.isFinite(nid) && nid >= 1) row.product_id = nid
    }
    out.push(row)
  }
  return out
}

/** Convierte montos del formulario (admite coma decimal europea). */
function parseDecimalInput(v) {
  const s = String(v ?? '').trim().replace(',', '.')
  if (!s) return NaN
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : NaN
}

/** Omite claves ``null``/``undefined`` del PATCH para no forzar nulos en el backend. */
function stripNullPatchFields(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    out[k] = v
  }
  return out
}

function inventoryUnitCostFromLine(pk, li, metaByKey) {
  const stored = parseDecimalInput(li?.inventory_unit_cost_usd)
  if (Number.isFinite(stored) && stored > 0) return stored
  const meta = metaByKey && typeof metaByKey === 'object' ? metaByKey[pk] : null
  const fromMeta = parseDecimalInput(meta?.reference_cost_usd)
  if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta
  return null
}

/** Claves `cp|{product_id}|{encodeURIComponent(paquete)}|{encodeURIComponent(proveedor)}` del GET /inventory/sales-options */
function parseCpOptionKey(pk) {
  const s = String(pk || '').trim()
  if (!s.startsWith('cp|')) return null
  const parts = s.slice(3).split('|')
  if (parts.length < 3) return null
  const productId = parseInt(parts[0], 10)
  if (!Number.isFinite(productId) || productId < 1) return null
  const packageLabel = decodeURIComponent(parts[1] || '')
  const provider = decodeURIComponent(parts[2] || '')
  return { productId, packageLabel, provider }
}

/** Descripción inicial por línea según inventario seleccionado (evita texto de producto previo). */
function defaultInvoiceLineDescriptionFromKey(pk, metaByKey) {
  const k = String(pk ?? '').trim()
  if (!k || k === 'draft:pending') return ''
  const m = metaByKey && typeof metaByKey === 'object' ? metaByKey[k] : null
  if (m?.kind === 'cn' || k.startsWith('cn:')) {
    const pname = String(m?.product_name ?? '').trim()
    if (pname) return pname
    return String(m?.label ?? '').trim() || ''
  }
  if (m?.kind === 'cp' || k.startsWith('cp|')) {
    const pname = String(m?.product_name ?? '').trim()
    const pkg = String(m?.package_label ?? '').trim()
    if (pname && pkg) return `${pname} — ${pkg}`
    if (pname) return pname
    if (pkg) return pkg
    return String(m?.label ?? '').trim() || ''
  }
  if (m?.kind === 'ss' || k.startsWith('ss:')) {
    return String(m?.label ?? '').trim() || ''
  }
  if (k.startsWith('fc:')) {
    const prov = decodeURIComponent(k.slice(3)).trim()
    return prov ? `Créditos completos — ${prov}` : ''
  }
  return ''
}

/** Recompone ``productKey`` desde ``invoice_lines`` (facturas mixtas / multilínea). */
function inferProductKeyFromInvoiceLine(il, sale, fifoCpFallback) {
  if (!il || typeof il !== 'object') return ''
  const persisted =
    typeof il.inventory_option_key === 'string' ? il.inventory_option_key.trim() : ''
  if (persisted) return persisted
  const lik = String(il.line_inventory_kind || '').trim().toLowerCase()

  const salePid = sale?.product_id != null ? Number(sale.product_id) : null
  const saleProv = String(sale?.inventory_provider || '').trim()
  const saleSsIdRaw = sale?.screen_stock_id
  const ssIdTrim =
    saleSsIdRaw != null && saleSsIdRaw !== ''
      ? String(saleSsIdRaw).trim()
      : ''

  const invUnitsRaw =
    sale?.inventory_screen_units != null ? Number(sale.inventory_screen_units) : 1
  const invUnits =
    Number.isFinite(invUnitsRaw) && Math.floor(invUnitsRaw) >= 1
      ? Math.floor(invUnitsRaw)
      : 1

  const hint = fifoCpFallback != null ? String(fifoCpFallback).trim() : ''

  if (lik === 'full_credits') {
    if (salePid != null && Number.isFinite(salePid) && salePid >= 1) return `cn:${salePid}`
    return saleProv ? `fc:${saleProv}` : ''
  }
  if (lik === 'screen_stock') {
    const qtyParsed = parseFloat(String(il.qty ?? '').replace(',', '.'))
    const qtyInt =
      Number.isFinite(qtyParsed) && qtyParsed >= 1 ? Math.round(qtyParsed) : 1
    const hintCp = hint.startsWith('cp|') ? hint : ''
    if (hintCp) return hintCp
    const useSs =
      qtyInt === 1 &&
      invUnits === 1 &&
      ssIdTrim !== '' &&
      !hintCp
    return useSs ? `ss:${ssIdTrim}` : hintCp || ''
  }
  return ''
}

/** Una fila UI por elemento de ``invoice_lines`` (orden servidor). */
function editableRowsFromSaleInvoiceLines(saleRecord, ils, fifoCpFallback) {
  const sidBase = saleRecord?.id != null ? String(saleRecord.id) : 'x'
  if (!Array.isArray(ils) || ils.length === 0) return [emptySaleLine()]
  const out = []
  for (let i = 0; i < ils.length; i += 1) {
    const il = ils[i]
    if (!il || typeof il !== 'object') continue
    const lik = String(il.line_inventory_kind || '').trim().toLowerCase()
    const hintForInfer = lik === 'full_credits' ? '' : fifoCpFallback
    const productKey = inferProductKeyFromInvoiceLine(il, saleRecord, hintForInfer || undefined)

    const qtyParsed = parseFloat(String(il.qty ?? '').replace(',', '.'))
    const qty =
      Number.isFinite(qtyParsed) && qtyParsed > 0
        ? Math.abs(qtyParsed - Math.round(qtyParsed)) < 1e-6
          ? String(Math.round(qtyParsed))
          : String(qtyParsed)
        : '1'

    const rateParsed = parseFloat(String(il.rate ?? '').replace(',', '.'))
    const rate = Number.isFinite(rateParsed) && rateParsed >= 0 ? String(rateParsed) : ''

    const tcRaw = fkOrNull(il.transaction_class_id ?? il.clase_id)
    const transaction_class_id =
      tcRaw != null ? String(tcRaw) : ''

    const descRaw =
      il.description != null ? String(il.description).trim().replace(/\s+/g, ' ') : ''
    const description = descRaw

    const skipWarehouseCreds = lik === 'screen_stock'
    let asignar_credenciales = false
    let cred_panel_expandido = false
    let iptv_usuario = ''
    let iptv_password = ''
    if (!skipWarehouseCreds) {
      const tuMeta = il.iptv_username ?? il.iptv_usuario
      const tpMeta = il.iptv_password
      iptv_usuario =
        tuMeta != null ? String(tuMeta).trim() : ''
      iptv_password =
        tpMeta != null ? String(tpMeta).trim() : ''
      const hasCreds = Boolean(iptv_usuario || iptv_password)
      asignar_credenciales = hasCreds
      cred_panel_expandido = hasCreds
    }

    out.push({
      id: `edit-line-${sidBase}-${i}`,
      productKey,
      description,
      qty,
      rate,
      clase_id: transaction_class_id,
      transaction_class_id,
      asignar_credenciales,
      cred_panel_expandido,
      iptv_usuario,
      iptv_password,
    })
  }
  return out.length ? out : [emptySaleLine()]
}

const RECEIPT_MAX_BYTES = 20 * 1024 * 1024

function emptySaleLine() {
  return {
    id: `ln_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    productKey: '',
    description: '',
    qty: '1',
    rate: '',
    clase_id: '',
    transaction_class_id: '',
    asignar_credenciales: false,
    cred_panel_expandido: true,
    iptv_usuario: '',
    iptv_password: '',
  }
}

/** Reparte `total` en partes proporcionales a `weights` con redondeo y ajuste en la última partida. */
function splitProportionalDecimalParts(total, weights) {
  const tgt = Math.round(Number(total) * 10000) / 10000
  const s = weights.reduce((a, b) => a + b, 0)
  if (s <= 0 || !Number.isFinite(tgt)) return weights.map(() => 0)
  const raw = weights.map((w) => (tgt * w) / s)
  const rounded = raw.map((x) => Math.round(x * 100) / 100)
  let drift = Math.round((tgt - rounded.reduce((a, b) => a + b, 0)) * 100) / 100
  if (Math.abs(drift) >= 0.005 && rounded.length) {
    rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1] + drift) * 100) / 100
  }
  return rounded
}

function receiptLooksPdf(file, urlPath) {
  if (file?.type === 'application/pdf') return true
  return String(urlPath || '')
    .toLowerCase()
    .endsWith('.pdf')
}

/** URL absoluta para evidencia adjunta (/uploads/… o ya absoluto). */
function absMediaUrl(urlPath) {
  if (!urlPath) return ''
  const s = String(urlPath).trim()
  if (!s || /^https?:\/\//i.test(s)) return s
  const origin = salesApiOrigin()
  return `${origin}${s.startsWith('/') ? '' : '/'}${s}`
}

export default function NuevaVentaModal({
  onClose,
  onSuccess,
  onToast,
  initialSale = null,
  prefillClientId = null,
  prefillDepositAccountId = null,
  /** Solo lectura: ventas archivadas (rechazadas / canceladas / anuladas). */
  readOnlyMode = false,
}) {
  const { openNewClient, openRechargeModal, openReceivePayment } = useModal()
  const {
    loadFinished,
    snapshotFor,
    combinedProvidersList,
    refreshInventoryData,
    screens,
    accounts,
  } = useInventoryData()

  const INITIAL = useMemo(
    () => ({
      client_id: '',
      provider: '',
      service_value: SERVICE_EMPTY,
      detail_package: '',
      selected_screen_stock_id: '',
      credits_quantity: '',
      currency: 'USD',
      exchange_rate: '1',
      local_amount: '',
      transaction_class_id: '',
      payment_method_id: '',
      deposit_account_id: '',
      notes: '',
      tag_ids: [],
      amount_paid: '',
    }),
    [],
  )

  const [form, setForm] = useState(INITIAL)
  const [linkedPayments, setLinkedPayments] = useState([])
  const [pendingReviewPayments, setPendingReviewPayments] = useState([])
  const [declaredDepositStr, setDeclaredDepositStr] = useState('')
  const declaredDepositInitializedRef = useRef(false)
  const [detailBalanceDue, setDetailBalanceDue] = useState(null)

  const amountPaidDirtyRef = useRef(false)
  const newClassTargetLineIdRef = useRef(null)

  const isSyntheticLedgerRecharge = Boolean(initialSale?.__clientDetailSyntheticRecharge)
  const isEditing = Boolean(initialSale?.id) || isSyntheticLedgerRecharge
  const saleIsViewOnly = Boolean(readOnlyMode)

  const isLegacyPending = useMemo(() => {
    if (isSyntheticLedgerRecharge) return false
    if (!initialSale?.id) return false
    const ch = String(initialSale.inventory_channel ?? '').trim()
    if (ch === 'full_credits' || ch === 'screen_stock') return false
    if (initialSale.screen_stock_id) return false
    const prov = String(initialSale.inventory_provider ?? '').trim()
    const cq = initialSale.credits_quantity
    if (cq != null && prov) return false
    return true
  }, [initialSale, isSyntheticLedgerRecharge])

  const mixedInitialSale = useMemo(
    () => isEditing && String(initialSale?.inventory_channel ?? '').trim() === 'mixed',
    [isEditing, initialSale?.inventory_channel],
  )

  const [clients, setClients] = useState([])
  const [portalPickRows, setPortalPickRows] = useState([])
  const [portalPickLoading, setPortalPickLoading] = useState(false)
  const [portalPickError, setPortalPickError] = useState(null)
  const [portalPickRetryKey, setPortalPickRetryKey] = useState(0)
  const [pickedPortalUser, setPickedPortalUser] = useState(null)
  const [debouncedClientPickQuery, setDebouncedClientPickQuery] = useState('')
  const [clientSearchMode, setClientSearchMode] = useState('nombre')
  const [clientPickerOpen, setClientPickerOpen] = useState(false)
  const [clientPickerQuery, setClientPickerQuery] = useState('')
  const clientPickerInputFocusedRef = useRef(false)
  const clientPickerRootRef = useRef(null)
  const skipClientPickerBlurRef = useRef(false)
  const lastNormalCredAutofillSigRef = useRef('')

  const [transactionClasses, setTransactionClasses] = useState([])
  const [newClassModalOpen, setNewClassModalOpen] = useState(false)

  const [paymentMethods, setPaymentMethods] = useState([])
  const [depositAccounts, setDepositAccounts] = useState([])
  const [selectedPaymentMethodIds, setSelectedPaymentMethodIds] = useState([])
  const [selectedDepositAccountIds, setSelectedDepositAccountIds] = useState([])
  /** Evita sobrescribir tasa al hidratar venta existente. */
  const skipCurrencyRateFetchRef = useRef(false)

  const [saleTagsReloadKey, setSaleTagsReloadKey] = useState(0)
  const bumpSaleTagsReload = useCallback(() => {
    setSaleTagsReloadKey((x) => x + 1)
  }, [])
  const [tagsAdminOpen, setTagsAdminOpen] = useState(false)

  /** Líneas factura (QuickBooks); en legado sin inventario no se usan. */
  const [lineItems, setLineItems] = useState(() => [emptySaleLine()])
  /** Vista previa FIFO (claves cp|…) — credenciales de la siguiente unidad sin reservar. */
  const [fifoCpCredPeekByPk, setFifoCpCredPeekByPk] = useState(() => ({}))
  const [inventorySalesOpts, setInventorySalesOpts] = useState(null)
  const [inventorySalesOptsLoading, setInventorySalesOptsLoading] = useState(false)

  /** Datos POST /inventory/screens/ + salePackage (no se envían al backend hasta Registrar venta). */
  const [draftRecharge, setDraftRecharge] = useState(null)

  const [detailScreensRows, setDetailScreensRows] = useState([])
  const [detailScreensLoading, setDetailScreensLoading] = useState(false)
  const [error, setError] = useState('')
  const [noStock, setNoStock] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [receiptFile, setReceiptFile] = useState(null)
  const [receiptServerCleared, setReceiptServerCleared] = useState(false)

  const receiptBlobImgUrl = useMemo(() => {
    if (!receiptFile || receiptFile.type === 'application/pdf') return null
    return URL.createObjectURL(receiptFile)
  }, [receiptFile])

  useEffect(() => {
    return () => {
      if (receiptBlobImgUrl) URL.revokeObjectURL(receiptBlobImgUrl)
    }
  }, [receiptBlobImgUrl])

  const catalogReady = loadFinished
  const inventorySnapshot = snapshotFor(form.provider)

  const isDetailScreens = form.service_value === DETAIL_SCREENS_VALUE
  const detailPackageTrim = String(form.detail_package ?? '').trim()
  const selectedScreenNum = Number(form.selected_screen_stock_id)

  const detailPackageOptions = useMemo(() => {
    const p = (form.provider || '').trim()
    if (!p || !catalogReady) return []
    const pv = p.toLowerCase()
    const pkgs = new Set()
    for (const row of screens || []) {
      if (!row || row.status !== 'free') continue
      if (row.sale_id != null && row.sale_id !== '') continue
      if (String(row.provider ?? '').trim().toLowerCase() !== pv) continue
      const pkg = String(row.package || '').trim()
      if (pkg) pkgs.add(pkg)
    }
    const ordered = packageCatalogOrderedForSale(screens, p)
    const out = []
    for (const x of ordered) {
      if (pkgs.has(x)) out.push(x)
    }
    for (const x of [...pkgs].sort((a, b) => a.localeCompare(b, 'es'))) {
      if (!out.includes(x)) out.push(x)
    }
    return out
  }, [form.provider, catalogReady, screens])

  const nuevaVentaDetailPackageSelectOptions = useMemo(
    () => [
      { value: '', label: 'Selecciona paquete…' },
      ...detailPackageOptions.map((pkg) => ({ value: pkg, label: pkg })),
    ],
    [detailPackageOptions],
  )

  useEffect(() => {
    if (!isDetailScreens || !detailPackageTrim || !(form.provider || '').trim()) {
      setDetailScreensRows([])
      setDetailScreensLoading(false)
      return undefined
    }
    let cancelled = false
    setDetailScreensLoading(true)
    api
      .get('/api/v1/inventory/screens/', {
        params: {
          status: 'free',
          provider: String(form.provider).trim(),
          package: detailPackageTrim,
        },
      })
      .then(({ data }) => {
        if (cancelled) return
        const list = Array.isArray(data) ? data : []
        setDetailScreensRows(
          list.filter(
            (r) =>
              r &&
              r.status === 'free' &&
              (r.sale_id == null || r.sale_id === ''),
          ),
        )
      })
      .catch(() => {
        if (!cancelled) setDetailScreensRows([])
      })
      .finally(() => {
        if (!cancelled) setDetailScreensLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isDetailScreens, form.provider, detailPackageTrim])

  useEffect(() => {
    if (!isDetailScreens || !form.selected_screen_stock_id) return
    const sid = Number(form.selected_screen_stock_id)
    if (!Number.isFinite(sid) || sid < 1) return
    if (!detailScreensRows.length) return
    const ok = detailScreensRows.some((r) => Number(r.id) === sid)
    if (!ok) setForm((prev) => ({ ...prev, selected_screen_stock_id: '' }))
  }, [detailScreensRows, isDetailScreens, form.selected_screen_stock_id])

  const inventoryLoadFailed =
    catalogReady && !!form.provider?.trim() && inventorySnapshot.showLoadError

  const creditsAvailableForProvider = useMemo(() => {
    if (!form.provider?.trim() || !catalogReady || inventoryLoadFailed) return null
    const n = Number(inventorySnapshot.totalCredits)
    if (Number.isNaN(n)) return null
    return Math.max(0, n)
  }, [form.provider, catalogReady, inventoryLoadFailed, inventorySnapshot.totalCredits])

  const isFullCredits = form.service_value === FULL_CREDITS_VALUE
  const isDraftScreenSale =
    Boolean(draftRecharge) && form.service_value === DRAFT_PENDING_SCREEN

  const localAmount = parseDecimalInput(form.local_amount) || 0
  const exchangeRate = parseDecimalInput(form.exchange_rate) || 1
  const usdEquiv = exchangeRate > 0 ? localAmount / exchangeRate : 0

  const currencySelectOptions = useMemo(() => {
    const raw = String(form.currency ?? '').trim()
    const code = raw ? normalizeCurrencyCode(raw, 'USD') : ''
    if (!code || SALES_CURRENCIES.some((c) => c.code === code)) return SALES_CURRENCIES
    return [{ code, label: `${code} — moneda actual`, flag: '🏷️' }, ...SALES_CURRENCIES]
  }, [form.currency])

  /** Factura QuickBooks (multilínea); ventas sin inventario ERP siguen en modo simple. */
  const showInvoiceLayout = !(isEditing && isLegacyPending)

  const salesInventoryMetaByKey = useMemo(() => {
    const meta = {}
    const d = inventorySalesOpts
    if (!d || typeof d !== 'object') return meta
    for (const n of Array.isArray(d.normal_credit_options) ? d.normal_credit_options : []) {
      if (n?.option_key != null) meta[String(n.option_key)] = { ...n, kind: 'cn' }
    }
    for (const p of Array.isArray(d.screen_package_options) ? d.screen_package_options : []) {
      if (p?.option_key != null) meta[String(p.option_key)] = { ...p, kind: 'cp' }
    }
    for (const s of Array.isArray(d.screen_pick_options) ? d.screen_pick_options : []) {
      if (s?.option_key != null) meta[String(s.option_key)] = { ...s, kind: 'ss' }
    }
    return meta
  }, [inventorySalesOpts])

  const normalCredLinesAutofillSig = useMemo(
    () =>
      `${pickedPortalUser?.id ?? ''}|${form.client_id ?? ''}|${(Array.isArray(lineItems) ? lineItems : [])
        .map((li) => String(li?.productKey || '').trim())
        .join('\u00bb')}`,
    [pickedPortalUser?.id, form.client_id, lineItems],
  )

  const fifoCpPeekTrigger = useMemo(() => {
    const keys = new Set()
    for (const li of Array.isArray(lineItems) ? lineItems : []) {
      const pk = String(li?.productKey || '').trim()
      if (pk.startsWith('cp|')) keys.add(pk)
    }
    return [...keys].sort().join('\x1f')
  }, [lineItems])

  useEffect(() => {
    const pks = fifoCpPeekTrigger ? fifoCpPeekTrigger.split('\x1f').filter(Boolean) : []
    let cancelled = false

    setFifoCpCredPeekByPk((prev) => {
      const allowed = new Set(pks)
      const next = {}
      for (const pk of allowed) {
        next[pk] = { loading: true, username: '', password: '', error: null }
      }
      return next
    })

    async function fetchPk(pk) {
      const parsed = parseCpOptionKey(pk)
      const pid = parsed?.productId
      if (!Number.isFinite(pid) || pid < 1) {
        setFifoCpCredPeekByPk((prev) => ({
          ...prev,
          [pk]: { loading: false, username: '', password: '', error: null },
        }))
        return
      }
      setFifoCpCredPeekByPk((prev) => ({
        ...prev,
        [pk]: { loading: true, username: '', password: '', error: null },
      }))
      try {
        const { data } = await api.get(`/api/v1/inventory/next-screen/${pid}`)
        if (cancelled) return
        setFifoCpCredPeekByPk((prev) => ({
          ...prev,
          [pk]: {
            loading: false,
            username: String(data?.iptv_username ?? '').trim(),
            password: String(data?.iptv_password ?? '').trim(),
            error: null,
          },
        }))
      } catch (err) {
        if (cancelled) return
        console.error('[NuevaVentaModal] next-screen peek failed', {
          product_id: pid,
          status: err?.response?.status,
          detail: err?.response?.data,
          message: err?.message,
        })
        const detail = err?.response?.data?.detail
        const msg =
          typeof detail === 'string'
            ? detail
            : err?.response?.status === 404
              ? 'No hay unidad disponible en bodega para este producto.'
              : 'No se pudo cargar la vista previa.'
        setFifoCpCredPeekByPk((prev) => ({
          ...prev,
          [pk]: { loading: false, username: '', password: '', error: msg },
        }))
      }
    }

    void Promise.all(pks.map((pk) => fetchPk(pk)))
    return () => {
      cancelled = true
    }
  }, [fifoCpPeekTrigger])

  useEffect(() => {
    if (saleIsViewOnly || !showInvoiceLayout) return
    if (!salesInventoryMetaByKey || typeof salesInventoryMetaByKey !== 'object') return
    setLineItems((prev) => {
      let changed = false
      const next = prev.map((li) => {
        const pk = String(li?.productKey || '').trim()
        if (!pk.startsWith('cp|') && !pk.startsWith('ss:')) return li
        const existing = parseDecimalInput(li?.inventory_unit_cost_usd)
        if (Number.isFinite(existing) && existing > 0) return li
        const unitCost = inventoryUnitCostFromLine(pk, li, salesInventoryMetaByKey)
        if (unitCost == null || unitCost <= 0) return li
        changed = true
        return { ...li, inventory_unit_cost_usd: String(unitCost) }
      })
      return changed ? next : prev
    })
  }, [salesInventoryMetaByKey, showInvoiceLayout, saleIsViewOnly])

  useEffect(() => {
    if (!showInvoiceLayout || isDraftScreenSale) return
    const cSel =
      pickedPortalUser ??
      (String(form.client_id ?? '').trim()
        ? clients.find((cl) => cl?.id != null && String(cl.id) === String(form.client_id))
        : null)
    if (!cSel) return

    const { user: uMem, pass: pMem } = pickClientNormalCreditCreds(cSel)
    if (!uMem && !pMem) {
      lastNormalCredAutofillSigRef.current = ''
      return
    }

    const sig = normalCredLinesAutofillSig
    const pipe = sig.indexOf('|')
    const tail = pipe >= 0 ? sig.slice(pipe + 1) : ''
    const hasNormalLine = tail
      .split('\u00bb')
      .some((pk) => pk.startsWith('cn:') || pk.startsWith('fc:'))
    if (!hasNormalLine) {
      lastNormalCredAutofillSigRef.current = ''
      return
    }

    if (sig === lastNormalCredAutofillSigRef.current) return
    lastNormalCredAutofillSigRef.current = sig

    setLineItems((prev) =>
      prev.map((li) => {
        const pk = String(li?.productKey || '').trim()
        if (!pk.startsWith('cn:') && !pk.startsWith('fc:')) return li
        return {
          ...li,
          asignar_credenciales: true,
          cred_panel_expandido: true,
          iptv_usuario: uMem,
          iptv_password: pMem,
        }
      }),
    )
  }, [normalCredLinesAutofillSig, pickedPortalUser, form.client_id, clients, showInvoiceLayout, isDraftScreenSale])

  useEffect(() => {
    if (!showInvoiceLayout) {
      setInventorySalesOpts(null)
      return undefined
    }
    let cancelled = false
    setInventorySalesOptsLoading(true)
    const params = {}
    if (isEditing && initialSale?.id != null && !isLegacyPending) {
      params.sale_id = initialSale.id
    }
    api
      .get('/api/v1/inventory/sales-options', { params })
      .then(({ data }) => {
        if (cancelled) return
        setInventorySalesOpts(data && typeof data === 'object' ? data : {})
      })
      .catch(() => {
        if (!cancelled) setInventorySalesOpts({})
      })
      .finally(() => {
        if (!cancelled) setInventorySalesOptsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [showInvoiceLayout, isEditing, initialSale?.id, isLegacyPending])

  const linesSubtotal = useMemo(() => {
    let t = 0
    const list = Array.isArray(lineItems) ? lineItems : []
    for (const li of list) {
      if (!li || typeof li !== 'object') continue
      const q = parseFloat(String(li.qty ?? '').replace(',', '.'))
      const r = parseFloat(String(li.rate ?? '').replace(',', '.'))
      if (Number.isFinite(q) && Number.isFinite(r)) t += q * r
    }
    return Math.round(t * 100) / 100
  }, [lineItems])

  /** Totales de factura sincronizan `local_amount`. El depósito (`amount_paid`) solo se autocompleta al crear venta nueva — nunca en edición. */
  useEffect(() => {
    if (saleIsViewOnly || isLegacyPending || !showInvoiceLayout) return
    setForm((prev) => {
      const la = linesSubtotal > 0 ? linesSubtotal.toFixed(2) : ''
      const next = { ...prev, local_amount: la }
      if (
        !isEditing &&
        !amountPaidDirtyRef.current &&
        linesSubtotal > 0
      ) {
        next.amount_paid = linesSubtotal.toFixed(2)
      }
      return next
    })
  }, [linesSubtotal, isLegacyPending, showInvoiceLayout, saleIsViewOnly, isEditing])

  const invoiceProductOptions = useMemo(() => {
    if (!showInvoiceLayout) return []

    const rows = []
    const provs =
      Array.isArray(combinedProvidersList) && combinedProvidersList.length
        ? combinedProvidersList
        : ['Flujo', 'Stella']

    if (inventorySalesOptsLoading || inventorySalesOpts == null) {
      rows.push({
        value: '__loading_inv',
        label: 'Cargando opciones de inventario…',
        disabled: true,
        sectionHeader: true,
      })
      return rows
    }

    const data = inventorySalesOpts

    rows.push({
      value: '__hdr_cn',
      label: 'CRÉDITOS NORMALES',
      disabled: true,
      sectionHeader: true,
    })
    const normals = Array.isArray(data.normal_credit_options) ? data.normal_credit_options : []
    for (const n of normals) {
      if (!n || typeof n !== 'object') continue
      rows.push({
        value: n.option_key,
        label: n.label || String(n.option_key),
        disabled: Boolean(n.disabled),
      })
    }

    rows.push({
      value: '__hdr_cp',
      label: 'CRÉDITOS POR PANTALLA (AL DETALLE)',
      disabled: true,
      sectionHeader: true,
    })
    const pkgs = Array.isArray(data.screen_package_options) ? data.screen_package_options : []
    for (const p of pkgs) {
      if (!p || typeof p !== 'object') continue
      rows.push({
        value: p.option_key,
        label: p.label || String(p.option_key),
        disabled: Boolean(p.disabled),
      })
    }

    const picks = Array.isArray(data.screen_pick_options) ? data.screen_pick_options : []
    if (picks.length) {
      rows.push({
        value: '__hdr_ss',
        label: 'Pantalla vinculada (esta venta)',
        disabled: true,
        sectionHeader: true,
      })
      for (const s of picks) {
        if (!s || typeof s !== 'object') continue
        rows.push({
          value: s.option_key,
          label: s.label || String(s.option_key),
          disabled: Boolean(s.disabled),
        })
      }
    }

    rows.push({
      value: '__hdr_fc',
      label: 'Saldo pooled por proveedor (sin catálogo)',
      disabled: true,
      sectionHeader: true,
    })
    for (const p of provs) {
      const snap = snapshotFor(p)
      const n = Number(snap.totalCredits)
      const stockLabel = Number.isFinite(n)
        ? n.toLocaleString('es-ES', { maximumFractionDigits: 4 })
        : '—'
      const zeroStock = catalogReady && Number.isFinite(n) && n <= 0
      rows.push({
        value: `fc:${p}`,
        label: `Créditos completos — ${p} (Disponible: ${stockLabel})${zeroStock ? ' · sin saldo' : ''}`,
        disabled: zeroStock,
      })
    }

    if (
      draftRecharge &&
      !isEditing &&
      (form.provider || '').trim() === String(draftRecharge.provider || '').trim()
    ) {
      rows.push({
        value: '__hdr_dr',
        label: 'Recarga al inventario',
        disabled: true,
        sectionHeader: true,
      })
      rows.push({
        value: 'draft:pending',
        label: `${draftRecharge.salePackage || 'Paquete'} (Recarga pendiente en borrador)`,
        disabled: false,
      })
    }

    const pk0 = String(lineItems[0]?.productKey || '').trim()
    if (pk0.startsWith('fc:') && !rows.some((r) => String(r.value) === pk0)) {
      rows.push({
        value: pk0,
        label: `${pk0.slice(3)} — saldo pooled (valor de la venta)`,
        disabled: false,
      })
    }

    return rows
  }, [
    showInvoiceLayout,
    inventorySalesOpts,
    inventorySalesOptsLoading,
    combinedProvidersList,
    snapshotFor,
    catalogReady,
    draftRecharge,
    isEditing,
    form.provider,
    lineItems,
  ])

  useEffect(() => {
    if (saleIsViewOnly || isLegacyPending || !showInvoiceLayout) return
    if (isDraftScreenSale) return
    const li = lineItems[0]
    const pk = String(li?.productKey || '').trim()
    if (!pk || pk === 'draft:pending') return

    if (pk.startsWith('cn:')) {
      const meta = salesInventoryMetaByKey[pk]
      const provFromRow = meta?.iptv_provider ? String(meta.iptv_provider).trim() : ''
      setForm((prev) => ({
        ...prev,
        provider: provFromRow || prev.provider,
        service_value: FULL_CREDITS_VALUE,
        credits_quantity: li.qty || '1',
        detail_package: '',
        selected_screen_stock_id: '',
      }))
    } else if (pk.startsWith('cp|')) {
      const parsed = parseCpOptionKey(pk)
      if (!parsed) return
      setForm((prev) => ({
        ...prev,
        provider: parsed.provider || prev.provider,
        service_value: DETAIL_SCREENS_VALUE,
        detail_package: parsed.packageLabel || '',
        selected_screen_stock_id: '',
        credits_quantity: '',
      }))
    } else if (pk.startsWith('fc:')) {
      const provider = pk.slice(3)
      setForm((prev) => ({
        ...prev,
        provider,
        service_value: FULL_CREDITS_VALUE,
        credits_quantity: li.qty || '1',
        detail_package: '',
        selected_screen_stock_id: '',
      }))
    } else if (pk.startsWith('ss:')) {
      const sid = pk.slice(3)
      const row = (screens || []).find((s) => String(s.id) === sid)
      const meta = salesInventoryMetaByKey[pk]
      const provMeta = meta?.iptv_provider ? String(meta.iptv_provider).trim() : ''
      const pkgMeta = meta?.package_label ? String(meta.package_label).trim() : ''
      setForm((prev) => ({
        ...prev,
        provider:
          (row ? String(row.provider || '').trim() : '') || provMeta || prev.provider,
        service_value: DETAIL_SCREENS_VALUE,
        detail_package: (row ? String(row.package || '').trim() : '') || pkgMeta || prev.detail_package,
        selected_screen_stock_id: sid,
        credits_quantity: '',
      }))
    }
  }, [
    lineItems,
    screens,
    salesInventoryMetaByKey,
    isLegacyPending,
    showInvoiceLayout,
    isDraftScreenSale,
    saleIsViewOnly,
  ])

  const line0InventoryPk = String(lineItems[0]?.productKey || '').trim()
  const fifoCpLine0 = line0InventoryPk.startsWith('cp|')

  const inventoryRequiredIncomplete = saleIsViewOnly
    ? false
    : showInvoiceLayout
    ? (Array.isArray(lineItems) ? lineItems : []).length < 1 ||
      (Array.isArray(lineItems) ? lineItems : []).some((li) => {
        if (!li || typeof li !== 'object') return true
        const pk = String(li.productKey || '').trim()
        if (!pk) return true
        if (pk === '__loading_inv') return true
        if (pk === 'draft:pending' && !draftRecharge) return true
        const q = parseFloat(String(li.qty ?? '').replace(',', '.'))
        const r = parseFloat(String(li.rate ?? '').replace(',', '.'))
        if (!Number.isFinite(q) || q <= 0) return true
        if (!Number.isFinite(r) || r < 0) return true
        return false
      }) ||
      (isDetailScreens &&
        !fifoCpLine0 &&
        !mixedInitialSale &&
        (!detailPackageTrim ||
          !Number.isFinite(selectedScreenNum) ||
          selectedScreenNum < 1))
    : (!isEditing || !isLegacyPending) &&
      (!form.provider?.trim() ||
        !form.service_value ||
        form.service_value === SERVICE_EMPTY ||
        form.service_value === RECHARGE_SCREENS_ACTION ||
        (form.service_value === DRAFT_PENDING_SCREEN && !draftRecharge) ||
        (form.service_value === DETAIL_SCREENS_VALUE &&
          (!detailPackageTrim ||
            !Number.isFinite(selectedScreenNum) ||
            selectedScreenNum < 1)))


  const catalogBusyEarly = !catalogReady
  const nuevaVentaServiceSelectOptions = useMemo(() => {
    const pv = (form.provider || '').trim()
    const creditsKnownInner =
      creditsAvailableForProvider !== null && creditsAvailableForProvider !== undefined
    if (!pv) {
      return [{ value: SERVICE_EMPTY, label: 'Selecciona primero el proveedor…' }]
    }

    const rows = []
    rows.push({ value: SERVICE_EMPTY, label: 'Selecciona servicio…' })
    rows.push({ value: '__hdr_mayorista', label: 'Mayorista', disabled: true })

    const creditsTail =
      catalogBusyEarly || !creditsKnownInner
        ? ' — cargando saldo…'
        : ` — ${(creditsAvailableForProvider ?? 0).toLocaleString('es-ES', {
            maximumFractionDigits: 4,
          })} disponibles`

    rows.push({
      value: FULL_CREDITS_VALUE,
      label: `Cuentas completas (Créditos)${creditsTail}`,
      disabled: creditsKnownInner && creditsAvailableForProvider <= 0,
    })

    rows.push({ value: '__hdr_detalle', label: 'Al detalle (pantallas)', disabled: true })

    if (catalogBusyEarly) {
      rows.push({ value: '__loading__', label: 'Cargando bodega…', disabled: true })
    } else {
      rows.push({
        value: DETAIL_SCREENS_VALUE,
        label: `Pantalla al detalle (elige paquete y fila debajo)${
          detailPackageOptions.length === 0 && !draftRecharge ? ' — sin stock libre' : ''
        }`,
        disabled: detailPackageOptions.length === 0 && !draftRecharge,
      })
      if (
        draftRecharge &&
        !isEditing &&
        (form.provider || '').trim() === String(draftRecharge.provider || '').trim()
      ) {
        rows.push({
          value: DRAFT_PENDING_SCREEN,
          label: `${draftRecharge.salePackage || 'Paquete'} (Recarga pendiente en borrador)`,
        })
      }
      if (!isEditing) {
        rows.push({
          value: RECHARGE_SCREENS_ACTION,
          label: '+ Recargar nuevas pantallas',
        })
      }
    }

    return rows
  }, [
    catalogBusyEarly,
    creditsAvailableForProvider,
    detailPackageOptions.length,
    draftRecharge,
    form.provider,
    isEditing,
  ])

  const estimatedInventoryCostUsd = useMemo(() => {
    const p = (form.provider || '').trim()
    if (!p || !catalogReady || inventoryLoadFailed) return null

    if (isFullCredits) {
      const qty = parseDecimalInput(form.credits_quantity)
      if (!qty || qty <= 0 || Number.isNaN(qty)) return null
      const unit = weightedAvgCostPerCreditUsd(accounts, p)
      if (unit == null || unit <= 0) return null
      return unit * qty
    }

    if (isDraftScreenSale && draftRecharge?.lines?.length) {
      const salePkg = String(draftRecharge.salePackage || '').trim()
      const line =
        draftRecharge.lines.find((l) => String(l.package || '').trim() === salePkg) ??
        draftRecharge.lines[0]
      const c = parseDecimalInput(line?.cost_per_package)
      if (!Number.isFinite(c) || c <= 0) return null
      return c
    }

    if (isDetailScreens && detailPackageTrim && !isDraftScreenSale) {
      const sid = selectedScreenNum
      const picked =
        Number.isFinite(sid) && sid >= 1
          ? detailScreensRows.find((r) => Number(r.id) === sid) ??
            (screens || []).find((s) => s && Number(s.id) === sid)
          : null
      if (picked) {
        const c = parseDecimalInput(picked.cost_per_package)
        if (Number.isFinite(c) && c > 0) return c
      }
      if (
        isEditing &&
        initialSale?.screen_stock_id &&
        Number(initialSale.screen_stock_id) === sid &&
        String(initialSale.inventory_provider ?? '').trim() === p &&
        String(initialSale.inventory_package ?? '').trim() === detailPackageTrim
      ) {
        const held = (screens || []).find((s) => s && s.id === initialSale.screen_stock_id)
        const ch = parseDecimalInput(held?.cost_per_package)
        if (Number.isFinite(ch) && ch > 0) return ch
      }
      const costs = detailScreensRows
        .map((r) => parseDecimalInput(r.cost_per_package))
        .filter((c) => Number.isFinite(c) && c > 0)
      if (costs.length) return Math.min(...costs)
      return null
    }

    if (showInvoiceLayout) {
      let total = 0
      let hasCost = false
      for (const li of Array.isArray(lineItems) ? lineItems : []) {
        if (!li || typeof li !== 'object') continue
        const pk = String(li.productKey || '').trim()
        if (!pk.startsWith('cp|') && !pk.startsWith('ss:')) continue
        const qty = parseDecimalInput(li.qty)
        if (!Number.isFinite(qty) || qty <= 0) continue
        const unitCost = inventoryUnitCostFromLine(pk, li, salesInventoryMetaByKey)
        if (unitCost == null || unitCost <= 0) continue
        total += unitCost * qty
        hasCost = true
      }
      if (hasCost && total > 0) return total
    }

    return null
  }, [
    accounts,
    catalogReady,
    detailPackageTrim,
    detailScreensRows,
    draftRecharge,
    form.credits_quantity,
    form.provider,
    form.selected_screen_stock_id,
    initialSale,
    inventoryLoadFailed,
    isDetailScreens,
    isDraftScreenSale,
    isEditing,
    isFullCredits,
    lineItems,
    salesInventoryMetaByKey,
    screens,
    selectedScreenNum,
    showInvoiceLayout,
  ])

  const blockSaleForCost =
    estimatedInventoryCostUsd != null &&
    estimatedInventoryCostUsd > 0 &&
    usdEquiv > 0 &&
    usdEquiv <= estimatedInventoryCostUsd

  const amountPaidRawTrim = String(form.amount_paid ?? '').trim()
  const amountPaidParsed = parseDecimalInput(amountPaidRawTrim)
  let balanceDueReceivable = 0
  const serverBalanceDue =
    detailBalanceDue !== null && Number.isFinite(detailBalanceDue)
      ? detailBalanceDue
      : initialSale?.balance_due != null && initialSale.balance_due !== ''
        ? parseFloat(String(initialSale.balance_due))
        : null

  const treatServerCxC =
    isEditing &&
    serverBalanceDue !== null &&
    Number.isFinite(serverBalanceDue) &&
    (linkedPayments.length > 0 || pendingReviewPayments.length > 0)
  if (treatServerCxC) {
    balanceDueReceivable = Math.max(0, serverBalanceDue)
  } else if (amountPaidRawTrim === '') {
    balanceDueReceivable = localAmount
  } else if (Number.isNaN(amountPaidParsed)) {
    balanceDueReceivable = localAmount
  } else {
    balanceDueReceivable = Math.max(0, localAmount - amountPaidParsed)
  }

  const saleCurrencyRaw = String(form.currency ?? '').trim()
  const saleCurrencyCode = saleCurrencyRaw ? normalizeCurrencyCode(saleCurrencyRaw, 'USD') : ''

  const depositLocked = saleIsViewOnly

  const autoAppliedFromCredit = useMemo(
    () => linkedPayments.reduce((acc, lp) => acc + (parseFloat(lp.amount_applied) || 0), 0),
    [linkedPayments],
  )

  const handleOpenLinkedPayment = useCallback(
    (lp) => {
      openReceivePayment(null, {
        viewMode: true,
        paymentId: lp.payment_id,
        paymentNumber: lp.payment_number,
      })
    },
    [openReceivePayment],
  )

  const handleOpenPendingReviewPayment = useCallback(
    (pr) => {
      openReceivePayment(null, {
        viewMode: true,
        paymentId: pr?.payment_id,
        paymentNumber: pr?.payment_number,
      })
    },
    [openReceivePayment],
  )

  const isDepositGroupingParent = useCallback(
    (accId) => depositAccounts.some((x) => Number(x.parent_id) === Number(accId)),
    [depositAccounts],
  )

  /** Monedas de cuentas de depósito seleccionadas que no coinciden con la moneda de cobro (puede haber varias). */
  const depositAccountCurrencyCode = useMemo(() => {
    if (!selectedDepositAccountIds.length) return ''
    const bad = new Set()
    for (const did of selectedDepositAccountIds) {
      const acc = depositAccounts.find((a) => Number(a.id) === Number(did))
      if (!acc || isDepositGroupingParent(acc.id)) continue
      const c = normalizeCurrencyCode(String(acc.currency ?? '').trim() || 'USD', 'USD')
      if (saleCurrencyCode && c !== saleCurrencyCode) bad.add(c)
    }
    return [...bad].join(', ')
  }, [
    depositAccounts,
    isDepositGroupingParent,
    saleCurrencyCode,
    selectedDepositAccountIds,
  ])

  const depositCurrencyMismatch = Boolean(depositAccountCurrencyCode)

  /** Muestra método de pago y cuenta si hay depósito explícito o la venta tiene cobro en revisión. */
  const showDepositPaymentFields =
    (amountPaidRawTrim !== '' && !Number.isNaN(amountPaidParsed) && amountPaidParsed > 0) ||
    (isEditing &&
      ['payment_submitted', 'partially_paid'].includes(
        String(initialSale?.status ?? '').toLowerCase(),
      )) ||
    (isEditing && pendingReviewPayments.length > 0)

  const showDeclaredDepositField =
    isEditing &&
    !saleIsViewOnly &&
    (pendingReviewPayments.length > 0 ||
      ['payment_submitted', 'partially_paid'].includes(
        String(initialSale?.status ?? '').toLowerCase(),
      ))

  const amountPaidInvalid =
    localAmount > 0 &&
    amountPaidRawTrim !== '' &&
    (Number.isNaN(amountPaidParsed) ||
      amountPaidParsed < 0 ||
      amountPaidParsed > localAmount + 1e-9)

  const cobroCurrencyOptions = useMemo(
    () =>
      currencySelectOptions.map((c) => ({
        value: c.code,
        label: `${c.flag ?? ''} ${c.label}`.trim(),
      })),
    [currencySelectOptions],
  )

  const salePaymentMethodOptions = useMemo(
    () =>
      paymentMethods
        .filter((m) => m?.is_active !== false)
        .map((m) => ({ value: String(m.id), label: m.name })),
    [paymentMethods],
  )

  const depositAccountsById = useMemo(
    () => Object.fromEntries(depositAccounts.map((a) => [Number(a.id), a])),
    [depositAccounts],
  )

  const depositAccountSelectOptions = useMemo(
    () =>
      depositAccounts.map((a) => {
        const isParent = isDepositGroupingParent(a.id)
        const pid = a.parent_id != null ? Number(a.parent_id) : NaN
        const par = Number.isFinite(pid) && pid >= 1 ? depositAccountsById[pid] : null
        let label
        if (isParent) {
          label = `${a.name} (${a.currency}) — Cuenta agrupadora · elija subcuenta`
        } else if (par) {
          label = `${par.name} - ${a.name} (${a.currency})`
        } else {
          label = `${a.name} (${a.currency})`
        }
        return {
          value: String(a.id),
          label,
          disabled: isParent,
        }
      }),
    [depositAccounts, depositAccountsById, isDepositGroupingParent],
  )

  const depositAccountsForPaymentPick = useMemo(() => {
    if (!selectedPaymentMethodIds.length) return depositAccounts

    const byId = depositAccountsById

    const selectedLowers = new Set(
      selectedPaymentMethodIds
        .map((id) => paymentMethods.find((m) => Number(m.id) === Number(id))?.name)
        .map((n) => String(n ?? '').trim().toLowerCase())
        .filter(Boolean),
    )

    if (!selectedLowers.size) return depositAccounts

    const linkedMatchesSelection = (acc) => {
      const lm = String(acc.linked_payment_method ?? '').trim().toLowerCase()
      return Boolean(lm && selectedLowers.has(lm))
    }

    return depositAccounts.filter((acc) => {
      if (linkedMatchesSelection(acc)) return true
      const pid = acc.parent_id != null ? Number(acc.parent_id) : NaN
      if (!Number.isFinite(pid) || pid < 1) return false
      const parent = byId[pid]
      return Boolean(parent && linkedMatchesSelection(parent))
    })
  }, [
    depositAccounts,
    depositAccountsById,
    paymentMethods,
    selectedPaymentMethodIds,
  ])

  /** Opciones de cuenta por método de pago (misma regla que el filtro por padre agrupador). */
  const depositAccountOptionsByMethodId = useMemo(() => {
    const byId = depositAccountsById
    const buildForMethodLower = (methodLower) =>
      depositAccounts
        .filter((acc) => {
          const lm = String(acc.linked_payment_method ?? '').trim().toLowerCase()
          if (lm && lm === methodLower) return true
          const pid = acc.parent_id != null ? Number(acc.parent_id) : NaN
          if (!Number.isFinite(pid) || pid < 1) return false
          const parent = byId[pid]
          if (!parent) return false
          const plm = String(parent.linked_payment_method ?? '').trim().toLowerCase()
          return Boolean(plm && plm === methodLower)
        })
        .map((a) => {
          const isParent = isDepositGroupingParent(a.id)
          const pid = a.parent_id != null ? Number(a.parent_id) : NaN
          const par = Number.isFinite(pid) && pid >= 1 ? byId[pid] : null
          let label
          if (isParent) {
            label = `${a.name} (${a.currency}) — Cuenta agrupadora · elija subcuenta`
          } else if (par) {
            label = `${par.name} - ${a.name} (${a.currency})`
          } else {
            label = `${a.name} (${a.currency})`
          }
          return { value: String(a.id), label, disabled: isParent }
        })

    const out = {}
    for (const m of paymentMethods) {
      if (m?.is_active === false) continue
      const ml = String(m.name ?? '').trim().toLowerCase()
      if (!ml) continue
      out[String(m.id)] = buildForMethodLower(ml)
    }
    return out
  }, [depositAccounts, depositAccountsById, isDepositGroupingParent, paymentMethods])

  const togglePaymentMethodId = useCallback((rawId) => {
    const n = Number(rawId)
    if (!Number.isFinite(n)) return
    setSelectedPaymentMethodIds((prev) =>
      prev.some((x) => Number(x) === n) ? prev.filter((x) => Number(x) !== n) : [...prev, n],
    )
  }, [])

  const syncCurrencyFromDepositAccounts = useCallback(
    (selectedIds) => {
      if (saleIsViewOnly || isLegacyPending) return
      const nextCur = currencyFromLastSelectedDepositIds(
        depositAccounts,
        selectedIds,
        isDepositGroupingParent,
      )
      if (!nextCur) return
      setForm((p) => {
        const prevCur = normalizeCurrencyCode(p.currency || 'USD', 'USD')
        if (prevCur === nextCur) return p
        return { ...p, currency: nextCur }
      })
    },
    [depositAccounts, isDepositGroupingParent, isLegacyPending, saleIsViewOnly],
  )

  const toggleDepositAccountId = useCallback(
    (rawId, disabled) => {
      if (disabled) return
      const n = Number(rawId)
      if (!Number.isFinite(n)) return
      setSelectedDepositAccountIds((prev) => {
        const next = prev.some((x) => Number(x) === n)
          ? prev.filter((x) => Number(x) !== n)
          : [...prev, n]
        syncCurrencyFromDepositAccounts(next)
        return next
      })
    },
    [syncCurrencyFromDepositAccounts],
  )

  const transactionClassSelectOptions = useMemo(
    () =>
      transactionClasses
        .filter((c) => c?.is_active !== false)
        .map((c) => ({ value: String(c.id), label: c.name })),
    [transactionClasses],
  )

  useEffect(() => {
    const sel = Number(form.deposit_account_id)
    if (!Number.isFinite(sel) || sel < 1 || !depositAccounts.length) return
    if (!isDepositGroupingParent(sel)) return
    setForm((p) => ({ ...p, deposit_account_id: '' }))
    setError('')
  }, [depositAccounts, form.deposit_account_id, isDepositGroupingParent])

  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedClientPickQuery(String(clientPickerQuery ?? '').trim())
    }, 300)
    return () => window.clearTimeout(id)
  }, [clientPickerQuery])

  useEffect(() => {
    if (initialSale?.id || initialSale?.__clientDetailSyntheticRecharge) return
    setClients([])
    setPortalPickRows([])
    setPortalPickError(null)
    setPickedPortalUser(null)
    setDebouncedClientPickQuery('')
    setClientPickerQuery('')
  }, [initialSale?.id, initialSale?.__clientDetailSyntheticRecharge])

  useEffect(() => {
    const cid = initialSale?.client_id
    if (!isEditing || cid == null) return undefined
    setPickedPortalUser(null)
    let cancelled = false
    api
      .get(`/api/v1/clients/${cid}`)
      .then(({ data }) => {
        if (cancelled || data == null) return
        setClients((prev) => {
          const list = Array.isArray(prev) ? prev : []
          const row = {
            ...data,
            __saleBinding: data?.__saleBinding ?? 'crm_client',
          }
          if (list.some((c) => c?.id != null && String(c.id) === String(row.id))) return list
          return [...list, row]
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [isEditing, initialSale?.client_id, initialSale?.id])

  const refreshClients = useCallback(() => {
    setPortalPickError(null)
    setPortalPickRetryKey((x) => x + 1)
  }, [])

  useEffect(() => {
    if (isEditing || !clientPickerOpen) return undefined
    const controller = new AbortController()
    setPortalPickLoading(true)
    setPortalPickError(null)
    const query = debouncedClientPickQuery
    api
      .get('/api/v1/users', {
        params: { role: 'client', search: query || undefined, limit: 80 },
        signal: controller.signal,
      })
      .then((res) => {
        const data = res?.data
        const rows = (Array.isArray(data) ? data : [])
          .map(mapUnifiedClientUserApiRow)
          .filter(Boolean)
        setPortalPickRows(rows)
      })
      .catch((err) => {
        const canceled =
          controller.signal.aborted ||
          err?.name === 'CanceledError' ||
          err?.code === 'ERR_CANCELED'
        if (canceled) return
        setPortalPickRows([])
        setPortalPickError('No se pudieron cargar los clientes del portal.')
      })
      .finally(() => {
        if (!controller.signal.aborted) setPortalPickLoading(false)
      })
    return () => controller.abort()
  }, [debouncedClientPickQuery, clientPickerOpen, isEditing, portalPickRetryKey])

  useEffect(() => {
    let cancelled = false
    api
      .get('/api/v1/classes/')
      .then(({ data }) => {
        if (cancelled) return
        const list = Array.isArray(data) ? data : []
        list.sort((a, b) =>
          String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'es', { sensitivity: 'base' }),
        )
        setTransactionClasses(list)
      })
      .catch(() => {
        if (!cancelled) setTransactionClasses([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api
      .get('/api/v1/payment-methods/')
      .then(({ data }) => {
        if (cancelled) return
        const list = Array.isArray(data) ? data : []
        list.sort((a, b) =>
          String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'es', { sensitivity: 'base' }),
        )
        setPaymentMethods(list)
      })
      .catch(() => {
        if (!cancelled) setPaymentMethods([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api
      .get('/api/v1/accounts/deposit-options')
      .then(({ data }) => {
        if (cancelled) return
        const list = Array.isArray(data) ? data : []
        list.sort((a, b) =>
          String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'es', { sensitivity: 'base' }),
        )
        setDepositAccounts(list)
      })
      .catch(() => {
        if (!cancelled) setDepositAccounts([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const first = selectedPaymentMethodIds[0]
    const s = first != null && Number.isFinite(Number(first)) ? String(first) : ''
    setForm((p) => (p.payment_method_id === s ? p : { ...p, payment_method_id: s }))
  }, [selectedPaymentMethodIds])

  useEffect(() => {
    const first = selectedDepositAccountIds[0]
    const s = first != null && Number.isFinite(Number(first)) ? String(first) : ''
    setForm((p) => (p.deposit_account_id === s ? p : { ...p, deposit_account_id: s }))
  }, [selectedDepositAccountIds])

  useEffect(() => {
    const allowed = new Set(depositAccountsForPaymentPick.map((a) => Number(a.id)))
    setSelectedDepositAccountIds((prev) => {
      const next = prev.filter((id) => allowed.has(Number(id)))
      return next.length === prev.length ? prev : next
    })
  }, [depositAccountsForPaymentPick])

  useEffect(() => {
    setSelectedDepositAccountIds((prev) => {
      const next = prev.filter((id) => !isDepositGroupingParent(Number(id)))
      return next.length === prev.length ? prev : next
    })
  }, [depositAccounts, isDepositGroupingParent])

  useEffect(() => {
    if (initialSale?.id) return
    setSelectedPaymentMethodIds([])
    setSelectedDepositAccountIds([])
  }, [initialSale?.id])

  useEffect(() => {
    if (isSyntheticLedgerRecharge) {
      setLinkedPayments([])
      setPendingReviewPayments([])
      setDetailBalanceDue(null)
      return undefined
    }
    if (!initialSale?.id) {
      setLinkedPayments([])
      setPendingReviewPayments([])
      setDetailBalanceDue(null)
      return undefined
    }
    setLinkedPayments(Array.isArray(initialSale.linked_payments) ? initialSale.linked_payments : [])
    setPendingReviewPayments(
      Array.isArray(initialSale.pending_review_payments) ? initialSale.pending_review_payments : [],
    )
    setDetailBalanceDue(null)
    let cancelled = false
    api
      .get(`/api/v1/sales/${initialSale.id}`)
      .then((detailRes) => {
        if (cancelled) return
        setLinkedPayments(
          Array.isArray(detailRes.data?.linked_payments) ? detailRes.data.linked_payments : [],
        )
        setPendingReviewPayments(
          Array.isArray(detailRes.data?.pending_review_payments)
            ? detailRes.data.pending_review_payments
            : [],
        )
        const bd = detailRes.data?.balance_due
        setDetailBalanceDue(
          bd !== null && bd !== undefined && bd !== '' ? parseFloat(String(bd)) : null,
        )
        const apd = detailRes.data?.amount_paid
        if (readOnlyMode && apd != null && apd !== '') {
          setForm((f) => ({ ...f, amount_paid: String(apd) }))
        }
      })
      .catch(() => {
        /* mantener datos del listado si falla el detalle */
      })
    return () => {
      cancelled = true
    }
  }, [initialSale?.id, initialSale?.linked_payments, isSyntheticLedgerRecharge, readOnlyMode])

  useEffect(() => {
    declaredDepositInitializedRef.current = false
    setDeclaredDepositStr('')
  }, [initialSale?.id])

  useEffect(() => {
    if (declaredDepositInitializedRef.current) return
    const pr = pendingReviewPayments[0]
    if (!pr) return
    const raw = pr.amount_applied_to_sale ?? pr.amount
    if (raw != null && Number.isFinite(Number(raw))) {
      setDeclaredDepositStr(String(Number(raw)))
      declaredDepositInitializedRef.current = true
    }
  }, [pendingReviewPayments])

  const pendingReviewForOcr = pendingReviewPayments[0] ?? null
  const showIllegibleDepositAlert =
    showDeclaredDepositField &&
    isIllegibleDeclaredRecord(
      buildIllegibleCheckSource({
        pendingPayment: pendingReviewForOcr,
        declaredAmount:
          declaredDepositStr !== '' && Number.isFinite(Number(declaredDepositStr.replace(',', '.')))
            ? Number(declaredDepositStr.replace(',', '.'))
            : null,
      }),
    )

  useEffect(() => {
    if (!initialSale?.id) return
    const cur = initialSale
    const apm = Array.isArray(cur.allowed_payment_methods) ? cur.allowed_payment_methods : []
    let pmIds = apm
      .map((name) =>
        paymentMethods.find(
          (m) => String(m.name || '').trim().toLowerCase() === String(name).trim().toLowerCase(),
        )?.id,
      )
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id >= 1)
    if (!pmIds.length && cur.payment_method_id != null) {
      const n = Number(cur.payment_method_id)
      if (Number.isFinite(n) && n >= 1) pmIds = [n]
    }
    const ada = Array.isArray(cur.allowed_deposit_accounts)
      ? cur.allowed_deposit_accounts.map(Number).filter((n) => Number.isFinite(n) && n >= 1)
      : []
    let depIds = [...ada]
    if (!depIds.length && cur.deposit_account_id != null) {
      const n = Number(cur.deposit_account_id)
      if (Number.isFinite(n) && n >= 1) depIds = [n]
    }
    setSelectedPaymentMethodIds(pmIds)
    setSelectedDepositAccountIds(depIds)
  }, [
    initialSale?.allowed_deposit_accounts,
    initialSale?.allowed_payment_methods,
    initialSale?.deposit_account_id,
    initialSale?.id,
    initialSale?.payment_method_id,
    paymentMethods,
  ])

  useEffect(() => {
    if (saleIsViewOnly || isLegacyPending) return
    if (selectedDepositAccountIds.length > 0) return
    let productImpliesUsd = false
    if (showInvoiceLayout) {
      const lines = Array.isArray(lineItems) ? lineItems : []
      const withPk = lines.filter((li) => String(li?.productKey || '').trim())
      if (withPk.length) {
        productImpliesUsd = withPk.every((li) => {
          const pk = String(li.productKey || '').trim()
          const meta = salesInventoryMetaByKey[pk]
          const rc = meta?.reference_currency
          if (!rc) return false
          return normalizeCurrencyCode(String(rc), 'USD') === 'USD'
        })
      }
    }
    if (!productImpliesUsd) return
    setForm((p) => {
      const cur = normalizeCurrencyCode(p.currency || 'USD', 'USD')
      const xr = String(p.exchange_rate ?? '')
        .replace(',', '.')
        .trim()
      if (cur === 'USD' && xr === '1') return p
      return { ...p, currency: 'USD', exchange_rate: '1' }
    })
  }, [
    isLegacyPending,
    lineItems,
    saleIsViewOnly,
    salesInventoryMetaByKey,
    selectedDepositAccountIds,
    showInvoiceLayout,
  ])

  const applyExchangeRateToForm = useCallback((rateStr, code) => {
    setForm((prev) => {
      if (normalizeCurrencyCode(prev.currency || 'USD', 'USD') !== code) return prev
      return { ...prev, exchange_rate: rateStr }
    })
  }, [])

  /** Moneda de cobro = `currency` de la última cuenta de depósito marcada (plan de cuentas). */
  useEffect(() => {
    syncCurrencyFromDepositAccounts(selectedDepositAccountIds)
  }, [selectedDepositAccountIds, syncCurrencyFromDepositAccounts])

  useExchangeRateForCurrency(form.currency, applyExchangeRateToForm, {
    enabled: !saleIsViewOnly && !isLegacyPending,
    skip: skipCurrencyRateFetchRef,
  })

  useEffect(() => {
    if (!initialSale) return
    if (!initialSale.id && !isSyntheticLedgerRecharge) return
    try {
      setPickedPortalUser(null)
      const cur = initialSale
    const channel = String(cur.inventory_channel ?? '').trim()
    let service_value = SERVICE_EMPTY
    let credits_quantity = ''

    let detail_package = ''
    let selected_screen_stock_id = ''

    if (channel === 'full_credits') {
      service_value = FULL_CREDITS_VALUE
      credits_quantity =
        cur.credits_quantity != null && cur.credits_quantity !== ''
          ? String(cur.credits_quantity)
          : ''
    } else if (channel === 'mixed') {
      service_value = SERVICE_EMPTY
      credits_quantity =
        cur.credits_quantity != null && cur.credits_quantity !== ''
          ? String(cur.credits_quantity)
          : ''
      detail_package = String(cur.inventory_package ?? '').trim()
      selected_screen_stock_id = ''
    } else if (channel === 'screen_stock' || (cur.screen_stock_id && channel !== 'mixed')) {
      const prov = String(cur.inventory_provider ?? '').trim()
      const pkg = String(cur.inventory_package ?? '').trim()
      if (prov && pkg) {
        service_value = DETAIL_SCREENS_VALUE
        detail_package = pkg
        if (cur.screen_stock_id != null) selected_screen_stock_id = String(cur.screen_stock_id)
      }
    } else {
      const prov = String(cur.inventory_provider ?? '').trim()
      const cq = cur.credits_quantity
      if (cq != null && prov) {
        service_value = FULL_CREDITS_VALUE
        credits_quantity = String(cq)
      }
    }

    skipCurrencyRateFetchRef.current = true
    setForm({
      client_id: cur.client_id != null ? String(cur.client_id) : '',
      provider: String(cur.inventory_provider ?? '').trim(),
      service_value,
      detail_package,
      selected_screen_stock_id,
      credits_quantity,
      currency: normalizeCurrencyCode(String(cur.currency ?? 'USD'), 'USD'),
      exchange_rate: String(cur.exchange_rate ?? '1'),
      local_amount:
        cur.local_amount != null && cur.local_amount !== ''
          ? String(cur.local_amount)
          : String(cur.amount ?? ''),
      transaction_class_id: cur.class_id != null ? String(cur.class_id) : '',
      payment_method_id: cur.payment_method_id != null ? String(cur.payment_method_id) : '',
      deposit_account_id: cur.deposit_account_id != null ? String(cur.deposit_account_id) : '',
      notes: cur.notes != null && cur.notes !== '' ? String(cur.notes) : '',
      tag_ids: Array.isArray(cur.tag_ids)
        ? cur.tag_ids
            .map((x) =>
              typeof x === 'number' && Number.isFinite(x)
                ? x
                : typeof x === 'string'
                  ? Number(String(x).trim())
                  : x != null && typeof x === 'object' && x.id != null
                    ? Number(x.id)
                    : Number(x),
            )
            .filter((n) => Number.isFinite(n) && n >= 1)
        : [],
      // ``payment_submitted``: el efectivo va como abono general en revisión — campo manual vacío.
      // Otros estados: monto registrado en BD si existe.
      amount_paid:
        cur.status === 'payment_submitted'
          ? ''
          : cur.amount_paid != null && cur.amount_paid !== ''
            ? String(cur.amount_paid)
            : '',
    })
    requestAnimationFrame(() => {
      skipCurrencyRateFetchRef.current = false
    })
    const ilApi = Array.isArray(cur.invoice_lines) ? cur.invoice_lines : []
    const fifoHintRaw =
      typeof cur.fifo_cp_inventory_key === 'string'
        ? cur.fifo_cp_inventory_key.trim()
        : ''
    const multiFromInvoice =
      ilApi.length > 0 && (channel === 'mixed' || ilApi.length > 1)

    let builtLines = [emptySaleLine()]
    if (!isLegacyPending) {
      if (multiFromInvoice) {
        builtLines = editableRowsFromSaleInvoiceLines(
          cur,
          ilApi,
          fifoHintRaw || undefined,
        )
      } else {
        let productKey = ''
        const prov = String(cur.inventory_provider ?? '').trim()
        const pkg = String(cur.inventory_package ?? '').trim()
        const pid = cur.product_id != null ? Number(cur.product_id) : null

        if (channel === 'full_credits') {
          productKey =
            pid != null && Number.isFinite(pid) && pid >= 1
              ? `cn:${pid}`
              : `fc:${prov}`
        } else if (channel === 'screen_stock' || (cur.screen_stock_id && channel !== 'mixed')) {
          if (cur.screen_stock_id != null && String(cur.screen_stock_id).trim() !== '') {
            productKey = `ss:${String(cur.screen_stock_id)}`
          } else if (pid != null && Number.isFinite(pid) && pid >= 1 && pkg && prov) {
            productKey = `cp|${pid}|${encodeURIComponent(pkg)}|${encodeURIComponent(prov)}`
          }
        }
        const scrUnits =
          Number.isFinite(Number(cur.inventory_screen_units)) &&
          Number(cur.inventory_screen_units) >= 1
            ? Math.min(200, Math.floor(Number(cur.inventory_screen_units)))
            : 1
        const laNum =
          cur.local_amount != null && cur.local_amount !== ''
            ? parseDecimalInput(cur.local_amount)
            : parseDecimalInput(cur.amount ?? '')
        const laNumSafe = Number.isFinite(laNum) ? laNum : 0
        if (channel === 'full_credits' && productKey && credits_quantity !== '') {
          const cq = parseFloat(String(credits_quantity))
          const rate =
            Number.isFinite(cq) && cq > 0 && laNumSafe > 0
              ? String((laNumSafe / cq).toFixed(6))
              : laNumSafe > 0
                ? String(laNumSafe)
                : ''
          builtLines = [
            {
              id: `edit-line-${cur.id}`,
              productKey,
              description: '',
              qty: String(credits_quantity),
              rate,
              clase_id: '',
              transaction_class_id: '',
              asignar_credenciales: false,
              cred_panel_expandido: false,
              iptv_usuario: '',
              iptv_password: '',
            },
          ]
        } else if (
          (channel === 'screen_stock' || (cur.screen_stock_id && channel !== 'mixed')) &&
          productKey
        ) {
          const qtyLine = productKey.startsWith('ss:') ? 1 : scrUnits
          const rateLine =
            Number.isFinite(qtyLine) &&
            qtyLine >= 1 &&
            laNumSafe > 0 &&
            !productKey.startsWith('fc:')
              ? String((laNumSafe / qtyLine).toFixed(2))
              : laNumSafe > 0
                ? laNumSafe.toFixed(2)
                : ''
          builtLines = [
            {
              id: `edit-line-${cur.id}`,
              productKey,
              description: '',
              qty: String(qtyLine),
              rate: rateLine,
              clase_id: '',
              transaction_class_id: '',
              asignar_credenciales: false,
              cred_panel_expandido: false,
              iptv_usuario: '',
              iptv_password: '',
            },
          ]
        } else {
          builtLines = [emptySaleLine()]
        }
        const creditosDesdeBodega =
          channel === 'screen_stock' ||
          (channel !== 'mixed' &&
            cur.screen_stock_id != null &&
            String(cur.screen_stock_id).trim() !== '')
        builtLines = mergeInvoiceLineMeta(builtLines, ilApi, {
          autoWarehouseCredentials: creditosDesdeBodega,
        })
      }
    } else {
      builtLines = mergeInvoiceLineMeta([emptySaleLine()], ilApi)
    }

    setLineItems(builtLines)
    // Modo edición: nunca sobrescribir amount_paid con el total de líneas desde el efecto de autofill.
    amountPaidDirtyRef.current = Boolean(cur?.id)
    setDraftRecharge(null)
    setReceiptFile(null)
    setReceiptServerCleared(false)
    setError('')
      setNoStock(false)
    } catch (err) {
      console.error('[NuevaVentaModal] Error al hidratar venta para edición/visualización:', err)
      setLineItems([emptySaleLine()])
      setError(
        'No se pudo reconstruir el formulario de esta venta. Puedes cerrar el modal o revisar los datos en el listado.',
      )
      setNoStock(false)
    }
  }, [initialSale, isLegacyPending, isSyntheticLedgerRecharge])

  useEffect(() => {
    if (initialSale?.__clientDetailSyntheticRecharge) return
    if (initialSale?.id != null) return
    if (prefillClientId == null || prefillClientId < 1) return
    setPickedPortalUser(null)
    setForm((prev) => ({ ...prev, client_id: String(prefillClientId) }))
    let cancelled = false
    api
      .get(`/api/v1/clients/${prefillClientId}`)
      .then(({ data }) => {
        if (cancelled || data == null) return
        setClients((prev) => {
          const list = Array.isArray(prev) ? prev : []
          const row = { ...data, __saleBinding: data?.__saleBinding ?? 'crm_client' }
          if (list.some((c) => c?.id != null && String(c.id) === String(row.id))) return list
          return [...list, row]
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [prefillClientId, initialSale?.id, initialSale?.__clientDetailSyntheticRecharge])

  useEffect(() => {
    if (initialSale?.__clientDetailSyntheticRecharge) return
    if (initialSale?.id != null) return
    const pid = prefillDepositAccountId
    if (pid == null || Number(pid) < 1) return
    setForm((prev) => ({ ...prev, deposit_account_id: String(pid) }))
  }, [prefillDepositAccountId, initialSale?.id, initialSale?.__clientDetailSyntheticRecharge])

  /** Paquete inválido tras cambiar inventario (solo modo pantalla). */
  useEffect(() => {
    if (form.service_value !== DETAIL_SCREENS_VALUE) return
    if (!detailPackageTrim) return
    if (!detailPackageOptions.length) return
    const ok = detailPackageOptions.some(
      (p) => String(p).trim().toLowerCase() === detailPackageTrim.toLowerCase(),
    )
    if (!ok) setForm((prev) => ({ ...prev, detail_package: '', selected_screen_stock_id: '' }))
  }, [detailPackageOptions, detailPackageTrim, form.service_value])

  const mergeClientSorted = useCallback((created) => {
    if (!created?.id) return
    const withBinding = {
      ...created,
      __saleBinding: created.__saleBinding ?? 'crm_client',
    }
    setClients((prev) => {
      const list = Array.isArray(prev) ? prev : []
      const next = [...list.filter((c) => c?.id !== withBinding.id), withBinding].filter(Boolean)
      next.sort((a, b) =>
        String(a?.username ?? a?.name ?? '').localeCompare(String(b?.username ?? b?.name ?? ''), 'es', {
          sensitivity: 'base',
        }),
      )
      return next
    })
  }, [])

  function handleChange(e) {
    const { name, value } = e.target
    setError('')
    setNoStock(false)

    if (name === 'service_value' && value === RECHARGE_SCREENS_ACTION) {
      const pv = (form.provider || '').trim()
      if (!pv) return
      openRechargeModal({
        defaultProvider: pv,
        defaultTab: 'Crédito por pantalla',
        onSaveDraft: (rechargeData) => {
          setDraftRecharge(rechargeData)
          setForm((prev) => ({
            ...prev,
            service_value: DRAFT_PENDING_SCREEN,
          }))
        },
      })
      return
    }

    if (name === 'provider') {
      setDraftRecharge(null)
    }
    if (
      name === 'service_value' &&
      value !== DRAFT_PENDING_SCREEN &&
      value !== RECHARGE_SCREENS_ACTION
    ) {
      setDraftRecharge(null)
    }

    if (name === 'amount_paid') {
      amountPaidDirtyRef.current = true
    }

    setForm((prev) => {
      let next = { ...prev, [name]: value }
      if (name === 'provider') {
        next = {
          ...next,
          provider: value,
          service_value: SERVICE_EMPTY,
          credits_quantity: '',
          detail_package: '',
          selected_screen_stock_id: '',
          ...(isEditing ? {} : { transaction_class_id: '' }),
        }
      }
      if (name === 'currency') {
        if (!amountPaidDirtyRef.current) {
          next.amount_paid = prev.local_amount
        }
      }
      if (name === 'service_value') {
        next.credits_quantity = value === FULL_CREDITS_VALUE ? prev.credits_quantity : ''
        if (value !== DETAIL_SCREENS_VALUE) {
          next.detail_package = ''
          next.selected_screen_stock_id = ''
        }
      }
      if (name === 'detail_package') {
        next.selected_screen_stock_id = ''
      }
      if (name === 'local_amount' && !amountPaidDirtyRef.current) {
        next.amount_paid = value
      }
      return next
    })
  }

  function handleServiceValuePick(nextValue) {
    const v = String(nextValue ?? '')
    if (v === RECHARGE_SCREENS_ACTION) {
      const pv = (form.provider || '').trim()
      if (!pv) return
      openRechargeModal({
        defaultProvider: pv,
        defaultTab: 'Crédito por pantalla',
        onSaveDraft: (rechargeData) => {
          setDraftRecharge(rechargeData)
          setForm((prev) => ({
            ...prev,
            service_value: DRAFT_PENDING_SCREEN,
          }))
        },
      })
      return
    }
    handleChange({ target: { name: 'service_value', value: v } })
  }

  const apiOrigin = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'
  const existingReceiptAbsoluteUrl =
    isEditing && initialSale?.receipt_url && !receiptServerCleared
      ? `${String(apiOrigin).replace(/\/$/, '')}${initialSale.receipt_url}`
      : null

  function clearReceiptAttachment() {
    const el = document.getElementById('sale-receipt-input')
    if (el) el.value = ''
    if (receiptFile) {
      setReceiptFile(null)
      return
    }
    setReceiptServerCleared(true)
  }

  function onReceiptFileChosen(ev) {
    const f = ev.target.files?.[0]
    if (!f) return
    if (!f.type.startsWith('image/') && f.type !== 'application/pdf') {
      setError('Formato no permitido. Usa imagen o PDF.')
      ev.target.value = ''
      return
    }
    if (f.size > RECEIPT_MAX_BYTES) {
      setError('El archivo supera el límite de 20 MB.')
      ev.target.value = ''
      return
    }
    setError('')
    setReceiptServerCleared(false)
    setReceiptFile(f)
    ev.target.value = ''
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (saleIsViewOnly) return
    setError('')
    setNoStock(false)

    const hasSaleClientBinding =
      pickedPortalUser?.id != null || String(form.client_id ?? '').trim().length > 0
    if (!hasSaleClientBinding) {
      const msg = 'Selecciona un cliente antes de registrar la venta.'
      setError(msg)
      if (typeof onToast === 'function') onToast(msg, 'error')
      return
    }

    const line0SubmitPk = String(lineItems[0]?.productKey || '').trim()
    const invoicePkOk =
      showInvoiceLayout &&
      line0SubmitPk &&
      line0SubmitPk !== '__loading_inv' &&
      (line0SubmitPk === 'draft:pending' ||
        line0SubmitPk.startsWith('cn:') ||
        line0SubmitPk.startsWith('cp|') ||
        line0SubmitPk.startsWith('ss:') ||
        line0SubmitPk.startsWith('fc:'))

    const needsErpLine = !isEditing || !isLegacyPending
    if (needsErpLine) {
      if (showInvoiceLayout && invoicePkOk) {
        if (line0SubmitPk === 'draft:pending' && !draftRecharge) {
          setError('Completa la recarga en borrador.')
          return
        }
        if (line0SubmitPk !== 'draft:pending' && !form.provider?.trim()) {
          setError('Selecciona un proveedor IPTV.')
          return
        }
      } else if (showInvoiceLayout) {
        setError('Completa la primera línea con un producto cargado desde inventario.')
        return
      } else {
        if (!form.provider?.trim()) {
          setError('Selecciona un proveedor IPTV.')
          return
        }
        if (
          !form.service_value ||
          form.service_value === SERVICE_EMPTY ||
          form.service_value === RECHARGE_SCREENS_ACTION ||
          (form.service_value === DRAFT_PENDING_SCREEN && !draftRecharge)
        ) {
          setError('Selecciona un servicio.')
          return
        }
        if (isEditing && form.service_value === DRAFT_PENDING_SCREEN) {
          setError('El flujo de borrador de recarga solo aplica al crear una venta nueva.')
          return
        }
      }
    }

    if (!form.local_amount || localAmount <= 0) {
      setError('Ingresa un monto válido.')
      return
    }
    if (exchangeRate <= 0) {
      setError('La tasa de cambio debe ser mayor a 0.')
      return
    }

    if (showInvoiceLayout) {
      for (const li of Array.isArray(lineItems) ? lineItems : []) {
        const pk = String(li?.productKey || '').trim()
        if (!pk.startsWith('cp|') && !pk.startsWith('ss:')) continue
        const rate = parseDecimalInput(li?.rate)
        const unitCost = inventoryUnitCostFromLine(pk, li, salesInventoryMetaByKey)
        if (
          Number.isFinite(rate) &&
          rate > 0 &&
          unitCost != null &&
          unitCost > 0 &&
          rate <= unitCost
        ) {
          const msg = 'Error: El precio de venta ingresado es menor al costo del producto'
          setError(msg)
          if (typeof onToast === 'function') onToast(msg, 'error')
          return
        }
      }
    }

    const apRaw = String(form.amount_paid ?? '').trim()
    const amountPaidSubmit = apRaw === '' ? localAmount : parseDecimalInput(apRaw)
    if (localAmount > 0) {
      if (Number.isNaN(amountPaidSubmit) || amountPaidSubmit < 0) {
        setError('Indica un monto pagado válido.')
        return
      }
      if (amountPaidSubmit > localAmount + 1e-9) {
        setError('El monto pagado no puede superar el importe de cobro.')
        return
      }
    }

    const provider = (form.provider || '').trim()
    const classFk = showInvoiceLayout
      ? primaryTransactionClassFromLines(lineItems)
      : fkOrNull(form.transaction_class_id)
    const pmFk = fkOrNull(form.payment_method_id)
    const depFk = fkOrNull(form.deposit_account_id)
    const notesVal = (form.notes || '').trim() || null

    const allowedPaymentMethodNames = selectedPaymentMethodIds
      .map((id) => paymentMethods.find((m) => Number(m.id) === Number(id))?.name)
      .map((n) => String(n || '').trim())
      .filter(Boolean)
    const allowedDepositIdsList = selectedDepositAccountIds
      .map((id) => Number(id))
      .filter((n) => Number.isFinite(n) && n >= 1)
    const paymentPortalFields =
      allowedPaymentMethodNames.length || allowedDepositIdsList.length
        ? {
            ...(allowedPaymentMethodNames.length ? { allowed_payment_methods: allowedPaymentMethodNames } : {}),
            ...(allowedDepositIdsList.length ? { allowed_deposit_accounts: allowedDepositIdsList } : {}),
          }
        : {}

    async function postSale(payload) {
      const tagList = Array.isArray(payload.tag_ids) ? payload.tag_ids : []
      const rest = { ...payload }
      delete rest.tag_ids
      const invoiceLines = rest.invoice_lines
      delete rest.invoice_lines
      const operationLines = rest.lines
      delete rest.lines
      if (receiptFile) {
        const fd = new FormData()
        Object.entries(rest).forEach(([k, v]) => {
          if (v === undefined || v === null) return
          if (k === 'allowed_payment_methods' || k === 'allowed_deposit_accounts') {
            fd.append(k, JSON.stringify(v))
            return
          }
          fd.append(k, String(v))
        })
        fd.append('tag_ids', JSON.stringify(tagList))
        if (invoiceLines != null) fd.append('invoice_lines', JSON.stringify(invoiceLines))
        if (operationLines != null) fd.append('lines', JSON.stringify(operationLines))
        fd.append('receipt', receiptFile)
        return api.post('/api/v1/sales/', fd)
      }
      return api.post('/api/v1/sales/', {
        ...rest,
        tag_ids: tagList,
        ...(invoiceLines != null ? { invoice_lines: invoiceLines } : {}),
        ...(operationLines != null ? { lines: operationLines } : {}),
      })
    }

    if (isEditing && initialSale?.id) {
      if (
        needsErpLine &&
        isFullCredits &&
        (!showInvoiceLayout || (!line0SubmitPk.startsWith('cn:') && !line0SubmitPk.startsWith('fc:')))
      ) {
        const qty = parseFloat(form.credits_quantity)
        if (!qty || qty <= 0 || Number.isNaN(qty)) {
          setError('Indica cantidad de créditos a vender (> 0).')
          return
        }
        const cap = creditsAvailableForProvider
        if (cap === null || cap === undefined || Number.isNaN(cap)) {
          setError('Espera a cargar el inventario de créditos o pulsa reintentar.')
          return
        }
        if (qty > cap + 1e-9) {
          setError(`No puedes vender más de ${cap.toFixed(4)} créditos disponibles (${provider}).`)
          return
        }
      }

      if (needsErpLine && isFullCredits && showInvoiceLayout && line0SubmitPk.startsWith('cn:')) {
        const qty = parseFloat(String(lineItems[0]?.qty || '').replace(',', '.'))
        if (!qty || qty <= 0 || Number.isNaN(qty)) {
          setError('Indica cantidad de créditos en la primera línea (> 0).')
          return
        }
        const cap = salesInventoryMetaByKey[line0SubmitPk]?.available_credits
        if (cap == null || Number.isNaN(Number(cap))) {
          setError('Espera a cargar inventario para este producto o reabre el modal.')
          return
        }
        if (qty > Number(cap) + 1e-6) {
          setError(`No puedes vender más de ${Number(cap).toFixed(4)} créditos (stock disponible).`)
          return
        }
      }

      if (needsErpLine && isFullCredits && showInvoiceLayout && line0SubmitPk.startsWith('fc:')) {
        const qty = parseFloat(String(lineItems[0]?.qty || '').replace(',', '.'))
        if (!qty || qty <= 0 || Number.isNaN(qty)) {
          setError('Indica cantidad de créditos en la primera línea (> 0).')
          return
        }
        const provFc = (line0SubmitPk.slice(3) || '').trim() || provider
        const snap = snapshotFor(provFc)
        const capFc = Number(snap.totalCredits)
        if (!Number.isFinite(capFc)) {
          setError('Espera a cargar el inventario pooled o sincroniza de nuevo.')
          return
        }
        if (qty > capFc + 1e-6) {
          setError(
            `No puedes vender más de ${capFc.toFixed(4)} créditos pooled disponibles (${provFc}).`,
          )
          return
        }
      }

      const basePatch = {
        ...buildSaleClientBindingPayload(pickedPortalUser, form.client_id),
        currency: normalizeCurrencyCode(form.currency || 'USD', 'USD'),
        exchange_rate: exchangeRate,
        local_amount: String(form.local_amount),
        amount_paid: String(amountPaidSubmit),
        class_id: classFk,
        payment_method_id: pmFk,
        deposit_account_id: depFk,
        notes: notesVal,
        tag_ids: Array.isArray(form.tag_ids) ? form.tag_ids : [],
        ...paymentPortalFields,
      }
      if (showDeclaredDepositField && String(declaredDepositStr ?? '').trim()) {
        const declAmt = Number.parseFloat(String(declaredDepositStr).replace(',', '.'))
        if (!Number.isFinite(declAmt) || declAmt <= 0) {
          setError('Indica un depósito declarado válido mayor que cero.')
          return
        }
        basePatch.declared_payment_amount = String(declAmt)
        const pendingPid = pendingReviewPayments[0]?.payment_id
        if (pendingPid != null) basePatch.declared_payment_id = Number(pendingPid)
      }
      if (!isLegacyPending && showInvoiceLayout) {
        basePatch.invoice_lines = buildInvoiceLinesPayload(lineItems)
      }

      let patchBody = basePatch
      if (!isLegacyPending) {
        if (showInvoiceLayout) {
          const pk = line0SubmitPk
          if (!pk || pk === 'draft:pending' || pk === '__loading_inv') {
            setError('Indica inventario válido en la primera línea.')
            return
          }
          const qtyLn = parseFloat(String(lineItems[0]?.qty ?? '').replace(',', '.'))
          if (!Number.isFinite(qtyLn) || qtyLn <= 0) {
            setError('Indica cantidad válida en la primera línea (> 0).')
            return
          }

          if (pk.startsWith('cn:')) {
            const pid = parseInt(pk.slice(3), 10)
            patchBody = {
              ...basePatch,
              inventory_channel: 'full_credits',
              provider: (form.provider || '').trim(),
              package: null,
              credits_quantity: qtyLn,
              product_id: Number.isFinite(pid) && pid >= 1 ? pid : undefined,
              inventory_screen_units: 1,
            }
          } else if (pk.startsWith('fc:')) {
            const provFc = String(pk.slice(3) || '').trim() || provider
            patchBody = {
              ...basePatch,
              inventory_channel: 'full_credits',
              provider: provFc,
              package: null,
              credits_quantity: qtyLn,
              product_id: null,
              inventory_screen_units: 1,
            }
          } else if (pk.startsWith('cp|')) {
            const cp = parseCpOptionKey(pk)
            if (!cp || !cp.packageLabel || !cp.provider) {
              setError('Combinación de inventario no válida.')
              return
            }
            const units = Math.min(200, Math.max(1, Math.floor(qtyLn)))
            const capSc = salesInventoryMetaByKey[pk]?.available_screens
            if (capSc != null && Number.isFinite(Number(capSc)) && units > Number(capSc) + 1e-6) {
              setError(`Solo hay ${Number(capSc)} pantalla(s) disponibles para ese paquete.`)
              return
            }
            patchBody = {
              ...basePatch,
              inventory_channel: 'screen_stock',
              provider: cp.provider,
              package: cp.packageLabel,
              credits_quantity: null,
              inventory_screen_units: units,
              product_id:
                Number.isFinite(cp.productId) && cp.productId >= 1 ? cp.productId : undefined,
            }
          } else if (pk.startsWith('ss:')) {
            if (
              !detailPackageTrim ||
              !Number.isFinite(selectedScreenNum) ||
              selectedScreenNum < 1
            ) {
              setError('Selecciona el paquete y una pantalla en la tabla.')
              return
            }
            patchBody = {
              ...basePatch,
              inventory_channel: 'screen_stock',
              provider,
              package: detailPackageTrim,
              credits_quantity: null,
              inventory_screen_units: 1,
            }
            const sel = selectedScreenNum
            const sameHeld =
              initialSale.screen_stock_id &&
              sel === Number(initialSale.screen_stock_id) &&
              String(initialSale.inventory_provider ?? '').trim() === provider &&
              String(initialSale.inventory_package ?? '').trim() === detailPackageTrim
            if (sameHeld) {
              patchBody.screen_stock_id = initialSale.screen_stock_id
            } else if (Number.isFinite(sel) && sel >= 1) {
              patchBody.selected_screen_id = sel
            }
          } else {
            setError('Producto de primera línea no reconocido.')
            return
          }
        } else {
          if (!isFullCredits && !isDetailScreens) {
            setError('Selecciona un servicio válido.')
            return
          }
          const fifoLineLegacy = line0SubmitPk.startsWith('cp|')
          if (
            isDetailScreens &&
            !fifoLineLegacy &&
            (!detailPackageTrim || !Number.isFinite(selectedScreenNum) || selectedScreenNum < 1)
          ) {
            setError('Selecciona el paquete y una pantalla en la tabla.')
            return
          }
          patchBody = {
            ...basePatch,
            inventory_channel: isFullCredits ? 'full_credits' : 'screen_stock',
            provider,
            credits_quantity: isFullCredits ? parseFloat(form.credits_quantity) : null,
            package: isFullCredits ? null : detailPackageTrim,
          }
          if (!isFullCredits) {
            const sel = selectedScreenNum
            const sameHeld =
              initialSale.screen_stock_id &&
              sel === Number(initialSale.screen_stock_id) &&
              String(initialSale.inventory_provider ?? '').trim() === provider &&
              String(initialSale.inventory_package ?? '').trim() === detailPackageTrim
            if (sameHeld) {
              patchBody.screen_stock_id = initialSale.screen_stock_id
            } else if (Number.isFinite(sel) && sel >= 1) {
              patchBody.selected_screen_id = sel
            }
          }
        }
      }

      setSubmitting(true)
      try {
        const payloadJson = stripNullPatchFields({ ...patchBody, notes: notesVal })
        if (receiptServerCleared && !receiptFile) {
          payloadJson.receipt_clear = true
        }
        if (receiptFile) {
          const fd = new FormData()
          fd.append(
            'payload',
            JSON.stringify(
              stripNullPatchFields({
                ...payloadJson,
                receipt_clear: false,
              }),
            ),
          )
          fd.append('receipt', receiptFile)
          await api.patch(`/api/v1/sales/${initialSale.id}`, fd)
        } else {
          await api.patch(`/api/v1/sales/${initialSale.id}`, payloadJson)
        }
        await Promise.resolve(onSuccess?.())
      } catch (err) {
        logSaleSubmitError(err, 'sale_patch')
        const raw = err?.response?.data?.detail ?? err?.message ?? ''
        const detail = typeof raw === 'string' ? raw : JSON.stringify(raw)
        const ds = typeof detail === 'string' ? detail.toLowerCase() : ''
        if (!err?.response && (err?.message === 'Network Error' || err?.code === 'ERR_NETWORK')) {
          const base =
            typeof err?.config?.baseURL === 'string'
              ? err.config.baseURL
              : '(revisa VITE_API_BASE_URL o el backend en localhost:8000)'
          setError(
            `Sin conexión con el servidor (${base}). ¿Está arrancado el API? Revisa la consola (F12) para CORS / connection refused.`,
          )
        } else if (err?.response?.status === 404) {
          setError(`Ruta no encontrada (404): ${detail || 'Verifica que la API sea /api/v1/sales/'}`)
        } else if (
          err?.response?.status === 400 &&
          typeof detail === 'string' &&
          detail.toLowerCase().includes('costo del inventario')
        ) {
          const friendly = 'Error: El precio de venta ingresado es menor al costo del producto'
          setError(friendly)
          if (typeof onToast === 'function') {
            onToast(friendly, 'error')
          }
        } else if (
          err?.response?.status === 400 &&
          (ds.includes('stock') ||
            ds.includes('pantallas') ||
            ds.includes('créditos insuficientes') ||
            ds.includes('insuficientes'))
        ) {
          setNoStock(true)
          setError(typeof detail === 'string' && detail ? detail : 'Inventario insuficiente.')
        } else {
          setError(
            typeof detail === 'string' && detail
              ? detail
              : 'No se pudo guardar la venta. Inténtalo de nuevo.',
          )
        }
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (!isEditing && showInvoiceLayout && !(isDraftScreenSale && draftRecharge)) {
      const pk = line0SubmitPk
      if (!pk || pk === '__loading_inv') {
        setError('Selecciona inventario en la primera línea.')
        return
      }
      const qtyLn = parseFloat(String(lineItems[0]?.qty ?? '').replace(',', '.'))
      if (!Number.isFinite(qtyLn) || qtyLn <= 0) {
        setError('Indica cantidad en la primera línea (> 0).')
        return
      }

      const bodyInvoice = {
        ...buildSaleClientBindingPayload(pickedPortalUser, form.client_id),
        inventory_channel: '',
        provider: (form.provider || '').trim(),
        currency: normalizeCurrencyCode(form.currency || 'USD', 'USD'),
        exchange_rate: exchangeRate,
        local_amount: String(form.local_amount),
        amount_paid: String(amountPaidSubmit),
        tag_ids: Array.isArray(form.tag_ids) ? form.tag_ids : [],
      }
      if (classFk !== null) bodyInvoice.class_id = classFk
      bodyInvoice.invoice_lines = buildInvoiceLinesPayload(lineItems)
      const opLinesPayload = buildSaleOperationLinesPayload(lineItems)
      if (opLinesPayload.length) bodyInvoice.lines = opLinesPayload
      if (pmFk !== null) bodyInvoice.payment_method_id = pmFk
      if (depFk !== null) bodyInvoice.deposit_account_id = depFk
      if (notesVal) bodyInvoice.notes = notesVal
      Object.assign(bodyInvoice, paymentPortalFields)

      if (pk.startsWith('cn:')) {
        const nid = parseInt(pk.slice(3), 10)
        const capCn = salesInventoryMetaByKey[pk]?.available_credits
        if (
          capCn != null &&
          Number.isFinite(Number(capCn)) &&
          qtyLn > Number(capCn) + 1e-6
        ) {
          setError(`Stock insuficiente: máximo ${Number(capCn).toFixed(4)} créditos.`)
          return
        }
        bodyInvoice.inventory_channel = 'full_credits'
        bodyInvoice.credits_quantity = qtyLn
        bodyInvoice.inventory_screen_units = 1
        if (Number.isFinite(nid) && nid >= 1) bodyInvoice.product_id = nid
      } else if (pk.startsWith('fc:')) {
        const provFc = (pk.slice(3) || '').trim() || provider
        const snap = snapshotFor(provFc)
        const capFc = Number(snap.totalCredits)
        if (!Number.isFinite(capFc)) {
          setError('Espera a cargar inventario pooled o sincroniza de nuevo.')
          return
        }
        if (qtyLn > capFc + 1e-6) {
          setError(
            `Stock insuficiente: máximo ${capFc.toFixed(4)} créditos pooled para ${provFc}.`,
          )
          return
        }
        bodyInvoice.inventory_channel = 'full_credits'
        bodyInvoice.provider = provFc
        bodyInvoice.credits_quantity = qtyLn
        bodyInvoice.inventory_screen_units = 1
      } else if (pk.startsWith('cp|')) {
        const cp = parseCpOptionKey(pk)
        if (!cp || !cp.packageLabel || !cp.provider) {
          setError('Paquete de inventario no válido.')
          return
        }
        const units = Math.min(200, Math.max(1, Math.floor(qtyLn)))
        const capSc = salesInventoryMetaByKey[pk]?.available_screens
        if (
          capSc != null &&
          Number.isFinite(Number(capSc)) &&
          units > Number(capSc) + 1e-6
        ) {
          setError(`Stock insuficiente: máximo ${Number(capSc)} pantalla(s).`)
          return
        }
        bodyInvoice.inventory_channel = 'screen_stock'
        bodyInvoice.provider = cp.provider
        bodyInvoice.package = cp.packageLabel
        bodyInvoice.inventory_screen_units = units
        if (Number.isFinite(cp.productId) && cp.productId >= 1) {
          bodyInvoice.product_id = cp.productId
        }
      } else if (pk.startsWith('ss:')) {
        if (
          !detailPackageTrim ||
          !Number.isFinite(selectedScreenNum) ||
          selectedScreenNum < 1
        ) {
          setError('Selecciona paquete y pantalla disponibles.')
          return
        }
        bodyInvoice.inventory_channel = 'screen_stock'
        bodyInvoice.provider = provider
        bodyInvoice.package = detailPackageTrim
        bodyInvoice.inventory_screen_units = 1
        bodyInvoice.selected_screen_id = selectedScreenNum
        const pidSs = salesInventoryMetaByKey[pk]?.product_id
        if (pidSs != null && Number(pidSs) >= 1) bodyInvoice.product_id = Number(pidSs)
      } else {
        setError('Producto de primera línea no reconocido.')
        return
      }

      setError('')
      setNoStock(false)
      setSubmitting(true)
      try {
        const { data } = await postSale(bodyInvoice)
        await alertScreenStockSaleCredentialsFromResponse(data)
        await Promise.resolve(onSuccess?.())
      } catch (err) {
        console.error('[NuevaVentaModal] POST venta (factura), respuesta API:', err?.response?.data, err)
        logSaleSubmitError(err, 'sale_submit_invoice_layout')
        const raw = err?.response?.data?.detail ?? err?.message ?? ''
        const detail = typeof raw === 'string' ? raw : JSON.stringify(raw)
        const ds = typeof detail === 'string' ? detail.toLowerCase() : ''
        if (!err?.response && (err?.message === 'Network Error' || err?.code === 'ERR_NETWORK')) {
          const base =
            typeof err?.config?.baseURL === 'string'
              ? err.config.baseURL
              : '(revisa VITE_API_BASE_URL o el backend en localhost:8000)'
          setError(
            `Sin conexión con el servidor (${base}). ¿Está arrancado el API? Revisa la consola (F12) para CORS / connection refused.`,
          )
          if (typeof onToast === 'function') {
            onToast('Sin conexión con el servidor. Revisa la consola (F12).', 'error')
          }
        } else if (err?.response?.status === 404) {
          const msg404 = `Ruta no encontrada (404): ${detail || 'Verifica que la API sea /api/v1/sales/'}`
          setError(msg404)
          if (typeof onToast === 'function') onToast(msg404, 'error')
        } else if (
          err?.response?.status === 400 &&
          typeof detail === 'string' &&
          detail.toLowerCase().includes('costo del inventario')
        ) {
          const friendly = 'Error: El precio de venta ingresado es menor al costo del producto'
          setError(friendly)
          if (typeof onToast === 'function') {
            onToast(friendly, 'error')
          }
        } else if (
          err?.response?.status === 400 &&
          (ds.includes('stock') ||
            ds.includes('pantallas') ||
            ds.includes('créditos insuficientes') ||
            ds.includes('insuficientes'))
        ) {
          setNoStock(true)
          const stockMsg =
            typeof detail === 'string' && detail ? detail : 'Inventario insuficiente.'
          setError(stockMsg)
          if (typeof onToast === 'function') onToast(stockMsg, 'error')
        } else {
          const msg =
            typeof detail === 'string' && detail
              ? detail
              : 'Error al registrar la venta. Inténtalo de nuevo.'
          setError(msg)
          if (typeof onToast === 'function') onToast(msg, 'error')
        }
      } finally {
        setSubmitting(false)
      }
      return
    }

    if (!showInvoiceLayout && isFullCredits) {
      const qty = parseFloat(form.credits_quantity)
      if (!qty || qty <= 0 || Number.isNaN(qty)) {
        setError('Indica cantidad de créditos a vender (> 0).')
        return
      }
      const cap = creditsAvailableForProvider
      if (cap === null || cap === undefined || Number.isNaN(cap)) {
        setError('Espera a cargar el inventario de créditos o pulsa reintentar.')
        return
      }
      if (qty > cap + 1e-9) {
        setError(`No puedes vender más de ${cap.toFixed(4)} créditos disponibles (${provider}).`)
        return
      }
    }

    const bodyBase = {
      ...buildSaleClientBindingPayload(pickedPortalUser, form.client_id),
      inventory_channel: '',
      provider,
      currency: normalizeCurrencyCode(form.currency || 'USD', 'USD'),
      exchange_rate: exchangeRate,
      local_amount: String(form.local_amount),
      amount_paid: String(amountPaidSubmit),
    }
    if (classFk !== null) bodyBase.class_id = classFk
    if (pmFk !== null) bodyBase.payment_method_id = pmFk
    if (depFk !== null) bodyBase.deposit_account_id = depFk
    if (notesVal) bodyBase.notes = notesVal
    bodyBase.tag_ids = Array.isArray(form.tag_ids) ? form.tag_ids : []
    Object.assign(bodyBase, paymentPortalFields)

    if (!showInvoiceLayout && isFullCredits) {
      bodyBase.inventory_channel = 'full_credits'
      bodyBase.credits_quantity = parseFloat(form.credits_quantity)
      bodyBase.inventory_screen_units = 1
    } else if (
      !showInvoiceLayout &&
      isDetailScreens &&
      detailPackageTrim &&
      !isDraftScreenSale
    ) {
      bodyBase.inventory_channel = 'screen_stock'
      bodyBase.package = detailPackageTrim
      bodyBase.inventory_screen_units = 1
      bodyBase.selected_screen_id = selectedScreenNum
    } else if (!isDraftScreenSale) {
      setError('Selecciona un servicio válido.')
      return
    }

    if (!showInvoiceLayout && isDetailScreens && !isDraftScreenSale) {
      if (!Number.isFinite(selectedScreenNum) || selectedScreenNum < 1) {
        setError('Selecciona una pantalla en la tabla.')
        return
      }
    }

    setError('')
    setNoStock(false)
    setSubmitting(true)

    try {
      if (isDraftScreenSale && draftRecharge) {
        const salePkg = String(draftRecharge.salePackage || '').trim()
        if (!salePkg) {
          throw new Error('Borrador sin paquete. Vuelve a preparar la recarga.')
        }
        const provDraft = String(draftRecharge.provider || '').trim()
        if (provDraft !== provider) {
          throw new Error('El borrador no coincide con el proveedor de la venta.')
        }
        const { salePackage: _discard, ...invPayload } = draftRecharge
        const invRes = await api.post('/api/v1/inventory/screens/', invPayload)
        const rows = Array.isArray(invRes.data) ? invRes.data : []
        const matchPkg = rows.filter(
          (r) => r && String(r.package || '').trim() === salePkg && r.status === 'free',
        )
        matchPkg.sort((a, b) => a.id - b.id)
        const pick = matchPkg[0]
        if (!pick?.id) {
          throw new Error(
            'Las pantallas se crearon pero no se pudo enlazar la venta. Revisa inventario.',
          )
        }
        const { data } = await postSale({
          ...bodyBase,
          inventory_channel: 'screen_stock',
          package: salePkg,
          selected_screen_id: pick.id,
        })
        await alertScreenStockSaleCredentialsFromResponse(data)
        setDraftRecharge(null)
        await refreshInventoryData()
        await Promise.resolve(onSuccess?.())
        return
      }

      const { data } = await postSale(bodyBase)
      await alertScreenStockSaleCredentialsFromResponse(data)
      await Promise.resolve(onSuccess?.())
    } catch (err) {
      logSaleSubmitError(err, isDraftScreenSale ? 'sale_submit_draft_flow' : 'sale_submit')

      const raw = err?.response?.data?.detail ?? err?.message ?? ''
      const detail = typeof raw === 'string' ? raw : JSON.stringify(raw)
      const ds = typeof detail === 'string' ? detail.toLowerCase() : ''

      if (!err?.response && (err?.message === 'Network Error' || err?.code === 'ERR_NETWORK')) {
        const base =
          typeof err?.config?.baseURL === 'string'
            ? err.config.baseURL
            : '(revisa VITE_API_BASE_URL o el backend en localhost:8000)'
        setError(
          `Sin conexión con el servidor (${base}). ¿Está arrancado el API? Revisa la consola (F12) para CORS / connection refused.`,
        )
      } else if (err?.response?.status === 404) {
        setError(`Ruta no encontrada (404): ${detail || 'Verifica que la API sea /api/v1/sales/'}`)
      } else if (
        err?.response?.status === 400 &&
        typeof detail === 'string' &&
        detail.toLowerCase().includes('costo del inventario')
      ) {
        const friendly = 'Error: El precio de venta ingresado es menor al costo del producto'
        setError(friendly)
        if (typeof onToast === 'function') {
          onToast(friendly, 'error')
        }
      } else if (
        err?.response?.status === 400 &&
        (ds.includes('stock') ||
          ds.includes('pantallas') ||
          ds.includes('créditos insuficientes') ||
          ds.includes('insuficientes'))
      ) {
        setNoStock(true)
        setError(typeof detail === 'string' && detail ? detail : 'Inventario insuficiente.')
      } else {
        setError(
          typeof detail === 'string' && detail
            ? detail
            : 'Error al registrar la venta. Inténtalo de nuevo.',
        )
      }

      if (isDraftScreenSale) {
        try {
          await refreshInventoryData()
        } catch (_) {
          /* ignore refresh errors */
        }
      }
    } finally {
      setSubmitting(false)
    }
  }

  const saleDateLabel = useMemo(() => {
    if (initialSale?.created_at) return formatShortDate(initialSale.created_at)
    return formatShortDateEcuador(new Date().toISOString())
  }, [initialSale?.created_at])

  const updateSaleLine = useCallback((id, patch) => {
    setLineItems((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }, [])

  const addSaleLine = useCallback(() => {
    setLineItems((prev) => [...prev, emptySaleLine()])
  }, [])

  const removeSaleLine = useCallback((id) => {
    setLineItems((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)))
  }, [])

  const refillNormalCredMemoryForClient = useCallback((clientRow) => {
    if (!clientRow?.id) return
    const { user: uMem, pass: pMem } = pickClientNormalCreditCreds(clientRow)
    setLineItems((prev) =>
      prev.map((li) => {
        const pk = String(li.productKey || '').trim()
        if (!pk.startsWith('cn:') && !pk.startsWith('fc:')) return li
        return {
          ...li,
          asignar_credenciales: true,
          cred_panel_expandido: true,
          iptv_usuario: uMem,
          iptv_password: pMem,
        }
      }),
    )
  }, [])

  const handleInvoiceLineProduct = useCallback(
    (lineId, productKey) => {
      setError('')
      setNoStock(false)
      const pk = String(productKey ?? '')
      if (pk === 'draft:pending') {
        setForm((prev) => ({ ...prev, service_value: DRAFT_PENDING_SCREEN }))
        updateSaleLine(lineId, {
          productKey: pk,
          description: '',
          rate: '',
          asignar_credenciales: false,
          cred_panel_expandido: false,
          iptv_usuario: '',
          iptv_password: '',
        })
        return
      }

      const descDefault =
        pk && pk !== '__loading_inv'
          ? defaultInvoiceLineDescriptionFromKey(pk, salesInventoryMetaByKey)
          : ''
      let patch = { productKey: pk, description: descDefault, rate: '' }

      if (pk.startsWith('cn:')) {
        const meta = salesInventoryMetaByKey[pk]
        const rp = meta?.reference_price
        const saleCur = normalizeCurrencyCode(form.currency || 'USD', 'USD')
        const refCur = normalizeCurrencyCode(meta?.reference_currency || 'USD', 'USD')
        if (rp != null && Number.isFinite(Number(rp)) && Number(rp) >= 0 && saleCur === refCur) {
          patch = { ...patch, rate: String(Number(rp)) }
        }
      }
      if (pk.startsWith('cp|') || pk.startsWith('ss:')) {
        const meta = salesInventoryMetaByKey[pk]
        const unitCost = parseDecimalInput(meta?.reference_cost_usd)
        patch = {
          ...patch,
          qty: '1',
          ...(Number.isFinite(unitCost) && unitCost > 0
            ? { inventory_unit_cost_usd: String(unitCost) }
            : { inventory_unit_cost_usd: '' }),
        }
      }
      const bodegaAuto = pk.startsWith('cp|') || pk.startsWith('ss:') || pk === 'draft:pending'
      const normalMem = pk.startsWith('cn:') || pk.startsWith('fc:')
      const cSel =
        pickedPortalUser ??
        (Array.isArray(clients) ? clients : []).find(
          (cl) => cl?.id != null && String(cl.id) === String(form.client_id),
        )
      if (bodegaAuto) {
        patch = {
          ...patch,
          asignar_credenciales: false,
          cred_panel_expandido: false,
          iptv_usuario: '',
          iptv_password: '',
        }
      } else if (normalMem) {
        const { user: uMem, pass: pMem } = pickClientNormalCreditCreds(cSel)
        patch = {
          ...patch,
          asignar_credenciales: true,
          cred_panel_expandido: true,
          iptv_usuario: uMem,
          iptv_password: pMem,
        }
      } else if (!pk) {
        patch = {
          ...patch,
          description: '',
          qty: '1',
          rate: '',
          asignar_credenciales: false,
          cred_panel_expandido: false,
          iptv_usuario: '',
          iptv_password: '',
        }
      }

      updateSaleLine(lineId, patch)
    },
    [clients, pickedPortalUser, form.client_id, form.currency, salesInventoryMetaByKey, updateSaleLine],
  )

  const openInvoiceRecharge = useCallback(() => {
    const pv = (form.provider || '').trim() || String(combinedProvidersList[0] || 'Flujo')
    openRechargeModal({
      defaultProvider: pv,
      defaultTab: 'Crédito por pantalla',
      onSaveDraft: (rechargeData) => {
        setDraftRecharge(rechargeData)
        setForm((prev) => ({
          ...prev,
          service_value: DRAFT_PENDING_SCREEN,
        }))
        setLineItems((prev) => {
          const next = [...prev]
          if (!next.length) next.push(emptySaleLine())
          next[0] = { ...next[0], productKey: 'draft:pending' }
          return next
        })
      },
    })
  }, [form.provider, combinedProvidersList, openRechargeModal])

  const inputCls = `w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800
                    focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition`

  const catalogBusy = !catalogReady
  const servicesDisabled = !form.provider?.trim() || catalogBusy

  const creditsKnown =
    creditsAvailableForProvider !== null && creditsAvailableForProvider !== undefined

  const providerOptions =
    Array.isArray(combinedProvidersList) && combinedProvidersList.length > 0
      ? combinedProvidersList
      : ['Flujo', 'Stella']

  const nuevaVentaProviderSelectOptions = useMemo(
    () => [
      { value: '', label: 'Selecciona proveedor…' },
      ...providerOptions.map((p) => ({ value: String(p), label: String(p) })),
    ],
    [providerOptions],
  )

  const safeClients = useMemo(() => {
    const list = Array.isArray(clients) ? clients.filter((c) => c != null && typeof c === 'object') : []
    list.sort((a, b) =>
      saleClientComboLabel(a, clientSearchMode).localeCompare(
        saleClientComboLabel(b, clientSearchMode),
        'es',
        { sensitivity: 'base' },
      ),
    )
    return list
  }, [clients, clientSearchMode])

  const unifiedClientDropdownRows = useMemo(() => {
    const q = clientPickerQuery.trim().toLowerCase()
    const crmRows = safeClients.filter((c) => !isPortalUnifiedBinding(c?.__saleBinding ?? 'crm_client'))
    const crmFiltered = !q
      ? crmRows
      : crmRows.filter((c) =>
          saleClientComboLabel(c, clientSearchMode).toLowerCase().includes(q),
        )
    if (isEditing) return crmFiltered
    return [...crmFiltered, ...portalPickRows]
  }, [safeClients, clientPickerQuery, clientSearchMode, isEditing, portalPickRows])

  const selectedClientObj =
    pickedPortalUser ??
    clients.find((c) => c?.id != null && String(c.id) === String(form.client_id))

  useEffect(() => {
    if (clientPickerInputFocusedRef.current) return
    const sel =
      pickedPortalUser ??
      clients.find((c) => c?.id != null && String(c.id) === String(form.client_id))
    setClientPickerQuery(sel ? saleClientComboLabel(sel, clientSearchMode) : '')
  }, [pickedPortalUser, form.client_id, clients, clientSearchMode])

  useEffect(() => {
    if (!clientPickerOpen) return undefined
    function onDocMouseDown(ev) {
      const root = clientPickerRootRef.current
      if (!root || root.contains(ev.target)) return
      setClientPickerOpen(false)
      clientPickerInputFocusedRef.current = false
      const sel =
        pickedPortalUser ??
        clients.find((c) => c?.id != null && String(c.id) === String(form.client_id))
      setClientPickerQuery(sel ? saleClientComboLabel(sel, clientSearchMode) : '')
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [clientPickerOpen, pickedPortalUser, form.client_id, clients, clientSearchMode])

  const pickSaleClient = useCallback(
    (c) => {
      if (!c?.id) return
      skipClientPickerBlurRef.current = true
      const bindingMode = c.__saleBinding ?? 'crm_client'
      if (isPortalUnifiedBinding(bindingMode)) {
        setPickedPortalUser(c)
        setForm((prev) => ({ ...prev, client_id: '' }))
      } else {
        setPickedPortalUser(null)
        setForm((prev) => ({ ...prev, client_id: String(c.id) }))
      }
      setClientPickerQuery(saleClientComboLabel(c, clientSearchMode))
      setClientPickerOpen(false)
      clientPickerInputFocusedRef.current = false
      setError('')
      setNoStock(false)
      refillNormalCredMemoryForClient(c)
    },
    [clientSearchMode, refillNormalCredMemoryForClient],
  )

  function handleAddNewClientFromPicker(ev) {
    ev.preventDefault()
    skipClientPickerBlurRef.current = true
    setPickedPortalUser(null)
    setClientPickerOpen(false)
    clientPickerInputFocusedRef.current = false
    openNewClient((createdClient) => {
      if (!createdClient?.id) return
      mergeClientSorted(createdClient)
      setForm((prev) => ({ ...prev, client_id: String(createdClient.id) }))
      setClientPickerQuery(saleClientComboLabel(createdClient, clientSearchMode))
      setError('')
      setNoStock(false)
    })
  }

  function onClientPickerFocus() {
    clientPickerInputFocusedRef.current = true
    setClientPickerOpen(true)
  }

  function onClientPickerBlur() {
    window.setTimeout(() => {
      if (skipClientPickerBlurRef.current) {
        skipClientPickerBlurRef.current = false
        return
      }
      clientPickerInputFocusedRef.current = false
      setClientPickerOpen(false)
      const selRow =
        pickedPortalUser ??
        (String(form.client_id ?? '').trim()
          ? clients.find((c) => c?.id != null && String(c.id) === String(form.client_id))
          : null)
      const expected = selRow ? saleClientComboLabel(selRow, clientSearchMode) : ''
      const q = clientPickerQuery.trim()
      if (!q) {
        setForm((prev) => ({ ...prev, client_id: '' }))
        setPickedPortalUser(null)
        setClientPickerQuery('')
        return
      }
      if (selRow && expected.toLowerCase() === q.toLowerCase()) return

      const applyPick = (row) => {
        const mode = row.__saleBinding ?? 'crm_client'
        if (isPortalUnifiedBinding(mode)) {
          setPickedPortalUser(row)
          setForm((prev) => ({ ...prev, client_id: '' }))
        } else {
          setPickedPortalUser(null)
          setForm((prev) => ({ ...prev, client_id: String(row.id) }))
        }
        setClientPickerQuery(saleClientComboLabel(row, clientSearchMode))
        refillNormalCredMemoryForClient(row)
      }

      const exact = unifiedClientDropdownRows.find(
        (c) => saleClientComboLabel(c, clientSearchMode).toLowerCase() === q.toLowerCase(),
      )
      if (exact) {
        applyPick(exact)
        return
      }
      const narrowed = unifiedClientDropdownRows.filter((c) =>
        saleClientComboLabel(c, clientSearchMode).toLowerCase().includes(q.toLowerCase()),
      )
      if (narrowed.length === 1) {
        applyPick(narrowed[0])
        return
      }
      if (selRow) setClientPickerQuery(expected)
      else {
        setForm((prev) => ({ ...prev, client_id: '' }))
        setPickedPortalUser(null)
        setClientPickerQuery('')
      }
    }, 150)
  }

  async function handleCopyCheckoutPortalBanner() {
    try {
      const kind = await copySalePaymentLink(initialSale)
      const msg =
        kind === 'portal' ? 'Enlace del portal del cliente copiado' : 'Enlace de pago de la venta copiado'
      if (typeof onToast === 'function') {
        onToast(msg)
      } else {
        await Swal.fire({
          toast: true,
          position: 'top-end',
          icon: 'success',
          title: msg,
          showConfirmButton: false,
          timer: 2200,
        })
      }
    } catch {
      if (typeof onToast === 'function') {
        onToast('No se pudo copiar el enlace.', 'error')
      } else {
        await Swal.fire({ icon: 'error', title: 'No se pudo copiar', timer: 2500 })
      }
    }
  }

  
  return (
    <>
    <div className="fixed inset-0 z-[55] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-6xl bg-white rounded-2xl shadow-2xl z-10 max-h-[95vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-gray-100 sticky top-0 bg-white rounded-t-2xl z-10">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-gray-900">
              {saleIsViewOnly ? 'Ver venta (solo lectura)' : isEditing ? 'Editar venta' : 'Nueva Venta'}
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {saleIsViewOnly
                ? 'No se pueden modificar los datos ni el inventario vinculado.'
                : isEditing
                  ? 'Actualiza los datos de la venta y guarda los cambios.'
                  : 'Factura rápida: líneas, etiquetas y depósitos estilo QuickBooks.'}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-0.5">
            {isEditing &&
            String(initialSale?.status ?? '').toLowerCase().trim() === 'pending' &&
            (initialSale?.client_portal_token || initialSale?.payment_token) ? (
              <button
                type="button"
                onClick={handleCopyCheckoutPortalBanner}
                title={
                  initialSale?.client_portal_token
                    ? 'Copiar enlace del portal del cliente'
                    : 'Copiar enlace de pago (checkout)'
                }
                className="checkout-pay-link-blink hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-lg
                           text-[11px] font-bold uppercase tracking-wide
                           bg-gradient-to-r from-sky-600 to-cyan-500 text-white border border-white/25
                           hover:from-sky-700 hover:to-cyan-600 shadow-sm whitespace-nowrap"
              >
                <LinkIcon size={14} strokeWidth={2.35} aria-hidden />
                <span>Copiar enlace pagado</span>
                <Copy size={13} strokeWidth={2.35} aria-hidden />
              </button>
            ) : null}
            {/* En pantallas muy estrechas el botón vive mejor debajo del título */}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors shrink-0"
              aria-label="Cerrar"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Móvil: botón público debajo del encabezado para mantener texto legible */}
        {isEditing &&
        String(initialSale?.status ?? '').toLowerCase().trim() === 'pending' &&
        (initialSale?.client_portal_token || initialSale?.payment_token) ? (
          <div className="sm:hidden px-6 pt-3 pb-2 border-b border-gray-50 bg-white">
            <button
              type="button"
              onClick={handleCopyCheckoutPortalBanner}
              title={
                initialSale?.client_portal_token
                  ? 'Copiar enlace del portal del cliente'
                  : 'Copiar enlace de pago (checkout)'
              }
              className="checkout-pay-link-blink w-full inline-flex items-center justify-center gap-2 px-3 py-3 rounded-xl
                         text-[12px] font-bold uppercase tracking-wide
                         bg-gradient-to-r from-sky-600 to-cyan-500 text-white border border-white/25
                         hover:from-sky-700 hover:to-cyan-600 shadow-sm"
            >
              <LinkIcon size={15} strokeWidth={2.35} aria-hidden />
              <span>Copiar enlace pagado</span>
              <Copy size={14} strokeWidth={2.35} aria-hidden />
            </button>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {saleIsViewOnly && (
            <div
              className="rounded-xl border border-slate-200 bg-slate-50 text-slate-800 text-sm px-4 py-3
                         ring-1 ring-slate-100"
            >
              <span className="font-semibold text-slate-900">Consulta auditoría:</span>{' '}
              los campos están bloqueados. Usa{' '}
              <span className="font-semibold">Cerrar</span> para salir.
            </div>
          )}

          {saleIsViewOnly && String(initialSale?.status ?? '').toLowerCase() === 'rejected' && (
            <div className="rounded-xl border border-red-200 bg-red-50/90 px-4 py-3 text-sm text-slate-800">
              <p className="text-xs font-bold uppercase tracking-wide text-red-800 mb-2">
                Motivo del rechazo
              </p>
              {String(initialSale?.rejection_reason ?? '').trim() ? (
                <p className="whitespace-pre-wrap break-words text-slate-900">
                  {String(initialSale?.rejection_reason ?? '').trim()}
                </p>
              ) : (
                <p className="text-xs text-slate-500">No se registró texto de motivo.</p>
              )}
              {initialSale?.rejection_image_url ? (
                <div className="mt-3 flex flex-col sm:flex-row sm:items-start gap-3">
                  <div className="min-w-0 space-y-2">
                    <a
                      href={absMediaUrl(initialSale?.rejection_image_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex text-xs font-semibold text-red-800 hover:text-red-950 underline underline-offset-2"
                    >
                      Ver evidencia en nueva pestaña
                    </a>
                  </div>
                  {(() => {
                    const evUrl = initialSale?.rejection_image_url
                    const p = String(evUrl ?? '').split('?')[0] || ''
                    const looksImg = /\.(jpe?g|png|gif|webp)$/i.test(p)
                    if (!looksImg) return null
                    return (
                      <a
                        href={absMediaUrl(evUrl)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block shrink-0"
                        title="Previsualización"
                      >
                        <img
                          src={absMediaUrl(evUrl)}
                          alt="Evidencia de rechazo"
                          className="max-h-44 max-w-full rounded-lg border border-red-200 object-contain bg-white"
                        />
                      </a>
                    )
                  })()}
                </div>
              ) : null}
            </div>
          )}

          <fieldset
            disabled={saleIsViewOnly}
            className="min-w-0 border-0 p-0 mx-0 space-y-4 disabled:opacity-95"
          >
          {isEditing && isLegacyPending && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 text-slate-800 text-xs px-4 py-3">
              Esta venta no tiene inventario ERP (créditos o bodega) vinculado. Solo puedes ajustar cliente,
              producto de catálogo, clase, pago, montos y moneda.
            </div>
          )}

          {noStock && (
            <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 text-amber-800
                            text-sm rounded-xl px-4 py-3">
              <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-500" />
              <div>
                <p className="font-semibold">Inventario insuficiente</p>
                <p className="text-xs mt-0.5 text-amber-700">
                  Verifica créditos de Recarga Total o pantallas disponibles para el proveedor y paquete elegidos.
                </p>
              </div>
            </div>
          )}

          <div className="space-y-4">
          <div>
            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">Modo de búsqueda de cliente:</label>
              <div className="flex space-x-2">
                <button
                  type="button"
                  onClick={() => setClientSearchMode('nombre')}
                  className={`px-4 py-1 rounded-full text-sm font-medium transition-colors ${clientSearchMode === 'nombre' ? 'bg-blue-600 text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >
                  👤 Por Nombre
                </button>
                <button
                  type="button"
                  onClick={() => setClientSearchMode('usuario')}
                  className={`px-4 py-1 rounded-full text-sm font-medium transition-colors ${clientSearchMode === 'usuario' ? 'bg-blue-600 text-white shadow' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >
                  📺 Por Usuario IPTV
                </button>
              </div>
            </div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Cliente</label>
            {!isEditing && portalPickError && (
              <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700 space-y-2 mb-2">
                <p>{portalPickError}</p>
                <button
                  type="button"
                  className="text-blue-700 font-medium hover:underline"
                  onClick={refreshClients}
                >
                  Reintentar
                </button>
              </div>
            )}
            <div className="relative" ref={clientPickerRootRef}>
                <div className="relative">
                  <input
                    type="text"
                    role="combobox"
                    aria-expanded={clientPickerOpen}
                    aria-autocomplete="list"
                    aria-controls="sale-client-combobox-list"
                    id="sale-client-combobox-input"
                    autoComplete="off"
                    value={clientPickerQuery}
                    onChange={(e) => {
                      setClientPickerQuery(e.target.value)
                      setPickedPortalUser((prev) => (prev ? null : prev))
                      setClientPickerOpen(true)
                      setError('')
                      setNoStock(false)
                    }}
                    onFocus={onClientPickerFocus}
                    onBlur={onClientPickerBlur}
                    placeholder="Buscar cliente…"
                    className={`${inputCls} pr-9`}
                  />
                  <ChevronDown
                    size={16}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
                    aria-hidden
                  />
                </div>
                {clientPickerOpen && (
                  <ul
                    id="sale-client-combobox-list"
                    role="listbox"
                    className="absolute left-0 right-0 z-[60] mt-1 max-h-52 overflow-auto rounded-xl border border-gray-200 bg-white py-1 shadow-lg ring-1 ring-black/5"
                  >
                    <li role="presentation">
                      <button
                        type="button"
                        role="option"
                        className="w-full text-left px-3 py-2 text-sm font-semibold text-blue-600 hover:bg-blue-50"
                        onMouseDown={handleAddNewClientFromPicker}
                      >
                        + Agregar nuevo
                      </button>
                    </li>
                    {!isEditing && portalPickLoading && (
                      <li className="px-3 py-2 text-xs text-gray-400 flex items-center gap-2">
                        <span className="w-3.5 h-3.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin shrink-0" />
                        Buscando…
                      </li>
                    )}
                    {unifiedClientDropdownRows.map((c) => {
                      const binding = c?.__saleBinding ?? 'crm_client'
                      const isPortalSel = isPortalUnifiedBinding(binding)
                      const isSelected =
                        (isPortalSel &&
                          pickedPortalUser &&
                          Number(pickedPortalUser.id) === Number(c?.id)) ||
                        (!pickedPortalUser &&
                          !isPortalSel &&
                          String(form.client_id) === String(c?.id))
                      return (
                        <li key={`${binding}-${c?.id ?? ''}`} role="presentation">
                          <button
                            type="button"
                            role="option"
                            className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${
                              isSelected ? 'bg-blue-50 text-blue-900 font-medium' : 'text-gray-800'
                            }`}
                            onMouseDown={(e) => {
                              e.preventDefault()
                              pickSaleClient(c)
                            }}
                          >
                            {saleClientComboLabel(c, clientSearchMode)}
                          </button>
                        </li>
                      )
                    })}
                    {unifiedClientDropdownRows.length === 0 && !portalPickLoading && (
                      <li className="px-3 py-2 text-xs text-gray-400">
                        {!isEditing && debouncedClientPickQuery.trim()
                          ? 'No se encontraron usuarios'
                          : 'Sin coincidencias'}
                      </li>
                    )}
                  </ul>
                )}
              </div>
            {selectedClientObj && selectedClientObj.email && (
              <div className="mt-2 mb-4 p-2 bg-gray-50 border border-gray-200 rounded-md">
                <span className="text-sm text-gray-600">
                  📧 {selectedClientObj.email}
                </span>
              </div>
            )}
          </div>

          {showInvoiceLayout && (
            <NuevaVentaInvoiceSection
              saleDateLabel={saleDateLabel}
              formTagIds={form.tag_ids}
              onTagIdsChange={(ids) => setForm((p) => ({ ...p, tag_ids: ids }))}
              onOpenTagsAdmin={() => setTagsAdminOpen(true)}
              submitting={submitting}
              lineItems={lineItems}
              invoiceProductOptions={invoiceProductOptions}
              invoiceProductOptionsLoading={inventorySalesOptsLoading}
              saleTagsReloadKey={saleTagsReloadKey}
              bumpSaleTagsReload={bumpSaleTagsReload}
              inputCls={inputCls}
              handleInvoiceLineProduct={handleInvoiceLineProduct}
              updateSaleLine={updateSaleLine}
              addSaleLine={addSaleLine}
              removeSaleLine={removeSaleLine}
              openInvoiceRecharge={openInvoiceRecharge}
              isDraftScreenSale={isDraftScreenSale}
              draftRecharge={draftRecharge}
              form={form}
              handleChange={handleChange}
              transactionClassSelectOptions={transactionClassSelectOptions}
              onOpenNewClassForLine={(lineId) => {
                newClassTargetLineIdRef.current = lineId
                setNewClassModalOpen(true)
              }}
              cobroCurrencyOptions={cobroCurrencyOptions}
              linesSubtotal={linesSubtotal}
              saleCurrencyCode={saleCurrencyCode}
              balanceDueReceivable={balanceDueReceivable}
              showDepositPaymentFields={showDepositPaymentFields}
              salePaymentMethodOptions={salePaymentMethodOptions}
              depositAccountOptionsByMethodId={depositAccountOptionsByMethodId}
              selectedPaymentMethodIds={selectedPaymentMethodIds}
              togglePaymentMethodId={togglePaymentMethodId}
              selectedDepositAccountIds={selectedDepositAccountIds}
              toggleDepositAccountId={toggleDepositAccountId}
              depositCurrencyMismatch={depositCurrencyMismatch}
              depositAccountCurrencyCode={depositAccountCurrencyCode}
              fifoCpCredPeekByPk={fifoCpCredPeekByPk}
              linkedPayments={linkedPayments}
              onOpenLinkedPayment={handleOpenLinkedPayment}
              pendingReviewPayments={pendingReviewPayments}
              onOpenPendingReviewPayment={handleOpenPendingReviewPayment}
              saleIsViewOnly={saleIsViewOnly}
            />
          )}

          {!showInvoiceLayout && (
            <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Proveedor IPTV <span className="text-[10px] text-gray-500 font-normal">(define el inventario disponible)</span>
            </label>
            {loadFinished ? null : (
              <p className="text-[11px] text-gray-400 mb-1.5">
                Sincronizando inventario con el servidor…
              </p>
            )}
            <SearchableSelect
              value={form.provider || ''}
              onChange={(v) =>
                handleChange({ target: { name: 'provider', value: v != null ? String(v) : '' } })
              }
              options={nuevaVentaProviderSelectOptions}
              disabled={catalogBusy || (isEditing && isLegacyPending)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              <span className="inline-flex items-center gap-1.5">
                <Package size={13} className="text-blue-500" />
                Servicios
              </span>
            </label>
            {servicesDisabled && !inventoryLoadFailed && (
              <p className="text-[11px] text-gray-500 mb-2">
                {catalogBusy ? 'Esperando catálogo de inventario…' : 'Elige proveedor antes de seleccionar un servicio.'}
              </p>
            )}
            {inventoryLoadFailed && (
              <p className="text-[11px] text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-1.5 mb-2">
                No fue posible cargar inventario para este proveedor. Reintenta sincronizar.
                <button
                  type="button"
                  className="ml-2 text-blue-700 font-medium underline"
                  onClick={() => refreshInventoryData()}
                >
                  Reintentar
                </button>
              </p>
            )}
            <SearchableSelect
              value={form.provider ? form.service_value : SERVICE_EMPTY}
              onChange={handleServiceValuePick}
              options={nuevaVentaServiceSelectOptions}
              disabled={servicesDisabled || !form.provider?.trim() || (isEditing && isLegacyPending)}
              className={servicesDisabled ? 'opacity-70' : undefined}
            />
            {isDraftScreenSale && draftRecharge && (
              <p className="mt-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                La recarga irá al inventario <strong>solo</strong> al pulsar{' '}
                <strong>Registrar Venta</strong>. Si cierras el modal sin vender, no se creará stock.
              </p>
            )}
            {isDetailScreens &&
              form.provider?.trim() &&
              !isDraftScreenSale &&
              !isFullCredits &&
              catalogReady && (
              <div className="mt-3 space-y-2">
                <label className="block text-xs font-medium text-gray-600">Paquete de bodega</label>
                <SearchableSelect
                  value={
                    form.detail_package != null && form.detail_package !== ''
                      ? String(form.detail_package)
                      : ''
                  }
                  onChange={(v) =>
                    handleChange({ target: { name: 'detail_package', value: v != null ? String(v) : '' } })
                  }
                  options={nuevaVentaDetailPackageSelectOptions}
                  disabled={catalogBusy || (isEditing && isLegacyPending)}
                />
                {detailPackageTrim ? (
                  <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                    <div className="max-h-48 overflow-y-auto">
                      <table className="w-full text-xs border-collapse">
                        <thead className="bg-gray-50 text-gray-600 sticky top-0 z-[1] shadow-sm">
                          <tr>
                            <th className="text-left px-2 py-2 font-medium w-10 border-b border-gray-100" />
                            <th className="text-left px-2 py-2 font-medium border-b border-gray-100">Usuario</th>
                            <th className="text-left px-2 py-2 font-medium border-b border-gray-100">Lote / Creación</th>
                            <th className="text-left px-2 py-2 font-medium border-b border-gray-100">Vencimiento</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailScreensLoading ? (
                            <tr>
                              <td colSpan={4} className="px-2 py-6 text-center text-gray-500">
                                Cargando pantallas disponibles…
                              </td>
                            </tr>
                          ) : detailScreensRows.length === 0 ? (
                            <tr>
                              <td colSpan={4} className="px-2 py-6 text-center text-amber-900 bg-amber-50/50">
                                No hay pantallas libres para este paquete.
                              </td>
                            </tr>
                          ) : (
                            detailScreensRows.map((row) => {
                              const idStr = String(row.id)
                              const sel = form.selected_screen_stock_id === idStr
                              const pkgName = String(row.package ?? detailPackageTrim)
                              return (
                                <tr
                                  key={row.id}
                                  onClick={() =>
                                    setForm((prev) => ({ ...prev, selected_screen_stock_id: idStr }))
                                  }
                                  onKeyDown={(ev) => {
                                    if (ev.key === 'Enter' || ev.key === ' ') {
                                      ev.preventDefault()
                                      setForm((prev) => ({ ...prev, selected_screen_stock_id: idStr }))
                                    }
                                  }}
                                  tabIndex={0}
                                  role="radio"
                                  aria-checked={sel}
                                  className={`border-t border-gray-100 outline-none cursor-pointer transition-colors ${
                                    sel ? 'bg-blue-50' : 'hover:bg-slate-50'
                                  }`}
                                >
                                  <td className="px-2 py-2 align-middle">
                                    <input
                                      type="radio"
                                      name="selected_screen_stock_id"
                                      value={idStr}
                                      checked={sel}
                                      onChange={handleChange}
                                      onClick={(ev) => ev.stopPropagation()}
                                      className="accent-blue-600"
                                    />
                                  </td>
                                  <td className="px-2 py-2 align-middle font-mono text-[11px] text-gray-900">
                                    {screenStockIptvUsername(row) || '—'}
                                  </td>
                                  <td className="px-2 py-2 align-middle text-[11px] text-gray-700">
                                    {formatLotCreationColumn(row)}
                                  </td>
                                  <td className="px-2 py-2 align-middle text-[11px] text-gray-700">
                                    {formatExpirationForPackage(pkgName, row.created_at)}
                                  </td>
                                </tr>
                              )
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
                {!detailScreensLoading && detailPackageTrim && detailScreensRows.length > 0 && (
                  <p className="text-[11px] text-gray-500 leading-snug">
                    Elige la fila exacta a vender (obligatorio). Las credenciales corresponden a la pantalla
                    seleccionada.
                  </p>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Clase (Oculto/Opcional){' '}
              <span className="text-[10px] text-gray-500 font-normal">(informes QuickBooks-style)</span>
            </label>
            <SearchableSelect
              value={form.transaction_class_id}
              onChange={(v) =>
                handleChange({ target: { name: 'transaction_class_id', value: String(v) } })
              }
              options={transactionClassSelectOptions}
              placeholder="Sin clase"
              clearLabel="Sin clase"
              onAddNew={() => setNewClassModalOpen(true)}
              disabled={submitting}
            />
          </div>
          </>
          )}

          </div>

          {!showInvoiceLayout && (
          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <label className="block text-sm font-medium text-gray-700">
                Etiquetas{' '}
                <span className="text-[10px] text-gray-500 font-normal">(opcional · QuickBooks)</span>
              </label>
              <button
                type="button"
                className="text-xs font-medium text-blue-600 hover:text-blue-800 shrink-0 bg-transparent border-0 cursor-pointer p-0"
                onClick={() => setTagsAdminOpen(true)}
              >
                Administrar etiquetas
              </button>
            </div>
            <SaleQBTagsCreatable
              key={saleTagsReloadKey}
              value={form.tag_ids}
              onChange={(ids) => setForm((p) => ({ ...p, tag_ids: ids }))}
              disabled={submitting}
              onCatalogRefresh={bumpSaleTagsReload}
            />
          </div>
          )}

          {!showInvoiceLayout && (
          <div className="space-y-4">
          {isFullCredits && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Cantidad de créditos a vender{' '}
                <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                name="credits_quantity"
                min="0"
                step="any"
                value={form.credits_quantity}
                onChange={handleChange}
                required
                placeholder="0"
                className={inputCls}
              />
              <p className="mt-1 text-[11px] text-gray-500">
                Disponibles en inventario ({form.provider || 'proveedor'}):{' '}
                <span className="font-semibold text-gray-800">
                  {catalogBusy || !creditsKnown
                    ? 'cargando…'
                    : (creditsAvailableForProvider ?? 0).toLocaleString('es-ES', { maximumFractionDigits: 4 })}
                </span>
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Monto ({form.currency})
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs font-medium">
                <CurrencyFlag code={form.currency} />
              </span>
              <input
                type="number"
                name="local_amount"
                value={form.local_amount}
                onChange={handleChange}
                required
                min="0.01"
                step="0.01"
                placeholder="0.00"
                className={`${inputCls} pl-8`}
              />
            </div>
          </div>

          {isEditing && (
            <FinancialSummarySidebar
              subtotal={localAmount}
              currency={saleCurrencyCode}
              linkedPayments={linkedPayments}
              pendingReviewPayments={pendingReviewPayments}
              balanceDue={balanceDueReceivable}
              autoAppliedCredit={autoAppliedFromCredit}
              apiOrigin={apiOrigin}
              onOpenLinkedPayment={handleOpenLinkedPayment}
              onOpenPendingReviewPayment={handleOpenPendingReviewPayment}
            />
          )}

          <div>
            {showDeclaredDepositField ? (
              <>
                {showIllegibleDepositAlert ? (
                  <div className="mb-2.5">
                    <IllegibleReceiptAlert className="w-full" layout="block" />
                  </div>
                ) : null}
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Depósito declarado ({form.currency})
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs font-medium">
                    <CurrencyFlag code={form.currency} />
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={declaredDepositStr}
                    onChange={(e) => setDeclaredDepositStr(e.target.value)}
                    disabled={submitting}
                    placeholder="0.00"
                    className={`${inputCls} pl-8`}
                  />
                </div>
                <p className="mt-1 text-xs text-gray-600 leading-snug">
                  Corrija aquí si la lectura automática del comprobante fue incorrecta. Al guardar, el monto se
                  aplicará al cobro en revisión.
                </p>
                {Array.isArray(pendingReviewPayments) && pendingReviewPayments.length > 0 ? (
                  <OcrSecurityBadges
                    className="mt-2"
                    {...pickOcrSecurityFlags(
                      pendingReviewPayments.find((p) => p?.receipt_file_url) ||
                        pendingReviewPayments[0],
                    )}
                    portal_declared_payment_amount={
                      pendingReviewPayments[0]?.amount_applied_to_sale ??
                      pendingReviewPayments[0]?.amount
                    }
                    amount={
                      pendingReviewPayments[0]?.amount_applied_to_sale ??
                      pendingReviewPayments[0]?.amount
                    }
                  />
                ) : null}
              </>
            ) : (
              <>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Importe del depósito ({form.currency})
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs font-medium">
                    <CurrencyFlag code={form.currency} />
                  </span>
                  <input
                    type="number"
                    name="amount_paid"
                    value={form.amount_paid}
                    onChange={handleChange}
                    min="0"
                    step="0.01"
                    readOnly={depositLocked}
                    disabled={depositLocked}
                    placeholder={form.local_amount ? String(form.local_amount) : '0.00'}
                    className={`${inputCls} pl-8 ${depositLocked ? 'bg-gray-50 text-gray-700 cursor-not-allowed' : ''}`}
                  />
                </div>
                {!isEditing && (
                  <p className="mt-1 text-xs text-gray-600 leading-snug">
                    Saldo pendiente (CxC):{' '}
                    <span className="font-semibold tabular-nums">
                      {balanceDueReceivable.toLocaleString('es-ES', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}{' '}
                      {saleCurrencyCode}
                    </span>
                  </p>
                )}
              </>
            )}
          </div>

          {showDepositPaymentFields && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Métodos de pago y cuentas de depósito{' '}
              <span className="text-[10px] text-gray-500 font-normal">(opcional · portal del cliente)</span>
            </label>
            <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
              {salePaymentMethodOptions.length === 0 ? (
                <p className="text-xs text-gray-500 px-3 py-2">No hay métodos de pago activos.</p>
              ) : (
                salePaymentMethodOptions.map((opt) => {
                  const checked = selectedPaymentMethodIds.some((x) => Number(x) === Number(opt.value))
                  const acctOpts = depositAccountOptionsByMethodId[String(opt.value)] ?? []
                  return (
                    <div key={opt.value} className="px-3 py-2.5">
                      <label className="flex items-center gap-2.5 cursor-pointer hover:bg-gray-50 -mx-1 px-1 py-1 rounded">
                        <input
                          type="checkbox"
                          className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 shrink-0"
                          checked={checked}
                          disabled={submitting}
                          onChange={() => togglePaymentMethodId(opt.value)}
                        />
                        <span className="text-sm font-medium text-gray-900">{opt.label}</span>
                      </label>
                      {checked && (
                        <div className="ml-6 pl-2 border-l-2 border-gray-200 mt-2 flex flex-col gap-2">
                          {acctOpts.length === 0 ? (
                            <p className="text-sm text-gray-500">No hay cuentas vinculadas a este método.</p>
                          ) : (
                            acctOpts.map((aOpt) => {
                              const accChecked = selectedDepositAccountIds.some(
                                (x) => Number(x) === Number(aOpt.value),
                              )
                              return (
                                <label
                                  key={aOpt.value}
                                  className={`flex items-center gap-2 text-sm text-gray-600 ${
                                    aOpt.disabled
                                      ? 'opacity-50 cursor-not-allowed'
                                      : 'cursor-pointer hover:text-gray-800'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 shrink-0"
                                    checked={accChecked}
                                    disabled={submitting || aOpt.disabled}
                                    onChange={() => toggleDepositAccountId(aOpt.value, aOpt.disabled)}
                                  />
                                  <span>{aOpt.label}</span>
                                </label>
                              )
                            })
                          )}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
            <p className="mt-1 text-[11px] text-gray-500">
              Solo cuentas de efectivo y equivalentes (banco, billeteras, etc.). El cliente verá en el portal solo lo
              que marque aquí.
            </p>
            {depositCurrencyMismatch && (
              <p className="mt-1 text-xs text-red-600 font-medium leading-snug">
                La moneda de cobro ({saleCurrencyCode}) no coincide con la moneda de alguna cuenta elegida (
                {depositAccountCurrencyCode}).
              </p>
            )}
          </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Moneda de cobro</label>
            <SearchableSelect
              value={form.currency}
              onChange={(v) => handleChange({ target: { name: 'currency', value: String(v) } })}
              options={cobroCurrencyOptions}
              hideClear
              disabled={submitting}
            />
            <p className="mt-1 text-[11px] text-gray-500">
              Se actualiza al marcar una cuenta de depósito según su moneda en el plan de cuentas; la tasa se
              completa con el último tipo de cambio usado.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              <span className="inline-flex items-center gap-1">
                <RefreshCw size={11} className="text-gray-400" />
                Tipo de cambio (a USD) — 1 USD = X {form.currency}
              </span>
            </label>
            <input
              type="number"
              name="exchange_rate"
              value={form.exchange_rate}
              onChange={handleChange}
              required
              min="0.0001"
              step="any"
              placeholder="1.00"
              disabled={form.currency === 'USD'}
              className={`${inputCls} ${form.currency === 'USD' ? 'bg-gray-50 text-gray-400 cursor-not-allowed' : ''}`}
            />
          </div>
          </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Nota o comentario <span className="text-[10px] text-gray-500 font-normal">(opcional)</span>
            </label>
            <textarea
              name="notes"
              value={form.notes}
              onChange={handleChange}
              rows={4}
              placeholder="Escribe detalles adicionales de esta venta..."
              className={`${inputCls} h-24 min-h-[6rem] resize-y border-gray-200/90`}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">
              Comprobante de pago <span className="text-[11px] text-gray-500 font-normal">(opcional)</span>
            </label>
            <input
              type="file"
              accept="image/*,.pdf,application/pdf"
              className="hidden"
              id="sale-receipt-input"
              onChange={onReceiptFileChosen}
            />

            {(() => {
              const showPdfPreview =
                (receiptFile && receiptFile.type === 'application/pdf') ||
                (!receiptFile &&
                  existingReceiptAbsoluteUrl &&
                  receiptLooksPdf(null, initialSale?.receipt_url))
              const showImagePreview =
                (receiptFile && receiptFile.type !== 'application/pdf') ||
                (!receiptFile &&
                  existingReceiptAbsoluteUrl &&
                  !receiptLooksPdf(null, initialSale?.receipt_url))
              const hasPreview =
                receiptFile ||
                (!receiptServerCleared && isEditing && initialSale?.receipt_url)

              if (!hasPreview) {
                return (
                  <div className="flex flex-col items-stretch gap-1">
                    <button
                      type="button"
                      onClick={() => document.getElementById('sale-receipt-input')?.click()}
                      className="w-full py-2.5 px-4 rounded-lg border border-blue-500 text-blue-600 text-sm font-medium
                                 bg-white hover:bg-blue-50/80 transition-colors text-center"
                    >
                      Añadir archivo adjunto
                    </button>
                    <p className="text-center text-[11px] text-gray-500">Tamaño máximo de archivo: 20 MB</p>
                  </div>
                )
              }

              const imgSrc =
                receiptFile && receiptFile.type !== 'application/pdf'
                  ? receiptBlobImgUrl
                  : !receiptFile
                    ? existingReceiptAbsoluteUrl
                    : null

              return (
                <div className="flex items-start gap-3">
                  <div className="shrink-0">
                    {showPdfPreview ? (
                      <div className="w-20 h-20 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center">
                        <FileText size={36} className="text-red-600" aria-hidden />
                      </div>
                    ) : showImagePreview && imgSrc ? (
                      <img
                        src={imgSrc}
                        alt="Comprobante"
                        className="w-20 h-20 object-cover rounded-lg border border-gray-200 bg-white"
                      />
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-2 min-w-0 flex-1">
                    {receiptFile && (
                      <span className="text-xs text-gray-600 truncate" title={receiptFile.name}>
                        {receiptFile.name}
                      </span>
                    )}
                    {!receiptFile && existingReceiptAbsoluteUrl && (
                      <span className="text-xs text-gray-500">Comprobante guardado</span>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {existingReceiptAbsoluteUrl ? (
                        <a
                          href={existingReceiptAbsoluteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600
                                     hover:text-blue-800 hover:bg-blue-50 px-2 py-1 rounded-lg transition-colors border border-blue-100"
                        >
                          <Eye size={14} aria-hidden />
                          Ver comprobante
                        </a>
                      ) : null}
                      <button
                        type="button"
                        onClick={clearReceiptAttachment}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600
                                   hover:text-red-700 hover:bg-red-50 px-2 py-1 rounded-lg transition-colors"
                      >
                        <Trash2 size={14} aria-hidden />
                        Eliminar
                      </button>
                    </div>
                  </div>
                </div>
              )
            })()}
          </div>

          {!isEditing && (
            <p className="text-[11px] text-amber-800">
              La venta se registrará como <strong>Pendiente</strong> hasta que un administrador la active en la lista.
            </p>
          )}

          {localAmount > 0 && (
            <div
              className={`rounded-xl px-4 py-3 border flex items-center gap-3 ${
                form.currency === 'USD' ? 'bg-green-50 border-green-100' : 'bg-blue-50 border-blue-100'
              }`}
            >
              <DollarSign size={16} className={form.currency === 'USD' ? 'text-green-500' : 'text-blue-500'} />
              <div className="text-sm">
                <span className="font-semibold text-gray-800">
                  Total a cobrar:{' '}
                  {new Intl.NumberFormat('es-ES', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  }).format(localAmount)}{' '}
                  {form.currency}
                </span>
                {form.currency !== 'USD' && (
                  <span className="text-gray-500 ml-1.5 text-xs font-normal">
                    ≈{' '}
                    <span className="font-medium text-gray-600">
                      ${usdEquiv.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
                    </span>{' '}
                    <span className="text-gray-400">referencia contable</span>
                  </span>
                )}
              </div>
            </div>
          )}

          {blockSaleForCost && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900 text-sm rounded-xl px-4 py-3">
              <AlertTriangle size={16} className="shrink-0 mt-0.5 text-amber-600" />
              <div className="text-xs leading-relaxed">
                <p className="font-semibold">Precio demasiado bajo respecto al costo</p>
                <p className="mt-1 text-amber-800">
                  El total contable en USD debe ser <strong>mayor</strong> al costo estimado del inventario (
                  <strong>
                    $
                    {estimatedInventoryCostUsd.toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 4,
                    })}{' '}
                    USD
                  </strong>
                  ). Ajusta el monto o la tasa de cambio.
                </p>
              </div>
            </div>
          )}

          </fieldset>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-100 text-red-600
                            text-sm rounded-xl px-4 py-3">
              <X size={14} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800
                         bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
            >
              {saleIsViewOnly ? 'Cerrar' : 'Cancelar'}
            </button>
            {!saleIsViewOnly && (
              <button
                type="submit"
                disabled={
                  submitting ||
                  !(pickedPortalUser?.id ?? String(form.client_id ?? '').trim()) ||
                  blockSaleForCost ||
                  inventoryRequiredIncomplete ||
                  depositCurrencyMismatch ||
                  amountPaidInvalid
                }
                className="px-5 py-2 text-sm font-semibold text-white bg-blue-600
                           hover:bg-blue-700 active:bg-blue-800 disabled:opacity-60
                           disabled:cursor-not-allowed rounded-xl transition-colors
                           flex items-center gap-2 shadow-sm shadow-blue-200"
              >
                {submitting ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Procesando…
                  </>
                ) : isEditing ? (
                  'Guardar'
                ) : (
                  'Registrar Venta'
                )}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>

      {newClassModalOpen && (
        <NewTransactionClassModal
          onClose={() => {
            newClassTargetLineIdRef.current = null
            setNewClassModalOpen(false)
          }}
          onCreated={(data) => {
            if (!data?.id) return
            setTransactionClasses((prev) => {
              const list = Array.isArray(prev) ? prev : []
              const merged = [...list.filter((x) => x?.id !== data.id), data]
              merged.sort((a, b) =>
                String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'es', {
                  sensitivity: 'base',
                }),
              )
              return merged
            })
            const lid = newClassTargetLineIdRef.current
            newClassTargetLineIdRef.current = null
            if (lid) {
              updateSaleLine(lid, {
                transaction_class_id: String(data.id),
                clase_id: String(data.id),
              })
            } else {
              setForm((p) => ({ ...p, transaction_class_id: String(data.id) }))
            }
          }}
        />
      )}
      {tagsAdminOpen && (
        <TagsManagerPanel
          open
          mode="slideover"
          zClassName="z-[90]"
          onClose={() => {
            setTagsAdminOpen(false)
            bumpSaleTagsReload()
          }}
          onCatalogChanged={bumpSaleTagsReload}
        />
      )}
    </>
  )
}
