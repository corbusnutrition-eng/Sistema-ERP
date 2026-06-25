export const FORBIDDEN_MESSAGE = 'No tienes permiso para ver esta información'

export function isForbiddenError(error) {
  return error?.response?.status === 403
}

export function isUnauthorizedError(error) {
  return error?.response?.status === 401
}

/**
 * Mensaje legible para errores de API.
 * Los 403 muestran un aviso claro de permisos insuficientes.
 */
export function getApiErrorMessage(error, { forbiddenMessage = FORBIDDEN_MESSAGE, fallback = 'Ocurrió un error.' } = {}) {
  if (isForbiddenError(error)) return forbiddenMessage

  const detail = error?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item.msg === 'string') return item.msg
        return null
      })
      .filter(Boolean)
    if (parts.length) return parts.join('; ')
  }

  return fallback
}
