/** Utilidades compartidas para links de pago Hotmart (admin + portal). */

export function isHotmartPaymentMethodName(name) {
  return /hotmart/i.test(String(name ?? '').trim())
}

export function emptyHotmartLinkRow() {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `hm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return { id, url: '', amount: '' }
}

export function hydrateHotmartLinkRows(raw, { all = false } = {}) {
  if (!Array.isArray(raw) || !raw.length) return [emptyHotmartLinkRow()]
  const items = all ? raw : raw.slice(0, 1)
  return items.map((item, index) => ({
    id: `hm-${index}-${Date.now()}`,
    url: String(item?.url ?? ''),
    amount: item?.amount != null && item?.amount !== '' ? String(item.amount) : '',
  }))
}

/** Valida filas y devuelve payload API `[{ url, amount }]` o `undefined`. */
export function buildHotmartLinksPayload(rows, { all = false } = {}) {
  const out = []
  const list = all ? rows || [] : rows?.length ? [rows[0]] : []
  for (const row of list) {
    const url = String(row?.url ?? '').trim()
    const amtRaw = String(row?.amount ?? '').trim().replace(',', '.')
    const hasUrl = url.length > 0
    const hasAmt = amtRaw.length > 0
    if (!hasUrl && !hasAmt) continue
    if (!hasUrl) {
      throw new Error('Cada link Hotmart debe incluir una URL de pago.')
    }
    const amt = parseFloat(amtRaw)
    if (!Number.isFinite(amt) || amt <= 0) {
      throw new Error('Cada link Hotmart debe incluir un monto mayor a cero.')
    }
    out.push({ url, amount: Math.round(amt * 100) / 100 })
  }
  return out.length ? out : undefined
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
