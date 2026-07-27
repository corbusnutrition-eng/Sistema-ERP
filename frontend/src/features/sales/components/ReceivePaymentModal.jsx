import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock, HelpCircle, MessageSquare, X, ChevronDown, Paperclip, Trash2, History, ChevronRight } from 'lucide-react'
import api from '../../../api/axios'
import { currencyCodeFromAccountId } from '../../../lib/accountCurrencyCascade'
import useExchangeRateForCurrency from '../../../hooks/useExchangeRateForCurrency'
import { useModal } from '../../../context/ModalContext'
import SearchableSelect from '../../../components/ui/SearchableSelect'
import { normalizeCurrencyCode } from '../../../lib/currencyCode'
import { isPortalSaldoCrossSinComprobante, parsePortalCreditAppliedAmount } from '../portalCreditMeta'
import { formatDateEcuador } from '../../../utils/datetime'

const field =
  'h-10 w-full rounded-md border border-gray-300 px-3 text-sm text-gray-800 bg-white shadow-sm ' +
  'focus:outline-none focus:ring-1 focus:ring-[#238016]/60 focus:border-[#2ca01c]'

const labelCls = 'block text-xs font-medium text-gray-600 mb-1'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

const RECEIPT_MAX_BYTES = 20 * 1024 * 1024
const RECEIPT_ACCEPT =
  'image/jpeg,image/png,image/gif,image/webp,application/pdf,.jpg,.jpeg,.png,.gif,.webp,.pdf'

function receiptFullUrl(path) {
  if (!path) return null
  const p = String(path).trim()
  if (!p) return null
  if (p.startsWith('http://') || p.startsWith('https://')) return p
  return `${API_BASE}${p.startsWith('/') ? p : `/${p}`}`
}

function validateReceiptFile(file) {
  if (!file) return null
  if (file.size > RECEIPT_MAX_BYTES) {
    return 'El archivo supera el límite de 20 MB.'
  }
  const okType =
    /^image\/(jpeg|png|gif|webp)$/i.test(file.type) ||
    file.type === 'application/pdf' ||
    /\.(jpe?g|png|gif|webp|pdf)$/i.test(file.name || '')
  if (!okType) {
    return 'Formato no permitido. Usa JPG, PNG, GIF, WEBP o PDF.'
  }
  return null
}

function formatMoneyDisplay(amount, currency) {
  const cur = normalizeCurrencyCode(currency || 'USD', 'USD')
  const n = Number(amount)
  const safe = Number.isFinite(n) ? n : 0
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safe)
  } catch {
    return `${safe.toFixed(2)} ${cur}`
  }
}


function clientLabel(c) {
  const n = (c.name ?? '').trim()
  const u = (c.username ?? '').trim()
  const mail = (c.email ?? '').trim()
  if (n) return n
  if (u) return u
  return mail || `Cliente #${c.id}`
}

/** Clave estable por obligación CxC (venta o recarga BaaS). */
function obligationKey(inv) {
  if (inv?.wallet_recharge_id != null) return `wr:${inv.wallet_recharge_id}`
  if (inv?.sale_id != null) return `sale:${inv.sale_id}`
  return `ref:${inv?.reference ?? 'unknown'}`
}

function obligationLabel(inv) {
  const kind =
    inv?.obligation_kind
    || (inv?.wallet_recharge_id != null ? 'wallet_recharge' : 'sale')
  if (kind === 'wallet_recharge') return `Recarga #${inv.reference}`
  return `Factura #${inv.reference}`
}

/** Distribuye el importe recibido a facturas más antiguas (FIFO). */
function fifoDistribute(amount, invoices) {
  const next = {}
  let remaining = Math.max(0, Number(amount) || 0)
  for (const inv of invoices) {
    const key = obligationKey(inv)
    if (remaining <= 1e-9) {
      next[key] = ''
      continue
    }
    const open = Number(inv.open_balance) || 0
    const apply = Math.min(remaining, open)
    if (apply > 1e-9) {
      next[key] = String(Math.round(apply * 100) / 100)
      remaining -= apply
    } else {
      next[key] = ''
    }
  }
  return next
}

/** Suma saldos CxC abiertos agrupados por moneda. */
function sumOpenBalancesByCurrency(invoices) {
  const byCur = new Map()
  for (const inv of invoices || []) {
    const cur = normalizeCurrencyCode(inv.currency || 'USD', 'USD')
    const open = Number(inv.open_balance) || 0
    if (open <= 1e-9) continue
    byCur.set(cur, (byCur.get(cur) || 0) + open)
  }
  return [...byCur.entries()]
    .map(([currency, amount]) => ({
      currency,
      amount: Math.round(amount * 100) / 100,
    }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

function ClientCombobox({ clients, value, onChange, onAddNew, disabled }) {
  const wrapRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selected = useMemo(
    () => clients.find((c) => String(c.id) === String(value)),
    [clients, value],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = Array.isArray(clients) ? clients : []
    if (!q) return list
    return list.filter((c) => {
      const blob = `${clientLabel(c)} ${c.email ?? ''} ${c.username ?? ''}`.toLowerCase()
      return blob.includes(q)
    })
  }, [clients, query])

  useEffect(() => {
    if (!open) return undefined
    function onDoc(ev) {
      if (!wrapRef.current?.contains(ev.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (!open) setQuery('')
  }, [value, open])

  useEffect(() => {
    if (open) setQuery(selected ? clientLabel(selected) : '')
  }, [open, selected])

  const displayValue = open ? query : selected ? clientLabel(selected) : ''

  if (disabled && selected) {
    return (
      <div className={`${field} bg-gray-50 text-gray-800 font-medium`}>{clientLabel(selected)}</div>
    )
  }

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        readOnly={!open || disabled}
        disabled={disabled}
        value={displayValue}
        onChange={(e) => setQuery(e.target.value)}
        onClick={() => !disabled && setOpen(true)}
        onFocus={() => !disabled && setOpen(true)}
        placeholder={clients.length ? 'Buscar cliente…' : 'Cargando…'}
        className={field}
      />
      {open && !disabled && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 z-[1] mt-1 max-h-56 overflow-auto rounded-md border border-gray-300 bg-white py-1 shadow-lg"
        >
          <li role="presentation">
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm font-semibold text-[#2ca01c] hover:bg-green-50"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false)
                onAddNew?.()
              }}
            >
              + Agregar nuevo
            </button>
          </li>
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-gray-500">Sin coincidencias</li>
          ) : (
            filtered.map((c) => {
              const isSel = String(c.id) === String(value)
              return (
                <li key={c.id} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-gray-50 ${isSel ? 'bg-gray-50 font-medium' : ''}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onChange(String(c.id))
                      setOpen(false)
                      setQuery('')
                    }}
                  >
                    {clientLabel(c)}
                  </button>
                </li>
              )
            })
          )}
        </ul>
      )}
    </div>
  )
}

/**
 * Modal «Recibir pago» — conciliación estilo QuickBooks.
 */
export default function ReceivePaymentModal({ onClose, onToast, onAfterSave, prefill = null }) {
  const { openNewClient } = useModal()
  const isExistingPayment = Boolean(prefill?.paymentId)
  const viewMode = Boolean(prefill?.viewMode && prefill?.paymentId)
  const reviewMode = Boolean(prefill?.paymentId && !viewMode)

  const [clients, setClients] = useState([])
  const [depositAccounts, setDepositAccounts] = useState([])
  const [unpaidInvoices, setUnpaidInvoices] = useState([])
  const [loadingInvoices, setLoadingInvoices] = useState(false)
  const [paymentHistory, setPaymentHistory] = useState([])
  const [loadingPaymentHistory, setLoadingPaymentHistory] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(true)

  const [commentsOpen, setCommentsOpen] = useState(false)
  const [commentsText, setCommentsText] = useState('')
  const [saveMenuOpen, setSaveMenuOpen] = useState(false)
  const saveMenuRef = useRef(null)

  const [clientId, setClientId] = useState(() => {
    if (prefill?.clientId != null) return String(prefill.clientId)
    return ''
  })
  const [paymentDate, setPaymentDate] = useState(() => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  })
  const [referenceNo, setReferenceNo] = useState('')
  const [depositAccountId, setDepositAccountId] = useState('')
  const [amountStr, setAmountStr] = useState('')
  const [exchangeRateStr, setExchangeRateStr] = useState('1')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [loadingPaymentView, setLoadingPaymentView] = useState(false)
  const [existingPaymentLoaded, setExistingPaymentLoaded] = useState(false)
  const [viewPaymentMeta, setViewPaymentMeta] = useState(null)
  const [receiptFile, setReceiptFile] = useState(null)
  const [receiptDragOver, setReceiptDragOver] = useState(false)
  const receiptInputRef = useRef(null)

  /** { [obligationKey]: "12.50" } */
  const [paidBySale, setPaidBySale] = useState({})
  const skipFifoRef = useRef(false)
  const prefillAppliedRef = useRef(false)
  const paymentLoadedRef = useRef(false)

  const paymentStatus = String(viewPaymentMeta?.status ?? '').toLowerCase()
  const isPendingReviewPayment = isExistingPayment && paymentStatus === 'pending_review'
  const isHistoricalView =
    viewMode
    || (isExistingPayment && Boolean(paymentStatus) && paymentStatus !== 'pending_review')
  const formReadOnly = isHistoricalView
  const allocationsReadOnly = isHistoricalView
  const showSaveActions =
    !isHistoricalView && (!isExistingPayment || (existingPaymentLoaded && isPendingReviewPayment))

  /** Moneda del cobro: prioridad cuenta «Depositar en» (`account.currency`), luego facturas / prefill. */
  const paymentCurrency = useMemo(() => {
    if (depositAccountId) {
      return currencyCodeFromAccountId(depositAccounts, depositAccountId, 'USD')
    }
    if (viewPaymentMeta?.currency) {
      return normalizeCurrencyCode(viewPaymentMeta.currency, 'USD')
    }
    if (unpaidInvoices[0]?.currency) {
      return normalizeCurrencyCode(unpaidInvoices[0].currency, 'USD')
    }
    if (prefill?.currency) return normalizeCurrencyCode(prefill.currency, 'USD')
    return 'USD'
  }, [depositAccountId, depositAccounts, unpaidInvoices, prefill?.currency, viewPaymentMeta?.currency])

  const displayCurrency = paymentCurrency

  const applyPaymentExchangeRate = useCallback((rateStr) => {
    setExchangeRateStr(rateStr)
  }, [])

  useExchangeRateForCurrency(paymentCurrency, applyPaymentExchangeRate, {
    enabled: !formReadOnly,
  })

  const handleDepositAccountChange = useCallback(
    (v) => {
      const id = String(v ?? '')
      setDepositAccountId(id)
      if (!id || formReadOnly) return
      const cur = currencyCodeFromAccountId(depositAccounts, id, 'USD')
      if (cur === 'USD') setExchangeRateStr('1')
    },
    [depositAccounts, formReadOnly],
  )

  const amountNum = Number.parseFloat(String(amountStr).replace(',', '.'))
  const headerAmount = Number.isFinite(amountNum) ? amountNum : 0

  const receiveDepositSelectOptions = useMemo(() => {
    const map = new Map()
    for (const a of depositAccounts) {
      const cur = normalizeCurrencyCode(a.currency || 'USD', 'USD')
      if (!map.has(cur)) map.set(cur, [])
      map.get(cur).push(a)
    }
    const opts = []
    for (const [cur, list] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      opts.push({ value: `__hdr_${cur}`, label: `— ${cur} —`, disabled: true })
      for (const a of list) {
        opts.push({
          value: String(a.id),
          label: `${a.name}${a.account_number ? ` · ${a.account_number}` : ''} (${cur})`,
        })
      }
    }
    return opts
  }, [depositAccounts])

  const totalApplied = useMemo(() => {
    return unpaidInvoices.reduce((sum, inv) => {
      const v = Number.parseFloat(String(paidBySale[obligationKey(inv)] ?? '').replace(',', '.'))
      return sum + (Number.isFinite(v) && v > 0 ? v : 0)
    }, 0)
  }, [unpaidInvoices, paidBySale])

  const unappliedAmount = Math.max(0, Math.round((headerAmount - totalApplied) * 100) / 100)

  const totalDebtByCurrency = useMemo(
    () => sumOpenBalancesByCurrency(unpaidInvoices),
    [unpaidInvoices],
  )

  const totalDebtPrimary = totalDebtByCurrency[0] ?? null

  const loadPaymentHistory = useCallback(async (cid) => {
    if (!cid) {
      setPaymentHistory([])
      return
    }
    setLoadingPaymentHistory(true)
    try {
      const { data } = await api.get('/api/v1/payments/', {
        params: {
          client_id: Number(cid),
          status_filter: 'approved',
          limit: 100,
        },
      })
      setPaymentHistory(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error(
        '[ReceivePaymentModal] payment history failed:',
        err?.response?.status,
        err?.response?.data ?? err?.message ?? err,
      )
      setPaymentHistory([])
    } finally {
      setLoadingPaymentHistory(false)
    }
  }, [])

  const showReceiptUpload = !formReadOnly && !isPendingReviewPayment
  const viewReceiptUrl = receiptFullUrl(
    viewPaymentMeta?.receipt_file_url || prefill?.receiptUrl || null,
  )

  /** Notas combinadas vista API + prefill tabla (hay contexto antes de GET /payments/{id}). */
  const mergedReviewNotes =
    isExistingPayment ? String(viewPaymentMeta?.notes ?? prefill?.notes ?? '') : ''

  const isPortalSaldoCrossNoReceipt =
    isExistingPayment
      ? isPortalSaldoCrossSinComprobante({
          receiptFileUrlOrPath: viewPaymentMeta?.receipt_file_url ?? prefill?.receiptUrl,
          notes: mergedReviewNotes,
        })
      : false

  const portalSaldoApplied = parsePortalCreditAppliedAmount(mergedReviewNotes)

  const loadCatalogs = useCallback(async () => {
    try {
      const [clRes, depRes] = await Promise.all([
        api.get('/api/v1/clients/', { params: { skip: 0, limit: 800 } }),
        api.get('/api/v1/accounts/deposit-options'),
      ])
      setClients(Array.isArray(clRes.data) ? clRes.data : [])
      setDepositAccounts(Array.isArray(depRes.data) ? depRes.data : [])
    } catch {
      setClients([])
      setDepositAccounts([])
      onToast?.('No se pudieron cargar clientes o cuentas.', 'error')
    }
  }, [onToast])

  const loadUnpaidInvoices = useCallback(
    async (cid, { autoFifoAmount } = {}) => {
      if (!cid) {
        setUnpaidInvoices([])
        setPaidBySale({})
        return
      }
      setLoadingInvoices(true)
      try {
        const { data } = await api.get(`/api/v1/clients/${cid}/unpaid-invoices`)
        const list = Array.isArray(data) ? data : []
        setUnpaidInvoices(list)
        if (autoFifoAmount != null && Number(autoFifoAmount) > 0) {
          skipFifoRef.current = true
          setPaidBySale(fifoDistribute(autoFifoAmount, list))
        } else {
          setPaidBySale({})
        }
      } catch {
        setUnpaidInvoices([])
        onToast?.('No se pudieron cargar las facturas pendientes.', 'error')
      } finally {
        setLoadingInvoices(false)
      }
    },
    [onToast],
  )

  useEffect(() => {
    loadCatalogs()
  }, [loadCatalogs])

  useEffect(() => {
    if (!saveMenuOpen) return undefined
    function onDoc(ev) {
      if (!saveMenuRef.current?.contains(ev.target)) setSaveMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [saveMenuOpen])

  const loadPaymentView = useCallback(
    async (pid) => {
      setLoadingPaymentView(true)
      try {
        const { data } = await api.get(`/api/v1/payments/${pid}`)
        setViewPaymentMeta(data)
        setClientId(String(data.client_id))
        setAmountStr(String(Number(data.amount)))
        setReferenceNo(data.reference_number || '')
        if (data.deposit_account_id != null) setDepositAccountId(String(data.deposit_account_id))
        setNote(data.notes || '')
        const dtRaw = data.approved_at || data.created_at
        if (dtRaw) {
          try {
            const d = new Date(dtRaw)
            const p = (n) => String(n).padStart(2, '0')
            setPaymentDate(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
          } catch {
            /* keep default */
          }
        }
        const status = String(data.status || '').toLowerCase()
        const isHistorical = status && status !== 'pending_review'
        const hasAllocations = Array.isArray(data.allocations) && data.allocations.length > 0

        if (!isHistorical && status === 'pending_review' && !hasAllocations) {
          paymentLoadedRef.current = true
          setExistingPaymentLoaded(true)
          const amt = Number(data.amount)
          await loadUnpaidInvoices(String(data.client_id), {
            autoFifoAmount: Number.isFinite(amt) && amt > 0 ? amt : undefined,
          })
          return
        }

        const rows = (data.allocations || []).map((a) => ({
          obligation_kind: a.obligation_kind || (a.wallet_recharge_id != null ? 'wallet_recharge' : 'sale'),
          sale_id: a.sale_id,
          wallet_recharge_id: a.wallet_recharge_id,
          reference: a.sale_ref,
          date: a.sale_date,
          total_amount: a.invoice_total ?? a.amount_applied,
          open_balance: isHistorical ? 0 : (a.open_balance ?? a.amount_applied),
          currency: a.currency || data.currency,
          historical_applied: Number(a.amount_applied),
        }))
        skipFifoRef.current = true
        setUnpaidInvoices(rows)
        const paid = {}
        for (const a of data.allocations || []) {
          const applied = Number(a.amount_applied)
          paid[obligationKey(a)] = Number.isFinite(applied) ? String(applied) : ''
        }
        setPaidBySale(paid)
        paymentLoadedRef.current = true
        setExistingPaymentLoaded(true)
      } catch (err) {
        paymentLoadedRef.current = true
        setExistingPaymentLoaded(true)
        console.error(
          '[ReceivePaymentModal] GET /api/v1/payments/{id} failed:',
          err?.response?.status,
          err?.response?.data ?? err?.message ?? err,
        )
        const fallbackClient = prefill?.clientId ?? clientId
        const fallbackAmt = Number(prefill?.amount ?? amountStr)
        if (fallbackClient) {
          try {
            await loadUnpaidInvoices(String(fallbackClient), {
              autoFifoAmount:
                Number.isFinite(fallbackAmt) && fallbackAmt > 0 ? fallbackAmt : undefined,
            })
          } catch (loadErr) {
            console.error(
              '[ReceivePaymentModal] unpaid-invoices fallback failed:',
              loadErr?.response?.status,
              loadErr?.response?.data ?? loadErr?.message ?? loadErr,
            )
          }
        }
        onToast?.('No se pudo cargar el detalle del pago.', 'error')
      } finally {
        setLoadingPaymentView(false)
      }
    },
    [onToast, loadUnpaidInvoices, prefill?.clientId, prefill?.amount],
  )

  useEffect(() => {
    paymentLoadedRef.current = false
    setExistingPaymentLoaded(false)
    prefillAppliedRef.current = false
    setViewPaymentMeta(null)
    if (prefill?.clientId != null) setClientId(String(prefill.clientId))
  }, [prefill?.paymentId, prefill?.clientId, prefill?.viewMode])

  const openHistoricalPayment = useCallback(
    (pid) => {
      paymentLoadedRef.current = false
      setExistingPaymentLoaded(false)
      setViewPaymentMeta(null)
      setPaidBySale({})
      setUnpaidInvoices([])
      void loadPaymentView(pid)
    },
    [loadPaymentView],
  )

  useEffect(() => {
    if (isExistingPayment && !paymentLoadedRef.current) {
      void loadPaymentView(prefill.paymentId)
    }
  }, [isExistingPayment, prefill?.paymentId, loadPaymentView])

  useEffect(() => {
    if (formReadOnly) return
    if (!prefill || prefillAppliedRef.current) return
    if (prefill.clientId != null) setClientId(String(prefill.clientId))
    if (prefill.amount != null) setAmountStr(String(prefill.amount))
    if (prefill.referenceNumber) setReferenceNo(String(prefill.referenceNumber))
    if (prefill.depositAccountId != null) setDepositAccountId(String(prefill.depositAccountId))
    if (prefill.notes) setNote(String(prefill.notes))
    if (prefill.paymentDate) {
      try {
        const d = new Date(prefill.paymentDate)
        const p = (n) => String(n).padStart(2, '0')
        setPaymentDate(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
      } catch {
        /* keep default */
      }
    }
    prefillAppliedRef.current = true
  }, [prefill, formReadOnly, isExistingPayment])

  useEffect(() => {
    if (!isPendingReviewPayment || !clientId || !existingPaymentLoaded) return
    if (loadingInvoices || loadingPaymentView) return
    const hasManualAlloc = unpaidInvoices.some((inv) => {
      const v = Number.parseFloat(String(paidBySale[obligationKey(inv)] ?? '').replace(',', '.'))
      return Number.isFinite(v) && v > 1e-9
    })
    if (hasManualAlloc) return
    const amt = Number(viewPaymentMeta?.amount ?? prefill?.amount ?? amountNum)
    if (!Number.isFinite(amt) || amt <= 0 || unpaidInvoices.length === 0) return
    skipFifoRef.current = true
    setPaidBySale(fifoDistribute(amt, unpaidInvoices))
  }, [
    isPendingReviewPayment,
    clientId,
    existingPaymentLoaded,
    loadingInvoices,
    loadingPaymentView,
    unpaidInvoices,
    paidBySale,
    viewPaymentMeta?.amount,
    prefill?.amount,
    amountNum,
  ])

  useEffect(() => {
    if (isExistingPayment) return
    if (!clientId) {
      setUnpaidInvoices([])
      setPaidBySale({})
      setPaymentHistory([])
      return
    }
    const fifoAmt =
      reviewMode && prefill?.amount != null ? Number(prefill.amount) : undefined
    loadUnpaidInvoices(clientId, { autoFifoAmount: fifoAmt })
    void loadPaymentHistory(clientId)
  }, [clientId, reviewMode, prefill?.amount, isExistingPayment, loadUnpaidInvoices, loadPaymentHistory])

  useEffect(() => {
    if (!isExistingPayment || !clientId) return
    void loadPaymentHistory(clientId)
  }, [isExistingPayment, clientId, loadPaymentHistory])

  useEffect(() => {
    if (skipFifoRef.current) {
      skipFifoRef.current = false
      return
    }
    if (isExistingPayment) return
    if (!Number.isFinite(amountNum) || amountNum <= 0 || unpaidInvoices.length === 0) return
    setPaidBySale(fifoDistribute(amountNum, unpaidInvoices))
  }, [amountStr, amountNum, unpaidInvoices, isExistingPayment])

  function buildAllocationsPayload() {
    const rows = []
    for (const inv of unpaidInvoices) {
      const v = Number.parseFloat(String(paidBySale[obligationKey(inv)] ?? '').replace(',', '.'))
      if (Number.isFinite(v) && v > 1e-9) {
        const applied = Math.round(v * 100) / 100
        if (inv.wallet_recharge_id != null) {
          rows.push({ wallet_recharge_id: inv.wallet_recharge_id, applied_amount: applied })
        } else if (inv.sale_id != null) {
          rows.push({ sale_id: inv.sale_id, applied_amount: applied })
        }
      }
    }
    return rows
  }

  function pickReceiptFile(fileList) {
    const file = fileList?.[0]
    if (!file) return
    const err = validateReceiptFile(file)
    if (err) {
      onToast?.(err, 'error')
      return
    }
    setReceiptFile(file)
  }

  function resetForm() {
    setClientId('')
    setReferenceNo('')
    setDepositAccountId('')
    setAmountStr('')
    setNote('')
    setCommentsText('')
    setReceiptFile(null)
    setUnpaidInvoices([])
    setPaidBySale({})
    prefillAppliedRef.current = false
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    setPaymentDate(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)
  }

  function validateForm() {
    if (!clientId) {
      window.alert('Selecciona un cliente.')
      return false
    }
    if (!depositAccountId && !isPortalSaldoCrossNoReceipt && !reviewMode) {
      window.alert('Selecciona la cuenta donde se depositó el pago.')
      return false
    }
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      window.alert('Introduce un importe recibido mayor que cero.')
      return false
    }
    const allocations = buildAllocationsPayload()
    if (allocations.length === 0) {
      window.alert('Asigna al menos un monto a una factura en la tabla.')
      return false
    }
    if (totalApplied > headerAmount + 0.01) {
      window.alert('La suma aplicada a facturas no puede superar el importe recibido.')
      return false
    }
    return true
  }

  async function handleSave(mode) {
    if (!validateForm()) return
    const allocations = buildAllocationsPayload()

    setSaving(true)
    try {
      if (reviewMode && prefill?.paymentId) {
        await api.patch(`/api/v1/payments/${prefill.paymentId}/approve`, {
          amount: headerAmount,
          reference_number: referenceNo.trim() || undefined,
          notes: note.trim() || undefined,
          allocations,
        })
        onToast?.(
          `Pago ${prefill.paymentNumber || `#${prefill.paymentId}`} aprobado y aplicado a ${allocations.length} factura(s).`,
          'success',
        )
      } else {
        const xr = Number.parseFloat(String(exchangeRateStr).replace(',', '.'))
        const payload = {
          client_id: Number(clientId),
          amount: headerAmount,
          currency: displayCurrency,
          exchange_rate:
            displayCurrency === 'USD'
              ? 1
              : Number.isFinite(xr) && xr > 0
                ? xr
                : 1,
          deposit_account_id: Number(depositAccountId),
          reference_number: referenceNo.trim() || undefined,
          notes: note.trim() || undefined,
          allocations,
        }
        const formData = new FormData()
        formData.append('payload', JSON.stringify(payload))
        if (receiptFile) {
          formData.append('receipt_file', receiptFile)
        }
        await api.post('/api/v1/payments/', formData)
        onToast?.(`Pago registrado y aplicado a ${allocations.length} factura(s).`, 'success')
      }
      onAfterSave?.()
      if (mode === 'close') onClose?.()
      else resetForm()
    } catch (err) {
      const d = err?.response?.data?.detail
      onToast?.(typeof d === 'string' ? d : 'No se pudo guardar el pago.', 'error')
    } finally {
      setSaving(false)
      setSaveMenuOpen(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[82] flex items-center justify-center bg-black/45 p-2 sm:p-4 font-sans text-gray-800"
      onClick={(e) => e.target === e.currentTarget && onClose?.()}
      role="presentation"
    >
      <div
        className="flex max-h-[min(92vh,920px)] w-[95%] sm:w-full max-w-6xl flex-col overflow-y-auto sm:overflow-hidden rounded-sm bg-white shadow-2xl ring-1 ring-black/10"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-gray-300 px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <Clock className="h-7 w-7 shrink-0 text-gray-700" strokeWidth={1.75} aria-hidden />
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">
              {isHistoricalView
                ? `Pago ${viewPaymentMeta?.payment_number || prefill?.paymentNumber || ''}`.trim()
                : isPendingReviewPayment
                  ? `Revisar pago ${prefill?.paymentNumber || viewPaymentMeta?.payment_number || ''}`.trim()
                  : 'Recibir pago'}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {showSaveActions && (
              <button
                type="button"
                onClick={() => setCommentsOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-[#1b5e20] hover:bg-gray-100"
              >
                <MessageSquare className="h-4 w-4" aria-hidden />
                Comentarios
              </button>
            )}
            <button type="button" onClick={onClose} className="rounded-md p-2 text-gray-500 hover:bg-gray-100" aria-label="Cerrar">
              <X className="h-5 w-5" strokeWidth={2} />
            </button>
          </div>
        </header>

        {commentsOpen && (
          <div className="border-b border-gray-200 bg-gray-50 px-6 py-3">
            <label className={labelCls}>Comentarios internos</label>
            <textarea
              rows={2}
              value={commentsText}
              onChange={(e) => setCommentsText(e.target.value)}
              className={`${field} h-20 resize-none`}
            />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-6">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-end">
            <div className="lg:col-span-5">
              <label className={labelCls}>Cliente</label>
              <ClientCombobox
                clients={clients}
                value={clientId}
                onChange={setClientId}
                onAddNew={() => openNewClient(loadCatalogs)}
                disabled={isExistingPayment}
              />
              {clientId && totalDebtByCurrency.length > 0 && !isHistoricalView ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {totalDebtByCurrency.map(({ currency, amount }) => (
                    <span
                      key={currency}
                      className="inline-flex items-center rounded-md border border-orange-200 bg-orange-50 px-2.5 py-1 text-xs font-bold text-orange-900 ring-1 ring-orange-100"
                    >
                      Deuda total: {formatMoneyDisplay(amount, currency)}
                    </span>
                  ))}
                </div>
              ) : clientId && !loadingInvoices && !isHistoricalView ? (
                <p className="mt-2 text-xs font-medium text-emerald-700">Sin deuda CxC pendiente</p>
              ) : null}
              {isExistingPayment ?
                (() => {
                  const relPath = viewPaymentMeta?.receipt_file_url ?? prefill?.receiptUrl ?? null
                  const receiptDisplayUrl = receiptFullUrl(relPath)
                  if (receiptDisplayUrl) {
                    return (
                      <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                          Comprobante del cliente
                        </p>
                        {/\.(jpe?g|png|webp|gif)(\?|$)/i.test(relPath || '') ? (
                          <a
                            href={receiptDisplayUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block"
                          >
                            <img
                              src={receiptDisplayUrl}
                              alt="Comprobante de pago"
                              className="max-h-48 w-auto rounded-md border border-gray-200 object-contain"
                            />
                          </a>
                        ) : (
                          <a
                            href={receiptDisplayUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex text-xs font-semibold text-blue-600 hover:underline"
                          >
                            Ver comprobante (PDF / archivo)
                          </a>
                        )}
                      </div>
                    )
                  }
                  if (!isPortalSaldoCrossNoReceipt) return null
                  return (
                    <div className="mt-3 rounded-lg border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-4 shadow-sm ring-1 ring-emerald-100">
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-emerald-900">
                        Comprobante del cliente
                      </p>
                      <p className="m-0 text-sm font-semibold leading-relaxed text-emerald-900">
                        🔄 CRUCE DE SALDO A FAVOR — No se requiere comprobante físico
                      </p>
                      {portalSaldoApplied != null && Number(portalSaldoApplied) > 0 ? (
                        <p className="mt-2 mb-0 text-xs font-medium tabular-nums text-emerald-800">
                          Parte aplicada desde saldo a favor:{' '}
                          <span className="font-bold">{formatMoneyDisplay(portalSaldoApplied, displayCurrency)}</span>
                          . El depósito bancario en este movimiento fue cero según los datos enviados por el cliente.
                        </p>
                      ) : (
                        <p className="mt-2 mb-0 text-xs text-emerald-800/90 leading-relaxed">
                          El cliente usó únicamente su crédito de tienda; no hubo archivo de transferencia adjunto en el portal.
                        </p>
                      )}
                    </div>
                  )
                })()
              : null}
            </div>

            <div className="lg:col-span-3">
              <label className={labelCls}>Fecha de pago</label>
              <input
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
                className={field}
                readOnly={formReadOnly}
                disabled={formReadOnly}
              />
            </div>

            <div className="lg:col-span-4 flex flex-col items-end text-right">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Importe recibido</p>
              <input
                type="text"
                inputMode="decimal"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                readOnly={formReadOnly}
                disabled={formReadOnly}
                className={`${field} mt-1 max-w-[220px] text-right text-xl font-bold tabular-nums ${formReadOnly ? 'bg-gray-50' : ''}`}
                placeholder="0.00"
              />
              <p className="mt-2 text-xs text-gray-500">
                Aplicado:{' '}
                <span className="font-semibold tabular-nums">{formatMoneyDisplay(totalApplied, displayCurrency)}</span>
                {' · '}
                Sin aplicar:{' '}
                <span className="font-semibold tabular-nums text-amber-700">
                  {formatMoneyDisplay(unappliedAmount, displayCurrency)}
                </span>
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {(!isPendingReviewPayment || isHistoricalView) ? (
            <div>
              <label className={labelCls}>Depositar en</label>
              <SearchableSelect
                value={depositAccountId}
                onChange={handleDepositAccountChange}
                options={receiveDepositSelectOptions}
                placeholder="Seleccionar cuenta"
                clearLabel="Seleccionar cuenta"
                disabled={formReadOnly}
              />
            </div>
            ) : null}
            <div>
              <label className={labelCls}>N.º de referencia</label>
              <input
                type="text"
                value={referenceNo}
                onChange={(e) => setReferenceNo(e.target.value)}
                className={field}
                readOnly={formReadOnly}
                disabled={formReadOnly}
              />
            </div>
            {displayCurrency !== 'USD' ? (
              <div className="sm:col-span-2">
                <label className={labelCls}>Tipo de cambio (a USD)</label>
                <p className="mb-1 text-[11px] text-gray-500">
                  Unidades de {displayCurrency} por 1 USD (última tasa usada en el sistema; editable).
                </p>
                <input
                  type="number"
                  min="0.0001"
                  step="any"
                  value={exchangeRateStr}
                  onChange={(e) => setExchangeRateStr(e.target.value)}
                  className={field}
                  readOnly={formReadOnly}
                  disabled={formReadOnly}
                />
              </div>
            ) : null}
          </div>

          <div className="mt-3">
            <label className={labelCls}>Nota</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className={`${field} resize-y py-2`}
              readOnly={formReadOnly}
              disabled={formReadOnly}
            />
          </div>

          <div className="mt-8">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-bold uppercase tracking-wide text-gray-700">
                  {isHistoricalView ? 'Distribución del pago' : 'Facturas pendientes'}
                </h2>
                {clientId && totalDebtPrimary && !isHistoricalView ? (
                  <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-800 ring-1 ring-red-100">
                    Deuda: {formatMoneyDisplay(totalDebtPrimary.amount, totalDebtPrimary.currency)}
                  </span>
                ) : null}
              </div>
              {(loadingInvoices || loadingPaymentView) && (
                <span className="text-xs text-gray-500">Cargando facturas…</span>
              )}
            </div>

            {!clientId ? (
              <p className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center text-sm text-gray-500">
                {loadingPaymentView
                  ? 'Cargando detalle del pago…'
                  : 'Selecciona un cliente para ver sus facturas con saldo pendiente.'}
              </p>
            ) : unpaidInvoices.length === 0 && !loadingInvoices && !loadingPaymentView ? (
              <p className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center text-sm text-gray-500">
                {isHistoricalView
                  ? 'Este pago no tiene facturas asociadas registradas.'
                  : 'Este cliente no tiene facturas aprobadas con saldo pendiente.'}
              </p>
            ) : unpaidInvoices.length === 0 && (loadingInvoices || loadingPaymentView) ? (
              <p className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center text-sm text-gray-500">
                Cargando facturas del pago…
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-300">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-gray-300 bg-gray-100 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">
                      <th className="px-3 py-2.5">Descripción</th>
                      <th className="px-3 py-2.5 whitespace-nowrap">Fecha</th>
                      <th className="px-3 py-2.5 text-right whitespace-nowrap">Importe original</th>
                      <th className="px-3 py-2.5 text-right whitespace-nowrap">Saldo pendiente</th>
                      <th className="px-3 py-2.5 text-right whitespace-nowrap w-36">Pagado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {unpaidInvoices.map((inv) => {
                      const rowKey = obligationKey(inv)
                      const paidVal = paidBySale[rowKey] ?? ''
                      const paidNum = Number.parseFloat(String(paidVal).replace(',', '.'))
                      const hasPay = Number.isFinite(paidNum) && paidNum > 1e-9
                      return (
                        <tr key={rowKey} className={hasPay ? 'bg-green-50/40' : undefined}>
                          <td className="px-3 py-2 font-medium text-gray-900">
                            {obligationLabel(inv)}
                          </td>
                          <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{formatDateEcuador(inv.date)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-800">
                            {formatMoneyDisplay(inv.total_amount, inv.currency || displayCurrency)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-900">
                            {isHistoricalView ? (
                              <span className="text-gray-400 font-normal">—</span>
                            ) : (
                              formatMoneyDisplay(inv.open_balance, inv.currency || displayCurrency)
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              inputMode="decimal"
                              value={paidVal}
                              onChange={(e) => {
                                skipFifoRef.current = true
                                setPaidBySale((p) => ({ ...p, [rowKey]: e.target.value }))
                              }}
                              readOnly={allocationsReadOnly}
                              disabled={allocationsReadOnly}
                              className={`${field} text-right tabular-nums h-9 ${allocationsReadOnly ? 'bg-gray-50' : ''}`}
                              placeholder="0.00"
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-50 font-semibold">
                      <td colSpan={4} className="px-3 py-2.5 text-right text-gray-700">
                        Total aplicado
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[#1b5e20]">
                        {formatMoneyDisplay(totalApplied, displayCurrency)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {clientId && !isHistoricalView ? (
            <div className="mt-8">
              <button
                type="button"
                onClick={() => setHistoryOpen((v) => !v)}
                className="mb-3 flex w-full items-center justify-between gap-2 text-left"
              >
                <span className="inline-flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-gray-700">
                  <History className="h-4 w-4 text-gray-500" aria-hidden />
                  Abonos previos
                  {paymentHistory.length > 0 ? (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600 normal-case">
                      {paymentHistory.length}
                    </span>
                  ) : null}
                </span>
                <ChevronDown
                  className={`h-4 w-4 text-gray-500 transition-transform ${historyOpen ? 'rotate-180' : ''}`}
                  aria-hidden
                />
              </button>

              {historyOpen ? (
                loadingPaymentHistory ? (
                  <p className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
                    Cargando historial de pagos…
                  </p>
                ) : paymentHistory.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-sm text-gray-500">
                    Este cliente aún no tiene abonos confirmados.
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="w-full min-w-[480px] text-sm">
                      <thead>
                        <tr className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                          <th className="px-3 py-2">Fecha</th>
                          <th className="px-3 py-2">Referencia</th>
                          <th className="px-3 py-2 text-right">Importe</th>
                          <th className="w-8 px-2 py-2" aria-hidden />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 bg-white">
                        {paymentHistory.map((p) => {
                          const refLabel =
                            p.reference_number?.trim()
                            || p.payment_method?.trim()
                            || p.payment_number
                            || `#${p.id}`
                          return (
                            <tr key={p.id}>
                              <td className="px-3 py-2 whitespace-nowrap text-gray-700">
                                <button
                                  type="button"
                                  onClick={() => openHistoricalPayment(p.id)}
                                  className="w-full text-left rounded px-1 py-1 -mx-1 hover:bg-sky-50 hover:text-sky-900 transition-colors cursor-pointer"
                                >
                                  {formatDateEcuador(p.approved_at || p.created_at)}
                                </button>
                              </td>
                              <td className="px-3 py-2 text-gray-800 truncate max-w-[12rem]">
                                <button
                                  type="button"
                                  onClick={() => openHistoricalPayment(p.id)}
                                  className="w-full text-left rounded px-1 py-1 -mx-1 hover:bg-sky-50 hover:text-sky-900 transition-colors cursor-pointer truncate"
                                  title={refLabel}
                                >
                                  {refLabel}
                                </button>
                              </td>
                              <td className="px-3 py-2 text-right tabular-nums font-semibold text-gray-900">
                                <button
                                  type="button"
                                  onClick={() => openHistoricalPayment(p.id)}
                                  className="w-full text-right rounded px-1 py-1 -mx-1 hover:bg-sky-50 hover:text-sky-900 transition-colors cursor-pointer"
                                >
                                  {formatMoneyDisplay(p.amount, p.currency || displayCurrency)}
                                </button>
                              </td>
                              <td className="px-2 py-2 text-gray-400">
                                <button
                                  type="button"
                                  onClick={() => openHistoricalPayment(p.id)}
                                  className="p-1 rounded hover:bg-sky-50 hover:text-sky-700"
                                  aria-label="Ver detalle del pago"
                                >
                                  <ChevronRight className="h-4 w-4" aria-hidden />
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              ) : null}
            </div>
          ) : null}

          {showReceiptUpload && (
            <div className="mt-6">
              <input
                ref={receiptInputRef}
                type="file"
                accept={RECEIPT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  pickReceiptFile(e.target.files)
                  e.target.value = ''
                }}
              />
              {!receiptFile ? (
                <button
                  type="button"
                  onClick={() => receiptInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setReceiptDragOver(true)
                  }}
                  onDragLeave={() => setReceiptDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setReceiptDragOver(false)
                    pickReceiptFile(e.dataTransfer.files)
                  }}
                  className={`w-full rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors ${
                    receiptDragOver
                      ? 'border-[#2ca01c] bg-green-50/50'
                      : 'border-gray-300 bg-gray-50/80 hover:border-gray-400 hover:bg-gray-50'
                  }`}
                >
                  <Paperclip className="mx-auto h-8 w-8 text-gray-400 mb-2" strokeWidth={1.5} aria-hidden />
                  <p className="text-sm font-medium text-gray-700">
                    Añadir archivo adjunto{' '}
                    <span className="font-normal text-gray-500">(Tamaño máximo: 20 MB)</span>
                  </p>
                  <p className="mt-1 text-xs text-gray-500">Arrastra un archivo o haz clic para buscar</p>
                  <p className="mt-0.5 text-[11px] text-gray-400">JPG, PNG, GIF, WEBP o PDF</p>
                </button>
              ) : (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-300 bg-white px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <Paperclip className="h-5 w-5 shrink-0 text-gray-500" aria-hidden />
                    <span className="truncate text-sm font-medium text-gray-800">{receiptFile.name}</span>
                    <span className="shrink-0 text-xs text-gray-500 tabular-nums">
                      ({(receiptFile.size / (1024 * 1024)).toFixed(2)} MB)
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setReceiptFile(null)}
                    className="shrink-0 rounded-md p-2 text-gray-500 hover:bg-red-50 hover:text-red-600"
                    aria-label="Quitar archivo"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              )}
            </div>
          )}

          {isHistoricalView && viewReceiptUrl && (
            <div className="mt-6 rounded-lg border border-gray-200 bg-slate-50 px-4 py-3">
              <a
                href={viewReceiptUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600 hover:text-blue-800 hover:underline"
              >
                <Paperclip className="h-4 w-4 shrink-0" aria-hidden />
                Ver comprobante adjunto
              </a>
            </div>
          )}
        </div>

        <footer className="shrink-0 border-t border-gray-300 bg-white px-6 py-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <button type="button" onClick={onClose} className="text-sm font-semibold text-[#1b5e20] hover:underline">
              {isHistoricalView ? 'Cerrar' : 'Cancelar'}
            </button>
            {showSaveActions && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                disabled={saving}
                onClick={() => handleSave('keep')}
                className="h-10 rounded-md border border-[#2ca01c] bg-white px-4 text-sm font-semibold text-[#2ca01c] hover:bg-green-50 disabled:opacity-50"
              >
                {saving ? 'Guardando…' : 'Guardar'}
              </button>
              <div className="relative inline-flex rounded-md shadow-sm" ref={saveMenuRef}>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => handleSave('close')}
                  className="h-10 rounded-l-md bg-[#2ca01c] px-4 text-sm font-semibold text-white hover:bg-[#238016] disabled:opacity-50"
                >
                  Guardar y cerrar
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setSaveMenuOpen((o) => !o)}
                  className="h-10 rounded-r-md border-l border-white/25 bg-[#2ca01c] px-2 text-white hover:bg-[#238016] disabled:opacity-50"
                >
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
