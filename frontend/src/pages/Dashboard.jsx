import { useCallback, useEffect, useState } from 'react'
import { Users, TrendingUp, ShoppingBag, RefreshCw, AlertCircle, Package } from 'lucide-react'
import InventorySummaryCards from '../features/inventory/components/InventorySummaryCards'
import { formatDateEcuador } from '../utils/datetime'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

function currency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(Number(value) || 0)
}

// ── Skeleton primitives ───────────────────────────────────────────────────────

function SkeletonBlock({ className = '' }) {
  return <div className={`bg-gray-200 rounded-lg animate-pulse ${className}`} />
}

function MetricCardSkeleton() {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-4">
      <div className="flex items-center justify-between">
        <SkeletonBlock className="w-12 h-12 rounded-xl" />
        <SkeletonBlock className="w-16 h-5 rounded-full" />
      </div>
      <SkeletonBlock className="w-24 h-4" />
      <SkeletonBlock className="w-32 h-9" />
      <SkeletonBlock className="w-28 h-3" />
    </div>
  )
}

function SalesRowSkeleton() {
  return (
    <tr>
      <td className="px-6 py-3.5"><SkeletonBlock className="h-4 w-6" /></td>
      <td className="px-6 py-3.5"><SkeletonBlock className="h-4 w-32" /></td>
      <td className="px-6 py-3.5"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
      <td className="px-6 py-3.5"><SkeletonBlock className="h-4 w-20 ml-auto" /></td>
    </tr>
  )
}

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({ icon: Icon, label, value, sub, iconBg, iconColor, badgeText, badgeBg, badgeColor }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 flex flex-col gap-3 hover:shadow-md transition-shadow">
      <div className="flex items-center justify-between">
        <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${iconBg}`}>
          <Icon size={22} className={iconColor} />
        </div>
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${badgeBg} ${badgeColor}`}>
          {badgeText}
        </span>
      </div>
      <p className="text-sm font-medium text-gray-500">{label}</p>
      <p className="text-3xl font-bold text-gray-900 leading-none">{value}</p>
      {sub && <p className="text-xs text-gray-400">{sub}</p>}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const authHeaders = () => {
    const token = localStorage.getItem('access_token')
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  const fetchSummary = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const res = await fetch(`${API_BASE}/api/v1/dashboard/summary/`, {
        headers: authHeaders(),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch {
      setError(true)
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSummary()
  }, [fetchSummary])

  const netPositive = data && Number(data.financials?.net_profit) >= 0

  return (
    <div className="p-6 space-y-8">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-500 mb-0.5">
            Panel Principal
          </p>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Resumen de métricas clave del negocio
          </p>
        </div>
        <button
          onClick={fetchSummary}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Actualizar
        </button>
      </div>

      {/* ── Error banner ── */}
      {error && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 text-red-700 rounded-xl px-5 py-4 text-sm">
          <AlertCircle size={18} className="shrink-0" />
          No se pudieron cargar los datos. Verifica que el servidor esté activo.
        </div>
      )}

      {/* ── Metric cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        {loading ? (
          <>
            <MetricCardSkeleton />
            <MetricCardSkeleton />
          </>
        ) : (
          <>
            {/* Clientes */}
            <MetricCard
              icon={Users}
              label="Clientes Totales"
              value={data?.total_clients ?? '—'}
              sub="Clientes registrados"
              iconBg="bg-blue-50"
              iconColor="text-blue-600"
              badgeText="Clientes"
              badgeBg="bg-blue-50"
              badgeColor="text-blue-600"
            />

            {/* Beneficio neto */}
            <MetricCard
              icon={TrendingUp}
              label="Beneficio Neto"
              value={data ? currency(data.financials.net_profit) : '—'}
              sub={`Ingresos: ${data ? currency(data.financials.total_income) : '—'}`}
              iconBg={netPositive ? 'bg-green-50' : 'bg-orange-50'}
              iconColor={netPositive ? 'text-green-600' : 'text-orange-500'}
              badgeText={netPositive ? 'Ganancia' : 'Pérdida'}
              badgeBg={netPositive ? 'bg-green-50' : 'bg-orange-50'}
              badgeColor={netPositive ? 'text-green-600' : 'text-orange-500'}
            />
          </>
        )}
      </div>

      {/* ── Inventory summary ── */}
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Package size={16} className="text-gray-400" />
          <h2 className="text-base font-semibold text-gray-800">Estado de Inventario</h2>
        </div>
        <InventorySummaryCards />
      </div>

      {/* ── Recent sales ── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <ShoppingBag size={17} className="text-gray-400" />
            <h2 className="text-base font-semibold text-gray-800">
              Últimas 5 Ventas
            </h2>
          </div>
          {!loading && data && (
            <span className="text-xs text-gray-400">
              {data.recent_sales.length} registro{data.recent_sales.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wide bg-gray-50/60">
                <th className="px-6 py-3">#</th>
                <th className="px-6 py-3">Cliente</th>
                <th className="px-6 py-3 text-right">Monto</th>
                <th className="px-6 py-3 text-right">Fecha</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <>
                  <SalesRowSkeleton />
                  <SalesRowSkeleton />
                  <SalesRowSkeleton />
                  <SalesRowSkeleton />
                  <SalesRowSkeleton />
                </>
              ) : !data || data.recent_sales.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-12 text-center text-gray-400 text-sm">
                    <ShoppingBag size={32} className="mx-auto mb-2 opacity-25" />
                    No hay ventas registradas aún.
                  </td>
                </tr>
              ) : (
                data.recent_sales.map((sale) => (
                  <tr
                    key={sale.id}
                    className="hover:bg-gray-50/60 transition-colors"
                  >
                    <td className="px-6 py-3.5 text-gray-400 font-mono text-xs">
                      #{sale.id}
                    </td>
                    <td className="px-6 py-3.5 text-gray-800 font-medium">
                      {sale.client_name}
                    </td>
                    <td className="px-6 py-3.5 text-right font-semibold text-green-600">
                      {currency(sale.amount)}
                    </td>
                    <td className="px-6 py-3.5 text-right text-gray-500">
                      {formatDateEcuador(sale.date)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
