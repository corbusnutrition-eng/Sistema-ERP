import { useCallback, useEffect, useMemo, useState } from 'react'
import CreatableSelect from 'react-select/creatable'
import api from '../../../api/axios'

/**
 * Etiquetas de **venta** (tabla `sale_tags`, ids enteros) — mismas APIs que TagManagerPanel:
 * GET `/tag-groups/`, POST `/sale-tags/`.
 *
 * Nota: `/api/v1/tags` es el catálogo CRM (UUID) y no es compatible con `tag_ids` en POST /sales/.
 */
export default function SaleQBTagsCreatable({
  value,
  onChange,
  disabled,
  onCatalogRefresh,
  zIndex = 6100,
}) {
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const loadGroups = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get('/api/v1/tag-groups/')
      const list = Array.isArray(data) ? data : []
      list.sort((a, b) =>
        String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'es', { sensitivity: 'base' }),
      )
      setGroups(list)
    } catch {
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadGroups()
  }, [loadGroups])

  const defaultGroupId = useMemo(() => {
    const g = groups[0]
    return g?.id != null ? Number(g.id) : null
  }, [groups])

  const options = useMemo(() => {
    const out = []
    for (const g of groups) {
      const color = g.color || '#64748B'
      const gname = String(g.name || '')
      for (const t of Array.isArray(g.tags) ? g.tags : []) {
        if (t?.id == null) continue
        out.push({
          value: Number(t.id),
          label: String(t.name || '').trim() || `Etiqueta ${t.id}`,
          meta: { color, groupName: gname },
        })
      }
    }
    out.sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }))
    return out
  }, [groups])

  const selectedSet = useMemo(() => new Set(Array.isArray(value) ? value.map(Number) : []), [value])

  const valueAsOptions = useMemo(
    () => options.filter((o) => selectedSet.has(o.value)),
    [options, selectedSet],
  )

  const handleCreate = useCallback(
    async (inputValue) => {
      const name = String(inputValue || '').trim()
      if (!name || !defaultGroupId || creating || disabled) return
      setCreating(true)
      try {
        const { data } = await api.post('/api/v1/sale-tags/', {
          name,
          group_id: defaultGroupId,
        })
        const nid = data?.id != null ? Number(data.id) : null
        await loadGroups()
        await onCatalogRefresh?.()
        if (nid != null && Number.isFinite(nid)) {
          onChange([...new Set([...(Array.isArray(value) ? value : []), nid])].sort((a, b) => a - b))
        }
      } catch {
        /* parent puede mostrar error vía toast si se desea */
      } finally {
        setCreating(false)
      }
    },
    [defaultGroupId, creating, disabled, loadGroups, onCatalogRefresh, onChange, value],
  )

  const customStyles = useMemo(
    () => ({
      control: (base, state) => ({
        ...base,
        borderRadius: 12,
        borderColor: state.isFocused ? '#93c5fd' : '#e5e7eb',
        boxShadow: state.isFocused ? '0 0 0 2px rgba(59,130,246,0.15)' : 'none',
        minHeight: 42,
        fontSize: 14,
      }),
      menuPortal: (base) => ({ ...base, zIndex }),
      multiValue: (base, { data }) => ({
        ...base,
        backgroundColor: data.meta?.color ? `${data.meta.color}26` : '#f1f5f9',
        borderRadius: 8,
      }),
      multiValueLabel: (base, { data }) => ({
        ...base,
        color: '#1e293b',
        fontWeight: 500,
        fontSize: 12,
      }),
      multiValueRemove: (base) => ({
        ...base,
        ':hover': { backgroundColor: 'rgba(0,0,0,0.06)', color: '#0f172a' },
      }),
      option: (base, state) => ({
        ...base,
        fontSize: 14,
        backgroundColor: state.isSelected ? '#eff6ff' : state.isFocused ? '#f8fafc' : 'white',
        color: '#0f172a',
      }),
    }),
    [zIndex],
  )

  if (loading) {
    return (
      <div className="text-sm text-gray-400 py-2 flex items-center gap-2">
        <span className="w-3.5 h-3.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
        Cargando etiquetas…
      </div>
    )
  }

  return (
    <CreatableSelect
      isMulti
      isClearable
      isDisabled={disabled || creating}
      options={options}
      value={valueAsOptions}
      onChange={(sel) => {
        const ids = (Array.isArray(sel) ? sel : []).map((x) => Number(x.value)).filter((n) => n >= 1)
        onChange(ids.sort((a, b) => a - b))
      }}
      onCreateOption={handleCreate}
      placeholder="Buscar o crear etiqueta…"
      formatCreateLabel={(inputValue) => `Crear «${inputValue.trim()}»`}
      noOptionsMessage={({ inputValue }) =>
        inputValue ? 'Sin coincidencias' : 'Escribe para buscar o crear'
      }
      styles={customStyles}
      menuPortalTarget={typeof document !== 'undefined' ? document.body : null}
      menuPosition="fixed"
      classNamePrefix="sale-qb-tags"
      isValidNewOption={(inputValue) => {
        const v = String(inputValue || '').trim().toLowerCase()
        if (v.length < 1) return false
        return !options.some((o) => o.label.toLowerCase() === v)
      }}
    />
  )
}
