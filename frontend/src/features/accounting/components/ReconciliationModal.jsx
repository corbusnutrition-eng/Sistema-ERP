import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckSquare, FileSpreadsheet, FileText, ImagePlus, Loader2, X } from 'lucide-react'
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

function formatAuditCreatedAt(createdAt) {
  if (!createdAt) return '—'
  const { dateLine, timeLine } = formatSaleLedgerDateParts(createdAt)
  return timeLine ? `${dateLine} ${timeLine}` : dateLine
}

function auditSourceLabel(audit) {
  return `${audit.service_name} (${audit.start_date} → ${audit.end_date})`
}

function flattenAuditRows(audits, field) {
  const out = []
  for (const audit of audits) {
    const rows = Array.isArray(audit[field]) ? audit[field] : []
    for (const row of rows) {
      out.push({
        ...row,
        _source: auditSourceLabel(audit),
        _service: audit.service_name,
        _period: `${audit.start_date} → ${audit.end_date}`,
      })
    }
  }
  return out
}

function buildConsolidatedExportBaseName(accountName) {
  const name = sanitizeFilePart(accountName)
  const today = todayIsoDateEcuador()
  return `Auditorias_Inventario_${name}_${today}`
}

function buildSingleAuditExportBaseName(audit, accountName) {
  const name = sanitizeFilePart(accountName || audit?.account_name)
  const svc = sanitizeFilePart(audit?.service_name)
  const start = audit?.start_date ?? 'inicio'
  const end = audit?.end_date ?? 'fin'
  return `Auditoria_${name}_${svc}_${start}_al_${end}`
}

function mapInventoryCreditRowForExport(row) {
  return [
    row.username ?? '—',
    row.credits_platform != null ? row.credits_platform : '',
    row.credits_erp != null ? row.credits_erp : '',
    row.credits != null ? row.credits : '',
  ]
}

function exportSingleInventoryAuditExcel({ audit, accountName }) {
  if (!audit) return

  const head = ['Usuario', 'Plataforma', 'ERP', 'Créditos']
  const meta = [
    ['Auditoría de inventario'],
    ['Cuenta', accountName || audit.account_name || '—'],
    ['Servicio', audit.service_name],
    ['Periodo', `${audit.start_date} al ${audit.end_date}`],
    ['Filas leídas (IA)', audit.platform_rows_extracted ?? 0],
    [],
  ]

  const mkRows = (rows) => [head, ...(Array.isArray(rows) ? rows : []).map(mapInventoryCreditRowForExport)]

  const wb = XLSX.utils.book_new()

  const wsMatched = XLSX.utils.aoa_to_sheet([...meta, ['✅ Cuadran perfectamente'], ...mkRows(audit.matched)])
  const wsErp = XLSX.utils.aoa_to_sheet([...meta, ['⚠️ Faltan en el sistema'], ...mkRows(audit.missing_in_erp)])
  const wsPlatform = XLSX.utils.aoa_to_sheet([
    ...meta,
    ['❓ Faltan en plataforma'],
    ...mkRows(audit.missing_in_platform),
  ])

  wsMatched['!cols'] = [{ wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 12 }]
  wsErp['!cols'] = [{ wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 12 }]
  wsPlatform['!cols'] = [{ wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 12 }]

  XLSX.utils.book_append_sheet(wb, wsMatched, 'Cuadran')
  XLSX.utils.book_append_sheet(wb, wsErp, 'Faltan ERP')
  XLSX.utils.book_append_sheet(wb, wsPlatform, 'Faltan plataforma')
  XLSX.writeFile(wb, `${buildSingleAuditExportBaseName(audit, accountName)}.xlsx`)
}

function exportSingleInventoryAuditPDF({ audit, accountName }) {
  if (!audit) return

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  const displayName = accountName || audit.account_name || '—'
  const creditHead = [['Usuario', 'Plataforma', 'ERP', 'Créditos']]
  const mapBody = (rows) =>
    (Array.isArray(rows) ? rows : []).map((row) =>
      mapInventoryCreditRowForExport(row).map((v) => (v === '' ? '—' : String(v))),
    )

  doc.setFontSize(16)
  doc.text('Auditoría de inventario', 14, 14)
  doc.setFontSize(10)
  doc.text(`Cuenta: ${displayName}`, 14, 22)
  doc.text(`Servicio: ${audit.service_name}`, 14, 28)
  doc.text(`Periodo: ${audit.start_date} al ${audit.end_date}`, 14, 34)
  doc.text(`Filas leídas (IA): ${audit.platform_rows_extracted ?? 0}`, 14, 40)

  let y = 48
  doc.setFontSize(11)
  doc.text(`Cuadran perfectamente (${(audit.matched || []).length})`, 14, y)
  autoTable(doc, {
    startY: y + 3,
    head: creditHead,
    body: mapBody(audit.matched),
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [16, 185, 129], textColor: 255, fontStyle: 'bold' },
    margin: { left: 14, right: 14 },
  })

  y = doc.lastAutoTable.finalY + 8
  doc.text(`Faltan en el sistema (${(audit.missing_in_erp || []).length})`, 14, y)
  autoTable(doc, {
    startY: y + 3,
    head: creditHead,
    body: mapBody(audit.missing_in_erp),
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [239, 68, 68], textColor: 255, fontStyle: 'bold' },
    margin: { left: 14, right: 14 },
  })

  y = doc.lastAutoTable.finalY + 8
  if (y > 180) {
    doc.addPage()
    y = 14
  }
  doc.text(`Faltan en plataforma (${(audit.missing_in_platform || []).length})`, 14, y)
  autoTable(doc, {
    startY: y + 3,
    head: creditHead,
    body: mapBody(audit.missing_in_platform),
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [245, 158, 11], textColor: 255, fontStyle: 'bold' },
    margin: { left: 14, right: 14 },
  })

  doc.save(`${buildSingleAuditExportBaseName(audit, accountName)}.pdf`)
}

function exportConsolidatedInventoryExcel({ audits, accountName }) {
  if (!Array.isArray(audits) || audits.length === 0) return

  const matched = flattenAuditRows(audits, 'matched_data')
  const missingErp = flattenAuditRows(audits, 'missing_erp_data')
  const missingPlatform = flattenAuditRows(audits, 'missing_platform_data')

  const rows = [
    ['Auditorías de inventario — reporte consolidado'],
    ['Cuenta', accountName || '—'],
    ['Total auditorías', audits.length],
    [],
    ['Resumen por auditoría'],
    ['Fecha guardado', 'Servicio', 'Periodo', 'Cuadran', 'Faltan ERP', 'Faltan plataforma'],
  ]

  for (const audit of audits) {
    rows.push([
      formatAuditCreatedAt(audit.created_at),
      audit.service_name,
      `${audit.start_date} → ${audit.end_date}`,
      (audit.matched_data || []).length,
      (audit.missing_erp_data || []).length,
      (audit.missing_platform_data || []).length,
    ])
  }

  rows.push(
    [],
    ['✅ Cuadran perfectamente (consolidado)'],
    ['Servicio / periodo', 'Usuario', 'Plataforma', 'ERP', 'Créditos'],
  )
  for (const row of matched) {
    rows.push([
      row._source,
      row.username,
      row.credits_platform ?? '',
      row.credits_erp ?? '',
      row.credits ?? '',
    ])
  }

  rows.push(
    [],
    ['⚠️ Faltan en el sistema (consolidado)'],
    ['Servicio / periodo', 'Usuario', 'Plataforma', 'ERP', 'Créditos'],
  )
  for (const row of missingErp) {
    rows.push([
      row._source,
      row.username,
      row.credits_platform ?? '',
      row.credits_erp ?? '',
      row.credits ?? '',
    ])
  }

  rows.push(
    [],
    ['❓ Faltan en plataforma (consolidado)'],
    ['Servicio / periodo', 'Usuario', 'Plataforma', 'ERP', 'Créditos'],
  )
  for (const row of missingPlatform) {
    rows.push([
      row._source,
      row.username,
      row.credits_platform ?? '',
      row.credits_erp ?? '',
      row.credits ?? '',
    ])
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 28 }, { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 12 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Consolidado')
  XLSX.writeFile(wb, `${buildConsolidatedExportBaseName(accountName)}.xlsx`)
}

function exportConsolidatedInventoryPDF({ audits, accountName }) {
  if (!Array.isArray(audits) || audits.length === 0) return

  const matched = flattenAuditRows(audits, 'matched_data')
  const missingErp = flattenAuditRows(audits, 'missing_erp_data')
  const missingPlatform = flattenAuditRows(audits, 'missing_platform_data')

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
  doc.setFontSize(16)
  doc.text('Auditorías de inventario — consolidado', 14, 14)
  doc.setFontSize(10)
  doc.text(`Cuenta: ${accountName || '—'}`, 14, 22)
  doc.text(`Total auditorías: ${audits.length}`, 14, 28)

  const summaryBody = audits.map((audit) => [
    formatAuditCreatedAt(audit.created_at),
    audit.service_name,
    `${audit.start_date} → ${audit.end_date}`,
    String((audit.matched_data || []).length),
    String((audit.missing_erp_data || []).length),
    String((audit.missing_platform_data || []).length),
  ])

  autoTable(doc, {
    startY: 34,
    head: [['Fecha', 'Servicio', 'Periodo', 'Cuadran', 'Faltan ERP', 'Faltan plat.']],
    body: summaryBody,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [59, 130, 246], textColor: 255, fontStyle: 'bold' },
    margin: { left: 14, right: 14 },
  })

  const creditTableHead = [['Servicio / periodo', 'Usuario', 'Plataforma', 'ERP', 'Créditos']]
  const mapCreditRows = (list) =>
    list.map((row) => [
      row._source,
      row.username,
      row.credits_platform != null ? String(row.credits_platform) : '—',
      row.credits_erp != null ? String(row.credits_erp) : '—',
      row.credits != null ? String(row.credits) : '—',
    ])

  let y = doc.lastAutoTable.finalY + 8
  doc.setFontSize(11)
  doc.text(`Cuadran perfectamente (${matched.length})`, 14, y)
  autoTable(doc, {
    startY: y + 3,
    head: creditTableHead,
    body: mapCreditRows(matched),
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [16, 185, 129], textColor: 255, fontStyle: 'bold' },
    margin: { left: 14, right: 14 },
  })

  y = doc.lastAutoTable.finalY + 8
  doc.text(`Faltan en el sistema (${missingErp.length})`, 14, y)
  autoTable(doc, {
    startY: y + 3,
    head: creditTableHead,
    body: mapCreditRows(missingErp),
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [239, 68, 68], textColor: 255, fontStyle: 'bold' },
    margin: { left: 14, right: 14 },
  })

  y = doc.lastAutoTable.finalY + 8
  if (y > 180) {
    doc.addPage()
    y = 14
  }
  doc.text(`Faltan en plataforma (${missingPlatform.length})`, 14, y)
  autoTable(doc, {
    startY: y + 3,
    head: creditTableHead,
    body: mapCreditRows(missingPlatform),
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [245, 158, 11], textColor: 255, fontStyle: 'bold' },
    margin: { left: 14, right: 14 },
  })

  doc.save(`${buildConsolidatedExportBaseName(accountName)}.pdf`)
}

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-xl text-gray-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500'

const INVENTORY_SERVICE_OPTIONS = [
  { value: 'FLUJO TV', label: 'FLUJO TV' },
  { value: 'STELLA TV', label: 'STELLA TV' },
]

function InventoryCreditTable({ rows, columns, emptyMessage }) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) {
    return <p className="text-sm text-gray-500 py-4 text-center">{emptyMessage}</p>
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 bg-slate-50/80">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600 ${col.align === 'right' ? 'text-right' : 'text-left'}`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {list.map((row, idx) => (
            <tr key={`${row.username}-${idx}`} className="hover:bg-slate-50/50">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-3 py-2.5 tabular-nums ${col.align === 'right' ? 'text-right text-gray-900' : 'text-left text-gray-900'}`}
                >
                  {col.render ? col.render(row) : row[col.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

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
 * @param {boolean} [isInventoryAccount]
 */
export default function ReconciliationModal({
  open,
  onClose,
  accountId,
  accountName = '',
  currency = 'USD',
  defaultStartDate = '',
  defaultEndDate = '',
  isInventoryAccount = false,
}) {
  const fileInputRef = useRef(null)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [serviceName, setServiceName] = useState(INVENTORY_SERVICE_OPTIONS[0].value)
  const [imageFiles, setImageFiles] = useState([])
  const [imagePreviews, setImagePreviews] = useState([])
  const [dragActive, setDragActive] = useState(false)
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [inventoryTab, setInventoryTab] = useState('new')
  const [savedAudits, setSavedAudits] = useState([])
  const [savedLoading, setSavedLoading] = useState(false)
  const [savedError, setSavedError] = useState('')
  const [historyDateFrom, setHistoryDateFrom] = useState('')
  const [historyDateTo, setHistoryDateTo] = useState('')
  const [saveLoading, setSaveLoading] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState('')

  useEffect(() => {
    if (!open) return
    setStartDate(defaultStartDate || monthStartIso())
    setEndDate(defaultEndDate || todayIsoDateEcuador())
    setServiceName(INVENTORY_SERVICE_OPTIONS[0].value)
    setImageFiles([])
    setImagePreviews([])
    setDragActive(false)
    setReport(null)
    setError('')
    setLoading(false)
    setInventoryTab('new')
    setSavedAudits([])
    setSavedLoading(false)
    setSavedError('')
    setHistoryDateFrom('')
    setHistoryDateTo('')
    setSaveLoading(false)
    setSaveSuccess('')
  }, [open, defaultStartDate, defaultEndDate, accountId, isInventoryAccount])

  useEffect(() => {
    return () => {
      imagePreviews.forEach((url) => {
        if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
      })
    }
  }, [imagePreviews])

  const revokePreviewUrls = useCallback((urls) => {
    urls.forEach((url) => {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
    })
  }, [])

  const addImages = useCallback(
    (fileList) => {
      if (!fileList?.length) return
      const validFiles = []
      const newPreviews = []
      let rejected = false

      for (const file of Array.from(fileList)) {
        if (!file.type.startsWith('image/')) {
          rejected = true
          continue
        }
        if (file.size > 12 * 1024 * 1024) {
          rejected = true
          continue
        }
        validFiles.push(file)
        newPreviews.push(URL.createObjectURL(file))
      }

      if (rejected && validFiles.length === 0) {
        setError('Selecciona imágenes JPG, PNG o WebP de hasta 12 MB cada una.')
        return
      }
      if (validFiles.length === 0) return

      if (rejected) {
        setError('Algunos archivos se omitieron por formato o tamaño no válido.')
      } else {
        setError('')
      }

      setImageFiles((prev) => [...prev, ...validFiles])
      setImagePreviews((prev) => [...prev, ...newPreviews])
    },
    [],
  )

  const clearImages = useCallback(() => {
    revokePreviewUrls(imagePreviews)
    setImageFiles([])
    setImagePreviews([])
  }, [imagePreviews, revokePreviewUrls])

  const handleFileInputChange = useCallback(
    (e) => {
      addImages(e.target.files)
      e.target.value = ''
    },
    [addImages],
  )

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault()
      setDragActive(false)
      addImages(e.dataTransfer.files)
    },
    [addImages],
  )

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

    if (isInventoryAccount) {
      if (!serviceName?.trim()) {
        setError('Selecciona el servicio a conciliar.')
        return
      }
      if (imageFiles.length === 0) {
        setError('Sube al menos una captura de pantalla de la plataforma IPTV.')
        return
      }
    }

    setLoading(true)
    setError('')
    try {
      if (isInventoryAccount) {
        const formData = new FormData()
        formData.append('start_date', startDate)
        formData.append('end_date', endDate)
        formData.append('service_name', serviceName.trim())
        for (const file of imageFiles) {
          formData.append('files', file)
        }
        const { data } = await api.post(
          `/api/v1/accounting/accounts/${accountId}/inventory-reconciliation`,
          formData,
        )
        setReport(data)
        if (data?.ai_read_success === false && data?.ai_error) {
          setError(data.ai_error)
        }
      } else {
        const { data } = await api.get(`/api/v1/accounting/accounts/${accountId}/reconciliation`, {
          params: { start_date: startDate, end_date: endDate },
        })
        setReport(data)
      }
    } catch (err) {
      setReport(null)
      setError(
        getApiErrorMessage(err, {
          fallback: isInventoryAccount
            ? 'No se pudo completar la auditoría de inventario.'
            : 'No se pudo generar el cuadre bancario.',
        }),
      )
    } finally {
      setLoading(false)
    }
  }, [accountId, startDate, endDate, isInventoryAccount, serviceName, imageFiles])

  const loadSavedAudits = useCallback(async () => {
    if (!accountId || accountId < 1) return
    setSavedLoading(true)
    setSavedError('')
    try {
      const params = { account_id: accountId }
      if (historyDateFrom) params.date_from = historyDateFrom
      if (historyDateTo) params.date_to = historyDateTo
      const { data } = await api.get('/api/v1/accounting/inventory-audits', { params })
      setSavedAudits(Array.isArray(data) ? data : [])
    } catch (err) {
      setSavedAudits([])
      setSavedError(getApiErrorMessage(err, { fallback: 'No se pudieron cargar las auditorías guardadas.' }))
    } finally {
      setSavedLoading(false)
    }
  }, [accountId, historyDateFrom, historyDateTo])

  useEffect(() => {
    if (!open || !isInventoryAccount || inventoryTab !== 'saved') return
    loadSavedAudits()
  }, [open, isInventoryAccount, inventoryTab, loadSavedAudits])

  const handleSaveAudit = useCallback(async () => {
    if (!isInventoryAccount || !report || report.summary || report.ai_read_success === false) return
    setSaveLoading(true)
    setSaveSuccess('')
    setError('')
    try {
      await api.post('/api/v1/accounting/inventory-audits', {
        account_id: accountId,
        service_name: report.service_name,
        start_date: report.start_date,
        end_date: report.end_date,
        matched_data: report.matched ?? [],
        missing_erp_data: report.missing_in_erp ?? [],
        missing_platform_data: report.missing_in_platform ?? [],
      })
      setSaveSuccess('Informe de auditoría guardado correctamente.')
    } catch (err) {
      setError(getApiErrorMessage(err, { fallback: 'No se pudo guardar el informe de auditoría.' }))
    } finally {
      setSaveLoading(false)
    }
  }, [accountId, report, isInventoryAccount])

  const handleExportSingleAuditExcel = useCallback(() => {
    if (!isInventoryAccount || !report || report.summary) return
    exportSingleInventoryAuditExcel({ audit: report, accountName })
  }, [report, accountName, isInventoryAccount])

  const handleExportSingleAuditPdf = useCallback(() => {
    if (!isInventoryAccount || !report || report.summary) return
    exportSingleInventoryAuditPDF({ audit: report, accountName })
  }, [report, accountName, isInventoryAccount])

  const handleExportConsolidatedExcel = useCallback(() => {
    exportConsolidatedInventoryExcel({ audits: savedAudits, accountName })
  }, [savedAudits, accountName])

  const handleExportConsolidatedPdf = useCallback(() => {
    exportConsolidatedInventoryPDF({ audits: savedAudits, accountName })
  }, [savedAudits, accountName])

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
  const inventoryReport = isInventoryAccount && report && !report.summary ? report : null
  const inventoryColumns = [
    { key: 'username', label: 'Usuario / nombre' },
    {
      key: 'credits_platform',
      label: 'Plataforma',
      align: 'right',
      render: (row) => (row.credits_platform != null ? row.credits_platform : '—'),
    },
    {
      key: 'credits_erp',
      label: 'ERP',
      align: 'right',
      render: (row) => (row.credits_erp != null ? row.credits_erp : '—'),
    },
    {
      key: 'credits',
      label: 'Créditos',
      align: 'right',
      render: (row) => row.credits ?? '—',
    },
  ]

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
                {isInventoryAccount ? 'Auditoría de inventario (IA)' : 'Conciliación bancaria'}
              </h2>
              <p className="text-xs text-emerald-900/80 mt-0.5 truncate">
                {accountName ? `${accountName} · ` : ''}
                {isInventoryAccount ? 'Cuadre de créditos con captura IPTV' : 'Cuadre por rango de fechas'}
              </p>
            </div>
          </div>
          <button type="button" className="p-1.5 rounded-lg text-gray-400 hover:bg-white/80 shrink-0" onClick={onClose} aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>

        {isInventoryAccount ? (
          <div className="flex gap-1 px-5 pt-3 shrink-0 border-b border-gray-100 bg-white">
            <button
              type="button"
              onClick={() => setInventoryTab('new')}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                inventoryTab === 'new'
                  ? 'border-emerald-600 text-emerald-800 bg-emerald-50/60'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Nueva auditoría
            </button>
            <button
              type="button"
              onClick={() => setInventoryTab('saved')}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                inventoryTab === 'saved'
                  ? 'border-blue-600 text-blue-800 bg-blue-50/60'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Auditorías guardadas
            </button>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {isInventoryAccount && inventoryTab === 'saved' ? (
            <>
              <div className="rounded-xl border border-gray-200 bg-slate-50/60 p-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto] gap-3 items-end">
                  <div>
                    <label htmlFor="history-from" className="block text-xs font-medium text-gray-600 mb-1">
                      Fecha guardado desde
                    </label>
                    <input
                      id="history-from"
                      type="date"
                      value={historyDateFrom}
                      onChange={(e) => setHistoryDateFrom(e.target.value)}
                      disabled={savedLoading}
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label htmlFor="history-to" className="block text-xs font-medium text-gray-600 mb-1">
                      Fecha guardado hasta
                    </label>
                    <input
                      id="history-to"
                      type="date"
                      value={historyDateTo}
                      onChange={(e) => setHistoryDateTo(e.target.value)}
                      disabled={savedLoading}
                      className={inputCls}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={loadSavedAudits}
                    disabled={savedLoading}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 h-10"
                  >
                    {savedLoading ? <Loader2 size={16} className="animate-spin shrink-0" aria-hidden /> : null}
                    Actualizar lista
                  </button>
                </div>
                {savedError ? (
                  <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{savedError}</p>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={handleExportConsolidatedExcel}
                  disabled={savedAudits.length === 0 || savedLoading}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-emerald-800 bg-emerald-50 ring-1 ring-emerald-200 hover:bg-emerald-100 disabled:opacity-40 transition-colors"
                >
                  <FileSpreadsheet size={16} aria-hidden />
                  Exportar consolidado Excel
                </button>
                <button
                  type="button"
                  onClick={handleExportConsolidatedPdf}
                  disabled={savedAudits.length === 0 || savedLoading}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-rose-800 bg-rose-50 ring-1 ring-rose-200 hover:bg-rose-100 disabled:opacity-40 transition-colors"
                >
                  <FileText size={16} aria-hidden />
                  Exportar consolidado PDF
                </button>
              </div>

              {savedLoading ? (
                <p className="text-sm text-gray-500 text-center py-8 flex items-center justify-center gap-2">
                  <Loader2 size={16} className="animate-spin" aria-hidden />
                  Cargando auditorías…
                </p>
              ) : savedAudits.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-8">
                  No hay auditorías guardadas{historyDateFrom || historyDateTo ? ' en este rango' : ''}.
                </p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-gray-200">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-slate-50/80">
                        <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                          Fecha auditoría
                        </th>
                        <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                          Servicio
                        </th>
                        <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                          Rango de fechas
                        </th>
                        <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                          Cuadran
                        </th>
                        <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                          Faltan ERP
                        </th>
                        <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                          Faltan plat.
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {savedAudits.map((audit) => (
                        <tr key={audit.id} className="hover:bg-slate-50/50">
                          <td className="px-3 py-2.5 whitespace-nowrap text-gray-900">
                            {formatAuditCreatedAt(audit.created_at)}
                          </td>
                          <td className="px-3 py-2.5 font-medium text-gray-900">{audit.service_name}</td>
                          <td className="px-3 py-2.5 text-gray-700 tabular-nums">
                            {audit.start_date} → {audit.end_date}
                          </td>
                          <td className="px-3 py-2.5 text-center tabular-nums text-emerald-700">
                            {(audit.matched_data || []).length}
                          </td>
                          <td className="px-3 py-2.5 text-center tabular-nums text-red-700">
                            {(audit.missing_erp_data || []).length}
                          </td>
                          <td className="px-3 py-2.5 text-center tabular-nums text-amber-700">
                            {(audit.missing_platform_data || []).length}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <>
          <div className="rounded-xl border border-gray-200 bg-slate-50/60 p-4">
            <div
              className={`grid grid-cols-1 gap-3 items-end ${isInventoryAccount ? 'sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto]' : 'sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto]'}`}
            >
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
              {isInventoryAccount ? (
                <div>
                  <label htmlFor="recon-service" className="block text-xs font-medium text-gray-600 mb-1">
                    Servicio
                  </label>
                  <select
                    id="recon-service"
                    value={serviceName}
                    onChange={(e) => setServiceName(e.target.value)}
                    disabled={loading}
                    className={inputCls}
                  >
                    {INVENTORY_SERVICE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <button
                type="button"
                onClick={generateReport}
                disabled={loading}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 h-10"
              >
                {loading ? <Loader2 size={16} className="animate-spin shrink-0" aria-hidden /> : null}
                {isInventoryAccount ? 'Generar auditoría' : 'Generar cuadre'}
              </button>
            </div>

            {isInventoryAccount ? (
              <div className="mt-4">
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Captura de la plataforma IPTV
                </label>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="sr-only"
                  onChange={handleFileInputChange}
                  disabled={loading}
                />
                <div
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click()
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragActive(true)
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 cursor-pointer transition-colors ${
                    dragActive
                      ? 'border-emerald-500 bg-emerald-50/80'
                      : 'border-gray-300 bg-white hover:border-emerald-400 hover:bg-emerald-50/30'
                  }`}
                >
                  {imagePreviews.length > 0 ? (
                    <div className="flex flex-col items-center gap-2 w-full">
                      <div className="flex flex-wrap justify-center gap-2 max-h-32 overflow-y-auto w-full">
                        {imagePreviews.map((src, idx) => (
                          <img
                            key={`${src}-${idx}`}
                            src={src}
                            alt={`Vista previa ${idx + 1}`}
                            className="h-16 w-16 rounded-lg object-cover shadow-sm border border-gray-200"
                          />
                        ))}
                      </div>
                      <p className="text-sm font-medium text-emerald-800">
                        {imageFiles.length} {imageFiles.length === 1 ? 'imagen seleccionada' : 'imágenes seleccionadas'}
                      </p>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          clearImages()
                        }}
                        className="text-xs text-gray-500 hover:text-red-600 underline"
                      >
                        Quitar todas
                      </button>
                    </div>
                  ) : (
                    <>
                      <ImagePlus size={28} className="text-emerald-600" aria-hidden />
                      <p className="text-sm text-gray-700 text-center">
                        Arrastra una o varias imágenes aquí o haz clic para seleccionar
                      </p>
                      <p className="text-xs text-gray-500">JPG, PNG o WebP · máx. 12 MB por imagen</p>
                    </>
                  )}
                </div>
              </div>
            ) : null}

            {error ? (
              <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>
            ) : null}
          </div>

          {inventoryReport ? (
            <>
              {inventoryReport.ai_read_success === false ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                  <p className="font-semibold">No se pudo leer la imagen con IA</p>
                  <p className="mt-1">{inventoryReport.ai_error || 'Intenta con una captura más nítida o recorta solo la tabla.'}</p>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-4 text-xs text-gray-500 px-1">
                    <span>
                      Servicio: <strong className="text-gray-700">{inventoryReport.service_name}</strong>
                    </span>
                    <span>
                      Periodo: {inventoryReport.start_date} → {inventoryReport.end_date}
                    </span>
                    <span>
                      Filas leídas:{' '}
                      <strong className="text-gray-700 tabular-nums">{inventoryReport.platform_rows_extracted ?? 0}</strong>
                    </span>
                  </div>

                  <div className="space-y-2">
                    {saveSuccess ? (
                      <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                        {saveSuccess}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSaveAudit}
                        disabled={saveLoading || loading}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-40 transition-colors"
                      >
                        {saveLoading ? <Loader2 size={16} className="animate-spin shrink-0" aria-hidden /> : null}
                        💾 Guardar Auditoría
                      </button>
                      <button
                        type="button"
                        onClick={handleExportSingleAuditExcel}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-emerald-800 bg-emerald-50 ring-1 ring-emerald-200 hover:bg-emerald-100 transition-colors"
                      >
                        <FileSpreadsheet size={16} aria-hidden />
                        📊 Exportar Excel
                      </button>
                      <button
                        type="button"
                        onClick={handleExportSingleAuditPdf}
                        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-rose-800 bg-rose-50 ring-1 ring-rose-200 hover:bg-rose-100 transition-colors"
                      >
                        <FileText size={16} aria-hidden />
                        📄 Exportar PDF
                      </button>
                    </div>
                  </div>

                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold text-emerald-800 flex items-center gap-2">
                      <span aria-hidden>✅</span> Cuadran perfectamente
                      <span className="text-xs font-normal text-gray-500">({inventoryReport.matched?.length ?? 0})</span>
                    </h3>
                    <InventoryCreditTable
                      rows={inventoryReport.matched}
                      columns={inventoryColumns}
                      emptyMessage="Ningún usuario coincide exactamente entre plataforma y ERP."
                    />
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold text-red-800 flex items-center gap-2">
                      <span aria-hidden>⚠️</span> Faltan en el sistema
                      <span className="text-xs font-normal text-gray-500">({inventoryReport.missing_in_erp?.length ?? 0})</span>
                    </h3>
                    <p className="text-xs text-red-700/90">Consumos que la IA leyó en la foto pero no están facturados en el ERP.</p>
                    <div className="rounded-xl border-red-200">
                      <InventoryCreditTable
                        rows={inventoryReport.missing_in_erp}
                        columns={inventoryColumns}
                        emptyMessage="No hay consumos pendientes de facturar según la captura."
                      />
                    </div>
                  </section>

                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold text-amber-800 flex items-center gap-2">
                      <span aria-hidden>❓</span> Faltan en plataforma
                      <span className="text-xs font-normal text-gray-500">({inventoryReport.missing_in_platform?.length ?? 0})</span>
                    </h3>
                    <p className="text-xs text-amber-800/90">Créditos cobrados en el ERP que la IA no encontró en la captura.</p>
                    <div className="rounded-xl border-amber-200">
                      <InventoryCreditTable
                        rows={inventoryReport.missing_in_platform}
                        columns={inventoryColumns}
                        emptyMessage="Todos los cobros del ERP aparecen reflejados en la captura."
                      />
                    </div>
                  </section>
                </>
              )}
            </>
          ) : summary ? (
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
                {isInventoryAccount
                  ? 'Indica fechas, servicio y sube la captura IPTV para ejecutar la auditoría.'
                  : 'Selecciona un rango de fechas y pulsa «Generar cuadre» para ver el reporte.'}
              </p>
            )
          )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
