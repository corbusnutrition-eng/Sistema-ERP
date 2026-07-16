import { Search, HelpCircle, ChevronDown, Menu, X } from 'lucide-react'
import NotificationBell from './NotificationBell'

function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null')
  } catch {
    return null
  }
}

export default function Header({ onMenuClick, mobileNavOpen = false }) {
  const user = getCurrentUser()
  const initials = user?.name
    ? user.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
    : 'U'

  return (
    <header className="flex items-center justify-between h-16 px-3 sm:px-6 bg-white border-b border-gray-200 shrink-0 gap-2">
      {/* Hamburguesa — solo móvil/tablet */}
      <button
        type="button"
        onClick={onMenuClick}
        className="lg:hidden p-2 -ml-0.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors shrink-0"
        aria-label={mobileNavOpen ? 'Cerrar menú' : 'Abrir menú'}
        aria-expanded={mobileNavOpen}
      >
        {mobileNavOpen ? <X size={22} /> : <Menu size={22} />}
      </button>

      {/* Search */}
      <div className="flex-1 max-w-md min-w-0">
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
          />
          <input
            type="search"
            placeholder="Buscar…"
            className="w-full pl-9 pr-3 sm:pr-4 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
            aria-label="Buscar clientes, facturas, reportes"
          />
        </div>
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-1 sm:gap-2 ml-1 sm:ml-6 shrink-0">
        <button
          className="hidden sm:inline-flex p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
          aria-label="Ayuda"
        >
          <HelpCircle size={18} />
        </button>

        <NotificationBell />

        <div className="hidden sm:block w-px h-6 bg-gray-200 mx-1" />

        <button className="flex items-center gap-2 px-1.5 sm:px-2 py-1.5 rounded-lg hover:bg-gray-100 transition-colors">
          <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
            <span className="text-xs font-semibold text-white">{initials}</span>
          </div>
          <span className="hidden sm:block text-sm font-medium text-gray-700">
            {user?.name?.split(' ')[0] || 'Usuario'}
          </span>
          <ChevronDown size={14} className="text-gray-400 hidden sm:block" />
        </button>
      </div>
    </header>
  )
}
