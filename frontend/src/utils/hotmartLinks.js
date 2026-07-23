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

export function hydrateHotmartLinkRows(raw) {
  if (!Array.isArray(raw) || !raw.length) return [emptyHotmartLinkRow()]
  return raw.map((item, index) => ({
    id: `hm-${index}-${Date.now()}`,
    url: String(item?.url ?? ''),
    amount: item?.amount != null && item?.amount !== '' ? String(item.amount) : '',
  }))
}

/** Valida filas del editor y devuelve payload API o `undefined` si no hay links. */
export function buildHotmartLinksPayload(rows) {
  const out = []
  for (const row of rows || []) {
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

export function portalMethodLabelIsHotmart(methodId, methods) {
  const list = Array.isArray(methods) ? methods : []
  const hit = list.find((m) => String(m?.id) === String(methodId))
  return isHotmartPaymentMethodName(hit?.name ?? hit?.label)
}
