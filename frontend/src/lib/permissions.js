/** Claves de permisos — deben coincidir con `backend/app/permissions.py` (matriz QBO). */

export const BAAS_VIEW_USERS_TAB = 'baas:view_users_tab'
export const BAAS_VIEW_REQUESTS_TAB = 'baas:view_requests_tab'
export const BAAS_VIEW_NOTIFICATIONS_TAB = 'baas:view_notifications_tab'
export const BAAS_CREATE_RECHARGE = 'baas:create_recharge'

export const PERMS = Object.freeze({
  DASHBOARD_VIEW: 'dashboard:overview:view',

  CLIENTS_VIEW: 'clients_inventory:clients:view',
  CLIENTS_CREATE: 'clients_inventory:clients:create',
  CLIENTS_EDIT: 'clients_inventory:clients:edit',
  CLIENTS_DELETE: 'clients_inventory:clients:delete',

  INVENTORY_VIEW: 'clients_inventory:inventory:view',
  PRODUCTS_VIEW: 'clients_inventory:products:view',

  SALES_INVOICES_VIEW: 'sales:invoices:view',
  SALES_SUBSCRIPTIONS_VIEW: 'sales:subscriptions:view',
  SALES_RECEIPTS_VIEW: 'sales:receipts:view',

  TEAM_USERS_VIEW: 'team:users:view',
  REPORTS_FINANCIAL_VIEW: 'reports:financial:view',
  REPORTS_LISTS_VIEW: 'reports:lists:view',
  REPORTS_CLASSES_VIEW: 'reports:classes:view',

  ACCOUNTING_CHART_VIEW: 'accounting:chart:view',
  ACCOUNTING_RECEIVABLES_VIEW: 'accounting:receivables:view',
  ACCOUNTING_EXPENSES_VIEW: 'accounting:expenses:view',
  ACCOUNTING_VENDORS_VIEW: 'accounting:vendors:view',
  ACCOUNTING_RECONCILE_VIEW: 'accounting:reconcile:view',
})

export const BAAS_TAB_PERMISSIONS = Object.freeze({
  users: BAAS_VIEW_USERS_TAB,
  requests: BAAS_VIEW_REQUESTS_TAB,
  notifications: BAAS_VIEW_NOTIFICATIONS_TAB,
})

const LEGACY_TO_MATRIX = Object.freeze({
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
})

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
  return normalizePermissions(permissions)
}

export function hasPermission(role, permissions, permission) {
  const perm = String(permission || '').trim()
  if (!perm) return false
  if (String(role || '').toLowerCase() === 'admin') return true
  const granted = new Set(normalizePermissions(permissions))
  if (granted.has(perm)) return true
  const matrixKeys = LEGACY_TO_MATRIX[perm]
  if (matrixKeys?.some((k) => granted.has(k))) return true
  return false
}

export function hasAnyPermissionPrefix(role, permissions, prefix) {
  if (String(role || '').toLowerCase() === 'admin') return true
  const p = String(prefix || '').trim()
  if (!p) return false
  return normalizePermissions(permissions).some((k) => k.startsWith(`${p}:`))
}

export function hasAnyBaasPermission(role, permissions) {
  if (String(role || '').toLowerCase() === 'admin') return true
  for (const key of normalizePermissions(permissions)) {
    if (key.startsWith('baas:') || Object.prototype.hasOwnProperty.call(LEGACY_TO_MATRIX, key)) {
      return true
    }
  }
  return false
}

export function isNavItemVisible(item, { role, permissions, isAdmin, hasAnyBaasAccess }) {
  if (item.adminOnly) return isAdmin
  if (item.baasAccess) return isAdmin || hasAnyBaasAccess
  if (item.permissionAny) return hasAnyPermissionPrefix(role, permissions, item.permissionAny)
  if (item.permission) return hasPermission(role, permissions, item.permission)
  return true
}
