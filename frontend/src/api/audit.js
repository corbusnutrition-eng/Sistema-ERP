import api from './axios'

/** Página del listado de auditoría (paginación keyset por `cursor`). */
export async function fetchAuditLogs(params = {}) {
  const { data } = await api.get('/api/v1/audit', { params })
  return data
}

/** Detalle completo (con before/after) de una fila. */
export async function fetchAuditLogDetail(id) {
  const { data } = await api.get(`/api/v1/audit/${id}`)
  return data
}

/** Todos los cambios de una misma petición (correlacionados por request_id). */
export async function fetchAuditRequestTrace(requestId) {
  const { data } = await api.get(`/api/v1/audit/request/${requestId}`)
  return data
}

/** Catálogo de tablas auditables (para el filtro). */
export async function fetchAuditTables() {
  const { data } = await api.get('/api/v1/audit/meta/tables')
  return data
}
