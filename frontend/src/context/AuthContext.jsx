import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import api from '../api/axios'
import { fetchAuthMe } from '../api/auth'
import { effectivePermissions, hasPermission as checkPermission, hasAnyBaasPermission } from '../lib/permissions'

const AuthContext = createContext(null)

// El JWT vive en una cookie HttpOnly (invisible para JS, inmune a robo por
// XSS): este `user` cacheado en localStorage es solo una copia no sensible
// (nombre, rol, permisos) para pintar la UI sin parpadeo antes de que
// resuelva `refreshSession()`. La fuente de verdad es siempre GET /auth/me.
function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null')
  } catch {
    return null
  }
}

function persistUser(user) {
  try {
    if (user) {
      localStorage.setItem('user', JSON.stringify(user))
    } else {
      localStorage.removeItem('user')
    }
  } catch {
    // localStorage puede fallar (modo privado, cuota); no es crítico, es solo caché.
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => readStoredUser())
  const [loading, setLoading] = useState(true)

  const permissions = useMemo(
    () => effectivePermissions(user?.role, user?.permissions),
    [user?.role, user?.permissions],
  )

  const setSession = useCallback((nextUser) => {
    const normalized = nextUser
      ? {
          ...nextUser,
          permissions: effectivePermissions(nextUser.role, nextUser.permissions),
          role_template: nextUser.role_template ?? null,
          assigned_account_ids: Array.isArray(nextUser.assigned_account_ids)
            ? nextUser.assigned_account_ids
            : [],
        }
      : null
    persistUser(normalized)
    setUser(normalized)
    setLoading(false)
  }, [])

  const clearSession = useCallback(async () => {
    try {
      await api.post('/api/v1/auth/logout')
    } catch {
      // Si el logout en el servidor falla (red caída, sesión ya inválida) igual
      // limpiamos el estado local: no queremos dejar al usuario "atascado".
    }
    persistUser(null)
    setUser(null)
    setLoading(false)
  }, [])

  const refreshSession = useCallback(async () => {
    setLoading(true)
    try {
      const me = await fetchAuthMe()
      const nextUser = {
        name: me.name,
        role: me.role,
        email: me.email,
        user_id: me.user_id ?? null,
        permissions: me.permissions ?? [],
        role_template: me.role_template ?? null,
        assigned_account_ids: Array.isArray(me.assigned_account_ids) ? me.assigned_account_ids : [],
      }
      persistUser(nextUser)
      setUser(nextUser)
      return nextUser
    } catch {
      persistUser(null)
      setUser(null)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Sin cookie no hay forma de saber desde JS si hay sesión: se pregunta
    // siempre al backend al montar (antes esto se saltaba si no había
    // `access_token` en localStorage, porque el token SÍ era legible ahí).
    refreshSession()
  }, [refreshSession])

  const hasPermission = useCallback(
    (permission) => checkPermission(user?.role, permissions, permission),
    [user?.role, permissions],
  )

  const value = useMemo(
    () => ({
      user,
      permissions,
      loading,
      isAuthenticated: Boolean(user),
      isAdmin: user?.role === 'admin',
      hasAnyBaasAccess: hasAnyBaasPermission(user?.role, permissions),
      hasPermission,
      setSession,
      clearSession,
      refreshSession,
    }),
    [user, permissions, loading, hasPermission, setSession, clearSession, refreshSession],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth debe usarse dentro de AuthProvider')
  }
  return ctx
}
