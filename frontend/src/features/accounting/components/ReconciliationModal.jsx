import { useCallback, useEffect, useState } from 'react'
import { CheckSquare, FileSpreadsheet, FileText, Loader2, X } from 'lucide-react'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'
import api from '../../../api/axios'
import { getApiErrorMessage } from '../../../lib/apiErrors'
import { formatSaleLedgerDateParts } from '../../sales/saleTableHelpers'
import { LEDGER_VERIFICATION_OPTIONS } from '../ledgerVerificationConstants'
import { todayIsoDateEcuador } from '../../../utils/datetime'

function formatMoney(n, currency) {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(n) || 0)
  } catch {
    return `${Number(n || 0).toFixed(2)} ${currency}`
  }
}

function formatMoneyPlain(n, currency) {
  const num = Number(n)
  if (!Number.isFinite(num)) return '—'
  return `${num.toFixed(2)} ${currency || 'USD'}`
}

function verificationStatusLabel(value) {
  if (!value) return 'Sin verificar'
  const v = String(value).trim().toLowerCase()
  const opt = LEDGER_VERIFICATION_OPTIONS.find((o) => o.value === v)
  return opt?.label ?? String(value)
}

function statusBadgeClass(value) {
  if (!value) return 'bg-slate-100 text-slate-600 ring-slate-200'
  const v = String(value).trim().toLowerCase()
  const opt = LEDGER_VERIFICATION_OPTIONS.find((o) => o.value === v)
  if (!opt) return 'bg-slate-100 text-slate-600 ring-slate-200'
  return `${opt.idleClass} ring-1`
}

function monthStartIso() {
  const today = todayIsoDateEcuador()
  const [y, m] = today.split('-')
  return `${y}-${m}-01`
}

function sanitizeFilePart(value) {
  return (
    String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'Cuenta'
  )
}

function buildExportBaseName(summary, accountName) {
  const name = sanitizeFilePart(accountName || summary?.account_name)
  const start = summary?.start_date ?? 'inicio'
  const end = summary?.end_date ?? 'fin'
  return `Conciliacion_${name}_${start}_al_${end}`
}

function beneficiaryExportLabel(tx) {
  const name = String(tx?.client_name ?? '').trim() || '—'
  const reason = String(tx?.transaction_reason ?? '').trim()
  return reason ? `${name} — ${reason}` : name
}

function mapTransactionsForExport(transactions) {
  return (Array.isArray(transactions) ? transactions : []).map((tx) => {
    const { dateLine } = formatSaleLedgerDateParts(tx.occurred_at)
    return {
      fecha: dateLine,
      referencia: tx.reference_number || '—',
      beneficiario: beneficiaryExportLabel(tx),
      deposito: tx.deposit != null ? Number(tx.deposit) : null,
      pago: tx.payment != null ? Number(tx.payment) : null,
      estado: verificationStatusLabel(tx.verification_status),
    }
  })
}

function exportToExcel({ summary, transactions, accountName, reportCurrency }) {
  if (!summary) return

  const rows = [
    ['Conciliación bancaria'],
    ['Cuenta', accountName || summary.account_name || '—'],
    ['Periodo', `${summary.start_date} al ${summary.end_date}`],
    ['Moneda', reportCurrency],
    [],
    ['Resumen del cuadre'],
    ['Total confirmado', Number(summary.total_confirmed)],
    ['Interbancario pendiente', Number(summary.total_interbank)],
    ['Pagos / retiros', Number(summary.total_payments)],
    ['Total a cuadrar', Number(summary.total_to_reconcile)],
    ['Depósitos totales', Number(summary.total_deposits)],
    ['No efectivas', Number(summary.total_no_effective)],
    [],
    ['Fecha', 'Referencia', 'Beneficiario', 'Depósito', 'Pago', 'Estado'],
  ]

  for (const tx of mapTransactionsForExport(transactions)) {
    rows.push([
      tx.fecha,
      tx.referencia,
      tx.beneficiario,
      tx.deposito ?? '',
      tx.pago ?? '',
      tx.estado,
    ])
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 14 }, { wch: 16 }, { wch: 36 }, { wch: 14 }, { wch: 14 }, { wch: 18 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Conciliacion')
  XLSX.writeFile(wb, `${buildExportBaseName(summary, accountName)}.xlsx`)
}

function exportToPDF({ summary, transactions, accountName, reportCurrency }) {
  if (!summary) return

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const displayName = accountName || summary.account_name || '—'

  doc.setFontSize(16)
  doc.text('Conciliación bancaria', 14, 14)
  doc.setFontSize(10)
  doc.text(`Cuenta: ${displayName}`, 14, 22)
  doc.text(`Periodo: ${summary.start_date} al ${summary.end_date}`, 14, 28)
  doc.text(`Moneda: ${reportCurrency}`, 14, 34)

  doc.setFontSize(9)
  doc.text(`Total confirmado: ${formatMoney(summary.total_confirmed, reportCurrency)}`, 14, 42)
  doc.text(`Interbancario pendiente: ${formatMoney(summary.total_interbank, reportCurrency)}`, 14, 47)
  doc.text(`Pagos / retiros: ${formatMoney(summary.total_payments, reportCurrency)}`, 14, 52)
  doc.text(`Total a cuadrar: ${formatMoney(summary.total_to_reconcile, reportCurrency)}`, 14, 57)

  const body = mapTransactionsForExport(transactions).map((tx) => [
    tx.fecha,
    tx.referencia,
    tx.beneficiario,
    tx.deposito != null ? formatMoneyPlain(tx.deposito, reportCurrency) : '—',
    tx.pago != null ? formatMoneyPlain(tx.pago, reportCurrency) : '—',
    tx.estado,
  ])

  autoTable(doc, {
    startY: 64,
    head: [['Fecha', 'Referencia', 'Beneficiario', 'Depósito', 'Pago', 'Estado']],
    body,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [16, 185, 129], textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 28 },
      1: { cellWidth: 28 },
      2: { cellWidth: 72 },
      3: { halign: 'right', cellWidth: 28 },
      4: { halign: 'right', cellWidth: 28 },
      5: { halign: 'center', cellWidth: 28 },
    },
    margin: { left: 14, right: 14 },
  })

  doc.save(`${buildExportBaseName(summary, accountName)}.pdf`)
}

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-xl text-gray-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500'

/**
 * Modal de conciliación bancaria por rango de fechas.
 *
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {number} accountId
 * @param {string} [accountName]
 * @param {string} [currency]
 * @param {string} [defaultStartDate]
 * @param {string} [defaultEndDate]
 */
export default function ReconciliationModal({
  open,
  onClose,
  accountId,
  accountName = '',
  currency = 'USD',
  defaultStartDate = '',
  defaultEndDate = '',
}) {
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setStartDate(defaultStartDate || monthStartIso())
    setEndDate(defaultEndDate || todayIsoDateEcuador())
    setReport(null)
    setError('')
    setLoading(false)
  }, [open, defaultStartDate, defaultEndDate, accountId])

  const generateReport = useCallback(async () => {
    if (!accountId || accountId < 1) return
    if (!startDate || !endDate) {
      setError('Indica fecha inicio y fecha fin.')
      return
    }
    if (startDate > endDate) {
      setError('La fecha inicio debe ser anterior o igual a la fecha fin.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const { data } = await api.get(`/api/v1/accounting/accounts/${accountId}/reconciliation`, {
        params: { start_date: startDate, end_date: endDate },
      })
      setReport(data)
    } catch (err) {
      setReport(null)
      setError(getApiErrorMessage(err, { fallback: 'No se pudo generar el cuadre bancario.' }))
    } finally {
      setLoading(false)
    }
  }, [accountId, startDate, endDate])

  const handleExportExcel = useCallback(() => {
    if (!report?.summary) return
    exportToExcel({
      summary: report.summary,
      transactions: report.transactions,
      accountName,
      reportCurrency: report.summary.currency || currency,
    })
  }, [report, accountName, currency])

  const handleExportPdf = useCallback(() => {
    if (!report?.summary) return
    exportToPDF({
      summary: report.summary,
      transactions: report.transactions,
      accountName,
      reportCurrency: report.summary.currency || currency,
    })
  }, [report, accountName, currency])

  if (!open) return null

  const summary = report?.summary
  const transactions = Array.isArray(report?.transactions) ? report.transactions : []
  const reportCurrency = summary?.currency || currency

  return (
    <div className="fixed inset-0 z-[88] flex items-center justify-center p-4 sm:p-6">
      <button type="button" className="absolute inset-0 bg-black/45" aria-label="Cerrar" onClick={onClose} />

      <div
        role="dialog"
        aria-labelledby="reconciliation-modal-title"
        className="relative w-full max-w-4xl max-h-[min(92vh,860px)] flex flex-col rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden"
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100 shrink-0 bg-emerald-50/50">
          <div className="flex items-start gap-3 min-w-0">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
              <CheckSquare size={18} aria-hidden />
            </div>
            <div className="min-w-0">
              <h2 id="reconciliation-modal-title" className="text-base font-semibold text-gray-900 truncate">
                Conciliación bancaria
              </h2>
              <p className="text-xs text-emerald-900/80 mt-0.5 truncate">
                {accountName ? `${accountName} · ` : ''}
                Cuadre por rango de fechas
              </p>
            </div>
          </div>
          <button type="button" className="p-1.5 rounded-lg text-gray-400 hover:bg-white/80 shrink-0" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <div className="rounded-xl border border-gray-200 bg-slate-50/60 p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto] gap-3 items-end">
              <div>
                <label htmlFor="recon-start" className="block text-xs font-medium text-gray-600 mb-1">
                  Fecha inicio
                </label>
                <input
                  id="recon-start"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  disabled={loading}
                  className={inputCls}
                />
              </div>
              <div>
                <label htmlFor="recon-end" className="block text-xs font-medium text-gray-600 mb-1">
                  Fecha fin
                </label>
                <input
                  id="recon-end"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  disabled={loading}
                  className={inputCls}
                />
              </div>
              <button
                type="button"
                onClick={generateReport}
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 h-10"
              >
                {loading ? <Loader2 size={16} className="animate-spin shrink-0" aria-hidden /> : null}
                Generar cuadre
              </button>
            </div>
            {error ? (
              <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>
            ) : null}
          </div>

          {summary ? (
            <>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={handleExportExcel}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-emerald-800 bg-emerald-50 ring-1 ring-emerald-200 hover:bg-emerald-100 transition-colors"
                >
                  <FileSpreadsheet size={16} aria-hidden />
                  Exportar Excel
                </button>
                <button
                  type="button"
                  onClick={handleExportPdf}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-rose-800 bg-rose-50 ring-1 ring-rose-200 hover:bg-rose-100 transition-colors"
                >
                  <FileText size={16} aria-hidden />
                  Exportar PDF
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/80 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Total confirmado</p>
                  <p className="mt-1 text-xl font-bold text-emerald-900 tabular-nums">
                    {formatMoney(summary.total_confirmed, reportCurrency)}
                  </p>
                </div>
                <div className="rounded-xl border border-amber-200 bg-amber-50/80 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-800">Interbancario pendiente</p>
                  <p className="mt-1 text-xl font-bold text-amber-900 tabular-nums">
                    {formatMoney(summary.total_interbank, reportCurrency)}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-600">Pagos / retiros</p>
                  <p className="mt-1 text-xl font-bold text-slate-800 tabular-nums">
                    {formatMoney(summary.total_payments, reportCurrency)}
                  </p>
                </div>
                <div className="rounded-xl border border-blue-200 bg-blue-50/80 p-4 sm:col-span-2 lg:col-span-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-blue-800">Total a cuadrar</p>
                  <p className="mt-1 text-xl font-bold text-blue-900 tabular-nums">
                    {formatMoney(summary.total_to_reconcile, reportCurrency)}
                  </p>
                  <p className="text-[10px] text-blue-700/80 mt-1">Confirmado + interbancario − pagos</p>
                </div>
              </div>

              <div className="flex flex-wrap gap-4 text-xs text-gray-500 px-1">
                <span>
                  Depósitos totales:{' '}
                  <strong className="text-gray-700 tabular-nums">{formatMoney(summary.total_deposits, reportCurrency)}</strong>
                </span>
                <span>
                  No efectivas:{' '}
                  <strong className="text-gray-700 tabular-nums">{formatMoney(summary.total_no_effective, reportCurrency)}</strong>
                </span>
                <span>
                  Periodo: {summary.start_date} → {summary.end_date}
                </span>
              </div>

              <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-slate-50/80">
                      <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                        Fecha
                      </th>
                      <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                        Referencia
                      </th>
                      <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                        Beneficiario / descripción
                      </th>
                      <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                        Depósito
                      </th>
                      <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                        Pago
                      </th>
                      <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                        Estado
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {transactions.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-10 text-center text-gray-400 text-sm">
                          No hay movimientos en este periodo.
                        </td>
                      </tr>
                    ) : (
                      transactions.map((tx) => {
                        const { dateLine } = formatSaleLedgerDateParts(tx.occurred_at)
                        return (
                          <tr key={tx.ledger_transaction_id} className="hover:bg-slate-50/50">
                            <td className="px-3 py-2.5 whitespace-nowrap text-gray-900">{dateLine}</td>
                            <td className="px-3 py-2.5 font-mono text-xs text-blue-700 tabular-nums">
                              {tx.reference_number || '—'}
                            </td>
                            <td className="px-3 py-2.5 min-w-0 max-w-[14rem]">
                              <div className="truncate font-medium text-gray-900" title={tx.client_name}>
                                {tx.client_name}
                              </div>
                              {tx.transaction_reason ? (
                                <div className="truncate text-xs text-gray-500 mt-0.5" title={tx.transaction_reason}>
                                  {tx.transaction_reason}
                                </div>
                              ) : null}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-gray-900">
                              {tx.deposit != null ? formatMoney(tx.deposit, reportCurrency) : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-gray-900">
                              {tx.payment != null ? formatMoney(tx.payment, reportCurrency) : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded-lg text-[10px] font-semibold ${statusBadgeClass(tx.verification_status)}`}
                              >
                                {verificationStatusLabel(tx.verification_status)}
                              </span>
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            !loading &&
            !error && (
              <p className="text-sm text-gray-500 text-center py-8">
                Selecciona un rango de fechas y pulsa «Generar cuadre» para ver el reporte.
              </p>
            )
          )}
        </div>
      </div>
    </div>
  )
}
