import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  X,
  Loader2,
  ArrowLeft,
  Tags,
} from 'lucide-react'
import api from '../../api/axios'
import SearchableSelect from '../../components/ui/SearchableSelect'

/** Paleta estilo QuickBooks */
export const QB_TAG_COLORS = [
  '#2563EB',
  '#DC2626',
  '#059669',
  '#D97706',
  '#7C3AED',
  '#DB2777',
  '#0891B2',
  '#CA8A04',
  '#4F46E5',
  '#EA580C',
  '#64748B',
  '#0F766E',
]

function formatApiDetail(err, fallback) {
  const d = err?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d)) return d.map((x) => x.msg ?? JSON.stringify(x)).join(' · ')
  return fallback
}

/**
 * Panel estilo QuickBooks para grupos y etiquetas de **ventas**.
 * API: `/tag-groups`, `/sale-tags` (el endpoint `/tags` sigue reservado al catálogo CRM).
 */
export default function TagsManagerPanel({
  open = true,
  onClose,
  mode = 'slideover',
  zClassName = 'z-[85]',
  onCatalogChanged,
  className = '',
}) {
  const [groups, setGroups] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())
  const [view, setView] = useState('list')

  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupColor, setNewGroupColor] = useState(QB_TAG_COLORS[0])
  const [newGroupTagLines, setNewGroupTagLines] = useState([''])

  const [newTagName, setNewTagName] = useState('')
  const [newTagGroupId, setNewTagGroupId] = useState('')

  const [editGroupRow, setEditGroupRow] = useState(null)
  const [editTagRow, setEditTagRow] = useState(null)

  const [saving, setSaving] = useState(false)

  const fetchGroups = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const { data } = await api.get('/api/v1/tag-groups/')
      const list = Array.isArray(data) ? data : []
      list.sort((a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'es', { sensitivity: 'base' }))
      setGroups(list)
      onCatalogChanged?.()
    } catch (err) {
      setError(formatApiDetail(err, 'No se pudieron cargar los grupos.'))
      setGroups([])
    } finally {
      setLoading(false)
    }
  }, [onCatalogChanged])

  useEffect(() => {
    if (mode === 'slideover' && !open) return
    fetchGroups()
  }, [open, mode, fetchGroups])

  useEffect(() => {
    if (!groups.length) return
    setNewTagGroupId((prev) => {
      if (prev && groups.some((g) => String(g.id) === prev)) return prev
      return String(groups[0].id)
    })
  }, [groups])

  const toggleExpand = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const resetCreateGroup = () => {
    setNewGroupName('')
    setNewGroupColor(QB_TAG_COLORS[0])
    setNewGroupTagLines([''])
    setView('list')
  }

  async function submitCreateGroup(e) {
    e.preventDefault()
    const name = newGroupName.trim()
    if (!name) return
    const tag_names = newGroupTagLines.map((s) => String(s).trim()).filter(Boolean)
    setSaving(true)
    setError('')
    try {
      await api.post('/api/v1/tag-groups/', {
        name,
        color: newGroupColor,
        tag_names,
      })
      await fetchGroups()
      resetCreateGroup()
    } catch (err) {
      setError(formatApiDetail(err, 'No se pudo crear el grupo.'))
    } finally {
      setSaving(false)
    }
  }

  async function submitCreateTag(e) {
    e.preventDefault()
    const name = newTagName.trim()
    const gid = Number(newTagGroupId)
    if (!name || !gid) return
    setSaving(true)
    setError('')
    try {
      await api.post('/api/v1/sale-tags/', { name, group_id: gid })
      setNewTagName('')
      await fetchGroups()
      setView('list')
    } catch (err) {
      setError(formatApiDetail(err, 'No se pudo crear la etiqueta.'))
    } finally {
      setSaving(false)
    }
  }

  async function saveEditGroup(e) {
    e.preventDefault()
    if (!editGroupRow?.id) return
    const name = String(editGroupRow.name ?? '').trim()
    if (!name) return
    setSaving(true)
    setError('')
    try {
      await api.patch(`/api/v1/tag-groups/${editGroupRow.id}`, {
        name,
        color: editGroupRow.color || QB_TAG_COLORS[0],
      })
      setEditGroupRow(null)
      await fetchGroups()
    } catch (err) {
      setError(formatApiDetail(err, 'No se pudo guardar el grupo.'))
    } finally {
      setSaving(false)
    }
  }

  async function saveEditTag(e) {
    e.preventDefault()
    if (!editTagRow?.id) return
    const name = String(editTagRow.name ?? '').trim()
    const gid = Number(editTagRow.group_id)
    if (!name || !gid) return
    setSaving(true)
    setError('')
    try {
      await api.patch(`/api/v1/sale-tags/${editTagRow.id}`, {
        name,
        group_id: gid,
      })
      setEditTagRow(null)
      await fetchGroups()
    } catch (err) {
      setError(formatApiDetail(err, 'No se pudo guardar la etiqueta.'))
    } finally {
      setSaving(false)
    }
  }

  async function deleteGroup(g) {
    if (!window.confirm(`¿Eliminar el grupo «${g.name}» y todas sus etiquetas?`)) return
    setSaving(true)
    setError('')
    try {
      await api.delete(`/api/v1/tag-groups/${g.id}`)
      await fetchGroups()
    } catch (err) {
      setError(formatApiDetail(err, 'No se pudo eliminar el grupo.'))
    } finally {
      setSaving(false)
    }
  }

  async function deleteTag(t) {
    if (!window.confirm(`¿Eliminar la etiqueta «${t.name}»?`)) return
    setSaving(true)
    setError('')
    try {
      await api.delete(`/api/v1/sale-tags/${t.id}`)
      await fetchGroups()
    } catch (err) {
      setError(formatApiDetail(err, 'No se pudo eliminar la etiqueta.'))
    } finally {
      setSaving(false)
    }
  }

  const sortedGroups = useMemo(() => groups, [groups])

  const inner = (
    <div
      className={`flex flex-col bg-white ${mode === 'embedded' ? `rounded-2xl border border-gray-200 shadow-sm ${className}` : 'h-full'}`}
    >
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center ring-1 ring-blue-100 shrink-0">
            <Tags size={20} className="text-blue-600" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900 truncate">Administra tus etiquetas</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Etiquetas para clasificar ventas (distintas del CRM de clientes).
            </p>
          </div>
        </div>
        {mode === 'slideover' && (
          <button
            type="button"
            onClick={() => onClose?.()}
            className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 shrink-0"
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {view === 'list' && (
        <div className="flex flex-wrap gap-2 px-5 py-3 border-b border-gray-50 bg-gray-50/60">
          <button
            type="button"
            onClick={() => setView('newTag')}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 shadow-sm"
          >
            Crear etiqueta
          </button>
          <button
            type="button"
            onClick={() => setView('newGroup')}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 shadow-sm"
          >
            Crear grupo
          </button>
          <button
            type="button"
            onClick={() => fetchGroups()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-gray-600 border border-transparent hover:bg-gray-100 ml-auto"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : null}
            Actualizar
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {error && (
          <div className="mb-3 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</div>
        )}

        {view === 'newGroup' && (
          <form onSubmit={submitCreateGroup} className="space-y-4 max-w-lg">
            <button
              type="button"
              onClick={() => resetCreateGroup()}
              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              <ArrowLeft size={14} /> Volver al listado
            </button>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Nombre del grupo</label>
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                placeholder="Ej. Región"
                autoFocus
              />
            </div>
            <div>
              <span className="block text-xs font-medium text-gray-700 mb-2">Color</span>
              <div className="flex flex-wrap gap-2">
                {QB_TAG_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    title={c}
                    onClick={() => setNewGroupColor(c)}
                    className={`w-8 h-8 rounded-full ring-2 ring-offset-2 transition-transform hover:scale-105 ${
                      newGroupColor === c ? 'ring-blue-500 scale-110' : 'ring-transparent'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
            <div>
              <span className="block text-xs font-medium text-gray-700 mb-2">
                Etiquetas del grupo <span className="font-normal text-gray-400">(opcional)</span>
              </span>
              <div className="space-y-2">
                {newGroupTagLines.map((line, i) => (
                  <input
                    key={i}
                    value={line}
                    onChange={(e) => {
                      const next = [...newGroupTagLines]
                      next[i] = e.target.value
                      setNewGroupTagLines(next)
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                    placeholder={`Etiqueta ${i + 1}`}
                  />
                ))}
              </div>
              <button
                type="button"
                className="mt-2 text-xs font-medium text-blue-600 hover:text-blue-800"
                onClick={() => setNewGroupTagLines((prev) => [...prev, ''])}
              >
                + Añadir etiqueta
              </button>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => resetCreateGroup()} className="px-4 py-2 text-sm text-gray-600">
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saving || !newGroupName.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-blue-600 text-white disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                Guardar grupo
              </button>
            </div>
          </form>
        )}

        {view === 'newTag' && (
          <form onSubmit={submitCreateTag} className="space-y-4 max-w-lg">
            <button
              type="button"
              onClick={() => setView('list')}
              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              <ArrowLeft size={14} /> Volver al listado
            </button>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Grupo</label>
              <SearchableSelect
                value={newTagGroupId}
                onChange={(v) => setNewTagGroupId(v)}
                options={sortedGroups.map((g) => ({
                  value: String(g.id),
                  label: g.name,
                }))}
                hideClear
                disabled={!sortedGroups.length}
              />
              {!sortedGroups.length && (
                <p className="text-xs text-amber-700 mt-1">Primero crea un grupo.</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Nombre de la etiqueta</label>
              <input
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                placeholder="Ej. Norte"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setView('list')} className="px-4 py-2 text-sm text-gray-600">
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saving || !newTagName.trim() || !sortedGroups.length}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold bg-blue-600 text-white disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                Crear etiqueta
              </button>
            </div>
          </form>
        )}

        {editGroupRow && (
          <form onSubmit={saveEditGroup} className="mb-6 p-4 rounded-xl border border-blue-100 bg-blue-50/40 space-y-3">
            <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Editar grupo</p>
            <input
              value={editGroupRow.name}
              onChange={(e) => setEditGroupRow({ ...editGroupRow, name: e.target.value })}
              className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              {QB_TAG_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setEditGroupRow({ ...editGroupRow, color: c })}
                  className={`w-7 h-7 rounded-full ring-2 ring-offset-1 ${editGroupRow.color === c ? 'ring-blue-500' : 'ring-transparent'}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setEditGroupRow(null)} className="text-sm text-gray-600 px-3 py-1.5">
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saving}
                className="text-sm font-semibold text-white bg-blue-600 px-4 py-1.5 rounded-lg disabled:opacity-50"
              >
                Guardar
              </button>
            </div>
          </form>
        )}

        {editTagRow && (
          <form onSubmit={saveEditTag} className="mb-6 p-4 rounded-xl border border-blue-100 bg-blue-50/40 space-y-3">
            <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Editar etiqueta</p>
            <SearchableSelect
              value={String(editTagRow.group_id)}
              onChange={(v) =>
                setEditTagRow({ ...editTagRow, group_id: Number(v) })
              }
              options={sortedGroups.map((g) => ({
                value: String(g.id),
                label: g.name,
              }))}
              hideClear
            />
            <input
              value={editTagRow.name}
              onChange={(e) => setEditTagRow({ ...editTagRow, name: e.target.value })}
              className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm"
            />
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setEditTagRow(null)} className="text-sm text-gray-600 px-3 py-1.5">
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saving}
                className="text-sm font-semibold text-white bg-blue-600 px-4 py-1.5 rounded-lg disabled:opacity-50"
              >
                Guardar
              </button>
            </div>
          </form>
        )}

        {view === 'list' && (
          <>
            {loading && !groups.length ? (
              <div className="flex items-center justify-center py-16 text-gray-400 text-sm gap-2">
                <Loader2 size={18} className="animate-spin" /> Cargando…
              </div>
            ) : !groups.length ? (
              <div className="text-center py-12 text-sm text-gray-500 border border-dashed border-gray-200 rounded-xl">
                No hay grupos. Pulsa <strong>Crear grupo</strong> para empezar.
              </div>
            ) : (
              <ul className="space-y-1">
                {sortedGroups.map((g) => {
                  const isOpen = expanded.has(g.id)
                  const tags = Array.isArray(g.tags) ? [...g.tags] : []
                  tags.sort((a, b) =>
                    String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'es', { sensitivity: 'base' }),
                  )
                  return (
                    <li key={g.id} className="rounded-xl border border-gray-100 bg-gray-50/40 overflow-hidden">
                      <div className="flex items-center gap-2 px-3 py-2.5">
                        <button
                          type="button"
                          onClick={() => toggleExpand(g.id)}
                          className="p-1 rounded-lg text-gray-500 hover:bg-gray-100 shrink-0"
                          aria-expanded={isOpen}
                        >
                          {isOpen ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                        </button>
                        <span
                          className="w-3 h-3 rounded-full shrink-0 ring-1 ring-white shadow-sm"
                          style={{ backgroundColor: g.color || QB_TAG_COLORS[0] }}
                        />
                        <span className="font-medium text-gray-900 text-sm flex-1 truncate">{g.name}</span>
                        <button
                          type="button"
                          className="text-xs font-medium text-blue-600 hover:text-blue-800 px-2 py-1 shrink-0"
                          onClick={() =>
                            setEditGroupRow({ id: g.id, name: g.name, color: g.color || QB_TAG_COLORS[0] })
                          }
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className="text-xs text-gray-400 hover:text-red-600 px-1 shrink-0"
                          title="Eliminar grupo"
                          onClick={() => deleteGroup(g)}
                        >
                          ×
                        </button>
                      </div>
                      {isOpen && (
                        <ul className="border-t border-gray-100 bg-white px-3 py-2 space-y-1">
                          {!tags.length ? (
                            <li className="text-xs text-gray-400 py-2 px-2">Sin etiquetas en este grupo.</li>
                          ) : (
                            tags.map((t) => (
                              <li
                                key={t.id}
                                className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-lg hover:bg-gray-50"
                              >
                                <span className="text-sm text-gray-800 truncate">{t.name}</span>
                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    type="button"
                                    className="text-xs font-medium text-blue-600 hover:text-blue-800 px-2 py-0.5"
                                    onClick={() =>
                                      setEditTagRow({ id: t.id, name: t.name, group_id: t.group_id ?? g.id })
                                    }
                                  >
                                    Editar
                                  </button>
                                  <button
                                    type="button"
                                    className="text-xs text-gray-400 hover:text-red-600 px-1"
                                    title="Eliminar etiqueta"
                                    onClick={() => deleteTag(t)}
                                  >
                                    ×
                                  </button>
                                </div>
                              </li>
                            ))
                          )}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )

  if (mode === 'embedded') {
    return inner
  }

  if (!open) return null

  return (
    <div className={`fixed inset-0 flex justify-end ${zClassName}`}>
      <button type="button" className="absolute inset-0 bg-black/35" aria-label="Cerrar" onClick={() => onClose?.()} />
      <div className="relative w-full max-w-lg h-full shadow-2xl border-l border-gray-200 flex flex-col bg-white">
        {inner}
      </div>
    </div>
  )
}
