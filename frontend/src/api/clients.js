import api from './axios'

/**
 * Convierte la respuesta del listado CRM en un array de clientes.
 * El backend actual devuelve JSON array directo; otros proxies pueden envolver { items }, { data }, etc.
 */
export function normalizeClientsListPayload(payload) {
  if (payload == null) return []
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload.items)) return payload.items
  if (Array.isArray(payload.data)) return payload.data
  if (Array.isArray(payload.results)) return payload.results
  return []
}

/**
 * Una página del listado CRM (`GET /clients/` con skip/limit/search).
 *
 * @param {{ skip?: number, limit?: number, search?: string, signal?: AbortSignal }} opts
 */
export async function fetchClientsPage({ skip = 0, limit = 50, search, signal } = {}) {
  const params = { skip, limit }
  const term = search?.trim()
  if (term) params.search = term
  const { data } = await api.get('/api/v1/clients/', { params, signal })
  return normalizeClientsListPayload(data)
}

/**
 * Lista clientes en lotes hasta agotar el catálogo (evitar en vistas grandes).
 *
 * @param {{ limit?: number, skip?: number, search?: string }} opts
 */
export async function fetchClientsList(opts = {}) {
  const limit = opts.limit ?? 1000
  let skip = opts.skip ?? 0
  const search = opts.search?.trim() || undefined
  const all = []
  while (true) {
    const batch = await fetchClientsPage({ skip, limit, search })
    all.push(...batch)
    if (batch.length < limit) break
    skip += limit
  }
  return all
}

/**
 * Seguimiento CRM: clientes con última compra de créditos normales.
 *
 * @param {Record<string, string|number|undefined>} [params] Query opcional (search, credits_min, …).
 */
export async function fetchClientFollowUp(params = {}) {
  const { data } = await api.get('/api/v1/clients/follow-up', { params })
  if (Array.isArray(data?.items)) return data.items
  if (Array.isArray(data)) return data
  return []
}
