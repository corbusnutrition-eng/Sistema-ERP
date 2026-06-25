import api from './axios'

export async function fetchTeamUsers() {
  const { data } = await api.get('/api/v1/users/team')
  return data
}

export async function fetchTeamUser(userId) {
  const { data } = await api.get(`/api/v1/users/${userId}`)
  return data
}

export async function createTeamUser(payload) {
  const { data } = await api.post('/api/v1/users/', payload)
  return data
}

export async function updateTeamUser(userId, payload) {
  const { data } = await api.patch(`/api/v1/users/${userId}`, payload)
  return data
}

export async function toggleTeamUserActive(userId) {
  const { data } = await api.patch(`/api/v1/users/${userId}/toggle-active`)
  return data
}

export async function fetchPermissionsMatrix() {
  const { data } = await api.get('/api/v1/permissions/matrix')
  return data
}
