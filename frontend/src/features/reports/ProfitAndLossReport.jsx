import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BarChart3, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import api from '../../api/axios'
import SearchableSelect from '../../components/ui/SearchableSelect'
import { todayIsoDateEcuador } from '../../utils/datetime'

function pad2(n) {
  return String(n).padStart(2, '0')
}

function toIsoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** @returns {{ start: string, end: string }} ISO yyyy-mm-dd (calendario Ecuador) */
function rangeForPreset(presetId) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const y = Number(parts.find((p) => p.type === 'year')?.value)
  const m = Number(parts.find((p) => p.type === 'month')?.value) - 1
  const day = Number(parts.find((p) => p.type === 'day')?.value)
  const now = new Date(y, m, day)

  if (presetId === 'this_month') {
    const start = new Date(y, m, 1)
    const end = new Date(y, m + 1, 0)
    return { start: toIsoDate(start), end: toIsoDate(end) }
  }
  if (presetId === 'last_month') {
    const start = new Date(y, m - 1, 1)
    const end = new Date(y, m, 0)
    return { start: toIsoDate(start), end: toIsoDate(end) }
  }
  if (presetId === 'this_year') {
    const start = new Date(y, 0, 1)
    return { start: toIsoDate(start), end: todayIsoDateEcuador() }
  }
  const start = new Date(y, m, 1)
  const end = new Date(y, m + 1, 0)
  return { start: toIsoDate(start), end: toIsoDate(end) }
}

function formatMoney(n, currency = 'USD') {
  const x = Number(n)
  const safe = Number.isFinite(x) ? x : 0
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safe)
  } catch {
    return `${safe.toFixed(2)} ${currency}`
  }
}

function num(value) {
  const x = Number(value)
  return Number.isFinite(x) ? x : 0
}

const PRESETS = [
  { id: 'this_month', label: 'Este mes' },
  { id: 'last_month', label: 'Mes pasado' },
  { id: 'this_year', label: 'Este año' },
  { id: 'custom', label: 'Personalizado' },
]

const DISPLAY_CURRENCY = 'USD'

const CATEGORY_BLOCKS = [
  { key: 'Ingresos', totalLabel: 'Total ingresos' },
  { key: 'Otros ingresos', optional: true },
  { key: 'Costo de Ventas', totalLabel: 'Total costo de ventas' },
  { key: 'Gastos', totalLabel: 'Total gastos' },
  { key: 'Otros gastos financieros', optional: true },
]

function PnlSummaryRow({ label, value, bold = false, highlight = false, indent = false }) {
  const base = bold ? 'font-bold text-gray-900' : 'font-medium text-gray-700'
  const highlightCls = highlight
    ? ' text-base font-extrabold text-gray-950 pt-3 mt-2 border-t-4 border-double border-gray-900'
    : ''
  return (
    <div className={`flex justify-between items-center py-2 ${base}${highlightCls}`}>
      <span className={indent ? 'pl-4 text-sm text-gray-600' : ''}>{label}</span>
      <span className="tabular-nums">{formatMoney(value, DISPLAY_CURRENCY)}</span>
    </div>
  )
}

function sumRows(rows) {
  if (!Array.isArray(rows)) return 0
  return rows.reduce((acc, r) => acc + num(r.monto), 0)
}

function PnlAccountRows({ rows, depth = 0, pathPrefix = '', onDrillDown, accountType }) {
  const [open, setOpen] = useState(() => ({}))

  if (!rows?.length) {
    return <p className="text-sm text-gray-400 italic py-1 pl-2">Sin movimientos en el periodo.</p>
  }

  return (
    <ul className="space-y-0.5">
      {rows.map((row, idx) => {
        const subs = row.subcuentas || []
        const hasSubs = subs.length > 0
        const key = `${pathPrefix}-${row.account_id ?? idx}`
        const isOpen = open[key] !== false
        const pl = 12 + depth * 20
        const canDrill = row.account_id != null && Number(row.account_id) >= 1

        return (
          <li key={key}>
            <div
              className="flex items-center justify-between py-1.5 rounded-md hover:bg-gray-50/80"
              style={{ paddingLeft: pl, paddingRight: 8 }}
            >
              <span
                className={`flex items-center gap-1.5 text-sm text-gray-800 min-w-0 ${
                  hasSubs ? 'cursor-pointer' : ''
                }`}
                onClick={hasSubs ? () => setOpen((o) => ({ ...o, [key]: !isOpen })) : undefined}
                onKeyDown={
                  hasSubs
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setOpen((o) => ({ ...o, [key]: !isOpen }))
                        }
                      }
                    : undefined
                }
                role={hasSubs ? 'button' : undefined}
                tabIndex={hasSubs ? 0 : undefined}
              >
                {hasSubs ? (
                  isOpen ? (
                    <ChevronDown size={14} className="shrink-0 text-gray-400" />
                  ) : (
                    <ChevronRight size={14} className="shrink-0 text-gray-400" />
                  )
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <span className="truncate">{row.cuenta}</span>
              </span>
              {canDrill ? (
                <button
                  type="button"
                  title="Ver movimientos en libro mayor"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDrillDown?.(row.account_id, accountType)
                  }}
                  className="text-sm tabular-nums text-gray-900 shrink-0 ml-3 cursor-pointer hover:text-blue-600 hover:underline transition-colors bg-transparent border-0 p-0"
                >
                  {formatMoney(row.monto, DISPLAY_CURRENCY)}
                </button>
              ) : (
                <span className="text-sm tabular-nums text-gray-900 shrink-0 ml-3">
                  {formatMoney(row.monto, DISPLAY_CURRENCY)}
                </span>
              )}
            </div>
            {hasSubs && isOpen && (
              <PnlAccountRows
                rows={subs}
                depth={depth + 1}
                pathPrefix={key}
                onDrillDown={onDrillDown}
                accountType={accountType}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

function PnlCategorySection({ title, rows, totalLabel, onDrillDown, accountType }) {
  const subtotal = sumRows(rows)
  if (!rows?.length) return null

  return (
    <section className="py-4 border-b border-gray-100 last:border-0">
      <h3 className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">{title}</h3>
      <PnlAccountRows rows={rows} onDrillDown={onDrillDown} accountType={accountType} />
      {totalLabel && (
        <div className="flex justify-between items-center mt-3 pt-2 border-t border-gray-200 text-sm font-semibold text-gray-800">
          <span>{totalLabel}</span>
          <span className="tabular-nums">{formatMoney(subtotal, DISPLAY_CURRENCY)}</span>
        </div>
      )}
    </section>
  )
}

export default function ProfitAndLossReport() {
  const navigate = useNavigate()
  const [preset, setPreset] = useState('this_month')
  const [customFrom, setCustomFrom] = useState(() => rangeForPreset('this_month').start)
  const [customTo, setCustomTo] = useState(() => rangeForPreset('this_month').end)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState(null)

  const activeRange = useMemo(() => {
    if (preset === 'custom') return { start: customFrom, end: customTo }
    return rangeForPreset(preset)
  }, [preset, customFrom, customTo])

  async function runReport() {
    setLoading(true)
    setError('')
    try {
      const params = { start_date: activeRange.start, end_date: activeRange.end }
      const { data: body } = await api.get('/api/v1/reports/profit-and-loss', { params })
      setData(body)
    } catch (err) {
      setData(null)
      const d = err?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'No se pudo generar el informe.')
    } finally {
      setLoading(false)
    }
  }

  const presetSelectOptions = useMemo(
    () => PRESETS.map((p) => ({ value: p.id, label: p.label })),
    [],
  )

  function handleDrillDown(accountId) {
    const id = Number(accountId)
    if (!Number.isFinite(id) || id < 1) return
    const startDate = data?.start_date || activeRange.start
    const endDate = data?.end_date || activeRange.end
    const params = new URLSearchParams({
      account_id: String(id),
      start_date: startDate,
      end_date: endDate,
    })
    navigate(`/contabilidad/cuenta/${id}?${params.toString()}`)
  }

  return (
    <div className="max-w-4xl mx-auto pb-16 px-4 font-sans text-gray-800">
      <button
        type="button"
        onClick={() => navigate('/informes')}
        className="text-green-800 hover:text-green-950 font-medium mb-6 bg-transparent border-0 p-0 text-sm cursor-pointer"
      >
        ‹ Volver a informes
      </button>

      <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
        <BarChart3 size={14} className="text-gray-600" />
        <span>QuickBooks · Estado de resultados</span>
        <span className="text-xs font-normal text-gray-500 block mt-0.5">
          Consolidado en USD (tipo de cambio histórico por transacción)
        </span>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Pérdidas y ganancias</h1>
      <p className="text-xs text-gray-500 mt-1">Libro mayor · cuentas padre e hijas</p>

      <div className="mt-8 rounded-xl border border-gray-200 bg-white shadow-sm p-5 space-y-4">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
            Periodo
            <SearchableSelect
              value={preset}
              onChange={setPreset}
              options={presetSelectOptions}
              hideClear
              minPanelWidth={200}
            />
          </label>
          {preset === 'custom' && (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Desde
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="h-10 rounded-md border border-gray-300 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-500"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
                Hasta
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="h-10 rounded-md border border-gray-300 px-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-500"
                />
              </label>
            </>
          )}
          <button
            type="button"
            onClick={runReport}
            disabled={loading}
            className="h-10 px-5 rounded-md bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {loading ? <Loader2 className="animate-spin" size={16} /> : null}
            Ejecutar informe
          </button>
        </div>
        {preset !== 'custom' && (
          <p className="text-xs text-gray-500">
            Rango aplicado:{' '}
            <span className="font-mono tabular-nums">
              {activeRange.start} → {activeRange.end}
            </span>
          </p>
        )}
      </div>

      {error && (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 text-red-800 text-sm px-4 py-3">
          {error}
        </div>
      )}

      {data && !loading && (
        <div className="mt-8 rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200 bg-gray-50">
            <p className="text-sm font-semibold text-gray-700">
              {data.start_date} — {data.end_date}
            </p>
          </div>

          <div className="px-5 py-2">
            {CATEGORY_BLOCKS.map((block) => {
              const rows = data[block.key]
              if (block.optional && (!rows || rows.length === 0)) return null
              return (
                <PnlCategorySection
                  key={block.key}
                  title={block.key}
                  rows={rows || []}
                  totalLabel={block.totalLabel}
                  onDrillDown={handleDrillDown}
                  accountType={block.key}
                />
              )
            })}

            <section className="py-4 bg-gray-50/80 -mx-5 px-5 border-y border-double border-gray-300">
              <PnlSummaryRow
                label="Utilidad bruta (Ingresos − Costo de ventas)"
                value={num(data.utilidad_bruta)}
                bold
                highlight
              />
            </section>

            <section className="pt-4 pb-2">
              <PnlSummaryRow label="Utilidad neta" value={num(data.utilidad_neta)} bold highlight />
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
