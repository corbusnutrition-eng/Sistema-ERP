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
