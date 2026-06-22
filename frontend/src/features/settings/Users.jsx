import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Users as UsersIcon, UserPlus, RefreshCw, ShieldCheck, User, Wallet } from 'lucide-react'
import UserFormModal from './components/UserFormModal'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

function RoleBadge({ role }) {
  if (role === 'admin') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
        <ShieldCheck size={11} />
        Administrador
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
      <User size={11} />
      Trabajador
    </span>
  )
}

function StatusBadge({ isActive }) {
  return isActive ? (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-600 border border-green-200">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
      Activo
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
      <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
      Inactivo
    </span>
  )
}

function getInitials(name = '') {
  return name
    .split(' ')
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('')
}

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-pink-500',
  'bg-amber-500', 'bg-teal-500', 'bg-indigo-500',
]

function avatarColor(id) {
  return AVATAR_COLORS[id % AVATAR_COLORS.length]
}

export default function UsersPage() {
  const [users, setUsers]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [toast, setToast]       = useState('')
  const [toggling, setToggling] = useState(null)

  function authHeaders() {
    const token = localStorage.getItem('access_token')
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/v1/users/`, { headers: authHeaders() })
      if (!res.ok) throw new Error()
      setUsers(await res.json())
    } catch {
      setUsers([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 3500)
  }

  function handleSaved() {
    setShowModal(false)
    showToast('Trabajador registrado con éxito.')
    fetchUsers()
  }

  async function handleToggle(user) {
    setToggling(user.id)
    try {
      const res = await fetch(`${API_BASE}/api/v1/users/${user.id}/toggle-active`, {
        method: 'PATCH',
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error()
      showToast(`Usuario ${user.is_active ? 'desactivado' : 'activado'} correctamente.`)
      fetchUsers()
    } catch {
      showToast('No se pudo cambiar el estado.')
    } finally {
      setToggling(null)
    }
  }

  const adminCount  = users.filter(u => u.role === 'admin').length
  const workerCount = users.filter(u => u.role === 'worker').length
  const activeCount = users.filter(u => u.is_active).length

  return (
    <div className="p-6 space-y-8">
      {/* Toast */}
      {toast && (
        <div className="fixed top-5 right-5 z-50 flex items-center gap-2 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg animate-fade-in">
          <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Equipo</h1>
          <p className="text-sm text-gray-500 mt-0.5">Administra los usuarios y sus permisos</p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <Link
            to="/equipo/distribuidores"
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors"
          >
            <Wallet size={15} />
            Billeteras BaaS
          </Link>
          <button
            onClick={fetchUsers}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <RefreshCw size={14} />
            Actualizar
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
          >
            <UserPlus size={15} />
            Nuevo Trabajador
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total de usuarios" value={users.length} icon={UsersIcon} color="blue" />
        <StatCard label="Administradores"   value={adminCount}   icon={ShieldCheck} color="purple" />
        <StatCard label="Activos"           value={activeCount}  icon={User} color="green" />
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-800">Miembros del equipo</h2>
          <span className="text-xs text-gray-400">
            {loading ? '…' : `${users.length} miembro${users.length !== 1 ? 's' : ''} · ${workerCount} trabajador${workerCount !== 1 ? 'es' : ''}`}
          </span>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-14 bg-gray-100 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : users.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <UsersIcon size={44} className="mb-3 opacity-25" />
            <p className="text-sm font-medium">No hay usuarios registrados</p>
            <p className="text-xs mt-1">Haz clic en "+ Nuevo Trabajador" para empezar.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-medium text-gray-500 uppercase tracking-wide bg-gray-50/60">
                  <th className="px-6 py-3">Miembro</th>
                  <th className="px-6 py-3">Email</th>
                  <th className="px-6 py-3">Rol</th>
                  <th className="px-6 py-3">Estado</th>
                  <th className="px-6 py-3 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {users.map(user => (
                  <tr key={user.id} className="hover:bg-gray-50/60 transition-colors">
                    <td className="px-6 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-full ${avatarColor(user.id)} flex items-center justify-center text-white text-xs font-semibold shrink-0`}>
                          {getInitials(user.name)}
                        </div>
                        <span className="font-medium text-gray-800">{user.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-3.5 text-gray-500">{user.email}</td>
                    <td className="px-6 py-3.5">
                      <RoleBadge role={user.role} />
                    </td>
                    <td className="px-6 py-3.5">
                      <StatusBadge isActive={user.is_active} />
                    </td>
                    <td className="px-6 py-3.5 text-right">
                      <button
                        onClick={() => handleToggle(user)}
                        disabled={toggling === user.id}
                        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 ${
                          user.is_active
                            ? 'text-red-600 bg-red-50 hover:bg-red-100 border border-red-100'
                            : 'text-green-700 bg-green-50 hover:bg-green-100 border border-green-100'
                        }`}
                      >
                        {toggling === user.id ? '…' : user.is_active ? 'Desactivar' : 'Activar'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <UserFormModal onClose={() => setShowModal(false)} onSaved={handleSaved} />
      )}
    </div>
  )
}

function StatCard({ label, value, icon: Icon, color }) {
  const colors = {
    blue:   { bg: 'bg-blue-50',   text: 'text-blue-600',   icon: 'text-blue-500'   },
    purple: { bg: 'bg-purple-50', text: 'text-purple-600', icon: 'text-purple-500' },
    green:  { bg: 'bg-green-50',  text: 'text-green-600',  icon: 'text-green-500'  },
  }
  const c = colors[color] ?? colors.blue
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex items-center gap-4">
      <div className={`w-11 h-11 rounded-xl ${c.bg} flex items-center justify-center shrink-0`}>
        <Icon size={20} className={c.icon} />
      </div>
      <div>
        <p className="text-xs text-gray-500 font-medium">{label}</p>
        <p className={`text-2xl font-bold ${c.text}`}>{value}</p>
      </div>
    </div>
  )
}
