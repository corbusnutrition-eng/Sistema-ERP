import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  ChevronDown,
  ChevronRight,
  Download,
  Filter,
  Loader2,
  CheckSquare,
  Eye,
} from 'lucide-react'
import api from '../../api/axios'
import { useModal } from '../../context/ModalContext'
import { formatSaleDocNo, formatSaleLedgerDateParts } from '../sales/saleTableHelpers'
import { toDatetimeLocalEcuador } from '../../utils/datetime'
import RefundModal from './components/RefundModal'
import SearchableSelect from '../../components/ui/SearchableSelect'
import { normalizeCurrencyCode } from '../../lib/currencyCode'

const API_ORIGIN = String(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

/** Texto de opción estilo registro QuickBooks: "Nombre - número - MON". */
function ledgerAccountDisplayLabel(account) {
  if (!account) return ''
  const name = String(account.name ?? '').trim() || '—'
  const numRaw = String(account.account_number ?? '').trim()
  const num = numRaw || '—'
  const cur = normalizeCurrencyCode(account.currency ?? 'USD', 'USD')
  return `${name} - ${num} - ${cur}`
}

function lineCargoAmount(line) {
  const v = line.charge_amount ?? line.deposit
  return v != null && v !== '' ? v : null
}

function linePagoAmount(line) {
  const v = line.payment_amount ?? line.payment
  return v != null && v !== '' ? v : null
}

/** Columnas registro banco / efectivo (orden = celdas). */
const CASH_LEDGER_COLUMN_CONFIG = [
  { id: 'date', label: 'FECHA', defaultWidth: 108, minWidth: 92, maxWidth: 220 },
  { id: 'ref', label: 'N.º REFERENCIA', defaultWidth: 100, minWidth: 72, maxWidth: 160 },
  { id: 'payee', label: 'BENEFICIARIO / CLIENTE', defaultWidth: 200, minWidth: 140, maxWidth: 380 },
  { id: 'iptv_user', label: 'USUARIO IPTV', defaultWidth: 120, minWidth: 96, maxWidth: 200 },
  { id: 'notes', label: 'NOTAS', defaultWidth: 168, minWidth: 100, maxWidth: 400 },
  { id: 'deposit', label: 'DEPÓSITO', defaultWidth: 124, minWidth: 96, maxWidth: 220 },
  { id: 'payment', label: 'PAGO', defaultWidth: 124, minWidth: 96, maxWidth: 220 },
  { id: 'balance', label: 'SALDO', defaultWidth: 136, minWidth: 104, maxWidth: 260 },
  { id: 'receipt', label: 'COMPROBANTE', defaultWidth: 112, minWidth: 96, maxWidth: 150, alignHeader: 'right' },
]

/** Estilo registro Cuentas por cobrar (QuickBooks). */
const AR_LEDGER_COLUMN_CONFIG = [
  { id: 'date', label: 'FECHA', defaultWidth: 108, minWidth: 92, maxWidth: 220 },
  { id: 'ref_type', label: 'N.º REFERENCIA / TIPO', defaultWidth: 132, minWidth: 104, maxWidth: 220 },
  { id: 'beneficiary_notes', label: 'BENEFICIARIO / NOTAS', defaultWidth: 260, minWidth: 160, maxWidth: 480 },
  { id: 'cargo', label: 'CARGO / CRÉDITO', defaultWidth: 132, minWidth: 100, maxWidth: 240 },
  { id: 'pago', label: 'PAGO', defaultWidth: 124, minWidth: 96, maxWidth: 220 },
  { id: 'balance', label: 'SALDO', defaultWidth: 136, minWidth: 104, maxWidth: 260 },
  { id: 'receipt', label: 'COMPROBANTE', defaultWidth: 112, minWidth: 96, maxWidth: 150, alignHeader: 'right' },
]

const ITEMS_PER_PAGE = 10

function ResizableLedgerTh({ column, width, onColumnResize, children }) {
  const { id, minWidth, maxWidth } = column
  const headerJustify = column.alignHeader === 'right' ? 'justify-end' : ''

  const onResizeStart = useCallback(
    (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startW = width
      const move = (ev) => {
        const dx = ev.clientX - startX
        const next = Math.min(maxWidth, Math.max(minWidth, startW + dx))
        onColumnResize(id, next)
      }
      const up = () => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    },
    [id, width, minWidth, maxWidth, onColumnResize],
  )

  return (
    <th
      scope="col"
      style={{ width, minWidth }}
      className="relative border-b border-gray-200 bg-slate-50 text-left align-middle"
    >
      <div className={`pointer-events-none flex items-center px-3 py-3 pr-2 min-w-0 ${headerJustify}`}>
        <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider truncate">{children}</span>
      </div>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Redimensionar columna ${column.label}`}
        title="Arrastrar para cambiar ancho"
        className="absolute top-0 bottom-0 right-0 z-[25] w-3 cursor-col-resize border-0 bg-transparent p-0 hover:bg-blue-400/15 active:bg-blue-500/25"
        onMouseDown={onResizeStart}
      />
    </th>
  )
}

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

function ledgerReferenceDisplay(line) {
  if (line.reference_number || line.reference) return line.reference_number || line.reference
  if (line.sale_id != null && line.sale_id !== '') return formatSaleDocNo(line.sale_id)
  return ''
}

function csvDateTimeCell(iso) {
  const { dateLine, timeLine } = formatSaleLedgerDateParts(iso)
  return timeLine ? `${dateLine} · ${timeLine}` : dateLine
}

function receiptAbsoluteUrl(path) {
  if (path == null || path === '') return null
  const p = String(path).trim()
  if (!p) return null
  if (p.startsWith('http://') || p.startsWith('https://')) return p
  return `${API_ORIGIN}${p.startsWith('/') ? p : `/${p}`}`
}

function ledgerReceiptIsPdf(urlPath) {
  if (!urlPath) return false
  return String(urlPath).toLowerCase().split('?')[0].endsWith('.pdf')
}

const inputCls =
  'w-full px-2.5 py-1.5 text-sm border border-gray-200 rounded-lg text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500'

export default function AccountHistoryPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { openNewSale, openTransferModal } = useModal()
  const accountId = Number(id)

  const addTxnMenuRef = useRef(null)

  const qpStartDate = searchParams.get('start_date') || ''
  const qpEndDate = searchParams.get('end_date') || ''
  const qpAccountId = searchParams.get('account_id') || ''

  const [accounts, setAccounts] = useState([])
  const [meta, setMeta] = useState(null)
  const [lines, setLines] = useState([])
  const [clients, setClients] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [filterOpen, setFilterOpen] = useState(false)
  const [dateFrom, setDateFrom] = useState(() => searchParams.get('start_date') || '')
  const [dateTo, setDateTo] = useState(() => searchParams.get('end_date') || '')
  const [pendingDateFrom, setPendingDateFrom] = useState(() => searchParams.get('start_date') || '')
  const [pendingDateTo, setPendingDateTo] = useState(() => searchParams.get('end_date') || '')
  const [filterUser, setFilterUser] = useState('')
  const [filterReference, setFilterReference] = useState('')

  const [colWidths, setColWidths] = useState(() =>
    Object.fromEntries(CASH_LEDGER_COLUMN_CONFIG.map((c) => [c.id, c.defaultWidth])),
  )

  const [expandedSaleId, setExpandedSaleId] = useState(null)
  const [editDraft, setEditDraft] = useState(null)
  const [saveLoading, setSaveLoading] = useState(false)

  const [addTxnMenuOpen, setAddTxnMenuOpen] = useState(false)
  const [refundModalOpen, setRefundModalOpen] = useState(false)

  const [currentPage, setCurrentPage] = useState(1)

  const onColumnResize = useCallback((columnId, nextWidth) => {
    setColWidths((prev) => ({ ...prev, [columnId]: nextWidth }))
  }, [])

  const loadAccounts = useCallback(async () => {
    try {
      const { data } = await api.get('/api/v1/accounts/', { params: { include_inactive: true } })
      setAccounts(Array.isArray(data) ? data : [])
    } catch {
      setAccounts([])
    }
  }, [])

  const loadClients = useCallback(async () => {
    try {
      const { data } = await api.get('/api/v1/clients/', { params: { skip: 0, limit: 500 } })
      setClients(Array.isArray(data) ? data : [])
    } catch {
      setClients([])
    }
  }, [])

  const loadHistory = useCallback(async () => {
    if (!accountId || Number.isNaN(accountId)) return
    setLoading(true)
    setError('')
    try {
      const params = {}
      if (pendingDateFrom) params.date_from = pendingDateFrom
      if (pendingDateTo) params.date_to = pendingDateTo
      const { data } = await api.get(`/api/v1/accounts/${accountId}/ledger`, { params })
      setMeta(data)
      setLines(Array.isArray(data?.lines) ? data.lines : [])
    } catch (err) {
      setMeta(null)
      setLines([])
      const d = err?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'No se pudo cargar el historial.')
    } finally {
      setLoading(false)
    }
  }, [accountId, pendingDateFrom, pendingDateTo])

  useEffect(() => {
    loadAccounts()
    loadClients()
  }, [loadAccounts, loadClients])

  useEffect(() => {
    if (qpAccountId) {
      const n = Number(qpAccountId)
      if (Number.isFinite(n) && n >= 1 && n !== accountId) {
        navigate(`/contabilidad/cuenta/${n}?${searchParams.toString()}`, { replace: true })
        return
      }
    }

    if (qpStartDate || qpEndDate) {
      setDateFrom(qpStartDate)
      setDateTo(qpEndDate)
      setPendingDateFrom(qpStartDate)
      setPendingDateTo(qpEndDate)
    }
  }, [accountId, qpAccountId, qpStartDate, qpEndDate, navigate, searchParams])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  useEffect(() => {
    setExpandedSaleId(null)
    setEditDraft(null)
    setAddTxnMenuOpen(false)
  }, [accountId])

  useEffect(() => {
    if (!addTxnMenuOpen) return undefined
    function onDocMouseDown(ev) {
      const root = addTxnMenuRef.current
      if (!root || root.contains(ev.target)) return
      setAddTxnMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [addTxnMenuOpen])

  const currency = meta?.currency || 'USD'
  const ledgerMode = meta?.ledger_display_mode === 'ar_register' ? 'ar_register' : 'cash_register'
  const columnConfig = ledgerMode === 'ar_register' ? AR_LEDGER_COLUMN_CONFIG : CASH_LEDGER_COLUMN_CONFIG
  const colCount = columnConfig.length

  useEffect(() => {
    const cfg = ledgerMode === 'ar_register' ? AR_LEDGER_COLUMN_CONFIG : CASH_LEDGER_COLUMN_CONFIG
    setColWidths(Object.fromEntries(cfg.map((c) => [c.id, c.defaultWidth])))
  }, [accountId, ledgerMode])

  const filteredWithRunning = useMemo(() => {
    let rows = [...lines]
    const uq = filterUser.trim().toLowerCase()
    const rq = filterReference.trim().toLowerCase()
    if (uq) {
      rows = rows.filter((r) => String(r.iptv_username ?? '').toLowerCase().includes(uq))
    }
    if (rq) {
      rows = rows.filter((r) => {
        const refHay = `${r.reference_number ?? ''} ${r.reference ?? ''} ${ledgerReferenceDisplay(r)}`
          .trim()
          .toLowerCase()
        return refHay.includes(rq)
      })
    }
    const ob = Number(meta?.opening_balance ?? 0)
    let run = ob
    return rows.map((r) => {
      let delta = 0
      if (r.balance_effect != null && r.balance_effect !== '') {
        delta = Number(r.balance_effect)
      } else {
        const dep = r.deposit != null ? Number(r.deposit) : 0
        const pay = r.payment != null ? Number(r.payment) : 0
        delta = dep - pay
      }
      run += delta
      return { ...r, displayRunning: run }
    })
  }, [lines, filterUser, filterReference, meta])

  const filteredTransactions = filteredWithRunning

  const totalPages = Math.ceil(filteredTransactions.length / ITEMS_PER_PAGE)

  const paginatedData = filteredTransactions.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE,
  )

  useEffect(() => {
    setCurrentPage(1)
  }, [accountId, pendingDateFrom, pendingDateTo, filterUser, filterReference])

  useEffect(() => {
    const n = filteredTransactions.length
    const tp = Math.ceil(n / ITEMS_PER_PAGE)
    if (tp === 0 && currentPage !== 1) setCurrentPage(1)
    else if (tp > 0 && currentPage > tp) setCurrentPage(tp)
  }, [filteredTransactions.length, currentPage])

  useEffect(() => {
    setExpandedSaleId(null)
    setEditDraft(null)
  }, [currentPage])

  const closingDisplayed =
    filteredWithRunning.length > 0
      ? filteredWithRunning[filteredWithRunning.length - 1].displayRunning
      : Number(meta?.opening_balance ?? 0)

  function openRow(line) {
    if (expandedSaleId === line.sale_id) {
      closeRow()
      return
    }
    setExpandedSaleId(line.sale_id)
    const la =
      line.local_amount != null && line.local_amount !== ''
        ? String(line.local_amount)
        : ''
    const apRaw =
      line.amount_paid != null && line.amount_paid !== ''
        ? String(line.amount_paid)
        : la
    setEditDraft({
      occurred_at: toDatetimeLocalEcuador(line.occurred_at),
      reference_number: ledgerReferenceDisplay(line),
      client_id: String(line.client_id),
      notes: line.notes ?? '',
      local_amount: la,
      amount_paid: apRaw,
      exchange_rate: String(line.exchange_rate ?? 1),
      currency: normalizeCurrencyCode(line.transaction_currency || currency, 'USD'),
      deposit_account_id:
        line.deposit_account_id != null ? String(line.deposit_account_id) : String(accountId),
    })
  }

  function closeRow() {
    setExpandedSaleId(null)
    setEditDraft(null)
  }

  async function saveEdit() {
    if (!expandedSaleId || !editDraft) return
    setSaveLoading(true)
    try {
      const er = Number.parseFloat(String(editDraft.exchange_rate).replace(',', '.'))
      const la = Number.parseFloat(String(editDraft.local_amount).replace(',', '.'))
      const ap = Number.parseFloat(String(editDraft.amount_paid).replace(',', '.'))
      if (!Number.isFinite(er) || er <= 0) {
        window.alert('La tasa de cambio debe ser mayor que 0.')
        return
      }
      if (!Number.isFinite(la) || la <= 0) {
        window.alert('El importe total cobrado debe ser mayor que 0.')
        return
      }
      if (!Number.isFinite(ap) || ap < 0) {
        window.alert('El monto pagado (depósito) debe ser un número válido ≥ 0.')
        return
      }
      if (ap > la + 1e-9) {
        window.alert('El monto pagado no puede superar el importe total cobrado.')
        return
      }
      const iso = new Date(editDraft.occurred_at).toISOString()
      let depFk = Number(editDraft.deposit_account_id)
      if (!Number.isFinite(depFk) || depFk < 1) {
        depFk = accountId
      }
      await api.patch(`/api/v1/sales/${expandedSaleId}`, {
        client_id: Number(editDraft.client_id),
        notes: editDraft.notes.trim() || null,
        currency: normalizeCurrencyCode(editDraft.currency.trim(), 'USD'),
        exchange_rate: er,
        local_amount: la,
        amount_paid: ap,
        deposit_account_id: depFk,
        created_at: iso,
      })
      closeRow()
      await loadHistory()
    } catch (err) {
      const d = err?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo guardar el movimiento.')
    } finally {
      setSaveLoading(false)
    }
  }

  async function deleteMovement() {
    if (!expandedSaleId) return
    if (
      !window.confirm(
        '¿Anular esta venta? Se revertirá el inventario asociado y dejará de figurar como activada.',
      )
    ) {
      return
    }
    setSaveLoading(true)
    try {
      await api.put(`/api/v1/sales/${expandedSaleId}/status`, { status: 'annulled' })
      closeRow()
      await loadHistory()
    } catch (err) {
      const d = err?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo anular.')
    } finally {
      setSaveLoading(false)
    }
  }

  const ledgerAccountSelectOptions = useMemo(
    () =>
      accounts.map((a) => ({
        value: String(a.id),
        label: ledgerAccountDisplayLabel(a),
      })),
    [accounts],
  )

  const editSaleClientSelectOptions = useMemo(
    () =>
      clients.map((c) => ({
        value: String(c.id),
        label:
          (c.name?.trim() || c.username || c.email || '').trim() || `Cliente #${c.id}`,
      })),
    [clients],
  )

  function applyFilters() {
    setPendingDateFrom(dateFrom)
    setPendingDateTo(dateTo)
    setFilterOpen(false)
  }

  function exportCsv() {
    const rows = filteredWithRunning
    const ar = ledgerMode === 'ar_register'
    const headers = ar
      ? [
          'FECHA',
          'REFERENCIA',
          'TIPO_LINEA',
          'BENEFICIARIO',
          'NOTAS',
          'IPTV_USUARIO',
          'CARGO_CREDITO',
          'PAGO',
          'SALDO',
          'COMPROBANTE',
        ]
      : [
          'FECHA',
          'REFERENCIA',
          'CLIENTE',
          'MOTIVO',
          'USUARIO_IPTV',
          'NOTAS',
          'DEPOSITO',
          'PAGO',
          'SALDO',
          'COMPROBANTE',
        ]
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const linesCsv = [
      headers.join(','),
      ...rows.map((r) => {
        const cargo = lineCargoAmount(r)
        const pago = linePagoAmount(r)
        if (ar) {
          return [
            escape(csvDateTimeCell(r.occurred_at)),
            escape(ledgerReferenceDisplay(r)),
            escape(r.line_kind ?? r.transaction_reason ?? ''),
            escape(r.client_name),
            escape(r.notes),
            escape(r.iptv_username ?? ''),
            escape(cargo != null ? Number(cargo).toFixed(4) : ''),
            escape(pago != null ? Number(pago).toFixed(4) : ''),
            escape(r.displayRunning.toFixed(4)),
            escape(r.receipt_url ? receiptAbsoluteUrl(r.receipt_url) : ''),
          ].join(',')
        }
        return [
          escape(csvDateTimeCell(r.occurred_at)),
          escape(ledgerReferenceDisplay(r)),
          escape(r.client_name),
          escape(r.transaction_reason ?? ''),
          escape(r.iptv_username ?? ''),
          escape(r.notes),
          escape(cargo != null ? Number(cargo).toFixed(4) : ''),
          escape(pago != null ? Number(pago).toFixed(4) : ''),
          escape(r.displayRunning.toFixed(4)),
          escape(r.receipt_url ? receiptAbsoluteUrl(r.receipt_url) : ''),
        ].join(',')
      }),
    ].join('\n')
    const bom = '\ufeff'
    const blob = new Blob([bom + linesCsv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `historial-cuenta-${accountId}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const selectedAccount = accounts.find((a) => Number(a.id) === accountId)

  return (
    <div className="min-h-screen bg-slate-50/80 pb-10">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 pt-5 space-y-4">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Link to="/contabilidad/plan-de-cuentas" className="text-blue-600 hover:text-blue-800 font-medium">
            Plan de cuentas
          </Link>
          <ChevronRight size={12} className="text-gray-300 shrink-0" />
          <span className="text-gray-700 font-medium truncate">Historial / Libro mayor</span>
        </div>

        {/* Cabecera estilo registro bancario */}
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 bg-white rounded-2xl ring-1 ring-gray-200 shadow-sm p-5 sm:p-6">
          <div className="min-w-0 flex-1 space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Cuenta seleccionada</p>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="w-full sm:max-w-xl min-w-0">
                <SearchableSelect
                  value={Number.isFinite(accountId) && accountId >= 1 ? String(accountId) : ''}
                  onChange={(v) => {
                    const n = Number(v)
                    if (Number.isFinite(n) && n >= 1) navigate(`/contabilidad/cuenta/${n}`)
                  }}
                  options={ledgerAccountSelectOptions}
                  placeholder={accounts.length ? 'Buscar cuenta…' : 'Cargando cuentas…'}
                  hideClear
                  disabled={!accounts.length}
                  minPanelWidth={320}
                />
              </div>
            </div>
            {selectedAccount && (
              <p className="text-sm text-gray-500">
                {selectedAccount.detail_type || selectedAccount.account_type}
                {selectedAccount.account_number ? ` · N.º ${selectedAccount.account_number}` : ''}
              </p>
            )}
          </div>

          <div className="flex flex-col items-stretch sm:items-end gap-3 shrink-0">
            <div className="text-right">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Saldo final (vista)</p>
              <p className="text-3xl sm:text-4xl font-bold text-gray-900 tabular-nums tracking-tight">
                {formatMoney(closingDisplayed, currency)}
              </p>
              {meta && (filterUser.trim() !== '' || filterReference.trim() !== '') && (
                <p className="text-xs text-gray-400 mt-1">
                  Total cuenta: {formatMoney(Number(meta.closing_balance ?? 0), currency)}
                </p>
              )}
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => window.alert('Conciliar: próximamente.')}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 shadow-sm transition-colors"
              >
                <CheckSquare size={16} />
                Conciliar
              </button>
              <button
                type="button"
                onClick={exportCsv}
                disabled={filteredWithRunning.length === 0}
                title="Exportar a Excel (CSV)"
                className="inline-flex items-center justify-center p-2.5 rounded-xl border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40 transition-colors"
              >
                <Download size={18} />
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setFilterOpen((o) => !o)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 bg-white text-gray-800 hover:bg-gray-50 transition-colors"
                >
                  <Filter size={16} />
                  Filtros
                  <ChevronDown size={14} className={`transition ${filterOpen ? 'rotate-180' : ''}`} />
                </button>
                {filterOpen && (
                  <div className="absolute right-0 mt-2 w-80 rounded-xl border border-gray-200 bg-white shadow-xl z-40 p-4 space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Desde</label>
                      <input
                        type="date"
                        value={dateFrom}
                        onChange={(e) => setDateFrom(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Hasta</label>
                      <input
                        type="date"
                        value={dateTo}
                        onChange={(e) => setDateTo(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Usuario</label>
                      <input
                        type="text"
                        value={filterUser}
                        onChange={(e) => setFilterUser(e.target.value)}
                        placeholder="Buscar por usuario…"
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Referencia</label>
                      <input
                        type="text"
                        value={filterReference}
                        onChange={(e) => setFilterReference(e.target.value)}
                        placeholder="Ej. 0037, TRX…"
                        className={inputCls}
                      />
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={applyFilters}
                        className="flex-1 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700"
                      >
                        Aplicar
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setDateFrom('')
                          setDateTo('')
                          setFilterUser('')
                          setFilterReference('')
                          setPendingDateFrom('')
                          setPendingDateTo('')
                          setFilterOpen(false)
                        }}
                        className="px-3 py-2 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50"
                      >
                        Limpiar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 text-red-800 text-sm px-4 py-3">{error}</div>
        )}

        <div className="bg-white rounded-2xl ring-1 ring-gray-200 shadow-sm overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-100 bg-slate-50/60">
            <div ref={addTxnMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setAddTxnMenuOpen((o) => !o)}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-slate-800 hover:bg-slate-900 shadow-sm transition-colors"
              >
                Agregar transacción
                <ChevronDown size={16} className={`transition shrink-0 ${addTxnMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {addTxnMenuOpen && (
                <div className="absolute left-0 top-full mt-1 w-56 rounded-xl border border-gray-200 bg-white shadow-xl z-30 py-1">
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2.5 text-sm text-gray-800 hover:bg-slate-50"
                    onClick={() => {
                      setAddTxnMenuOpen(false)
                      openNewSale(() => loadHistory(), { depositAccountId: accountId })
                    }}
                  >
                    📄 Recibo de venta
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2.5 text-sm text-gray-800 hover:bg-slate-50"
                    onClick={() => {
                      setAddTxnMenuOpen(false)
                      openTransferModal({
                        defaultSourceAccountId: accountId,
                        afterSave: () => {
                          loadHistory()
                          loadAccounts()
                        },
                      })
                    }}
                  >
                    🔄 Transferir
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2.5 text-sm text-gray-800 hover:bg-slate-50"
                    onClick={() => {
                      setAddTxnMenuOpen(false)
                      setRefundModalOpen(true)
                    }}
                  >
                    ↩️ Reembolso
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm table-fixed border-collapse">
              <thead>
                <tr>
                  {columnConfig.map((col) => (
                    <ResizableLedgerTh
                      key={col.id}
                      column={col}
                      width={colWidths[col.id] ?? col.defaultWidth}
                      onColumnResize={onColumnResize}
                    >
                      {col.label}
                    </ResizableLedgerTh>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading && (
                  <tr>
                    <td colSpan={colCount} className="px-6 py-16 text-center text-gray-500">
                      <div className="inline-flex items-center gap-2">
                        <Loader2 size={18} className="animate-spin text-blue-600" />
                        Cargando movimientos…
                      </div>
                    </td>
                  </tr>
                )}
                {!loading && filteredWithRunning.length === 0 && (
                  <tr>
                    <td colSpan={colCount} className="px-6 py-14 text-center text-gray-400">
                      No hay movimientos en este periodo.
                    </td>
                  </tr>
                )}
                {!loading &&
                  paginatedData.map((line) => {
                    const isSaleRow = line.sale_id != null && line.sale_id !== ''
                    const rowKey =
                      line.ledger_transaction_id != null
                        ? `txn-${line.ledger_transaction_id}`
                        : line.sale_id != null && line.sale_id !== ''
                          ? `sale-${line.sale_id}-${line.reference_number ?? 'x'}`
                          : `row-${line.reference_number ?? line.occurred_at}`
                    const { dateLine, timeLine } = formatSaleLedgerDateParts(line.occurred_at)
                    const refDisplay = ledgerReferenceDisplay(line)
                    const receiptHref = line.receipt_url ? receiptAbsoluteUrl(line.receipt_url) : null
                    const reasonText = line.transaction_reason || '—'
                    const kindLabel = (line.line_kind || '').trim() || reasonText
                    const cargo = lineCargoAmount(line)
                    const pago = linePagoAmount(line)

                    const cells = columnConfig.map((col) => {
                      const w = colWidths[col.id] ?? col.defaultWidth
                      switch (col.id) {
                        case 'date':
                          return (
                            <td
                              key={col.id}
                              style={{ width: w }}
                              className="px-3 py-2 align-top overflow-hidden min-w-0"
                              title={timeLine ? `${dateLine} ${timeLine}` : dateLine}
                            >
                              <div className="min-w-0">
                                <div className="text-sm text-gray-900 leading-snug truncate">{dateLine}</div>
                                {timeLine ? (
                                  <div className="text-xs text-gray-400 mt-0.5 truncate tabular-nums">{timeLine}</div>
                                ) : null}
                              </div>
                            </td>
                          )
                        case 'ref':
                          return (
                            <td key={col.id} style={{ width: w }} className="px-3 py-2 align-top overflow-hidden min-w-0">
                              <span className="font-mono text-xs text-blue-700 tabular-nums block truncate" title={refDisplay}>
                                {refDisplay}
                              </span>
                            </td>
                          )
                        case 'ref_type':
                          return (
                            <td key={col.id} style={{ width: w }} className="px-3 py-2 align-top overflow-hidden min-w-0">
                              <span className="font-mono text-xs text-blue-700 tabular-nums block truncate" title={refDisplay}>
                                {refDisplay}
                              </span>
                              <span className="text-xs text-gray-500 block truncate mt-0.5">{kindLabel}</span>
                            </td>
                          )
                        case 'payee':
                          return (
                            <td key={col.id} style={{ width: w }} className="px-3 py-2.5 align-top overflow-hidden min-w-0">
                              <div className="min-w-0" title={`${line.client_name} · ${reasonText}`}>
                                <span className="block truncate text-gray-900 font-medium">{line.client_name}</span>
                                <span className="text-xs text-gray-500 block truncate mt-0.5 leading-snug">{reasonText}</span>
                              </div>
                            </td>
                          )
                        case 'beneficiary_notes':
                          return (
                            <td key={col.id} style={{ width: w }} className="px-3 py-2.5 align-top overflow-hidden min-w-0">
                              <div className="min-w-0" title={`${line.client_name} · ${(line.notes || '').trim()}`}>
                                <span className="block truncate text-gray-900 font-medium">{line.client_name}</span>
                                <span className="text-xs text-gray-600 block truncate mt-0.5">{line.notes?.trim() || '—'}</span>
                                {line.iptv_username?.trim() ? (
                                  <span className="font-mono text-[11px] text-gray-500 block truncate mt-0.5">
                                    IPTV: {line.iptv_username}
                                  </span>
                                ) : null}
                              </div>
                            </td>
                          )
                        case 'iptv_user':
                          return (
                            <td
                              key={col.id}
                              style={{ width: w }}
                              className="px-3 py-2.5 align-top overflow-hidden min-w-0 font-mono text-xs text-gray-800"
                            >
                              <span className="block truncate" title={line.iptv_username || undefined}>
                                {line.iptv_username?.trim() ? line.iptv_username : '—'}
                              </span>
                            </td>
                          )
                        case 'notes':
                          return (
                            <td key={col.id} style={{ width: w }} className="px-3 py-2.5 align-top overflow-hidden min-w-0">
                              <span className="block truncate text-gray-600" title={(line.notes || '').trim() || undefined}>
                                {line.notes || '—'}
                              </span>
                            </td>
                          )
                        case 'deposit':
                          return (
                            <td
                              key={col.id}
                              style={{ width: w }}
                              className="px-3 py-2.5 text-right tabular-nums text-emerald-700 font-medium whitespace-nowrap overflow-hidden min-w-0"
                            >
                              {cargo != null ? formatMoney(cargo, currency) : '—'}
                            </td>
                          )
                        case 'cargo':
                          return (
                            <td
                              key={col.id}
                              style={{ width: w }}
                              className="px-3 py-2.5 text-right tabular-nums text-emerald-700 font-medium whitespace-nowrap overflow-hidden min-w-0"
                            >
                              {cargo != null ? formatMoney(cargo, currency) : '—'}
                            </td>
                          )
                        case 'payment':
                          return (
                            <td
                              key={col.id}
                              style={{ width: w }}
                              className="px-3 py-2.5 text-right tabular-nums text-rose-700 font-medium whitespace-nowrap overflow-hidden min-w-0"
                            >
                              {pago != null ? formatMoney(pago, currency) : '—'}
                            </td>
                          )
                        case 'pago':
                          return (
                            <td
                              key={col.id}
                              style={{ width: w }}
                              className="px-3 py-2.5 text-right tabular-nums text-rose-700 font-medium whitespace-nowrap overflow-hidden min-w-0"
                            >
                              {pago != null ? formatMoney(pago, currency) : '—'}
                            </td>
                          )
                        case 'balance':
                          return (
                            <td
                              key={col.id}
                              style={{ width: w }}
                              className="px-3 py-2.5 text-right tabular-nums font-semibold text-gray-900 whitespace-nowrap overflow-hidden min-w-0"
                            >
                              {formatMoney(line.displayRunning, currency)}
                            </td>
                          )
                        case 'receipt':
                          return (
                            <td
                              key={col.id}
                              style={{ width: w }}
                              className="px-3 py-2.5 align-middle text-right"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {receiptHref ? (
                                <a
                                  href={receiptHref}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  aria-label={
                                    ledgerReceiptIsPdf(line.receipt_url)
                                      ? 'Abrir comprobante PDF en nueva pestaña'
                                      : 'Abrir comprobante en nueva pestaña'
                                  }
                                  title="Ver comprobante"
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg
                                             bg-slate-100 text-slate-700 hover:bg-slate-200 ring-1 ring-slate-200 transition-colors"
                                >
                                  <Eye size={13} aria-hidden />
                                  Ver
                                </a>
                              ) : (
                                <span className="text-gray-400 text-sm tabular-nums">—</span>
                              )}
                            </td>
                          )
                        default:
                          return null
                      }
                    })

                    return (
                      <Fragment key={rowKey}>
                        <tr
                          className={`transition-colors hover:bg-slate-50/90 ${isSaleRow ? 'cursor-pointer' : 'cursor-default'} ${isSaleRow && expandedSaleId === line.sale_id ? 'bg-blue-50/50' : ''}`}
                          onClick={() => isSaleRow && openRow(line)}
                        >
                          {cells}
                        </tr>
                      {isSaleRow && expandedSaleId === line.sale_id && editDraft && (
                        <tr className="bg-slate-50">
                          <td colSpan={colCount} className="p-4 border-t border-blue-100">
                            <div
                              className="max-w-4xl space-y-4"
                              onClick={(e) => e.stopPropagation()}
                              role="presentation"
                            >
                              <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
                                Edición en línea (venta activada)
                              </p>
                              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                <div>
                                  <label className="block text-xs font-medium text-gray-600 mb-1">Fecha</label>
                                  <input
                                    type="datetime-local"
                                    value={editDraft.occurred_at}
                                    onChange={(e) => setEditDraft((d) => ({ ...d, occurred_at: e.target.value }))}
                                    className={inputCls}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-gray-600 mb-1">N.º referencia</label>
                                  <input
                                    type="text"
                                    value={editDraft.reference_number}
                                    readOnly
                                    className={`${inputCls} bg-gray-100 font-mono tabular-nums`}
                                  />
                                </div>
                                <div className="sm:col-span-2 lg:col-span-1">
                                  <label className="block text-xs font-medium text-gray-600 mb-1">Cliente</label>
                                  <SearchableSelect
                                    value={
                                      editDraft.client_id != null
                                        ? String(editDraft.client_id)
                                        : ''
                                    }
                                    onChange={(v) =>
                                      setEditDraft((d) => ({ ...d, client_id: String(v) }))
                                    }
                                    options={editSaleClientSelectOptions}
                                    hideClear
                                    disabled={saveLoading}
                                  />
                                </div>
                                <div className="sm:col-span-2">
                                  <label className="block text-xs font-medium text-gray-600 mb-1">Notas</label>
                                  <input
                                    type="text"
                                    value={editDraft.notes}
                                    onChange={(e) => setEditDraft((d) => ({ ...d, notes: e.target.value }))}
                                    className={inputCls}
                                    placeholder="Memo / descripción"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-gray-600 mb-1">
                                    Importe total cobro ({editDraft.currency})
                                  </label>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={editDraft.local_amount}
                                    onChange={(e) => setEditDraft((d) => ({ ...d, local_amount: e.target.value }))}
                                    className={inputCls}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-gray-600 mb-1">
                                    Monto pagado — depósito ({editDraft.currency})
                                  </label>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={editDraft.amount_paid}
                                    onChange={(e) => setEditDraft((d) => ({ ...d, amount_paid: e.target.value }))}
                                    className={inputCls}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-gray-600 mb-1">Tasa (local / USD)</label>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={editDraft.exchange_rate}
                                    onChange={(e) => setEditDraft((d) => ({ ...d, exchange_rate: e.target.value }))}
                                    className={inputCls}
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-gray-600 mb-1">Moneda transacción</label>
                                  <input
                                    type="text"
                                    maxLength={5}
                                    value={editDraft.currency}
                                    onChange={(e) =>
                                      setEditDraft((d) => ({
                                        ...d,
                                        currency: e.target.value.toUpperCase().slice(0, 5),
                                      }))
                                    }
                                    className={inputCls}
                                  />
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2 pt-1">
                                <button
                                  type="button"
                                  disabled={saveLoading}
                                  onClick={saveEdit}
                                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                                >
                                  {saveLoading ? 'Guardando…' : 'Guardar'}
                                </button>
                                <button
                                  type="button"
                                  disabled={saveLoading}
                                  onClick={closeRow}
                                  className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                                >
                                  Cancelar
                                </button>
                                <button
                                  type="button"
                                  disabled={saveLoading}
                                  onClick={deleteMovement}
                                  className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 ml-auto sm:ml-0"
                                >
                                  Eliminar
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                  })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-4 py-3 bg-white border-t border-gray-200 sm:px-6 mt-4 rounded-b-lg shadow-sm">
            <div className="text-sm text-gray-500">
              Mostrando{' '}
              <span className="font-medium text-gray-700">
                {filteredTransactions.length > 0 ? (currentPage - 1) * ITEMS_PER_PAGE + 1 : 0}
              </span>{' '}
              a{' '}
              <span className="font-medium text-gray-700">
                {Math.min(currentPage * ITEMS_PER_PAGE, filteredTransactions.length)}
              </span>{' '}
              de <span className="font-medium text-gray-700">{filteredTransactions.length}</span> registros
            </div>
            <div className="flex space-x-2 text-sm">
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-3 py-1 font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Anterior
              </button>
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages || totalPages === 0}
                className="px-3 py-1 font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Siguiente
              </button>
            </div>
          </div>
        </div>

        {refundModalOpen && <RefundModal clients={clients} onClose={() => setRefundModalOpen(false)} />}

        <p className="text-xs text-gray-400 px-1">
          Libro mayor desde journal entries (líneas del asiento contable en esta cuenta y subcuentas).
          El saldo acumulado sigue la convención débito positivo / crédito negativo del backend. Las transferencias comparten la
          referencia TRX. Las cuentas por cobrar usan columnas Cargo/Pago estilo QuickBooks.
        </p>
      </div>
    </div>
  )
}
