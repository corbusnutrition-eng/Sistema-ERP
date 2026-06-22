import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { X, Plus } from 'lucide-react'
import api from '../../../api/axios'

/**
 * Multi-select de etiquetas estilo QuickBooks: busca en el catálogo, permite crear nuevas (POST /sale-tags).
 */
export default function SaleCreatableTagsSelect({
  groups,
  value,
  onChange,
  disabled,
  onCatalogRefresh,
}) {
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState('')
  const inputRef = useRef(null)

  const defaultGroupId = useMemo(() => {
    const g = Array.isArray(groups) && groups.length ? groups[0] : null
    return g?.id != null ? Number(g.id) : null
  }, [groups])

  const flatTags = useMemo(() => {
    const out = []
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const t of Array.isArray(g?.tags) ? g.tags : []) {
        if (t?.id == null) continue
        out.push({
          id: Number(t.id),
          name: String(t.name ?? '').trim(),
          groupId: g.id,
          groupName: g.name,
          groupColor: g.color,
        })
      }
    }
    out.sort((a, b) =>
      String(a.name).localeCompare(String(b.name), 'es', { sensitivity: 'base' }),
    )
    return out
  }, [groups])

  const selectedSet = useMemo(
    () => new Set(Array.isArray(value) ? value.map(Number).filter((n) => n >= 1) : []),
    [value],
  )

  const selectedObjs = useMemo(() => {
    const map = new Map(flatTags.map((t) => [t.id, t]))
    return (Array.isArray(value) ? value : []).map((id) => map.get(Number(id))).filter(Boolean)
  }, [flatTags, value])

  const qTrim = q.trim()
  const qLower = qTrim.toLowerCase()
  const suggestions = useMemo(() => {
    if (!qLower) return flatTags.filter((t) => !selectedSet.has(t.id)).slice(0, 40)
    return flatTags.filter(
      (t) => !selectedSet.has(t.id) && String(t.name).toLowerCase().includes(qLower),
    )
  }, [flatTags, qLower, selectedSet])

  const canCreate =
    qTrim.length >= 1 &&
    !flatTags.some((t) => String(t.name).toLowerCase() === qLower) &&
    defaultGroupId != null &&
    Number.isFinite(defaultGroupId)

  const toggle = useCallback(
    (id) => {
      const n = Number(id)
      if (!Number.isFinite(n) || n < 1) return
      const next = new Set(selectedSet)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      onChange(Array.from(next).sort((a, b) => a - b))
    },
    [onChange, selectedSet],
  )

  const removeChip = useCallback(
    (id) => {
      const next = new Set(selectedSet)
      next.delete(Number(id))
      onChange(Array.from(next).sort((a, b) => a - b))
    },
    [onChange, selectedSet],
  )

  async function createTag() {
    if (!canCreate || disabled || creating) return
    setCreating(true)
    setCreateErr('')
    try {
      const { data } = await api.post('/api/v1/sale-tags/', {
        name: qTrim,
        group_id: defaultGroupId,
      })
      const nid = data?.id != null ? Number(data.id) : null
      if (nid != null && Number.isFinite(nid)) {
        const next = new Set(selectedSet)
        next.add(nid)
        onChange(Array.from(next).sort((a, b) => a - b))
        setQ('')
        await onCatalogRefresh?.()
      }
    } catch (err) {
      const d = err?.response?.data?.detail
      setCreateErr(typeof d === 'string' ? d : 'No se pudo crear la etiqueta.')
    } finally {
      setCreating(false)
    }
  }

  useEffect(() => {
    setCreateErr('')
  }, [qTrim])

  return (
    <div className="space-y-2">
      <div
        className={`min-h-[42px] flex flex-wrap gap-1.5 items-center px-2.5 py-1.5 rounded-xl border border-gray-200 bg-white ${
          disabled ? 'opacity-50' : ''
        }`}
        onClick={() => !disabled && inputRef.current?.focus()}
      >
        {selectedObjs.map((t) => (
          <span
            key={t.id}
            className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-800 border border-slate-200/80"
          >
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: t.groupColor || '#64748B' }}
              aria-hidden
            />
            <span className="max-w-[180px] truncate">{t.name}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation()
                removeChip(t.id)
              }}
              className="p-0.5 rounded hover:bg-slate-200 text-slate-500"
              aria-label={`Quitar ${t.name}`}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          disabled={disabled}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (suggestions[0] && !canCreate) toggle(suggestions[0].id)
              else if (canCreate) createTag()
            }
          }}
          placeholder={selectedObjs.length ? '' : 'Buscar o crear etiqueta…'}
          className="flex-1 min-w-[120px] bg-transparent text-sm outline-none border-0 py-1 px-0.5"
        />
      </div>

      {qTrim && (
        <div className="rounded-xl border border-gray-100 bg-gray-50/80 max-h-40 overflow-y-auto divide-y divide-gray-100">
          {canCreate && (
            <button
              type="button"
              disabled={disabled || creating}
              onClick={createTag}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm font-medium text-blue-700 hover:bg-blue-50"
            >
              <Plus size={16} className="shrink-0" />
              {creating ? 'Creando…' : `Crear etiqueta «${qTrim}»`}
            </button>
          )}
          {suggestions.map((t) => (
            <button
              key={t.id}
              type="button"
              disabled={disabled}
              onClick={() => {
                toggle(t.id)
                setQ('')
              }}
              className="w-full text-left px-3 py-2 text-sm text-gray-800 hover:bg-white flex items-center gap-2"
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: t.groupColor || '#64748B' }}
              />
              <span className="truncate">{t.name}</span>
              <span className="text-[10px] text-gray-400 truncate">{t.groupName}</span>
            </button>
          ))}
          {!canCreate && suggestions.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-500">Sin coincidencias</p>
          )}
        </div>
      )}

      {createErr && <p className="text-xs text-red-600">{createErr}</p>}
      {!defaultGroupId && (
        <p className="text-[11px] text-amber-800">
          Crea un grupo de etiquetas en «Administrar etiquetas» antes de añadir etiquetas nuevas.
        </p>
      )}
    </div>
  )
}
