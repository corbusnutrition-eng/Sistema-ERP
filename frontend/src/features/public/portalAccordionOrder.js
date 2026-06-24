export const PORTAL_ACCORDION_DEFAULT_ORDER = [
  'notifications',
  'new-orders',
  'wallet',
  'tracked-purchases',
  'reseller-network',
  'active-screens',
]

const STORAGE_PREFIX = 'portal_accordion_section_order'

function storageKey(token) {
  const t = String(token ?? '').trim()
  return t ? `${STORAGE_PREFIX}:${t}` : STORAGE_PREFIX
}

export function loadPortalAccordionOrder(token) {
  const fallback = [...PORTAL_ACCORDION_DEFAULT_ORDER]
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(storageKey(token))
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback
    const known = new Set(PORTAL_ACCORDION_DEFAULT_ORDER)
    const cleaned = parsed.filter((id) => typeof id === 'string' && known.has(id))
    for (const id of PORTAL_ACCORDION_DEFAULT_ORDER) {
      if (!cleaned.includes(id)) cleaned.push(id)
    }
    return cleaned
  } catch {
    return fallback
  }
}

export function savePortalAccordionOrder(token, order) {
  if (typeof window === 'undefined') return
  try {
    const known = new Set(PORTAL_ACCORDION_DEFAULT_ORDER)
    const cleaned = (Array.isArray(order) ? order : []).filter(
      (id) => typeof id === 'string' && known.has(id),
    )
    for (const id of PORTAL_ACCORDION_DEFAULT_ORDER) {
      if (!cleaned.includes(id)) cleaned.push(id)
    }
    window.localStorage.setItem(storageKey(token), JSON.stringify(cleaned))
  } catch {
    /* ignore quota / private mode */
  }
}

export function filterVisiblePortalAccordionOrder(order, { isDirectLineClient }) {
  return (Array.isArray(order) ? order : PORTAL_ACCORDION_DEFAULT_ORDER).filter((id) => {
    if (id === 'new-orders') return Boolean(isDirectLineClient)
    return true
  })
}
