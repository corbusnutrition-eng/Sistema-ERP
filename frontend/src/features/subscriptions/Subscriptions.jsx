import { useEffect, useState, useMemo } from 'react'
import {
  MessageCircle,
  RefreshCw,
  Wifi,
  WifiOff,
  AlertTriangle,
  Search,
  Calendar,
  Tv2,
} from 'lucide-react'
import { formatDateEcuador } from '../../utils/datetime'

const API_BASE = 'http://localhost:8000/api/v1'

const STATUS_CONFIG = {
  Activo: {
    badge: 'bg-green-100 text-green-700 border border-green-200',
    row: '',
    dot: 'bg-green-500',
    icon: Wifi,
  },
  'Por Vencer': {
    badge: 'bg-amber-100 text-amber-700 border border-amber-200',
    row: 'bg-amber-50',
    dot: 'bg-amber-500',
    icon: AlertTriangle,
  },
  Vencido: {
    badge: 'bg-red-100 text-red-700 border border-red-200',
    row: 'bg-red-50',
    dot: 'bg-red-500',
    icon: WifiOff,
  },
}

function cleanPhone(phone) {
  if (!phone) return ''
  return phone.replace(/[\s\-\(\)\+]/g, '')
}

function buildWhatsAppUrl(sub) {
  const phone = cleanPhone(sub.phone)
  const diasTexto =
    sub.days_remaining <= 0
      ? 'ya venció'
      : sub.days_remaining === 1
      ? 'vence mañana'
      : `vence en ${sub.days_remaining} días`
  const text = encodeURIComponent(
    `Hola ${sub.client_name}, tu servicio de IPTV ${diasTexto}. Puedes renovar rápidamente y sin recargos desde tu portal personal aquí: http://localhost:5175/pay/${sub.payment_link_id}`
  )
  return `https://wa.me/${phone}?text=${text}`
}

function StatCard({ label, value, colorClass, icon: Icon }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-center gap-4 shadow-sm">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${colorClass}`}>
        <Icon size={18} className="text-white" />
      </div>
      <div>
        <p className="text-2xl font-bold text-gray-800">{value}</p>
        <p className="text-xs text-gray-500 mt-0.5">{label}</p>
      </div>
    </div>
  )
}

export default function Subscriptions() {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('Todos')

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const token = localStorage.getItem('access_token')
      const res = await fetch(`${API_BASE}/subscriptions/status/`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`Error ${res.status}`)
      const json = await res.json()
      setData(json)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [])

  const stats = useMemo(() => ({
    total: data.length,
    activos: data.filter((d) => d.status === 'Activo').length,
    porVencer: data.filter((d) => d.status === 'Por Vencer').length,
    vencidos: data.filter((d) => d.status === 'Vencido').length,
  }), [data])

  const filtered = useMemo(() => {
    return data.filter((s) => {
      const matchFilter = filter === 'Todos' || s.status === filter
      const matchSearch =
        search === '' ||
        s.client_name.toLowerCase().includes(search.toLowerCase()) ||
        (s.phone && s.phone.includes(search)) ||
        (s.provider && s.provider.toLowerCase().includes(search.toLowerCase()))
      return matchFilter && matchSearch
    })
  }, [data, filter, search])

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Radar de Cobros</h1>
          <p className="text-sm text-gray-500 mt-1">
            Monitoreo de vencimientos y renovaciones de suscripciones IPTV
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
          Actualizar
        </button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total clientes" value={stats.total} colorClass="bg-blue-500" icon={Tv2} />
        <StatCard label="Activos" value={stats.activos} colorClass="bg-green-500" icon={Wifi} />
        <StatCard label="Por Vencer" value={stats.porVencer} colorClass="bg-amber-500" icon={AlertTriangle} />
        <StatCard label="Vencidos" value={stats.vencidos} colorClass="bg-red-500" icon={WifiOff} />
      </div>

      {/* Filtros y búsqueda */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Buscar por nombre, teléfono o proveedor…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex gap-2">
          {['Todos', 'Activo', 'Por Vencer', 'Vencido'].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                filter === f
                  ? 'bg-blue-600 text-white'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
          Error al cargar datos: {error}
        </div>
      )}

      {/* Tabla */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-gray-400 gap-3">
            <RefreshCw size={20} className="animate-spin" />
            <span className="text-sm">Cargando suscripciones…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400 gap-2">
            <Tv2 size={32} strokeWidth={1.5} />
            <p className="text-sm">No se encontraron suscripciones</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Cliente</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Pantalla</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Vencimiento</th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600">Días rest.</th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600">Estado</th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map((sub) => {
                  const cfg = STATUS_CONFIG[sub.status] ?? STATUS_CONFIG['Activo']
                  const StatusIcon = cfg.icon
                  const expDate = sub.expiration_date
                    ? formatDateEcuador(sub.expiration_date)
                    : '—'

                  return (
                    <tr key={sub.client_id} className={`hover:bg-gray-50 transition-colors ${cfg.row}`}>
                      {/* Cliente */}
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-800">{sub.client_name}</p>
                        <p className="text-xs text-gray-400 mt-0.5">{sub.phone || 'Sin teléfono'}</p>
                      </td>

                      {/* Pantalla */}
                      <td className="px-4 py-3">
                        {sub.provider ? (
                          <div>
                            <p className="font-medium text-gray-700">{sub.provider}</p>
                            <p className="text-xs text-gray-400 font-mono mt-0.5">
                              {sub.screen_credential} · P{sub.screen_number}
                            </p>
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>

                      {/* Vencimiento */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5 text-gray-600">
                          <Calendar size={13} className="shrink-0 text-gray-400" />
                          <span>{expDate}</span>
                        </div>
                      </td>

                      {/* Días restantes */}
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-block font-bold text-base ${
                            sub.days_remaining <= 0
                              ? 'text-red-600'
                              : sub.days_remaining <= 3
                              ? 'text-amber-600'
                              : 'text-green-600'
                          }`}
                        >
                          {sub.days_remaining <= 0 ? sub.days_remaining : `+${sub.days_remaining}`}
                        </span>
                      </td>

                      {/* Estado */}
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${cfg.badge}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                          {sub.status}
                        </span>
                      </td>

                      {/* Acción */}
                      <td className="px-4 py-3 text-center">
                        {sub.phone ? (
                          <a
                            href={buildWhatsAppUrl(sub)}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`Avisar a ${sub.client_name} por WhatsApp`}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-500 hover:bg-green-600 text-white text-xs font-medium rounded-lg transition-colors"
                          >
                            <MessageCircle size={13} />
                            Avisar
                          </a>
                        ) : (
                          <span className="text-xs text-gray-400">Sin teléfono</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 text-center">
        Mostrando {filtered.length} de {data.length} suscripciones · Las fechas se calculan sumando 30 días a la última venta aprobada.
      </p>
    </div>
  )
}
