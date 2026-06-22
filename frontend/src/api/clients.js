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
 * Lista clientes igual que la vista principal (`Clientes.jsx`: GET con paginación).
 * Trae toda la red (clientes directos y sub-clientes) en lotes.
 *
 * @param {{ limit?: number, skip?: number, search?: string }} opts
 */
export async function fetchClientsList(opts = {}) {
  const limit = opts.limit ?? 1000
  let skip = opts.skip ?? 0
  const search = opts.search?.trim() || undefined
  const all = []
  while (true) {
    const params = { skip, limit }
    if (search) params.search = search
    const { data } = await api.get('/api/v1/clients/', { params })
    const batch = normalizeClientsListPayload(data)
    all.push(...batch)
    if (batch.length < limit) break
    skip += limit
  }
  return all
}
