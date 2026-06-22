import api from './axios'

const LOGIN_FALLBACK = 'Error de validación al iniciar sesión'

/**
 * Convierte ``detail`` de FastAPI (string, array Pydantic, objeto) en texto para UI.
 */
export function parseAuthErrorDetail(detail, fallback = LOGIN_FALLBACK) {
  if (typeof detail === 'string' && detail.trim()) {
    return detail
  }
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0]
    if (typeof first === 'string') return first
    if (first && typeof first.msg === 'string') return first.msg
  }
  if (detail && typeof detail === 'object' && typeof detail.msg === 'string') {
    return detail.msg
  }
  return fallback
}

/**
 * POST ``/api/v1/auth/login`` — el backend espera JSON ``{ email, password }`` (LoginRequest).
 */
export async function loginWithEmailPassword(email, password) {
  const trimmedEmail = String(email ?? '').trim()
  const { data } = await api.post('/api/v1/auth/login', {
    email: trimmedEmail,
    password: String(password ?? ''),
  })
  return data
}
