import api from './axios'

function logApiValidationError(error, action) {
  const detail = error?.response?.data?.detail
  console.error(`Error 422 Detalle (${action}):`, detail ?? error?.response?.data ?? error)
  if (import.meta.env.DEV && error?.config?.data) {
    try {
      console.error('Payload enviado:', JSON.parse(error.config.data))
    } catch {
      console.error('Payload enviado (raw):', error.config.data)
    }
  }
}

export async function fetchTeamUsers() {
  const { data } = await api.get('/api/v1/users/team')
  return data
}

export async function fetchTeamUser(userId) {
  const { data } = await api.get(`/api/v1/users/${userId}`)
  return data
}

export async function createTeamUser(payload) {
  if (import.meta.env.DEV) {
    console.debug('[createTeamUser] POST /api/v1/users/', payload)
  }
  try {
    const { data } = await api.post('/api/v1/users/', payload)
    return data
  } catch (error) {
    if (error?.response?.status === 422) {
      logApiValidationError(error, 'POST /api/v1/users/')
    }
    throw error
  }
}

export async function updateTeamUser(userId, payload) {
  if (import.meta.env.DEV) {
    console.debug(`[updateTeamUser] PATCH /api/v1/users/${userId}`, payload)
  }
  try {
    const { data } = await api.patch(`/api/v1/users/${userId}`, payload)
    return data
  } catch (error) {
    if (error?.response?.status === 422) {
      logApiValidationError(error, `PATCH /api/v1/users/${userId}`)
    }
    throw error
  }
}

export async function toggleTeamUserActive(userId) {
  const { data } = await api.patch(`/api/v1/users/${userId}/toggle-active`)
  return data
}

export async function fetchPermissionsMatrix() {
  const { data } = await api.get('/api/v1/permissions/matrix')
  return data
}
