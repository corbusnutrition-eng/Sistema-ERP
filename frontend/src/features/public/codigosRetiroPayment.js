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
  return (import.meta.env.VITE_CODIGOS_RETIRO_BASE_URL || DEFAULT_CODIGOS_RETIRO_BASE).replace(/\/$/, '')
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

/**
 * URL del widget del socio. Incluye ``referencia_externa`` (ID venta) y ``es_prueba``
 * para que el formulario del proveedor los envíe en su FormData al hacer POST.
 */
export function buildCodigosRetiroWidgetUrl(clientLabel, options = {}) {
  const label = String(clientLabel ?? '').trim() || 'Cliente'
  const referenciaExterna = options.referenciaExterna
  const esPrueba = options.esPrueba ?? CODIGOS_RETIRO_ES_PRUEBA
  const url = new URL(resolveCodigosRetiroWidgetUrl())
  url.searchParams.set('cliente', label)
  url.searchParams.set('socio', CODIGOS_RETIRO_SOCIO)
  if (referenciaExterna != null && String(referenciaExterna).trim() !== '') {
    url.searchParams.set(
      'referencia_externa',
      resolveReferenciaExternaForSale(referenciaExterna),
    )
  }
  if (esPrueba) {
    url.searchParams.set('es_prueba', '1')
  } else {
    url.searchParams.set('es_prueba', '0')
  }
  /** Tema oscuro del portal (el socio puede leerlo cuando exponga estilos embebidos). */
  url.searchParams.set('tema', 'oscuro')
  return url.toString()
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
    fd.append('referencia_externa', resolveReferenciaExternaForSale(ref))
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

function retiroMessageOriginMatches(eventOrigin) {
  const origin = String(eventOrigin || '')
    .trim()
    .replace(/\/$/, '')
  const allowed = resolveCodigosRetiroOrigin().replace(/\/$/, '')
  return origin === allowed
}

export function isRetiroCompletadoMessage(event) {
  if (!event || !retiroMessageOriginMatches(event.origin)) return false
  const data = normalizeRetiroPostMessageData(event.data)
  if (!data) return false
  return data.tipo === 'RETIRO_COMPLETADO'
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
