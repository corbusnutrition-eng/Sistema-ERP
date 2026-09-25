import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000',
  headers: { 'Content-Type': 'application/json' },
  // El JWT viaja en una cookie HttpOnly: el navegador la adjunta solo si
  // withCredentials está activo (obligatorio para peticiones cross-origin,
  // que es el caso en producción — frontend y backend en dominios distintos).
  withCredentials: true,
})

api.interceptors.request.use((config) => {
  // FormData requiere que el navegador fije multipart boundary (no application/json por defecto)
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    delete config.headers['Content-Type']
  }
  return config
})

// ── Refresco silencioso de sesión ───────────────────────────────────────────
//
// Un 401 con detail "token_expired" dispara UN solo POST /auth/refresh
// (encolando cualquier petición concurrente que también reciba 401 mientras
// el refresh está en vuelo, para no disparar N refrescos en paralelo) y
// reintenta la petición original. Si el refresh falla, ahí sí se cierra
// sesión — evita el falso "sesión perdida" cuando el access token expira
// pero el usuario sigue activo.
const AUTH_PATHS = ['/auth/login', '/auth/refresh', '/auth/logout']

function isAuthPath(url) {
  const path = String(url || '')
  return AUTH_PATHS.some((p) => path.includes(p))
}

let refreshPromise = null

function refreshSessionOnce() {
  if (!refreshPromise) {
    refreshPromise = api
      .post('/api/v1/auth/refresh')
      .finally(() => {
        refreshPromise = null
      })
  }
  return refreshPromise
}

// Rutas públicas envueltas igual por AuthProvider (dispara GET /auth/me al
// montar) pero que NO deben rebotar a /login: tienen su propia UI de acceso
// (link con token, login del portal) y un visitante sin cookie de staff ahí
// es el caso normal, no una sesión perdida.
const PUBLIC_PATH_PREFIXES = ['/login', '/portal', '/pay', '/checkout']

function isPublicPath(pathname) {
  return PUBLIC_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

function redirectToLogin() {
  try {
    localStorage.removeItem('user')
  } catch {
    // localStorage puede fallar (modo privado); no es crítico.
  }
  // Sin esta guarda, un visitante sin sesión en /login o en una ruta pública
  // (portal, pago, checkout) sería forzado a `location.href = '/login'`
  // igual (Chromium recarga aunque el valor no cambie), lo que remonta
  // AuthProvider y repite el 401 en un bucle infinito de recargas.
  if (!isPublicPath(window.location.pathname)) {
    window.location.href = '/login'
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (import.meta.env.DEV) {
      console.error('[api]', error.config?.method, error.config?.url, error.response?.status, error.response?.data)
    }

    const original = error.config
    const status = error.response?.status
    const detail = error.response?.data?.detail

    if (status !== 401 || !original || isAuthPath(original.url)) {
      return Promise.reject(error)
    }

    if (detail !== 'token_expired') {
      // token_invalid, usuario inactivo, o "no autenticado" sin más contexto
      // (ninguna cookie presente): ningún refresh va a arreglar esto.
      redirectToLogin()
      return Promise.reject(error)
    }

    if (original._retriedAfterRefresh) {
      // Ya se reintentó una vez tras refrescar y volvió a fallar: sesión perdida de verdad.
      redirectToLogin()
      return Promise.reject(error)
    }

    try {
      await refreshSessionOnce()
    } catch {
      redirectToLogin()
      return Promise.reject(error)
    }

    original._retriedAfterRefresh = true
    return api(original)
  }
)

export default api
