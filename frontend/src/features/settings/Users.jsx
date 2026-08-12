import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ChevronDown,
  Loader2,
  RefreshCw,
  Search,
  UserPlus,
  Users as UsersIcon,
} from 'lucide-react'
import { deleteTeamUser, fetchTeamUsers, toggleTeamUserActive } from '../../api/users'
import usePermissions from '../../hooks/usePermissions'
import { getApiErrorMessage } from '../../lib/apiErrors'
import { PERMS } from '../../lib/permissions'

function StatusBadge({ isActive }) {
  return (
    <span
      className={`inline-flex items-center text-sm ${
        isActive ? 'text-gray-800' : 'text-gray-400'
      }`}
    >
      {isActive ? 'Activo' : 'Inactivo'}
    </span>
  )
}

function RoleLabel({ user }) {
  const label =
    user.role === 'admin'
      ? 'Administrador total'
      : user.role_template_label || (user.role === 'worker' ? 'Trabajador' : user.role)
  return <span className="text-sm text-gray-800">{label}</span>
}

function DeleteUserConfirmModal({ user, onConfirm, onCancel, loading }) {
  const name = String(user?.name || 'este usuario').trim() || 'este usuario'
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-50 ring-1 ring-red-200 flex items-center justify-center shrink-0">
            <AlertTriangle size={18} className="text-red-500" />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900">Eliminar usuario</h3>
            <p className="text-sm text-gray-500 mt-1 leading-relaxed">
              ¿Estás seguro de que deseas eliminar al usuario{' '}
              <span className="font-medium text-gray-700">{name}</span>? Esta acción es irreversible.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors disabled:opacity-60"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="px-4 py-2 text-sm font-semibold text-white bg-red-500 hover:bg-red-600 disabled:opacity-60 rounded-xl transition-colors flex items-center gap-2"
          >
            {loading && <Loader2 size={13} className="animate-spin" />}
            Sí, eliminar
          </button>
        </div>
      </div>
    </div>
  )
}

function EditUserMenu({ user, onToggle, onDelete, toggling, canDelete }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <div ref={ref} className="relative inline-block text-left">
      <div className="inline-flex rounded-md shadow-sm">
        <Link
          to={`/equipo/${user.id}/editar`}
          className="inline-flex items-center px-4 py-1.5 text-sm font-medium text-emerald-700 bg-white border border-emerald-600 rounded-l-md hover:bg-emerald-50 transition-colors"
        >
          Editar
        </Link>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center px-2 py-1.5 text-emerald-700 bg-white border border-l-0 border-emerald-600 rounded-r-md hover:bg-emerald-50 transition-colors"
          aria-label="Más acciones"
        >
          <ChevronDown size={16} />
        </button>
      </div>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 bg-white border border-gray-200 rounded-md shadow-lg py-1">
          <button
            type="button"
            disabled={toggling === user.id}
            onClick={() => {
              setOpen(false)
              onToggle(user)
            }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {toggling === user.id ? '…' : user.is_active ? 'Desactivar' : 'Activar'}
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onDelete(user)
              }}
              className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              Eliminar
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function UsersPage() {
  const { hasPermission } = usePermissions()
  const canDeleteUsers = hasPermission(PERMS.TEAM_USERS_DELETE)

  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [toast, setToast] = useState('')
  const [toggling, setToggling] = useState(null)
  const [userToDelete, setUserToDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchTeamUsers()
      setUsers(Array.isArray(data) ? data : [])
    } catch {
      setUsers([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 3500)
  }

  async function handleToggle(user) {
    setToggling(user.id)
    try {
      await toggleTeamUserActive(user.id)
      showToast(`Usuario ${user.is_active ? 'desactivado' : 'activado'} correctamente.`)
      fetchUsers()
    } catch {
      showToast('No se pudo cambiar el estado.')
    } finally {
      setToggling(null)
    }
  }

  function handleDeleteRequest(user) {
    setUserToDelete(user)
  }

  async function handleDeleteConfirm() {
    if (!userToDelete) return
    setDeleting(true)
    try {
      await deleteTeamUser(userToDelete.id)
      setUsers((prev) => prev.filter((u) => u.id !== userToDelete.id))
      showToast(`Usuario «${userToDelete.name}» eliminado correctamente.`)
      setUserToDelete(null)
    } catch (error) {
      showToast(getApiErrorMessage(error, { fallback: 'No se pudo eliminar el usuario.' }))
    } finally {
      setDeleting(false)
    }
  }

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return users
    return users.filter(
      (u) =>
        String(u.name || '').toLowerCase().includes(q) ||
        String(u.email || '').toLowerCase().includes(q) ||
        String(u.role_template_label || '').toLowerCase().includes(q),
    )
  }, [users, search])

  return (
    <div className="p-6 space-y-6 bg-gray-50 min-h-full">
      {toast && (
        <div className="fixed top-5 right-5 z-50 flex items-center gap-2 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg">
          <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
          {toast}
        </div>
      )}

      {userToDelete && (
        <DeleteUserConfirmModal
          user={userToDelete}
          loading={deleting}
          onCancel={() => {
            if (!deleting) setUserToDelete(null)
          }}
          onConfirm={handleDeleteConfirm}
        />
      )}

      <div>
        <h1 className="text-2xl font-bold text-gray-900">Administrar usuarios</h1>
        <p className="text-sm text-gray-500 mt-0.5">Equipo · roles y permisos del ERP</p>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 border-b border-gray-200">
          <div className="relative max-w-xs w-full">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={fetchUsers}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              <RefreshCw size={14} />
              Actualizar
            </button>
            <Link
              to="/equipo/nuevo"
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-md hover:bg-emerald-700 shadow-sm transition-colors"
            >
              <UserPlus size={15} />
              Agregar usuario
            </Link>
          </div>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : filteredUsers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <UsersIcon size={44} className="mb-3 opacity-25" />
            <p className="text-sm font-medium">No hay usuarios registrados</p>
            <p className="text-xs mt-1">Haz clic en «Agregar usuario» para empezar.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-white">
                  <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-gray-700">
                    Nombre
                  </th>
                  <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-gray-700">
                    Correo electrónico
                  </th>
                  <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-gray-700">
                    Estado
                  </th>
                  <th className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wide text-gray-700">
                    Rol
                  </th>
                  <th className="px-5 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-gray-700">
                    Acción
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredUsers.map((user) => (
                  <tr key={user.id} className="hover:bg-gray-50/60">
                    <td className="px-5 py-3.5 font-medium text-gray-900">{user.name}</td>
                    <td className="px-5 py-3.5 text-gray-600">{user.email}</td>
                    <td className="px-5 py-3.5">
                      <StatusBadge isActive={user.is_active} />
                    </td>
                    <td className="px-5 py-3.5">
                      <RoleLabel user={user} />
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <EditUserMenu
                        user={user}
                        onToggle={handleToggle}
                        onDelete={handleDeleteRequest}
                        toggling={toggling}
                        canDelete={canDeleteUsers}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
