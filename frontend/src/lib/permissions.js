/** Espejo del catálogo backend (`app/permissions.py`) para checks en UI. */

export const BAAS_VIEW_USERS_TAB = 'baas:view_users_tab'
export const BAAS_VIEW_REQUESTS_TAB = 'baas:view_requests_tab'
export const BAAS_VIEW_NOTIFICATIONS_TAB = 'baas:view_notifications_tab'
export const BAAS_CREATE_RECHARGE = 'baas:create_recharge'

export const ALL_PERMISSIONS = Object.freeze([
  BAAS_VIEW_USERS_TAB,
  BAAS_VIEW_REQUESTS_TAB,
  BAAS_VIEW_NOTIFICATIONS_TAB,
  BAAS_CREATE_RECHARGE,
])

const BAAS_LEGACY = new Set(ALL_PERMISSIONS)

export function normalizePermissions(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const key = String(item || '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

export function effectivePermissions(role, permissions) {
  if (String(role || '').toLowerCase() === 'admin') {
    return [...ALL_PERMISSIONS]
  }
  return normalizePermissions(permissions)
}

export function hasPermission(role, permissions, permission) {
  const perm = String(permission || '').trim()
  if (!perm) return false
  if (String(role || '').toLowerCase() === 'admin') return true
  const granted = new Set(normalizePermissions(permissions))
  if (granted.has(perm)) return true
  const matrixEquivalents = {
    [BAAS_VIEW_USERS_TAB]: ['baas:distributors:view', 'baas:distributors:edit'],
    [BAAS_VIEW_REQUESTS_TAB]: [
      'baas:recharge_requests:view',
      'baas:recharge_requests:edit',
      'baas:recharge_requests:approve',
      'baas:recharge_requests:delete',
    ],
    [BAAS_CREATE_RECHARGE]: ['baas:recharge_requests:create'],
    [BAAS_VIEW_NOTIFICATIONS_TAB]: [
      'baas:notifications:view',
      'baas:notifications:create',
      'baas:notifications:edit',
      'baas:notifications:delete',
    ],
  }
  for (const [legacy, matrixKeys] of Object.entries(matrixEquivalents)) {
    if (perm === legacy && matrixKeys.some((k) => granted.has(k))) return true
  }
  return false
}

export function hasAnyBaasPermission(role, permissions) {
  if (String(role || '').toLowerCase() === 'admin') return true
  const granted = normalizePermissions(permissions)
  for (const p of granted) {
    if (p.startsWith('baas:') || BAAS_LEGACY.has(p)) return true
  }
  return false
}

/** Pestañas del módulo Distribuidores BaaS → permiso requerido. */
export const BAAS_TAB_PERMISSIONS = Object.freeze({
  users: BAAS_VIEW_USERS_TAB,
  requests: BAAS_VIEW_REQUESTS_TAB,
  notifications: BAAS_VIEW_NOTIFICATIONS_TAB,
})
