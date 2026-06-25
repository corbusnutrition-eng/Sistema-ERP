import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { fetchAuthMe } from '../api/auth'
import { effectivePermissions, hasPermission as checkPermission, hasAnyBaasPermission } from '../lib/permissions'

const AuthContext = createContext(null)

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null')
  } catch {
    return null
  }
}

function persistUser(user) {
  if (user) {
    localStorage.setItem('user', JSON.stringify(user))
  } else {
    localStorage.removeItem('user')
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => readStoredUser())
  const [loading, setLoading] = useState(() => Boolean(localStorage.getItem('access_token')))

  const permissions = useMemo(
    () => effectivePermissions(user?.role, user?.permissions),
    [user?.role, user?.permissions],
  )

  const setSession = useCallback((accessToken, nextUser) => {
    if (accessToken) {
      localStorage.setItem('access_token', accessToken)
    }
    const normalized = nextUser
      ? {
          ...nextUser,
          permissions: effectivePermissions(nextUser.role, nextUser.permissions),
        }
      : null
    persistUser(normalized)
    setUser(normalized)
    setLoading(false)
  }, [])

  const clearSession = useCallback(() => {
    localStorage.removeItem('access_token')
    persistUser(null)
    setUser(null)
    setLoading(false)
  }, [])

  const refreshSession = useCallback(async () => {
    const token = localStorage.getItem('access_token')
    if (!token) {
      setLoading(false)
      return null
    }
    setLoading(true)
    try {
      const me = await fetchAuthMe()
      const nextUser = {
        name: me.name,
        role: me.role,
        email: me.email,
        user_id: me.user_id ?? null,
        permissions: me.permissions ?? [],
      }
      persistUser(nextUser)
      setUser(nextUser)
      return nextUser
    } catch {
      clearSession()
      return null
    } finally {
      setLoading(false)
    }
  }, [clearSession])

  useEffect(() => {
    if (localStorage.getItem('access_token')) {
      refreshSession()
    } else {
      setLoading(false)
    }
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
      isAuthenticated: Boolean(localStorage.getItem('access_token') && user),
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
