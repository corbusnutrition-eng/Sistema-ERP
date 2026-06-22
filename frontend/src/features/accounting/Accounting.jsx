import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  RefreshCw,
  Receipt,
  ChevronRight,
} from 'lucide-react'
import api from '../../api/axios'

function pad2(n) {
  return String(n).padStart(2, '0')
}

function toIsoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function monthRangeNow() {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  return { start: toIsoDate(start), end: toIsoDate(now) }
}

function currency(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(Number(value) || 0)
}

export default function Accounting() {
  const [summary, setSummary] = useState(null)
  const [loadingSummary, setLoadingSummary] = useState(true)

  const period = useMemo(() => monthRangeNow(), [])

  const fetchSummary = useCallback(async () => {
    setLoadingSummary(true)
    try {
      const { data } = await api.get('/api/v1/reports/profit-and-loss', {
        params: { start_date: period.start, end_date: period.end },
      })
      const otrosIng = Array.isArray(data?.['Otros ingresos'])
        ? data['Otros ingresos'].reduce((s, r) => s + (Number(r?.monto) || 0), 0)
        : 0
      const ingresos = (Number(data?.ingresos_operativos) || 0) + otrosIng
      const gastos =
        (Number(data?.costos_ventas) || 0) +
        (Number(data?.gastos_operativos) || 0) +
        (Number(data?.otros_gastos_financieros) || 0)
      const neto = Number(data?.utilidad_neta) || 0
      setSummary({
        total_income: ingresos,
        total_expenses: gastos,
        net_profit: neto,
        start_date: data?.start_date,
        end_date: data?.end_date,
      })
    } catch {
      setSummary(null)
    } finally {
      setLoadingSummary(false)
    }
  }, [period.end, period.start])

  useEffect(() => {
    fetchSummary()
  }, [fetchSummary])

  const netPositive = summary && Number(summary.net_profit) >= 0

  return (
    <div className="p-6 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contabilidad</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Estado de Pérdidas y Ganancias
            {summary?.start_date && summary?.end_date ? (
              <span className="text-gray-400">
                {' '}
                · {summary.start_date} — {summary.end_date}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => fetchSummary()}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <RefreshCw size={14} />
            Actualizar
          </button>
          <Link
            to="/contabilidad/gastos"
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors shadow-sm"
            style={{ backgroundColor: '#2ca01c' }}
          >
            <Receipt size={16} />
            Gastos
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 rounded-xl bg-green-50 flex items-center justify-center">
              <TrendingUp size={24} className="text-green-500" />
            </div>
            <span className="text-xs font-medium text-green-600 bg-green-50 px-2 py-1 rounded-full">
              Ingresos
            </span>
          </div>
          <p className="text-sm text-gray-500 font-medium">Ingresos Totales</p>
          {loadingSummary ? (
            <div className="h-9 w-32 bg-gray-100 rounded-lg animate-pulse mt-1" />
          ) : (
            <p className="text-3xl font-bold text-green-600 mt-1">
              {currency(summary?.total_income)}
            </p>
          )}
          <p className="text-xs text-gray-400 mt-2">Ingresos operativos del periodo (libro mayor)</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 rounded-xl bg-red-50 flex items-center justify-center">
              <TrendingDown size={24} className="text-red-500" />
            </div>
            <span className="text-xs font-medium text-red-600 bg-red-50 px-2 py-1 rounded-full">
              Egresos
            </span>
          </div>
          <p className="text-sm text-gray-500 font-medium">Gastos Totales</p>
          {loadingSummary ? (
            <div className="h-9 w-32 bg-gray-100 rounded-lg animate-pulse mt-1" />
          ) : (
            <p className="text-3xl font-bold text-red-500 mt-1">
              {currency(summary?.total_expenses)}
            </p>
          )}
          <p className="text-xs text-gray-400 mt-2">Costos, gastos operativos y financieros del periodo</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between mb-4">
            <div
              className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                netPositive ? 'bg-blue-50' : 'bg-orange-50'
              }`}
            >
              <Wallet
                size={24}
                className={netPositive ? 'text-blue-500' : 'text-orange-500'}
              />
            </div>
            <span
              className={`text-xs font-medium px-2 py-1 rounded-full ${
                netPositive
                  ? 'text-blue-600 bg-blue-50'
                  : 'text-orange-600 bg-orange-50'
              }`}
            >
              {netPositive ? 'Ganancia' : 'Pérdida'}
            </span>
          </div>
          <p className="text-sm text-gray-500 font-medium">Beneficio Neto</p>
          {loadingSummary ? (
            <div className="h-9 w-32 bg-gray-100 rounded-lg animate-pulse mt-1" />
          ) : (
            <p
              className={`text-3xl font-bold mt-1 ${
                netPositive ? 'text-blue-600' : 'text-orange-500'
              }`}
            >
              {currency(summary?.net_profit)}
            </p>
          )}
          <p className="text-xs text-gray-400 mt-2">Utilidad neta del periodo (P&amp;L)</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-800">
              Gastos y movimientos
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              Registra y revisa gastos con partida doble, adjuntos y plan de cuentas.
            </p>
          </div>
          <Link
            to="/contabilidad/gastos"
            className="inline-flex items-center gap-1 text-sm font-semibold hover:underline"
            style={{ color: '#2ca01c' }}
          >
            Ir a Gastos
            <ChevronRight size={16} />
          </Link>
        </div>
      </div>
    </div>
  )
}
