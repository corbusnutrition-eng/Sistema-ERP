/**
 * Clasificación por clave de inventario en línea de factura (Nueva venta).
 * - normal_credit: catálogo `cn:` o pooled `fc:` → credenciales editables + memoria cliente.
 * - screen_stock: paquete `cp|`, pantalla `ss:` o borrador recarga → bodega automática.
 */
export function invoiceLineCredentialKind(productKey) {
  const pk = String(productKey ?? '').trim()
  if (pk.startsWith('cn:') || pk.startsWith('fc:')) return 'normal_credit'
  if (pk.startsWith('cp|') || pk.startsWith('ss:') || pk === 'draft:pending') return 'screen_stock'
  return 'none'
}
