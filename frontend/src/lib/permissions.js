/** Claves de permisos — deben coincidir con `backend/app/permissions.py` (matriz QBO). */

/** @deprecated Usar PERMS.BAAS_DISTRIBUTORS_VIEW — alias legacy */
export const BAAS_VIEW_USERS_TAB = 'baas:view_users_tab'
/** @deprecated Usar PERMS.BAAS_RECHARGE_REQUESTS_VIEW */
export const BAAS_VIEW_REQUESTS_TAB = 'baas:view_requests_tab'
/** @deprecated Usar PERMS.BAAS_NOTIFICATIONS_VIEW */
export const BAAS_VIEW_NOTIFICATIONS_TAB = 'baas:view_notifications_tab'
/** @deprecated Usar PERMS.BAAS_RECHARGE_REQUESTS_CREATE */
export const BAAS_CREATE_RECHARGE = 'baas:create_recharge'

export const PERMS = Object.freeze({
  DASHBOARD_VIEW: 'dashboard:overview:view',

  CLIENTS_VIEW: 'clients_inventory:clients:view',
  CLIENTS_CREATE: 'clients_inventory:clients:create',
  CLIENTS_EDIT: 'clients_inventory:clients:edit',
  CLIENTS_DELETE: 'clients_inventory:clients:delete',

  INVENTORY_VIEW: 'clients_inventory:inventory:view',
  INVENTORY_CREATE: 'clients_inventory:inventory:create',
  INVENTORY_EDIT: 'clients_inventory:inventory:edit',
  INVENTORY_DELETE: 'clients_inventory:inventory:delete',

  PRODUCTS_VIEW: 'clients_inventory:products:view',
  PRODUCTS_CREATE: 'clients_inventory:products:create',
  PRODUCTS_EDIT: 'clients_inventory:products:edit',
  PRODUCTS_DELETE: 'clients_inventory:products:delete',

  SALES_INVOICES_VIEW: 'sales:invoices:view',
  SALES_INVOICES_CREATE: 'sales:invoices:create',
  SALES_INVOICES_EDIT: 'sales:invoices:edit',
  SALES_INVOICES_DELETE: 'sales:invoices:delete',
  SALES_SUBSCRIPTIONS_VIEW: 'sales:subscriptions:view',
  SALES_SUBSCRIPTIONS_CREATE: 'sales:subscriptions:create',
  SALES_SUBSCRIPTIONS_EDIT: 'sales:subscriptions:edit',
  SALES_SUBSCRIPTIONS_DELETE: 'sales:subscriptions:delete',
  SALES_RECEIPTS_VIEW: 'sales:receipts:view',
  SALES_RECEIPTS_CREATE: 'sales:receipts:create',
  SALES_RECEIPTS_EDIT: 'sales:receipts:edit',
  SALES_RECEIPTS_DELETE: 'sales:receipts:delete',

  BAAS_DISTRIBUTORS_VIEW: 'baas:distributors:view',
  BAAS_DISTRIBUTORS_CREATE: 'baas:distributors:create',
  BAAS_DISTRIBUTORS_EDIT: 'baas:distributors:edit',
  BAAS_DISTRIBUTORS_DELETE: 'baas:distributors:delete',

  BAAS_RECHARGE_REQUESTS_VIEW: 'baas:recharge_requests:view',
  BAAS_RECHARGE_REQUESTS_CREATE: 'baas:recharge_requests:create',
  BAAS_RECHARGE_REQUESTS_EDIT: 'baas:recharge_requests:edit',
  BAAS_RECHARGE_REQUESTS_DELETE: 'baas:recharge_requests:delete',
  BAAS_RECHARGE_REQUESTS_APPROVE: 'baas:recharge_requests:approve',

  BAAS_NOTIFICATIONS_VIEW: 'baas:notifications:view',
  BAAS_NOTIFICATIONS_CREATE: 'baas:notifications:create',
  BAAS_NOTIFICATIONS_EDIT: 'baas:notifications:edit',
  BAAS_NOTIFICATIONS_DELETE: 'baas:notifications:delete',

  BAAS_TREE_VIEW: 'baas:tree:view',
  BAAS_TREE_EDIT: 'baas:tree:edit',

  TEAM_USERS_VIEW: 'team:users:view',
  TEAM_USERS_CREATE: 'team:users:create',
  TEAM_USERS_EDIT: 'team:users:edit',
  TEAM_USERS_DELETE: 'team:users:delete',

  REPORTS_FINANCIAL_VIEW: 'reports:financial:view',
  REPORTS_LISTS_VIEW: 'reports:lists:view',
  REPORTS_LISTS_CREATE: 'reports:lists:create',
  REPORTS_LISTS_EDIT: 'reports:lists:edit',
  REPORTS_LISTS_DELETE: 'reports:lists:delete',
  REPORTS_CLASSES_VIEW: 'reports:classes:view',
  REPORTS_CLASSES_CREATE: 'reports:classes:create',
  REPORTS_CLASSES_EDIT: 'reports:classes:edit',
  REPORTS_CLASSES_DELETE: 'reports:classes:delete',

  ACCOUNTING_CHART_VIEW: 'accounting:chart:view',
  ACCOUNTING_CHART_CREATE: 'accounting:chart:create',
  ACCOUNTING_CHART_EDIT: 'accounting:chart:edit',
  ACCOUNTING_CHART_DELETE: 'accounting:chart:delete',
  ACCOUNTING_RECEIVABLES_VIEW: 'accounting:receivables:view',
  ACCOUNTING_RECEIVABLES_CREATE: 'accounting:receivables:create',
  ACCOUNTING_RECEIVABLES_EDIT: 'accounting:receivables:edit',
  ACCOUNTING_RECEIVABLES_DELETE: 'accounting:receivables:delete',
  ACCOUNTING_EXPENSES_VIEW: 'accounting:expenses:view',
  ACCOUNTING_EXPENSES_CREATE: 'accounting:expenses:create',
  ACCOUNTING_EXPENSES_EDIT: 'accounting:expenses:edit',
  ACCOUNTING_EXPENSES_DELETE: 'accounting:expenses:delete',
  ACCOUNTING_VENDORS_VIEW: 'accounting:vendors:view',
  ACCOUNTING_VENDORS_CREATE: 'accounting:vendors:create',
  ACCOUNTING_VENDORS_EDIT: 'accounting:vendors:edit',
  ACCOUNTING_VENDORS_DELETE: 'accounting:vendors:delete',
  ACCOUNTING_RECONCILE_VIEW: 'accounting:reconcile:view',
  ACCOUNTING_RECONCILE_CREATE: 'accounting:reconcile:create',
  ACCOUNTING_RECONCILE_EDIT: 'accounting:reconcile:edit',
  ACCOUNTING_RECONCILE_DELETE: 'accounting:reconcile:delete',

  APPROVALS_VIEW: 'approvals:bank:view',
  APPROVALS_VERIFY: 'approvals:bank:verify',
})

/** Visibilidad de pestañas BaaS — claves canónicas de matriz */
export const BAAS_TAB_PERMISSIONS = Object.freeze({
  users: PERMS.BAAS_DISTRIBUTORS_VIEW,
  requests: PERMS.BAAS_RECHARGE_REQUESTS_VIEW,
  notifications: PERMS.BAAS_NOTIFICATIONS_VIEW,
})

/** Matriz → legacy BaaS (compatibilidad con permisos antiguos en BD) */
const MATRIX_TO_LEGACY = Object.freeze({
  [PERMS.BAAS_DISTRIBUTORS_VIEW]: BAAS_VIEW_USERS_TAB,
  [PERMS.BAAS_DISTRIBUTORS_EDIT]: BAAS_VIEW_USERS_TAB,
  [PERMS.BAAS_RECHARGE_REQUESTS_VIEW]: BAAS_VIEW_REQUESTS_TAB,
  [PERMS.BAAS_RECHARGE_REQUESTS_EDIT]: BAAS_VIEW_REQUESTS_TAB,
  [PERMS.BAAS_RECHARGE_REQUESTS_APPROVE]: BAAS_VIEW_REQUESTS_TAB,
  [PERMS.BAAS_RECHARGE_REQUESTS_DELETE]: BAAS_VIEW_REQUESTS_TAB,
  [PERMS.BAAS_RECHARGE_REQUESTS_CREATE]: BAAS_CREATE_RECHARGE,
  [PERMS.BAAS_NOTIFICATIONS_VIEW]: BAAS_VIEW_NOTIFICATIONS_TAB,
  [PERMS.BAAS_NOTIFICATIONS_CREATE]: BAAS_VIEW_NOTIFICATIONS_TAB,
  [PERMS.BAAS_NOTIFICATIONS_EDIT]: BAAS_VIEW_NOTIFICATIONS_TAB,
  [PERMS.BAAS_NOTIFICATIONS_DELETE]: BAAS_VIEW_NOTIFICATIONS_TAB,
})

const LEGACY_TO_MATRIX = Object.freeze({
  [BAAS_VIEW_USERS_TAB]: [PERMS.BAAS_DISTRIBUTORS_VIEW, PERMS.BAAS_DISTRIBUTORS_EDIT],
  [BAAS_VIEW_REQUESTS_TAB]: [
    PERMS.BAAS_RECHARGE_REQUESTS_VIEW,
    PERMS.BAAS_RECHARGE_REQUESTS_EDIT,
    PERMS.BAAS_RECHARGE_REQUESTS_APPROVE,
    PERMS.BAAS_RECHARGE_REQUESTS_DELETE,
  ],
  [BAAS_CREATE_RECHARGE]: [PERMS.BAAS_RECHARGE_REQUESTS_CREATE],
  [BAAS_VIEW_NOTIFICATIONS_TAB]: [
    PERMS.BAAS_NOTIFICATIONS_VIEW,
    PERMS.BAAS_NOTIFICATIONS_CREATE,
    PERMS.BAAS_NOTIFICATIONS_EDIT,
    PERMS.BAAS_NOTIFICATIONS_DELETE,
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
  // Legacy en UI ← matriz en BD
  const matrixKeys = LEGACY_TO_MATRIX[perm]
  if (matrixKeys?.some((k) => granted.has(k))) return true
  // Matriz en UI ← legacy en BD
  const legacyKey = MATRIX_TO_LEGACY[perm]
  if (legacyKey && granted.has(legacyKey)) return true
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
