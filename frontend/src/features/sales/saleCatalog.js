import api from '../../api/axios'

function sortByName(a, b) {
  return String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'es', {
    sensitivity: 'base',
  })
}

/** Clases contables activas (`GET /api/v1/classes/` — el backend filtra inactivas por defecto). */
export async function fetchActiveTransactionClasses() {
  const { data } = await api.get('/api/v1/classes/', { params: { include_inactive: false } })
  const list = Array.isArray(data) ? data : []
  return list
    .filter((c) => c?.is_active !== false)
    .slice()
    .sort(sortByName)
}

/** Grupos de etiquetas de venta con tags anidadas (`GET /api/v1/tag-groups/`). */
export async function fetchSaleTagGroups() {
  const { data } = await api.get('/api/v1/tag-groups/')
  const list = Array.isArray(data) ? data : []
  return list.slice().sort(sortByName)
}

export async function fetchSaleCatalog() {
  const [classes, tagGroups] = await Promise.all([
    fetchActiveTransactionClasses(),
    fetchSaleTagGroups(),
  ])
  return { classes, tagGroups }
}

export function mapTransactionClassesToSelectOptions(classes) {
  return (Array.isArray(classes) ? classes : [])
    .filter((c) => c?.is_active !== false && c?.id != null)
    .map((c) => ({
      value: String(c.id),
      label: String(c.name ?? '').trim() || `Clase #${c.id}`,
    }))
}

/** Raíz del catálogo de etiquetas de venta (`group_id` va en el body, no en la URL). */
export const SALE_TAGS_API = '/api/v1/sale-tags'

function normalizeGroupId(groupId) {
  const gid = Number(groupId)
  if (!Number.isFinite(gid) || gid < 1) return null
  return gid
}

/** Crear etiqueta (`POST /api/v1/sale-tags` con `{ name, group_id }`). */
export async function createSaleTag({ name, group_id: groupId }) {
  const trimmed = String(name ?? '').trim()
  const gid = normalizeGroupId(groupId)
  if (!trimmed || gid == null) {
    throw new Error('Se requieren name y group_id válidos')
  }
  const { data } = await api.post(SALE_TAGS_API, { name: trimmed, group_id: gid })
  return data
}

export async function updateSaleTag(tagId, { name, group_id: groupId } = {}) {
  const id = Number(tagId)
  if (!Number.isFinite(id) || id < 1) {
    throw new Error('ID de etiqueta no válido')
  }
  const payload = {}
  if (name !== undefined) payload.name = String(name).trim()
  if (groupId !== undefined) {
    const gid = normalizeGroupId(groupId)
    if (gid == null) throw new Error('group_id no válido')
    payload.group_id = gid
  }
  const { data } = await api.patch(`${SALE_TAGS_API}/${id}`, payload)
  return data
}

export async function deleteSaleTag(tagId) {
  const id = Number(tagId)
  if (!Number.isFinite(id) || id < 1) {
    throw new Error('ID de etiqueta no válido')
  }
  await api.delete(`${SALE_TAGS_API}/${id}`)
}
