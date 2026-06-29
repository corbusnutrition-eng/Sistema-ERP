import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BarChart3, Download, Loader2 } from 'lucide-react'
import api from '../../api/axios'
import SearchableSelect from '../../components/ui/SearchableSelect'
import { todayIsoDateEcuador } from '../../utils/datetime'

function pad2(n) {
  return String(n).padStart(2, '0')
}

function toIsoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function rangeForPreset(presetId) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Guayaquil',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const y = Number(parts.find((p) => p.type === 'year')?.value)
  const m = Number(parts.find((p) => p.type === 'month')?.value) - 1
  const now = new Date(y, m, Number(parts.find((p) => p.type === 'day')?.value))

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
    return { start: toIsoDate(new Date(y, 0, 1)), end: todayIsoDateEcuador() }
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

function escapeCsv(value) {
  const s = value == null ? '' : String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

const PRESETS = [
  { id: 'this_month', label: 'Este mes' },
  { id: 'last_month', label: 'Mes pasado' },
  { id: 'this_year', label: 'Este año' },
  { id: 'custom', label: 'Personalizado' },
]

const LIST_TYPES = [
  { value: 'class', label: 'Clases' },
  { value: 'payment_method', label: 'Métodos de pago' },
  { value: 'currency', label: 'Monedas' },
  { value: 'tag', label: 'Etiquetas' },
]

function buildExportFilename(start, end, listType) {
  return `Reporte_Listas_${listType}_${start}_${end}.csv`
}

export default function ListClassificationReport() {
  const navigate = useNavigate()
  const [preset, setPreset] = useState('this_month')
  const [customFrom, setCustomFrom] = useState(() => rangeForPreset('this_month').start)
  const [customTo, setCustomTo] = useState(() => rangeForPreset('this_month').end)
  const [listType, setListType] = useState('payment_method')
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState(null)

  const activeRange = useMemo(() => {
    if (preset === 'custom') return { start: customFrom, end: customTo }
    return rangeForPreset(preset)
  }, [preset, customFrom, customTo])

  const runReport = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = {
        start_date: activeRange.start,
        end_date: activeRange.end,
        list_type: listType,
      }
      const { data: body } = await api.get('/api/v1/reports/list-classification', { params })
      setData(body)
    } catch (err) {
      setData(null)
      const d = err?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'No se pudo generar el informe.')
    } finally {
      setLoading(false)
    }
  }, [activeRange.start, activeRange.end, listType])

  useEffect(() => {
    void runReport()
  }, [runReport])

  const presetSelectOptions = useMemo(
    () => PRESETS.map((p) => ({ value: p.id, label: p.label })),
    [],
  )

  const listTypeOptions = useMemo(
    () => LIST_TYPES.map((t) => ({ value: t.value, label: t.label })),
    [],
  )

  const dimensionLabel = data?.list_type_label || LIST_TYPES.find((t) => t.value === listType)?.label || ''

  function exportCsv() {
    if (!data?.rows?.length) {
      setError('No hay datos para exportar en el periodo seleccionado.')
      return
    }
    setExporting(true)
    setError('')
    try {
      const header = ['Clasificación', 'Transacciones', 'Total (USD)']
      const lines = [
        header.join(','),
        ...data.rows.map((row) =>
          [
            escapeCsv(row.item_name),
            escapeCsv(row.transaction_count),
            escapeCsv(num(row.total_amount_usd).toFixed(2)),
          ].join(','),
        ),
        [
          escapeCsv('Total general'),
          escapeCsv(data.grand_total_count),
          escapeCsv(num(data.grand_total_amount_usd).toFixed(2)),
        ].join(','),
      ]
      const bom = '\ufeff'
      const blob = new Blob([bom + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', buildExportFilename(activeRange.start, activeRange.end, listType))
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      setError('No se pudo exportar el archivo CSV.')
    } finally {
      setExporting(false)
    }
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
        <span>QuickBooks · Informes · Listas</span>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 tracking-tight">
        Reporte por Clasificación (Listas)
      </h1>
      <p className="text-xs text-gray-500 mt-1">
        Totales de ventas y cobros agrupados por la dimensión seleccionada.
      </p>

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
          <label className="flex flex-col gap-1 text-xs font-medium text-gray-600">
            Dimensión de lista
            <SearchableSelect
              value={listType}
              onChange={setListType}
              options={listTypeOptions}
              hideClear
              minPanelWidth={220}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runReport}
              disabled={loading || exporting}
              className="h-10 px-5 rounded-md bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {loading ? <Loader2 className="animate-spin" size={16} /> : null}
              Ejecutar informe
            </button>
            <button
              type="button"
              onClick={exportCsv}
              disabled={loading || exporting || !data?.rows?.length}
              className="h-10 px-5 rounded-md border-2 border-green-700 bg-green-600 text-white text-sm font-bold hover:bg-green-700 hover:border-green-800 disabled:opacity-50 inline-flex items-center gap-2 shadow-sm"
            >
              {exporting ? (
                <Loader2 className="animate-spin" size={16} />
              ) : (
                <Download size={16} aria-hidden />
              )}
              Exportar CSV
            </button>
          </div>
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

      {loading && !data && (
        <div className="mt-8 flex items-center justify-center gap-2 text-sm text-gray-500 py-12">
          <Loader2 className="animate-spin" size={18} />
          Generando informe…
        </div>
      )}

      {data && !loading && (
        <div className="mt-8 rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200 bg-gray-50 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-gray-700">
                {data.start_date} — {data.end_date}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">Agrupado por: {dimensionLabel}</p>
            </div>
            <p className="text-xs text-gray-500 tabular-nums">
              {data.rows.length} {data.rows.length === 1 ? 'fila' : 'filas'}
            </p>
          </div>

          {data.rows.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-gray-500">
              No hay transacciones en el periodo para esta dimensión.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50/80">
                    <th className="text-left px-5 py-3 text-[11px] font-bold uppercase tracking-wider text-gray-500">
                      {dimensionLabel}
                    </th>
                    <th className="text-right px-5 py-3 text-[11px] font-bold uppercase tracking-wider text-gray-500">
                      Transacciones
                    </th>
                    <th className="text-right px-5 py-3 text-[11px] font-bold uppercase tracking-wider text-gray-500">
                      Total (USD)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {data.rows.map((row) => {
                    const rowKey = row.item_id ?? row.item_key ?? row.item_name
                    return (
                      <tr key={rowKey} className="hover:bg-slate-50/60 transition-colors">
                        <td className="px-5 py-3.5 font-medium text-gray-800">{row.item_name}</td>
                        <td className="px-5 py-3.5 text-right tabular-nums text-gray-700">
                          {row.transaction_count}
                        </td>
                        <td className="px-5 py-3.5 text-right tabular-nums text-gray-900 font-medium">
                          {formatMoney(row.total_amount_usd)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-200 bg-gray-50/80 font-semibold text-gray-900">
                    <td className="px-5 py-3.5">Total general</td>
                    <td className="px-5 py-3.5 text-right tabular-nums">{data.grand_total_count}</td>
                    <td className="px-5 py-3.5 text-right tabular-nums">
                      {formatMoney(data.grand_total_amount_usd)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
