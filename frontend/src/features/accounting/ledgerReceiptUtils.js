const API_ORIGIN = String(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

export function receiptAbsoluteUrl(path) {
  if (path == null || path === '') return null
  const p = String(path).trim()
  if (!p) return null
  if (p.startsWith('http://') || p.startsWith('https://')) return p
  return `${API_ORIGIN}${p.startsWith('/') ? p : `/${p}`}`
}

export function ledgerReceiptIsPdf(urlPath) {
  if (!urlPath) return false
  return String(urlPath).toLowerCase().split('?')[0].endsWith('.pdf')
}
