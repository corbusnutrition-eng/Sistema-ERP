import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Pencil, Plus, Trash2, X } from 'lucide-react'
import api from '../../api/axios'

function ModalShell({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/45" aria-label="Cerrar" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-gray-100 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} className="p-2 rounded-lg text-gray-400 hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export default function ClassList() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [editRow, setEditRow] = useState(null)
  const [newName, setNewName] = useState('')
  const [editName, setEditName] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get('/api/v1/classes/', { params: { include_inactive: true } })
      setRows(Array.isArray(data) ? data : [])
    } catch {
      setError('No se pudieron cargar las clases.')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function showToast(msg, ok = true) {
    setToast({ msg, ok })
    window.setTimeout(() => setToast(null), 4000)
  }

  async function handleCreate(e) {
    e.preventDefault()
    const n = newName.trim()
    if (!n) return
    setSaving(true)
    try {
      await api.post('/api/v1/classes/', { name: n })
      setCreateOpen(false)
      setNewName('')
      showToast('Clase creada.')
      await load()
    } catch (err) {
      const d = err?.response?.data?.detail
      showToast(typeof d === 'string' ? d : 'No se pudo crear.', false)
    } finally {
      setSaving(false)
    }
  }

  async function handleEdit(e) {
    e.preventDefault()
    if (!editRow) return
    const n = editName.trim()
    if (!n) return
    setSaving(true)
    try {
      await api.put(`/api/v1/classes/${editRow.id}`, { name: n })
      setEditRow(null)
      showToast('Clase actualizada.')
      await load()
    } catch (err) {
      const d = err?.response?.data?.detail
      showToast(typeof d === 'string' ? d : 'No se pudo guardar.', false)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(row) {
    if (!window.confirm(`¿Desactivar la clase «${row.name}»?`)) return
    try {
      await api.delete(`/api/v1/classes/${row.id}`)
      showToast('Clase desactivada.')
      await load()
    } catch (err) {
      const d = err?.response?.data?.detail
      showToast(typeof d === 'string' ? d : 'No se pudo eliminar.', false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <Link to="/informes" className="text-blue-600 hover:text-blue-800 font-medium">
              Informes
            </Link>
            <ChevronRight size={12} className="text-gray-300" />
            <span className="text-gray-700 font-medium">Lista de clases</span>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Clases contables</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Segmentación tipo QuickBooks para ventas y movimientos.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setNewName('')
            setCreateOpen(true)
          }}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl hover:bg-blue-700 shadow-sm shrink-0"
        >
          <Plus size={18} />
          Nueva clase
        </button>
      </div>

      {toast && (
        <div
          className={`rounded-xl px-4 py-3 text-sm font-medium ring-1 ${
            toast.ok ? 'bg-green-50 text-green-800 ring-green-200' : 'bg-red-50 text-red-800 ring-red-200'
          }`}
        >
          {toast.msg}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50/80">
          <div className="grid grid-cols-12 gap-2 text-[11px] font-bold uppercase tracking-wider text-gray-500">
            <div className="col-span-7">Nombre de la clase</div>
            <div className="col-span-2">Estado</div>
            <div className="col-span-3 text-right">Acciones</div>
          </div>
        </div>
        {loading ? (
          <div className="p-10 text-center text-gray-400 text-sm">Cargando…</div>
        ) : error ? (
          <div className="p-10 text-center text-red-600 text-sm">{error}</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-gray-500 text-sm">No hay clases. Crea la primera con «Nueva clase».</div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {rows.map((row) => (
              <li key={row.id} className="grid grid-cols-12 gap-2 items-center px-6 py-3.5 text-sm">
                <div className="col-span-7 font-medium text-gray-900">{row.name}</div>
                <div className="col-span-2">
                  {row.is_active ? (
                    <span className="text-xs font-semibold text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
                      Activa
                    </span>
                  ) : (
                    <span className="text-xs font-semibold text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                      Inactiva
                    </span>
                  )}
                </div>
                <div className="col-span-3 flex justify-end gap-1">
                  <button
                    type="button"
                    disabled={!row.is_active}
                    onClick={() => {
                      setEditRow(row)
                      setEditName(row.name)
                    }}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <Pencil size={14} />
                    Editar
                  </button>
                  <button
                    type="button"
                    disabled={!row.is_active}
                    onClick={() => handleDelete(row)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <Trash2 size={14} />
                    Eliminar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {createOpen && (
        <ModalShell title="Nueva clase" onClose={() => !saving && setCreateOpen(false)}>
          <form onSubmit={handleCreate} className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nombre de la clase</label>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                placeholder="Ej. Mayorista, Retail, Online…"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => setCreateOpen(false)}
                className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-xl"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saving || !newName.trim()}
                className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl disabled:opacity-50"
              >
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </form>
        </ModalShell>
      )}

      {editRow && (
        <ModalShell title="Editar clase" onClose={() => !saving && setEditRow(null)}>
          <form onSubmit={handleEdit} className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nombre de la clase</label>
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => setEditRow(null)}
                className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-xl"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saving || !editName.trim()}
                className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-xl disabled:opacity-50"
              >
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </form>
        </ModalShell>
      )}
    </div>
  )
}
