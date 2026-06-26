const DEFAULT_METRICS = {
  total: 0,
  pending: 0,
  expired: 0,
  review: 0,
  activated: 0,
  rejected: 0,
  voided: 0,
  revenueUsd: 0,
}

const KPI_ITEMS = [
  { key: 'total', label: 'Total Ventas', color: 'text-blue-600', bg: 'bg-blue-50', format: (v) => v },
  { key: 'activated', label: 'Activadas', color: 'text-green-600', bg: 'bg-green-50', format: (v) => v },
  { key: 'pending', label: 'Pendientes', color: 'text-amber-600', bg: 'bg-amber-50', format: (v) => v },
  { key: 'review', label: 'En revisión', color: 'text-sky-700', bg: 'bg-sky-50', format: (v) => v },
  { key: 'voided', label: 'Anuladas', color: 'text-slate-600', bg: 'bg-slate-50', format: (v) => v },
  {
    key: 'revenueUsd',
    label: 'Ingresos activados (USD)',
    color: 'text-gray-800',
    bg: 'bg-gray-50',
    format: (v) => `$${Number(v ?? 0).toLocaleString('es-ES', { minimumFractionDigits: 2 })}`,
  },
]

/** Tarjetas KPI — siempre montadas; valores por defecto en cero si aún no hay data. */
export default function SalesKPIs({ metrics }) {
  const m = { ...DEFAULT_METRICS, ...(metrics ?? {}) }

  return (
    <div
      className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 min-h-[6.5rem]"
      aria-label="Indicadores de ventas"
    >
      {KPI_ITEMS.map(({ key, label, color, bg, format }) => (
        <div key={key} className={`${bg} rounded-2xl px-5 py-4 ring-1 ring-gray-100`}>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
          <p className={`text-2xl sm:text-3xl font-bold mt-1 ${color}`}>{format(m[key])}</p>
        </div>
      ))}
    </div>
  )
}
