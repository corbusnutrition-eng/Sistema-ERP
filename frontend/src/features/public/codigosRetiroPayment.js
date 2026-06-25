/** Integración portal ↔ widget externo «Códigos de Retiro». */

import axios from 'axios'
import erpApi from '../../api/axios'

const DEFAULT_CODIGOS_RETIRO_BASE = 'https://codigos-retiro.onrender.com'
const CODIGOS_RETIRO_WIDGET_PATH = '/widget_retiro'

function parseEnvBool(raw, defaultValue = false) {
  if (raw == null || String(raw).trim() === '') return defaultValue
  const s = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'si', 'sí', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return defaultValue
}

/** Base del socio (``VITE_CODIGOS_RETIRO_BASE_URL`` en build de producción). */
export function resolveCodigosRetiroBaseUrl() {
  const raw = String(import.meta.env.VITE_CODIGOS_RETIRO_BASE_URL ?? '').trim()
  const base =
    raw && raw !== 'undefined' && raw !== 'null' && /^https?:\/\//i.test(raw)
      ? raw
      : DEFAULT_CODIGOS_RETIRO_BASE
  return base.replace(/\/$/, '')
}

/** Origen permitido para ``postMessage`` del iframe (mismo host que la base). */
export function resolveCodigosRetiroOrigin() {
  return resolveCodigosRetiroBaseUrl()
}

/** URL del widget en producción: ``{base}/widget_retiro`` (sin prefijo ``/pruebas``). */
export function resolveCodigosRetiroWidgetUrl() {
  return `${resolveCodigosRetiroBaseUrl()}${CODIGOS_RETIRO_WIDGET_PATH}`
}

/** @deprecated Usar ``resolveCodigosRetiroWidgetUrl()``; alias retrocompatible. */
export const CODIGOS_RETIRO_WIDGET_URL = resolveCodigosRetiroWidgetUrl()

export const CODIGOS_RETIRO_ORIGIN = resolveCodigosRetiroOrigin()

export const CODIGOS_RETIRO_SOCIO =
  String(import.meta.env.VITE_CODIGOS_RETIRO_SOCIO || 'alex').trim() || 'alex'

/** ``false`` en producción real; ``true`` solo si ``VITE_CODIGOS_RETIRO_ES_PRUEBA=1``. */
export const CODIGOS_RETIRO_ES_PRUEBA = parseEnvBool(
  import.meta.env.VITE_CODIGOS_RETIRO_ES_PRUEBA,
  false,
)

/** Base URL del backend ERP (``VITE_API_BASE_URL`` en build de producción). */
export function resolveErpApiBaseUrl() {
  return (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')
}

/** Instancia Axios con la misma base URL que el resto del ERP. */
function resolveErpApiClient(passedApi) {
  if (passedApi?.post) {
    const base = String(passedApi.defaults?.baseURL || '').trim().replace(/\/$/, '')
    if (base) return passedApi
  }
  const baseURL = resolveErpApiBaseUrl()
  if (String(erpApi.defaults?.baseURL || '').trim()) return erpApi
  return axios.create({
    baseURL,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Formato ``FAC-0042`` para enlazar venta con el webhook del socio. */
export function formatSaleReferenciaExterna(saleId) {
  const n = Number(saleId)
  if (!Number.isFinite(n) || n <= 0) return ''
  return `FAC-${String(Math.trunc(n)).padStart(4, '0')}`
}

/** Normaliza ID numérico o cadena ``FAC-*`` para la activación inmediata. */
export function resolveReferenciaExternaForSale(referenciaExterna) {
  if (referenciaExterna == null) return ''
  const raw = String(referenciaExterna).trim()
  if (!raw) return ''
  if (/^(?:FAC|REF|MOV)-\d+$/i.test(raw)) return raw.toUpperCase()
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return formatSaleReferenciaExterna(n)
  if (/^\d+$/.test(raw)) return formatSaleReferenciaExterna(parseInt(raw, 10))
  return raw
}

/** Etiqueta visible del cliente para el widget (nombre → email → fallback). */
export function resolvePortalClientLabelForRetiro(client) {
  if (!client || typeof client !== 'object') return 'Cliente'
  const name = String(client.name ?? '').trim()
  if (name) return name
  const email = String(client.email ?? '').trim()
  if (email) return email
  return 'Cliente'
}

/** Formato ``REC-00042`` para enlazar recarga BaaS con el webhook del socio. */
export function formatWalletRechargeReferenciaExterna(rechargeId) {
  const n = Number(rechargeId)
  if (!Number.isFinite(n) || n <= 0) return ''
  return `REC-${String(Math.trunc(n)).padStart(5, '0')}`
}

/** Infiere entidad portal a partir del prefijo de referencia. */
export function inferCodigosRetiroEntityFromReferencia(referenciaExterna) {
  const raw = String(referenciaExterna ?? '').trim()
  if (!raw) return null
  if (/^REC-\d+$/i.test(raw)) return 'recharge'
  if (/^(?:FAC|REF|MOV)-\d+$/i.test(raw)) return 'sale'
  return null
}

/** Normaliza ID numérico o cadena ``REC-*`` para recargas BaaS. */
export function resolveReferenciaExternaForWalletRecharge(referenciaExterna) {
  if (referenciaExterna == null) return ''
  const raw = String(referenciaExterna).trim()
  if (!raw || raw === 'undefined' || raw === 'null' || raw === '[object Object]') return ''
  if (/^REC-\d+$/i.test(raw)) return raw.toUpperCase()
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return formatWalletRechargeReferenciaExterna(n)
  return ''
}

function normalizeReferenciaExternaInput(referenciaExterna) {
  if (referenciaExterna == null) return null
  if (typeof referenciaExterna === 'number') {
    return Number.isFinite(referenciaExterna) && referenciaExterna > 0 ? referenciaExterna : null
  }
  const raw = String(referenciaExterna).trim()
  if (!raw || raw === 'undefined' || raw === 'null' || raw === '[object Object]') return null
  if (/^(?:FAC|REF|MOV|REC)-\d+$/i.test(raw)) return raw.toUpperCase()
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return n
  return null
}

/** Resuelve ``referencia_externa`` para el widget (misma tubería; prefijo distingue entidad). */
export function resolveReferenciaExternaForWidget(referenciaExterna, entity = 'sale') {
  const input = normalizeReferenciaExternaInput(referenciaExterna)
  if (input == null) return ''
  if (typeof input === 'string') {
    if (/^REC-\d+$/i.test(input)) return input.toUpperCase()
    return resolveReferenciaExternaForSale(input)
  }
  return entity === 'recharge'
    ? formatWalletRechargeReferenciaExterna(input)
    : resolveReferenciaExternaForSale(input)
}

/**
 * Construye enlace del widget con diagnóstico (ventas y recargas BaaS).
 * @returns {{ ok: boolean, href: string, missing: string[], entity: string, referenciaFormatted: string }}
 */
export function buildCodigosRetiroWidgetLink(clientLabel, options = {}) {
  const missing = []
  const label = String(clientLabel ?? '').trim() || 'Cliente'
  let entity = options.entity === 'recharge' ? 'recharge' : 'sale'
  const esPrueba = options.esPrueba ?? CODIGOS_RETIRO_ES_PRUEBA
  const normalizedRef = normalizeReferenciaExternaInput(options.referenciaExterna)

  let referenciaFormatted = ''
  if (normalizedRef != null) {
    if (typeof normalizedRef === 'string') {
      if (/^REC-\d+$/i.test(normalizedRef)) {
        entity = 'recharge'
        referenciaFormatted = normalizedRef.toUpperCase()
      } else {
        entity = 'sale'
        referenciaFormatted = resolveReferenciaExternaForSale(normalizedRef)
      }
    } else {
      referenciaFormatted =
        entity === 'recharge'
          ? formatWalletRechargeReferenciaExterna(normalizedRef)
          : formatSaleReferenciaExterna(normalizedRef)
    }
  } else if (entity === 'recharge') {
    missing.push('referenciaExterna (id de recarga BaaS)')
  }

  if (entity === 'recharge' && !referenciaFormatted) {
    if (!missing.some((m) => m.includes('referenciaExterna'))) {
      missing.push('referenciaExterna válida con prefijo REC-*')
    }
  }

  if (referenciaFormatted && entity === 'recharge' && !/^REC-\d+$/i.test(referenciaFormatted)) {
    missing.push(`referenciaExterna REC inválida: ${referenciaFormatted}`)
    referenciaFormatted = ''
  }

  let url
  try {
    url = new URL(resolveCodigosRetiroWidgetUrl())
  } catch {
    url = new URL(`${DEFAULT_CODIGOS_RETIRO_BASE}${CODIGOS_RETIRO_WIDGET_PATH}`)
  }

  url.searchParams.set('cliente', label)
  url.searchParams.set('socio', CODIGOS_RETIRO_SOCIO)
  if (referenciaFormatted) {
    url.searchParams.set('referencia_externa', referenciaFormatted)
  }
  url.searchParams.set('es_prueba', esPrueba ? '1' : '0')
  url.searchParams.set('tema', 'oscuro')

  const href = url.toString()
  const ok =
    missing.length === 0 &&
    /^https?:\/\//i.test(href) &&
    (entity !== 'recharge' || Boolean(referenciaFormatted))

  return {
    ok,
    href,
    missing,
    entity,
    referenciaFormatted,
    esPrueba,
  }
}

/**
 * URL del widget del socio. Misma construcción para ventas y recargas BaaS.
 * @throws {Error} si faltan parámetros obligatorios (recarga sin referencia).
 */
export function buildCodigosRetiroWidgetUrl(clientLabel, options = {}) {
  const link = buildCodigosRetiroWidgetLink(clientLabel, options)
  if (!link.ok) {
    throw new Error(
      `No se pudo construir URL Códigos de Retiro (${link.missing.join(', ') || 'parámetros inválidos'}).`,
    )
  }
  return link.href
}

/**
 * FormData para POST directo al endpoint del socio (``/widget_retiro`` en producción).
 * El proveedor devuelve el mismo ``referencia_externa`` en el webhook.
 */
export function buildCodigosRetiroPartnerFormData(fields) {
  const fd = new FormData()
  const cliente = String(fields?.cliente ?? '').trim() || 'Cliente'
  fd.append('cliente', cliente)
  fd.append('socio', String(fields?.socio ?? CODIGOS_RETIRO_SOCIO))
  const ref = fields?.referenciaExterna
  if (ref != null && String(ref).trim() !== '') {
    const entity = fields?.entity === 'recharge' ? 'recharge' : 'sale'
    fd.append('referencia_externa', resolveReferenciaExternaForWidget(ref, entity))
  }
  const esPrueba = fields?.esPrueba ?? CODIGOS_RETIRO_ES_PRUEBA
  fd.append('es_prueba', esPrueba ? '1' : '0')
  if (fields?.file) {
    fd.append('file', fields.file)
  }
  if (fields?.comprobante) {
    fd.append('comprobante', fields.comprobante)
  }
  return fd
}

/** POST del comprobante hacia el servidor del socio (Códigos de Retiro). */
export async function submitCodigosRetiroPartnerReceipt(formData) {
  const res = await fetch(resolveCodigosRetiroWidgetUrl(), {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    let detail = `Error ${res.status}`
    try {
      const j = await res.json()
      detail = j?.detail || j?.message || detail
    } catch {
      /* noop */
    }
    throw new Error(typeof detail === 'string' ? detail : `Error ${res.status}`)
  }
  try {
    return await res.json()
  } catch {
    return { ok: true }
  }
}

/** Regla 1: activación inmediata con CxC total tras envío exitoso al socio. */
export async function requestCodigosRetiroInstantActivationCxc(
  api,
  portalToken,
  referenciaExterna,
  paymentMethodId,
) {
  const ref = resolveReferenciaExternaForSale(referenciaExterna)
  if (!ref) {
    throw new Error('referencia_externa inválida para activación inmediata.')
  }
  const token = String(portalToken ?? '').trim()
  if (!token) {
    throw new Error('portal_token requerido para activación inmediata.')
  }
  const methodId = paymentMethodId != null ? String(paymentMethodId).trim() : ''
  if (!methodId) {
    throw new Error('payment_method_id requerido para activación inmediata con Códigos de Retiro.')
  }

  const client = resolveErpApiClient(api)
  const params = new URLSearchParams({ payment_method_id: methodId })
  const path = `/api/v1/portal/${encodeURIComponent(token)}/sales/${encodeURIComponent(ref)}/instant-activation-cxc?${params.toString()}`

  return client.post(path)
}

/** Regla 1 (recarga BaaS): activación inmediata con CxC total tras envío exitoso al socio. */
export async function requestCodigosRetiroInstantActivationCxcWalletRecharge(
  api,
  portalToken,
  referenciaExterna,
  paymentMethodId,
) {
  const ref = resolveReferenciaExternaForWalletRecharge(referenciaExterna)
  if (!ref) {
    throw new Error('referencia_externa inválida para activación inmediata de recarga BaaS.')
  }
  const token = String(portalToken ?? '').trim()
  if (!token) {
    throw new Error('portal_token requerido para activación inmediata.')
  }
  const methodId = paymentMethodId != null ? String(paymentMethodId).trim() : ''
  if (!methodId) {
    throw new Error('payment_method_id requerido para activación inmediata con Códigos de Retiro.')
  }

  const client = resolveErpApiClient(api)
  const params = new URLSearchParams({ payment_method_id: methodId })
  const path = `/api/v1/portal/${encodeURIComponent(token)}/recharges/${encodeURIComponent(ref)}/instant-activation-cxc?${params.toString()}`

  return client.post(path)
}

/** @deprecated Usar ``requestCodigosRetiroInstantActivationCxc``. */
export async function requestCodigosRetiroInstantActivation(api, portalToken, referenciaExterna) {
  return requestCodigosRetiroInstantActivationCxc(api, portalToken, referenciaExterna)
}

const RETIRO_METHOD_PATTERNS = [
  'códigos de retiro',
  'codigos de retiro',
  'código de retiro',
  'codigo de retiro',
  'codigos retiro',
  'codigo retiro',
]

/** True si el nombre del método de pago corresponde a retiros físicos / códigos de retiro. */
export function isCodigosRetiroPaymentMethod(name) {
  const n = String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
  if (!n) return false
  return RETIRO_METHOD_PATTERNS.some((p) => n.includes(p.replace(/ó/g, 'o')))
}

export function paymentMethodNameById(methods, methodId) {
  if (methodId == null || String(methodId).trim() === '') return ''
  const row = (Array.isArray(methods) ? methods : []).find((m) => String(m.id) === String(methodId))
  return String(row?.name || '').trim()
}

export function isCodigosRetiroMethodId(methods, methodId) {
  return isCodigosRetiroPaymentMethod(paymentMethodNameById(methods, methodId))
}

/** Normaliza ``event.data`` (objeto o JSON string) del widget externo. */
export function normalizeRetiroPostMessageData(data) {
  if (data == null) return null
  if (typeof data === 'string') {
    const trimmed = data.trim()
    if (!trimmed) return null
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  if (typeof data === 'object') return data
  return null
}

/** Lee ``monto`` del payload (prioridad explícita a ``event.data.monto``). */
export function extractRetiroMonto(data) {
  const raw = normalizeRetiroPostMessageData(data)
  if (!raw) return NaN
  const montoRaw =
    raw.monto ?? raw.paid_amount ?? raw.importe ?? raw.amount ?? raw.valor ?? raw.total
  if (typeof montoRaw === 'number' && Number.isFinite(montoRaw)) return montoRaw
  const parsed = parseFloat(String(montoRaw ?? '').trim().replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : NaN
}

/** Extrae campos útiles del postMessage ``RETIRO_COMPLETADO``. */
export function parseRetiroCompletadoPayload(data) {
  const raw = normalizeRetiroPostMessageData(data) || {}
  const monto = extractRetiroMonto(raw)
  const receiptUrl = String(
    raw.receipt_url ??
      raw.comprobante_url ??
      raw.url_comprobante ??
      raw.imagen_url ??
      raw.file_url ??
      raw.comprobante ??
      raw.url ??
      '',
  ).trim()
  const codigo = String(raw.codigo ?? raw.codigo_retiro ?? raw.codigoRetiro ?? '').trim()
  const currency = String(raw.moneda ?? raw.currency ?? '').trim().toUpperCase().slice(0, 10)
  return {
    monto,
    receiptUrl,
    codigo,
    currency: currency || null,
    tipo: raw.tipo ?? null,
    raw,
  }
}

/** Mensaje estándar cuando el socio rechaza el comprobante (duplicado / inválido). */
export const RETIRO_REJECTED_DEFAULT_MESSAGE =
  'Pago rechazado: Comprobante inválido o duplicado'

const RETIRO_ERROR_MESSAGE_TYPES = new Set([
  'RETIRO_ERROR',
  'RETIRO_RECHAZADO',
  'RETIRO_DUPLICADO',
  'RETIRO_INVALIDO',
  'ERROR',
  'FAILED',
  'FAIL',
  'REJECTED',
  'RECHAZADO',
])

const RETIRO_ERROR_TEXT_PATTERNS = [
  'ya fue ingresado',
  'codigo ya fue',
  'código ya fue',
  'codigo duplicad',
  'código duplicad',
  'comprobante duplicad',
  'comprobante invalido',
  'comprobante inválido',
  'comprobante no valido',
  'comprobante no válido',
  'codigo invalido',
  'código inválido',
  'codigo no valido',
  'código no válido',
  'rechazad',
  'duplicad',
]

function retiroMessageOriginMatches(eventOrigin) {
  const origin = String(eventOrigin || '')
    .trim()
    .replace(/\/$/, '')
  const allowed = resolveCodigosRetiroOrigin().replace(/\/$/, '')
  return origin === allowed
}

/** Texto legible del payload del widget (mensaje de error o aviso). */
export function extractRetiroMessageText(data, rawEventData) {
  if (data && typeof data === 'object') {
    const fromObj = String(
      data.mensaje ?? data.message ?? data.error ?? data.detail ?? data.msg ?? data.descripcion ?? '',
    ).trim()
    if (fromObj) return fromObj
  }
  if (typeof rawEventData === 'string') {
    const trimmed = rawEventData.trim()
    if (trimmed && !trimmed.startsWith('{')) return trimmed
  }
  return ''
}

function retiroPayloadLooksLikeError(data, rawEventData) {
  if (!data || typeof data !== 'object') {
    const plain = String(rawEventData ?? '').trim().toLowerCase()
    if (!plain || plain.startsWith('{')) return false
    return RETIRO_ERROR_TEXT_PATTERNS.some((p) => plain.includes(p))
  }

  const tipo = String(data.tipo ?? data.type ?? data.event ?? '')
    .trim()
    .toUpperCase()
  if (tipo && RETIRO_ERROR_MESSAGE_TYPES.has(tipo)) return true
  if (tipo.includes('ERROR') || tipo.includes('RECHAZ') || tipo.includes('DUPLIC')) return true

  if (data.ok === false || data.success === false || data.exito === false) return true

  const estado = String(data.estado ?? data.status ?? data.result ?? '')
    .trim()
    .toLowerCase()
  if (
    estado &&
    ['error', 'failed', 'fail', 'rechazado', 'rejected', 'duplicado', 'duplicate', 'invalid', 'invalido'].includes(
      estado,
    )
  ) {
    return true
  }

  const msg = extractRetiroMessageText(data, rawEventData).toLowerCase()
  if (msg && RETIRO_ERROR_TEXT_PATTERNS.some((p) => msg.includes(p))) return true

  return false
}

/** True si el iframe notifica un rechazo (duplicado, inválido, etc.). */
export function isRetiroErrorMessage(event) {
  if (!event || !retiroMessageOriginMatches(event.origin)) return false
  const data = normalizeRetiroPostMessageData(event.data)
  if (retiroPayloadLooksLikeError(data, event.data)) return true
  return false
}

/** Mensaje de error amigable para mostrar al usuario. */
export function parseRetiroErrorMessage(event) {
  const data = normalizeRetiroPostMessageData(event.data)
  const raw = extractRetiroMessageText(data, event?.data)
  if (raw) {
    const lower = raw.toLowerCase()
    if (RETIRO_ERROR_TEXT_PATTERNS.some((p) => lower.includes(p))) {
      return RETIRO_REJECTED_DEFAULT_MESSAGE
    }
    return raw
  }
  return RETIRO_REJECTED_DEFAULT_MESSAGE
}

function retiroPayloadLooksLikeSuccess(data) {
  if (!data || typeof data !== 'object') return false
  if (data.ok === false || data.success === false || data.exito === false) return false
  if (retiroPayloadLooksLikeError(data, null)) return false

  const tipo = String(data.tipo ?? data.type ?? data.event ?? '').trim()
  if (tipo !== 'RETIRO_COMPLETADO') return false

  const estado = String(data.estado ?? data.status ?? '').trim().toLowerCase()
  if (
    estado &&
    !['completado', 'completed', 'success', 'ok', 'approved', 'aprobado', ''].includes(estado)
  ) {
    return false
  }

  return true
}

export function isRetiroCompletadoMessage(event) {
  if (!event || !retiroMessageOriginMatches(event.origin)) return false
  if (isRetiroErrorMessage(event)) return false
  const data = normalizeRetiroPostMessageData(event.data)
  if (!data) return false
  return retiroPayloadLooksLikeSuccess(data)
}

/** Envía pago procesado por el widget al backend del portal (``pending_review``). */
export async function submitCodigosRetiroPortalPayment(api, portalToken, fields) {
  const fd = new FormData()
  fd.append('payment_intent', fields.paymentIntent)
  fd.append('codigos_retiro', '1')
  fd.append('payment_method_id', String(fields.paymentMethodId))
  fd.append('deposit_account_id', String(fields.depositAccountId))
  fd.append('paid_amount', String(fields.paidAmount))
  if (fields.currency) fd.append('currency', fields.currency)
  if (fields.receiptUrl) fd.append('receipt_url', fields.receiptUrl)
  if (fields.saleId != null) fd.append('sale_id', String(fields.saleId))
  if (fields.portalDebtKind) fd.append('portal_debt_kind', fields.portalDebtKind)
  if (fields.portalSaleId != null) fd.append('portal_sale_id', String(fields.portalSaleId))
  if (fields.portalWalletRechargeId != null) {
    fd.append('portal_wallet_recharge_id', String(fields.portalWalletRechargeId))
    fd.append('id_erp', String(fields.portalWalletRechargeId))
  }
  if (fields.notes) fd.append('notes', fields.notes)
  if (fields.applyCreditBalance) {
    fd.append('apply_credit_balance', '1')
    fd.append('use_credit_balance', '1')
  }
  return api.post(`/api/v1/portal/${portalToken}/payments`, fd)
}
