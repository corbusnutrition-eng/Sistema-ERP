/**
 * Construye las opciones agrupadas del selector de producto/servicio (Nueva venta).
 * Compartido entre NuevaVentaModal y PaymentLinksManager.
 */

export function buildInventorySalesProductOptions({
  inventorySalesOpts = null,
  inventorySalesOptsLoading = false,
  combinedProvidersList = ['Flujo', 'Stella'],
  snapshotFor = () => ({ totalCredits: 0 }),
  catalogReady = true,
  includeDraftRecharge = false,
  draftRecharge = null,
  draftProvider = '',
  includeScreenPicks = true,
  extraFallbackOptions = [],
}) {
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

  if (includeScreenPicks) {
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
    includeDraftRecharge &&
    draftRecharge &&
    String(draftProvider || '').trim() === String(draftRecharge.provider || '').trim()
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

  for (const opt of extraFallbackOptions) {
    if (!opt?.value || rows.some((r) => String(r.value) === String(opt.value))) continue
    rows.push(opt)
  }

  return rows
}

/** Resuelve product_id de catálogo a partir de una option_key del inventario de ventas. */
export function productIdFromSalesInventoryOption(optionKey, inventorySalesOpts) {
  const key = String(optionKey ?? '').trim()
  if (!key) return null

  if (key.startsWith('cn:')) {
    const pid = parseInt(key.slice(3), 10)
    return Number.isFinite(pid) && pid >= 1 ? pid : null
  }

  if (key.startsWith('cp|')) {
    const pid = parseInt(String(key.slice(3).split('|')[0] ?? ''), 10)
    if (Number.isFinite(pid) && pid >= 1) return pid
    const pkgs = Array.isArray(inventorySalesOpts?.screen_package_options)
      ? inventorySalesOpts.screen_package_options
      : []
    const hit = pkgs.find((p) => String(p?.option_key) === key)
    const fromRow = Number(hit?.product_id)
    return Number.isFinite(fromRow) && fromRow >= 1 ? fromRow : null
  }

  if (key.startsWith('ss:')) {
    const picks = Array.isArray(inventorySalesOpts?.screen_pick_options)
      ? inventorySalesOpts.screen_pick_options
      : []
    const hit = picks.find((s) => String(s?.option_key) === key)
    const pid = Number(hit?.product_id)
    return Number.isFinite(pid) && pid >= 1 ? pid : null
  }

  return null
}

/** Primera option_key del inventario que coincide con un product_id (para hidratar plantillas). */
export function salesInventoryOptionKeyForProductId(productId, inventorySalesOpts) {
  const pid = Number(productId)
  if (!Number.isFinite(pid) || pid < 1) return ''

  const d = inventorySalesOpts && typeof inventorySalesOpts === 'object' ? inventorySalesOpts : {}
  for (const n of Array.isArray(d.normal_credit_options) ? d.normal_credit_options : []) {
    if (Number(n?.product_id) === pid) return String(n.option_key || '')
  }
  for (const p of Array.isArray(d.screen_package_options) ? d.screen_package_options : []) {
    if (Number(p?.product_id) === pid) return String(p.option_key || '')
  }
  return ''
}
