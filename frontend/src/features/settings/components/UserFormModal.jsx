import { useEffect, useMemo, useState } from 'react'
import { X, UserPlus, Loader2, ShieldCheck } from 'lucide-react'
import SearchableSelect from '../../../components/ui/SearchableSelect'
import api from '../../../api/axios'
import { fetchPermissionsCatalog } from '../../../api/auth'

const ROLES = [
  { value: 'worker', label: 'Trabajador' },
  { value: 'admin', label: 'Administrador' },
]

function PermissionCheckbox({ id, label, description, checked, onChange }) {
  return (
    <label
      htmlFor={id}
      className="flex items-start gap-3 p-3 rounded-xl border border-gray-100 hover:border-blue-100 hover:bg-blue-50/30 cursor-pointer transition-colors"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-gray-900">{label}</span>
        {description ? (
          <span className="block text-xs text-gray-500 mt-0.5">{description}</span>
        ) : null}
      </span>
    </label>
  )
}

export default function UserFormModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'worker' })
  const [selectedPermissions, setSelectedPermissions] = useState([])
  const [catalogGroups, setCatalogGroups] = useState([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setCatalogLoading(true)
      try {
        const data = await fetchPermissionsCatalog()
        if (!cancelled) setCatalogGroups(Array.isArray(data?.groups) ? data.groups : [])
      } catch {
        if (!cancelled) setCatalogGroups([])
      } finally {
        if (!cancelled) setCatalogLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const showPermissions = form.role === 'worker'

  const allWorkerPermissionKeys = useMemo(() => {
    const keys = []
    for (const group of catalogGroups) {
      for (const perm of group?.permissions ?? []) {
        if (perm?.key) keys.push(perm.key)
      }
    }
    return keys
  }, [catalogGroups])

  function handleChange(e) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
    setError('')
  }

  function togglePermission(key, enabled) {
    setSelectedPermissions((prev) => {
      const set = new Set(prev)
      if (enabled) set.add(key)
      else set.delete(key)
      return [...set]
    })
  }

  function toggleModule(group, enabled) {
    const keys = (group?.permissions ?? []).map((p) => p.key).filter(Boolean)
    setSelectedPermissions((prev) => {
      const set = new Set(prev)
      for (const key of keys) {
        if (enabled) set.add(key)
        else set.delete(key)
      }
      return [...set]
    })
  }

  function moduleSelectionState(group) {
    const keys = (group?.permissions ?? []).map((p) => p.key).filter(Boolean)
    if (keys.length === 0) return { all: false, some: false }
    const selectedCount = keys.filter((k) => selectedPermissions.includes(k)).length
    return {
      all: selectedCount === keys.length,
      some: selectedCount > 0 && selectedCount < keys.length,
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.name.trim() || !form.email.trim() || !form.password.trim()) {
      setError('Todos los campos son obligatorios.')
      return
    }
    setSaving(true)
    try {
      const payload = {
        ...form,
        permissions: form.role === 'worker' ? selectedPermissions : [],
      }
      await api.post('/api/v1/users/', payload)
      onSaved()
    } catch (err) {
      const detail = err.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'Error al crear el usuario.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
              <UserPlus size={16} className="text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">Nuevo Trabajador</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4 overflow-y-auto flex-1">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Nombre completo</label>
            <input
              name="name"
              value={form.name}
              onChange={handleChange}
              placeholder="Ej: Juan García"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Correo electrónico</label>
            <input
              name="email"
              type="email"
              value={form.email}
              onChange={handleChange}
              placeholder="juan@empresa.com"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Contraseña</label>
            <input
              name="password"
              type="password"
              value={form.password}
              onChange={handleChange}
              placeholder="Mínimo 6 caracteres"
              className="w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Rol</label>
            <SearchableSelect
              value={form.role}
              onChange={(v) => {
                setForm((prev) => ({ ...prev, role: v }))
                if (v === 'admin') setSelectedPermissions([])
                setError('')
              }}
              options={ROLES}
              hideClear
            />
          </div>

          {showPermissions && (
            <div className="rounded-xl border border-gray-200 bg-gray-50/50 p-4 space-y-4">
              <div className="flex items-start gap-2">
                <ShieldCheck size={18} className="text-blue-600 shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Asignación de permisos</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Define qué módulos, pestañas y acciones puede usar este trabajador.
                  </p>
                </div>
              </div>

              {catalogLoading ? (
                <p className="text-xs text-gray-500 flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  Cargando catálogo de permisos…
                </p>
              ) : catalogGroups.length === 0 ? (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  No se pudo cargar el catálogo. El trabajador se creará sin permisos asignados.
                </p>
              ) : (
                <div className="space-y-4">
                  {catalogGroups.map((group) => {
                    const { all, some } = moduleSelectionState(group)
                    return (
                      <div key={group.module} className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                            {group.label}
                          </p>
                          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={all}
                              ref={(el) => {
                                if (el) el.indeterminate = some
                              }}
                              onChange={(e) => toggleModule(group, e.target.checked)}
                              className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            Todo el módulo
                          </label>
                        </div>
                        <div className="space-y-2">
                          {(group.permissions ?? []).map((perm) => (
                            <PermissionCheckbox
                              key={perm.key}
                              id={`perm-${perm.key}`}
                              label={perm.label}
                              description={perm.description}
                              checked={selectedPermissions.includes(perm.key)}
                              onChange={(checked) => togglePermission(perm.key, checked)}
                            />
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {selectedPermissions.length > 0 && (
                <p className="text-[11px] text-gray-500">
                  {selectedPermissions.length} de {allWorkerPermissionKeys.length || '—'} permisos seleccionados
                </p>
              )}
            </div>
          )}

          {error && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2 sticky bottom-0 bg-white pb-1">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-60 shadow-sm"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
