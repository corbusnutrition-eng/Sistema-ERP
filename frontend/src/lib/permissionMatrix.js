/** Utilidades para la matriz de permisos estilo QuickBooks. */

import {
  BAAS_CREATE_RECHARGE,
  BAAS_VIEW_NOTIFICATIONS_TAB,
  BAAS_VIEW_REQUESTS_TAB,
  BAAS_VIEW_USERS_TAB,
  PERMS,
} from './permissions'

export const ROLE_TEMPLATE_CUSTOM = 'custom'
export const ROLE_TEMPLATE_FULL_ADMIN = 'full_admin'
export const ROLE_TEMPLATE_ACCOUNT_VERIFIER = 'account_verifier'

export function isAccountVerifierUser(user) {
  if (!user || user.role === 'admin') return false
  return String(user.role_template || '').trim() === ROLE_TEMPLATE_ACCOUNT_VERIFIER
}

/** Trabajador/verificador con cuentas asignadas — vista operativa limitada al libro mayor. */
export function isRestrictedLedgerUser(user) {
  if (!user || user.role === 'admin') return false
  if (isAccountVerifierUser(user)) return true
  const ids = Array.isArray(user.assigned_account_ids) ? user.assigned_account_ids : []
  return user.role === 'worker' && ids.length > 0
}

export function getPrimaryAssignedAccountPath(user) {
  const ids = Array.isArray(user?.assigned_account_ids) ? user.assigned_account_ids : []
  const first = ids.map((id) => Number(id)).find((id) => Number.isFinite(id) && id > 0)
  return first ? `/contabilidad/cuenta/${first}` : null
}

/** Ruta de inicio tras login o acceso a `/`. */
export function resolvePostLoginPath(user, { hasPermission, hasAnyBaasPermission }) {
  if (!user) return '/login'
  if (user.role === 'admin') return '/dashboard'

  const ledgerPath = getPrimaryAssignedAccountPath(user)
  if (isRestrictedLedgerUser(user) && ledgerPath) return ledgerPath

  if (hasAnyBaasPermission(user.role, user.permissions)) return '/equipo/distribuidores'
  if (hasPermission?.(PERMS.DASHBOARD_VIEW)) return '/dashboard'
  if (hasPermission?.(PERMS.CLIENTS_VIEW)) return '/clientes'
  if (ledgerPath) return ledgerPath
  return '/clientes'
}

export function splitFullName(fullName = '') {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: '', lastName: '' }
  if (parts.length === 1) return { firstName: parts[0], lastName: '' }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

export function joinFullName(firstName, lastName) {
  return [firstName, lastName].map((s) => String(s || '').trim()).filter(Boolean).join(' ')
}

export function buildGrantedSet(permissions) {
  return new Set(Array.isArray(permissions) ? permissions.filter(Boolean) : [])
}

export function collectMatrixKeys(modules = []) {
  const keys = []
  for (const mod of modules) {
    for (const row of mod?.rows ?? []) {
      for (const key of Object.values(row?.cells ?? {})) {
        if (key) keys.push(key)
      }
    }
  }
  return keys
}

export function moduleAccessSummary(module, grantedSet) {
  const rows = module?.rows ?? []
  const withAccess = []
  const withoutAccess = []

  for (const row of rows) {
    const keys = Object.values(row?.cells ?? {}).filter(Boolean)
    const hasAny = keys.some((k) => grantedSet.has(k))
    if (hasAny) withAccess.push(row.label)
    else withoutAccess.push(row.label)
  }

  if (withAccess.length === 0) {
    return { level: 'none', label: 'Sin acceso', withAccess, withoutAccess }
  }
  if (withoutAccess.length === 0) {
    return { level: 'full', label: 'Acceso completo', withAccess, withoutAccess }
  }
  return { level: 'partial', label: 'Acceso parcial', withAccess, withoutAccess }
}

export function permissionsFromRoleTemplate(roleTemplate, predefinedRoles = [], allMatrixKeys = []) {
  const tpl = predefinedRoles.find((r) => r.id === roleTemplate)
  if (!tpl) return []
  if (roleTemplate === ROLE_TEMPLATE_FULL_ADMIN) return [...allMatrixKeys]
  return Array.isArray(tpl.permissions) ? [...tpl.permissions] : []
}

export function toggleMatrixPermission(grantedSet, permissionKey, enabled) {
  const next = new Set(grantedSet)
  if (enabled) next.add(permissionKey)
  else next.delete(permissionKey)
  return next
}

/** Legacy BaaS → celdas de matriz (solo visualización). */
const LEGACY_TO_MATRIX_DISPLAY = {
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

export function expandPermissionsForMatrixDisplay(permissions, modules = []) {
  const matrixKeys = new Set(collectMatrixKeys(modules))
  const out = new Set()
  for (const raw of permissions ?? []) {
    const key = String(raw || '').trim()
    if (!key) continue
    if (matrixKeys.has(key)) out.add(key)
    if (LEGACY_TO_MATRIX_DISPLAY[key]) {
      for (const mk of LEGACY_TO_MATRIX_DISPLAY[key]) {
        if (matrixKeys.has(mk)) out.add(mk)
      }
    }
  }
  return [...out]
}

export function matrixPermissionsOnly(grantedSet, modules) {
  const valid = new Set(collectMatrixKeys(modules))
  const source = grantedSet instanceof Set ? grantedSet : new Set(grantedSet)
  return [...source].filter((k) => valid.has(k))
}

/**
 * Serializa el estado de la matriz QBO al payload REST esperado por UserCreate/UserUpdate.
 * Siempre devuelve: { name, email, role_template, permissions? , password? }
 */
export function buildUserApiPayload({
  firstName,
  lastName,
  email,
  password,
  roleTemplate,
  isCustomRole,
  granted,
  modules,
  assignedAccountIds,
}) {
  const name = joinFullName(firstName, lastName)
  const payload = {
    name,
    email: String(email || '').trim(),
    role_template: String(roleTemplate || '').trim(),
  }

  if (!payload.name) {
    throw new Error('El nombre es obligatorio.')
  }
  if (!payload.email) {
    throw new Error('El correo electrónico es obligatorio.')
  }
  if (!payload.role_template) {
    throw new Error('Selecciona un rol para continuar.')
  }

  const pwd = String(password || '').trim()
  if (pwd) {
    if (pwd.length < 6) {
      throw new Error('La contraseña debe tener al menos 6 caracteres.')
    }
    payload.password = pwd
  }

  if (isCustomRole) {
    const permissions = matrixPermissionsOnly(new Set(granted), modules)
    if (!permissions.length) {
      throw new Error('El rol personalizado requiere al menos un permiso en la matriz.')
    }
    payload.permissions = permissions
  }

  if (roleTemplate === ROLE_TEMPLATE_ACCOUNT_VERIFIER) {
    const ids = Array.isArray(assignedAccountIds)
      ? [...new Set(assignedAccountIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
      : []
    if (!ids.length) {
      throw new Error('Selecciona al menos una cuenta asignada para el Verificador de Cuentas.')
    }
    payload.assigned_account_ids = ids
  }

  return payload
}
