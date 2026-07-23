/** Utilidades compartidas para links y bloques de cobro (admin + portal). */

export function isHotmartPaymentMethodName(name) {
  return /hotmart/i.test(String(name ?? '').trim())
}

export function emptyHotmartLinkRow() {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `hm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return { id, type: 'standard', url: '', amount: '', text: '', image_url: '', imagePreview: null }
}

export function emptyCustomHotmartLinkRow() {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `hm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return { id, type: 'custom', url: '', amount: '', text: '', image_url: '', imagePreview: null }
}

export function isCustomPaymentLinkBlock(item) {
  return String(item?.type ?? '').trim().toLowerCase() === 'custom'
}

export function hydrateHotmartLinkRows(raw, { all = false } = {}) {
  if (!Array.isArray(raw) || !raw.length) return [emptyHotmartLinkRow()]
  const items = all ? raw : raw.slice(0, 1)
  return items.map((item, index) => ({
    id: `hm-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: isCustomPaymentLinkBlock(item) ? 'custom' : 'standard',
    url: String(item?.url ?? ''),
    amount: item?.amount != null && item?.amount !== '' ? String(item.amount) : '',
    text: String(item?.text ?? ''),
    image_url: String(item?.image_url ?? ''),
    imagePreview: String(item?.image_url ?? '').trim() || null,
  }))
}

function buildStandardPayloadRow(row) {
  const url = String(row?.url ?? '').trim()
  const amtRaw = String(row?.amount ?? '').trim().replace(',', '.')
  const hasUrl = url.length > 0
  const hasAmt = amtRaw.length > 0
  if (!hasUrl && !hasAmt) return null
  if (!hasUrl) {
    throw new Error('Cada link estándar debe incluir una URL de pago.')
  }
  const amt = parseFloat(amtRaw)
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('Cada link estándar debe incluir un monto mayor a cero.')
  }
  return { type: 'standard', url, amount: Math.round(amt * 100) / 100 }
}

function buildCustomPayloadRow(row) {
  const text = String(row?.text ?? '').trim()
  const imageUrl = String(row?.image_url ?? '').trim()
  const url = String(row?.url ?? '').trim()
  const amtRaw = String(row?.amount ?? '').trim().replace(',', '.')
  const hasAmt = amtRaw.length > 0
  let amount = null
  if (hasAmt) {
    amount = parseFloat(amtRaw)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('El valor del bloque personalizado debe ser mayor a cero.')
    }
    amount = Math.round(amount * 100) / 100
  }
  if (!text && !imageUrl && !url && amount == null) return null
  const out = { type: 'custom' }
  if (text) out.text = text
  if (imageUrl) out.image_url = imageUrl
  if (url) out.url = url
  if (amount != null) out.amount = amount
  return out
}

/** Valida filas y devuelve payload API o `undefined`. */
export function buildHotmartLinksPayload(rows, { all = false } = {}) {
  const out = []
  const list = all ? rows || [] : rows?.length ? [rows[0]] : []
  for (const row of list) {
    const built = isCustomPaymentLinkBlock(row)
      ? buildCustomPayloadRow(row)
      : buildStandardPayloadRow(row)
    if (built) out.push(built)
  }
  return out.length ? out : undefined
}

export async function uploadPaymentLinkImage(api, file) {
  if (!api || !file) throw new Error('Archivo de imagen requerido.')
  const fd = new FormData()
  fd.append('file', file)
  const { data } = await api.post('/api/v1/uploads/receipt', fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  const url = data?.receipt_url || data?.file_url || data?.url
  if (!url) throw new Error('No se recibió la URL pública de la imagen.')
  return String(url)
}

export function formatPaymentLinkAmount(amount, currency = 'USD') {
  const n = typeof amount === 'number' ? amount : parseFloat(String(amount ?? 0))
  if (!Number.isFinite(n)) return '—'
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: String(currency || 'USD').trim().toUpperCase().slice(0, 10) || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${currency || 'USD'} ${n.toFixed(2)}`
  }
}

export function paymentLinkBlockHasPortalContent(item) {
  if (!item || typeof item !== 'object') return false
  if (isCustomPaymentLinkBlock(item)) {
    return Boolean(
      String(item.text ?? '').trim() ||
        String(item.image_url ?? '').trim() ||
        (String(item.url ?? '').trim() && Number(item.amount) > 0),
    )
  }
  return Boolean(String(item.url ?? '').trim() && Number(item.amount) > 0)
}

export function selectedMethodsIncludeHotmart(selectedIds, options) {
  const opts = Array.isArray(options) ? options : []
  return (selectedIds || []).some((id) => {
    const opt = opts.find((o) => Number(o.value) === Number(id))
    return isHotmartPaymentMethodName(opt?.label)
  })
}

export function firstSelectedHotmartMethodId(selectedIds, options) {
  for (const id of selectedIds || []) {
    const opt = (options || []).find((o) => Number(o.value) === Number(id))
    if (isHotmartPaymentMethodName(opt?.label)) return Number(id)
  }
  return null
}

export function portalMethodLabelIsHotmart(methodId, methods) {
  const list = Array.isArray(methods) ? methods : []
  const hit = list.find((m) => String(m?.id) === String(methodId))
  return isHotmartPaymentMethodName(hit?.name ?? hit?.label)
}

/** Extrae product_id del inventario seleccionado en una venta (primera línea con catálogo). */
export function resolveSaleProductIdForTemplate(lineItems, form, salesInventoryMetaByKey) {
  const lines = Array.isArray(lineItems) ? lineItems : []
  for (const li of lines) {
    const pk = String(li?.productKey ?? '').trim()
    if (pk.startsWith('cp|')) {
      const pid = parseInt(pk.slice(3).split('|')[0], 10)
      if (Number.isFinite(pid) && pid >= 1) return pid
    }
    if (pk.startsWith('cn:')) {
      const meta = salesInventoryMetaByKey?.[pk]
      const pid = Number(meta?.product_id)
      if (Number.isFinite(pid) && pid >= 1) return pid
    }
  }
  const formPid = Number(form?.product_id)
  if (Number.isFinite(formPid) && formPid >= 1) return formPid
  return null
}

export async function fetchPaymentLinkTemplate(api, { paymentMethodId, moduleType, productId, signal }) {
  if (!paymentMethodId || !moduleType) return null
  const params = {
    payment_method_id: Number(paymentMethodId),
    module_type: String(moduleType).trim().toUpperCase(),
  }
  if (params.module_type === 'VENTAS') {
    if (!productId) return null
    params.product_id = Number(productId)
  }
  const { data } = await api.get('/api/v1/payment-link-templates/', { params, signal })
  return Array.isArray(data) && data.length ? data[0] : null
}
