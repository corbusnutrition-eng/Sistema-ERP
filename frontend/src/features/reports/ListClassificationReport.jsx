import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BarChart3, ChevronDown, ChevronRight, Download, ExternalLink, Loader2 } from 'lucide-react'
import api from '../../api/axios'
import SearchableSelect from '../../components/ui/SearchableSelect'
import { useModal } from '../../context/ModalContext'
import usePermissions from '../../hooks/usePermissions'
import { PERMS } from '../../lib/permissions'
import { todayIsoDateEcuador } from '../../utils/datetime'
import NuevaVentaModal from '../sales/components/NuevaVentaModal'
import { saleOpensReadOnly } from '../sales/saleTableHelpers'

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

function buildRowKey(row) {
  return `${row.item_id ?? '∅'}::${row.item_key ?? '∅'}::${row.item_name}`
}

function txnTypeLabel(type) {
  switch (type) {
    case 'sale':
      return 'Factura'
    case 'payment':
      return 'Pago'
    case 'debt_payment':
      return 'Abono'
    case 'expense':
      return 'Gasto'
    default:
      return String(type || '—')
  }
}

function formatTxnDate(value) {
  if (!value) return '—'
  const s = String(value).slice(0, 10)
  const [y, m, d] = s.split('-')
  if (!y || !m || !d) return s
  return `${d}/${m}/${y}`
}

function formatApiErrorDetail(err, fallback) {
  const d = err?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d)) {
    const parts = d.map((x) => (typeof x === 'object' && x != null && 'msg' in x ? x.msg : JSON.stringify(x)))
    return parts.length ? parts.join(' · ') : fallback
  }
  return fallback
}

export default function ListClassificationReport() {
  const navigate = useNavigate()
  const { openReceivePayment } = useModal()
  const { hasPermission } = usePermissions()
  const canViewSalesDetail = hasPermission(PERMS.SALES_INVOICES_VIEW)
  const canEditPayments =
    hasPermission(PERMS.ACCOUNTING_RECEIVABLES_EDIT) || hasPermission(PERMS.SALES_RECEIPTS_EDIT)
  const canViewPayments = hasPermission(PERMS.ACCOUNTING_RECEIVABLES_VIEW) || canEditPayments
  const [preset, setPreset] = useState('this_month')
  const [customFrom, setCustomFrom] = useState(() => rangeForPreset('this_month').start)
  const [customTo, setCustomTo] = useState(() => rangeForPreset('this_month').end)
  const [listType, setListType] = useState('payment_method')
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState(null)
  const [expandedRowKey, setExpandedRowKey] = useState(null)
  const [rowTransactions, setRowTransactions] = useState({})
  const [loadingRowKey, setLoadingRowKey] = useState(null)
  const [txnLoadError, setTxnLoadError] = useState('')
  const [editSale, setEditSale] = useState(null)

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
    setExpandedRowKey(null)
    setRowTransactions({})
    setTxnLoadError('')
  }, [runReport])

  const fetchRowTransactions = useCallback(
    async (row) => {
      const key = buildRowKey(row)
      setLoadingRowKey(key)
      setTxnLoadError('')
      try {
        const params = {
          start_date: activeRange.start,
          end_date: activeRange.end,
          list_type: listType,
          item_name: row.item_name,
        }
        if (row.item_id != null) params.item_id = row.item_id
        if (row.item_key != null) params.item_key = row.item_key
        const { data: body } = await api.get('/api/v1/reports/list-classification/transactions', { params })
        const txns = Array.isArray(body?.transactions) ? body.transactions : []
        setRowTransactions((prev) => ({ ...prev, [key]: txns }))
        return txns
      } catch (err) {
        setTxnLoadError(formatApiErrorDetail(err, 'No se pudo cargar el detalle de transacciones.'))
        return []
      } finally {
        setLoadingRowKey(null)
      }
    },
    [activeRange.end, activeRange.start, listType],
  )

  const toggleRowExpand = useCallback(
    async (row) => {
      const key = buildRowKey(row)
      if (expandedRowKey === key) {
        setExpandedRowKey(null)
        return
      }
      setExpandedRowKey(key)
      if (!rowTransactions[key]) {
        await fetchRowTransactions(row)
      }
    },
    [expandedRowKey, fetchRowTransactions, rowTransactions],
  )

  const handleOpenTransaction = useCallback(
    async (txn) => {
      if (!txn) return
      if (txn.type === 'sale') {
        if (!canViewSalesDetail) {
          window.alert('No tienes permiso para ver facturas.')
          return
        }
        const saleId = Number(txn.id)
        if (!Number.isFinite(saleId) || saleId < 1) return
        try {
          const { data: sale } = await api.get(`/api/v1/sales/${saleId}`)
          setEditSale(sale)
        } catch (err) {
          window.alert(formatApiErrorDetail(err, 'No se pudo cargar la factura.'))
        }
        return
      }

      if (txn.type === 'payment') {
        if (!canViewPayments) {
          window.alert('No tienes permiso para ver pagos.')
          return
        }
        const paymentId = Number(txn.id)
        const clientId = Number(txn.client_id)
        if (!Number.isFinite(paymentId) || paymentId < 1) return
        openReceivePayment(null, {
          ...(canEditPayments ? {} : { viewMode: true }),
          paymentId,
          paymentNumber: txn.reference,
          clientId: Number.isFinite(clientId) ? clientId : undefined,
        })
        return
      }

      if (txn.type === 'debt_payment' && txn.client_id) {
        navigate(`/clientes/${txn.client_id}`)
        return
      }

      if (txn.type === 'expense') {
        navigate('/contabilidad/gastos')
        return
      }

      window.alert('Este tipo de transacción no tiene detalle editable desde el informe.')
    },
    [canEditPayments, canViewPayments, canViewSalesDetail, navigate, openReceivePayment],
  )

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

      {txnLoadError && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-sm px-4 py-3">
          {txnLoadError}
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
                    const rowKey = buildRowKey(row)
                    const isExpanded = expandedRowKey === rowKey
                    const txns = rowTransactions[rowKey] || []
                    const isLoadingTxns = loadingRowKey === rowKey
                    const canExpand = row.transaction_count > 0
                    return (
                      <Fragment key={rowKey}>
                        <tr className="hover:bg-slate-50/60 transition-colors">
                          <td className="px-5 py-3.5 font-medium text-gray-800">
                            <div className="flex items-center gap-2">
                              {canExpand ? (
                                <button
                                  type="button"
                                  onClick={() => void toggleRowExpand(row)}
                                  className="p-0.5 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 shrink-0"
                                  aria-expanded={isExpanded}
                                  aria-label={isExpanded ? 'Ocultar transacciones' : 'Ver transacciones'}
                                >
                                  {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                </button>
                              ) : (
                                <span className="w-[18px] shrink-0" aria-hidden />
                              )}
                              <span>{row.item_name}</span>
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-right tabular-nums">
                            {canExpand ? (
                              <button
                                type="button"
                                onClick={() => void toggleRowExpand(row)}
                                className="text-blue-700 hover:text-blue-900 hover:underline font-medium cursor-pointer tabular-nums"
                              >
                                {row.transaction_count}
                              </button>
                            ) : (
                              <span className="text-gray-700">{row.transaction_count}</span>
                            )}
                          </td>
                          <td className="px-5 py-3.5 text-right tabular-nums text-gray-900 font-medium">
                            {formatMoney(row.total_amount_usd)}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-slate-50/80">
                            <td colSpan={3} className="px-5 py-3">
                              {isLoadingTxns ? (
                                <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
                                  <Loader2 size={16} className="animate-spin" />
                                  Cargando transacciones…
                                </div>
                              ) : txns.length === 0 ? (
                                <p className="text-sm text-gray-500 py-2">No hay transacciones para mostrar.</p>
                              ) : (
                                <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="border-b border-gray-100 bg-gray-50/90">
                                        <th className="text-left px-3 py-2 font-semibold text-gray-500 uppercase tracking-wide">
                                          Fecha
                                        </th>
                                        <th className="text-left px-3 py-2 font-semibold text-gray-500 uppercase tracking-wide">
                                          Tipo
                                        </th>
                                        <th className="text-left px-3 py-2 font-semibold text-gray-500 uppercase tracking-wide">
                                          Referencia
                                        </th>
                                        <th className="text-left px-3 py-2 font-semibold text-gray-500 uppercase tracking-wide">
                                          Cliente
                                        </th>
                                        <th className="text-right px-3 py-2 font-semibold text-gray-500 uppercase tracking-wide">
                                          Monto (USD)
                                        </th>
                                        <th className="text-right px-3 py-2 font-semibold text-gray-500 uppercase tracking-wide">
                                          Acción
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50">
                                      {txns.map((txn) => {
                                        const openable =
                                          txn.type === 'sale'
                                          || txn.type === 'payment'
                                          || txn.type === 'debt_payment'
                                          || txn.type === 'expense'
                                        return (
                                          <tr
                                            key={`${txn.type}-${txn.id}-${txn.reference}`}
                                            className={openable ? 'hover:bg-blue-50/40 cursor-pointer' : ''}
                                            onClick={() => {
                                              if (openable) void handleOpenTransaction(txn)
                                            }}
                                          >
                                            <td className="px-3 py-2 tabular-nums text-gray-700 whitespace-nowrap">
                                              {formatTxnDate(txn.date)}
                                            </td>
                                            <td className="px-3 py-2 text-gray-700">{txnTypeLabel(txn.type)}</td>
                                            <td className="px-3 py-2 font-mono text-gray-800">{txn.reference || '—'}</td>
                                            <td className="px-3 py-2 text-gray-700 max-w-[180px] truncate">
                                              {txn.client_name || '—'}
                                            </td>
                                            <td className="px-3 py-2 text-right tabular-nums text-gray-900 font-medium whitespace-nowrap">
                                              {formatMoney(txn.amount_usd)}
                                            </td>
                                            <td className="px-3 py-2 text-right">
                                              {openable ? (
                                                <button
                                                  type="button"
                                                  onClick={(e) => {
                                                    e.stopPropagation()
                                                    void handleOpenTransaction(txn)
                                                  }}
                                                  className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 font-medium"
                                                >
                                                  {txn.type === 'sale' ? 'Ver/editar' : 'Ver'}
                                                  <ExternalLink size={12} />
                                                </button>
                                              ) : (
                                                <span className="text-gray-400">—</span>
                                              )}
                                            </td>
                                          </tr>
                                        )
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
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

      {editSale && (
        <NuevaVentaModal
          initialSale={editSale}
          readOnlyMode={saleOpensReadOnly(editSale)}
          prefillClientId={null}
          onClose={() => setEditSale(null)}
          onSuccess={() => setEditSale(null)}
          onToast={(msg, variant) => {
            if (variant === 'error') window.alert(msg)
          }}
        />
      )}
    </div>
  )
}
