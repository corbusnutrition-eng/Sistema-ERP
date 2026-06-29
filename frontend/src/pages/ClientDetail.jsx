import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clipboard,
  DollarSign,
  Eye,
  Globe,
  Loader2,
  Mail,
  Pencil,
  Phone,
  Link2,
} from 'lucide-react'
import api from '../api/axios'
import { useModal } from '../context/ModalContext'
import usePermissions from '../hooks/usePermissions'
import { PERMS } from '../lib/permissions'
import NuevaVentaModal from '../features/sales/components/NuevaVentaModal'
import {
  ClientDetailNotesCell,
  SaleAmountCell,
  SaleReceiptProofLink,
  saleOpensReadOnly,
  formatSaleDocNo,
  formatSaleTableDate,
  copyClientPortalLink,
  clientPortalPublicUrl,
} from '../features/sales/saleTableHelpers'
import { EditModal } from './Clientes'
import { formatDateTimeEcuador } from '../utils/datetime'
import VerRecargaModal from '../features/settings/VerRecargaModal'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

function formatClientMoney(amount, currency = 'USD') {
  const n = Number(amount)
  const cur = String(currency || 'USD').toUpperCase().slice(0, 10)
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number.isFinite(n) ? n : 0)
  } catch {
    return `${Number.isFinite(n) ? n.toFixed(2) : '0'} ${cur}`
  }
}

function paymentReceiptHref(receiptPath) {
  if (!receiptPath) return null
  const p = String(receiptPath).trim()
  if (!p) return null
  if (p.startsWith('http://') || p.startsWith('https://')) return p
  return `${API_BASE}${p.startsWith('/') ? p : `/${p}`}`
}

function PaymentReceiptProofLink({ receiptPath }) {
  const href = paymentReceiptHref(receiptPath)
  if (!href) {
    return <span className="text-gray-400 text-sm tabular-nums select-none">—</span>
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold
                 bg-slate-100 text-slate-700 shadow-sm ring-1 ring-inset ring-slate-200/90
                 hover:bg-white hover:text-slate-900 hover:ring-slate-300 transition-colors"
      title="Ver comprobante"
      onClick={(e) => e.stopPropagation()}
    >
      <Eye size={13} className="shrink-0 opacity-90" aria-hidden strokeWidth={2} />
      Ver
    </a>
  )
}

function saleStatusLabel(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'approved') return 'Activado'
  if (s === 'pending') return 'Pendiente'
  if (s === 'payment_submitted') return 'En revisión'
  if (s === 'partially_paid') return 'Parcial'
  if (s === 'rejected') return 'Rechazado'
  if (s === 'annulled') return 'Cancelada'
  if (s === 'cancelled') return 'Anulado'
  return status || '—'
}


function formatLedgerMoney(amount, currency) {
  const n = Number(amount)
  const cur = String(currency || 'USD').toUpperCase().slice(0, 10)
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: 2,
    }).format(Number.isFinite(n) ? n : 0)
  } catch {
    return `${Number.isFinite(n) ? n.toFixed(2) : '0'} ${cur}`
  }
}

function LedgerCreditsCell({ entry }) {
  const isInvoice =
    entry?.entity_kind === 'sale'
    || String(entry?.type || '').toLowerCase() === 'factura'
  const credits = Number(entry?.total_credits)
  if (!isInvoice || !Number.isFinite(credits) || credits <= 0) {
    return <span className="text-gray-400 text-xs">—</span>
  }
  const label = Number.isInteger(credits) ? String(credits) : credits.toFixed(2)
  return (
    <span className="inline-flex items-center rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-bold tabular-nums text-emerald-800 ring-1 ring-emerald-100">
      {label}
    </span>
  )
}

function saleStatusBadgeClass(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'approved')
    return 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-100'
  if (s === 'pending') return 'bg-amber-50 text-amber-900 ring-1 ring-amber-100'
  if (s === 'rejected') return 'bg-red-50 text-red-800 ring-1 ring-red-100'
  if (s === 'annulled') return 'bg-slate-100 text-slate-700 ring-1 ring-slate-200'
  if (s === 'cancelled') return 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'
  return 'bg-gray-50 text-gray-700 ring-1 ring-gray-200'
}

/** Estado para filas RECARGA del ledger (etiquetas en español desde API). */
function walletRechargeLedgerStatusClass(label) {
  const s = String(label || '').toLowerCase()
  if (s.includes('rechaz')) return 'bg-red-50 text-red-800 ring-1 ring-red-100'
  if (s.includes('cancel')) return 'bg-slate-100 text-slate-700 ring-1 ring-slate-200'
  if (s.includes('activ')) return 'bg-emerald-50 text-emerald-800 ring-emerald-100'
  if (s.includes('parcial')) return 'bg-violet-50 text-violet-900 ring-violet-100'
  if (s.includes('revis')) return 'bg-sky-50 text-sky-800 ring-sky-100'
  if (s.includes('pendient')) return 'bg-amber-50 text-amber-900 ring-amber-100'
  return 'bg-fuchsia-50 text-fuchsia-900 ring-1 ring-fuchsia-100'
}

function pickClientNormalCreditCredsForDetail(c) {
  if (!c) return { user: '', pass: '' }
  const user = String(
    c.last_normal_credit_username ??
      c.lastNormalCreditUsername ??
      c.last_iptv_username ??
      c.lastIptvUsername ??
      '',
  ).trim()
  const pass = String(
    c.last_normal_credit_password ??
      c.lastNormalCreditPassword ??
      c.last_iptv_password ??
      c.lastIptvPassword ??
      '',
  ).trim()
  return { user, pass }
}

function DevToast({ message, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2800)
    return () => clearTimeout(t)
  }, [onDone])
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[80] flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium bg-slate-800 text-white ring-1 ring-white/10">
      <span className="text-sky-300">ℹ</span>
      {message}
      <button type="button" onClick={onDone} className="ml-1 text-white/50 hover:text-white text-xs">
        ✕
      </button>
    </div>
  )
}

export default function ClientDetail() {
  const { clientId } = useParams()
  const navigate = useNavigate()
  const { openNewSale, openReceivePayment } = useModal()
  const { hasPermission } = usePermissions()
  const canEdit = hasPermission(PERMS.CLIENTS_EDIT)

  const idNum = Number(clientId)
  const invalidId = !Number.isFinite(idNum) || idNum < 1

  const [client, setClient] = useState(null)
  const [sales, setSales] = useState([])
  const [ledger, setLedger] = useState([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState(null)

  const [editHeaderOpen, setEditHeaderOpen] = useState(false)
  const [editSale, setEditSale] = useState(null)
  const [menuSaleId, setMenuSaleId] = useState(null)
  const [txnMenuOpen, setTxnMenuOpen] = useState(false)
  const [walletRechargeModalLoadingId, setWalletRechargeModalLoadingId] = useState(null)
  const [walletRechargeViewerDetail, setWalletRechargeViewerDetail] = useState(null)
  const [devToast, setDevToast] = useState(null)
  const [detailTab, setDetailTab] = useState('historial')
  const [subClients, setSubClients] = useState([])
  const [subClientsLoading, setSubClientsLoading] = useState(false)
  const [subClientsErr, setSubClientsErr] = useState(null)
  const [revertTarget, setRevertTarget] = useState(null)
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false)
  const [revertLoading, setRevertLoading] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [expandedRowId, setExpandedRowId] = useState(null)
  const txnMenuRef = useRef(null)

  const HISTORY_PAGE_SIZE = 10
  const historyTotalPages = Math.max(1, Math.ceil(ledger.length / HISTORY_PAGE_SIZE))
  const paginatedLedger = useMemo(() => {
    const start = (currentPage - 1) * HISTORY_PAGE_SIZE
    return ledger.slice(start, start + HISTORY_PAGE_SIZE)
  }, [ledger, currentPage])

  useEffect(() => {
    setCurrentPage(1)
    setExpandedRowId(null)
  }, [ledger.length, idNum])

  const toastInfo = useCallback((msg) => setDevToast(msg), [])

  const openRevertTransferModal = useCallback((entry) => {
    if (!entry?.can_revert || !entry?.wallet_transaction_id) return
    setRevertTarget(entry)
    setRevertConfirmOpen(true)
  }, [])

  const closeRevertTransferModal = useCallback(() => {
    if (revertLoading) return
    setRevertConfirmOpen(false)
    setRevertTarget(null)
  }, [revertLoading])

  const openWalletRechargeViewer = useCallback(async (requestId) => {
    const rid = Number(requestId)
    if (!Number.isFinite(rid) || rid < 1) return
    setWalletRechargeModalLoadingId(rid)
    try {
      const { data } = await api.get(`/api/v1/distributors/recharge-requests/${rid}`)
      setWalletRechargeViewerDetail(data)
    } catch (err) {
      const d = err?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo cargar el detalle de la recarga.')
    } finally {
      setWalletRechargeModalLoadingId(null)
    }
  }, [])

  const handleViewLedgerPayment = useCallback(
    (entry) => {
      const paymentId = entry.payment_id ?? entry.entity_id
      if (!paymentId) return
      openReceivePayment(null, {
        viewMode: true,
        paymentId,
        paymentNumber: entry.ref_number,
        receiptUrl: entry.receipt_file_url,
      })
    },
    [openReceivePayment],
  )

  const copyCredToClipboard = useCallback(async (label, raw) => {
    const text = String(raw ?? '').trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setDevToast(`${label} copiado al portapapeles`)
    } catch (_) {
      setDevToast('No se pudo copiar. ¿Permiso del navegador?')
    }
  }, [])

  const fetchClient = useCallback(async () => {
    if (invalidId) return
    const { data } = await api.get(`/api/v1/clients/${idNum}`)
    setClient(data)
  }, [invalidId, idNum])

  const fetchSales = useCallback(async () => {
    if (invalidId) return
    const { data } = await api.get('/api/v1/sales/', { params: { client_id: idNum } })
    setSales(Array.isArray(data) ? data : [])
  }, [invalidId, idNum])

  const fetchLedger = useCallback(async () => {
    if (invalidId) return
    const { data } = await api.get(`/api/v1/clients/${idNum}/ledger`)
    setLedger(Array.isArray(data?.entries) ? data.entries : [])
  }, [invalidId, idNum])

  const reloadClientFinancials = useCallback(async () => {
    await Promise.all([fetchClient(), fetchLedger()])
  }, [fetchClient, fetchLedger])

  const confirmRevertTransfer = useCallback(async () => {
    const txId = revertTarget?.wallet_transaction_id ?? revertTarget?.entity_id
    if (!txId) return
    setRevertLoading(true)
    try {
      await api.post(`/api/v1/admin/transactions/${txId}/revert`)
      setRevertConfirmOpen(false)
      setRevertTarget(null)
      toastInfo('Transferencia revertida correctamente.')
      await reloadClientFinancials()
    } catch (err) {
      const d = err?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo revertir la transferencia.')
    } finally {
      setRevertLoading(false)
    }
  }, [revertTarget, reloadClientFinancials, toastInfo])

  const fetchSubClients = useCallback(async () => {
    if (invalidId) return
    setSubClientsLoading(true)
    setSubClientsErr(null)
    try {
      const { data } = await api.get(`/api/v1/clients/${idNum}/sub-clients`)
      setSubClients(Array.isArray(data) ? data : [])
    } catch (err) {
      const d = err?.response?.data?.detail
      setSubClientsErr(typeof d === 'string' ? d : 'No se pudo cargar la red de sub-clientes.')
      setSubClients([])
    } finally {
      setSubClientsLoading(false)
    }
  }, [invalidId, idNum])

  useEffect(() => {
    if (invalidId) {
      navigate('/clientes', { replace: true })
      return
    }
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setFetchError(null)
      try {
        await Promise.all([fetchClient(), fetchSales(), fetchLedger()])
      } catch (err) {
        if (!cancelled) {
          const d = err?.response?.data?.detail
          setFetchError(typeof d === 'string' ? d : 'No se pudo cargar el cliente.')
          setClient(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [invalidId, idNum, navigate, fetchClient, fetchSales, fetchLedger])

  useEffect(() => {
    if (detailTab !== 'subclients' || invalidId) return
    void fetchSubClients()
  }, [detailTab, invalidId, idNum, fetchSubClients])

  useEffect(() => {
    setRevertConfirmOpen(false)
    setRevertTarget(null)
  }, [idNum])

  useEffect(() => {
    if (menuSaleId == null) return
    function onDocClick(e) {
      if (!e.target.closest('[data-sale-row-actions]')) setMenuSaleId(null)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [menuSaleId])

  useEffect(() => {
    if (!txnMenuOpen) return undefined
    function onDocClick(e) {
      if (txnMenuRef.current && !txnMenuRef.current.contains(e.target)) setTxnMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [txnMenuOpen])

  const pendingByCurrency = useMemo(() => {
    const raw = client?.pending_balances_by_currency
    if (Array.isArray(raw) && raw.length > 0) {
      return raw
        .map((row) => ({
          currency: String(row?.currency || 'USD').trim().toUpperCase().slice(0, 10),
          amount: Number(row?.amount) || 0,
        }))
        .filter((row) => row.amount > 1e-9)
    }
    const legacyAmt = Number(client?.total_pending_balance) || 0
    const legacyCur = client?.pending_balance_currency || 'USD'
    if (legacyAmt > 1e-9) {
      return [{ currency: legacyCur, amount: legacyAmt }]
    }
    return []
  }, [client])

  const saldoPendienteLabel = useMemo(() => {
    if (pendingByCurrency.length === 0) {
      return formatClientMoney(0, client?.pending_balance_currency || 'USD')
    }
    if (pendingByCurrency.length === 1) {
      const r = pendingByCurrency[0]
      return formatClientMoney(r.amount, r.currency)
    }
    return pendingByCurrency
      .map((r) => formatClientMoney(r.amount, r.currency))
      .join(' · ')
  }, [pendingByCurrency, client?.pending_balance_currency])

  const creditByCurrency = useMemo(() => {
    const raw =
      client?.credit_balances_by_currency ??
      client?.available_credit_by_currency ??
      []
    if (Array.isArray(raw) && raw.length > 0) {
      return raw
        .map((row) => ({
          currency: String(row?.currency || 'USD').trim().toUpperCase().slice(0, 10),
          amount: Number(row?.amount) || 0,
        }))
        .filter((row) => row.amount > 1e-9)
    }
    const legacyAmt = Number(client?.credit_balance) || 0
    const legacyCur = client?.credit_balance_currency || 'USD'
    if (legacyAmt > 1e-9) {
      return [{ currency: legacyCur, amount: legacyAmt }]
    }
    return []
  }, [client])

  const saldoFavorLabel = useMemo(() => {
    if (creditByCurrency.length === 0) {
      return formatClientMoney(0, client?.credit_balance_currency || 'USD')
    }
    if (creditByCurrency.length === 1) {
      const r = creditByCurrency[0]
      return formatClientMoney(r.amount, r.currency)
    }
    return creditByCurrency
      .map((r) => formatClientMoney(r.amount, r.currency))
      .join(' · ')
  }, [creditByCurrency, client?.credit_balance_currency])

  const pagoVencido = 0

  async function handleSaveClient(cid, payload) {
    await api.patch(`/api/v1/clients/${cid}`, payload)
    await Promise.all([fetchClient(), fetchLedger()])
    setEditHeaderOpen(false)
  }

  const refreshAfterClientTransaction = useCallback(async () => {
    await Promise.all([fetchSales(), fetchClient(), fetchLedger()])
  }, [fetchSales, fetchClient, fetchLedger])

  function handleNewInvoice() {
    setTxnMenuOpen(false)
    openNewSale(refreshAfterClientTransaction, { clientId: idNum })
  }

  function handleReceivePaymentForClient() {
    setTxnMenuOpen(false)
    openReceivePayment(refreshAfterClientTransaction, { clientId: idNum })
  }

  if (invalidId) return null

  const { user: panelCredUser, pass: panelCredPass } = pickClientNormalCreditCredsForDetail(client)
  const hasSavedNormalCreditCred = !!(panelCredUser || panelCredPass)

  const trimmedName = (client?.name ?? '').trim()
  const trimmedUsername = (client?.username ?? '').trim()
  const clientPageTitle = trimmedName || trimmedUsername || 'Cliente'

  const revertModalParties = useMemo(() => {
    if (!revertTarget || !client) return null
    const amount = Number(revertTarget.baas_transfer_amount ?? Math.abs(revertTarget.amount ?? 0)) || 0
    const cpName = (revertTarget.revert_counterparty_name ?? '').trim() || '—'
    const selfName = clientPageTitle
    const isOut = Number(revertTarget.amount) < 0
    if (isOut) {
      return { amount, sender: selfName, receiver: cpName }
    }
    return { amount, sender: cpName, receiver: selfName }
  }, [revertTarget, client, clientPageTitle])

  return (
    <div className="max-w-6xl mx-auto px-4 pt-4 pb-6 space-y-4">
      <button
        type="button"
        onClick={() => navigate('/clientes')}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 hover:text-emerald-700 transition-colors"
      >
        <ArrowLeft size={16} aria-hidden />
        Volver a Clientes
      </button>

      {loading && (
        <div className="flex items-center justify-center py-24 text-gray-500 gap-2">
          <Loader2 className="animate-spin" size={22} />
          Cargando cliente…
        </div>
      )}

      {!loading && fetchError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {fetchError}
          <button
            type="button"
            className="ml-3 underline font-medium"
            onClick={() => navigate('/clientes')}
          >
            Volver al listado
          </button>
        </div>
      )}

      {!loading && client && (
        <>
          {client.parent_id != null && (client.parent_username || client.parent_name) && (
            <p className="text-sm text-gray-600 mt-1">
              Sub-cliente de{' '}
              <Link
                to={`/clientes/${client.parent_id}`}
                className="font-semibold text-emerald-600 hover:text-emerald-700"
              >
                {(client.parent_username || client.parent_name || '').trim() || `Cliente #${client.parent_id}`}
              </Link>
            </p>
          )}

          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight truncate mt-2 mb-3">
            {clientPageTitle}
          </h1>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8 items-start">
            {/* Columna izquierda: portal + contacto/credenciales */}
            <div className="lg:col-span-2 flex flex-col gap-6 min-w-0">
              {(client.portal_token || client.payment_token) && (
                <div
                  className="rounded-xl border-2 border-violet-400/90 bg-gradient-to-br from-violet-600 via-violet-700 to-indigo-800
                             p-6 text-white shadow-md ring-1 ring-white/15"
                >
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                    <div className="min-w-0 space-y-2">
                      <p className="text-xs font-bold uppercase tracking-wide text-violet-100">
                        Enlace al portal del cliente
                      </p>
                      <p className="text-sm text-white/90 leading-snug">
                        Comparte este enlace permanente: el cliente verá sus facturas pendientes y podrá adjuntar el
                        comprobante de pago cuando corresponda.
                      </p>
                      <p className="text-[11px] font-mono break-all text-violet-100/90 bg-black/20 rounded-lg px-2.5 py-2">
                        {clientPortalPublicUrl(client.portal_token ?? client.payment_token)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await copyClientPortalLink(client.portal_token ?? client.payment_token)
                          toastInfo('Enlace del portal copiado al portapapeles.')
                        } catch (_) {
                          toastInfo('No se pudo copiar el enlace.')
                        }
                      }}
                      className="inline-flex items-center justify-center gap-2 shrink-0 px-4 py-2.5 rounded-lg text-sm font-bold
                                 bg-white text-violet-800 hover:bg-violet-50 shadow-sm transition-colors w-full sm:w-auto"
                    >
                      <Link2 size={18} aria-hidden />
                      Copiar enlace
                    </button>
                  </div>
                </div>
              )}

              {/* Contacto y credenciales del panel */}
              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-md">
                <div className="mb-4 flex w-full items-center justify-between gap-3">
                  <p className="text-xs font-bold uppercase tracking-wide text-gray-500 m-0">
                    Datos de contacto
                  </p>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => setEditHeaderOpen(true)}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-600 transition-colors hover:bg-blue-100"
                    >
                      <Pencil size={14} aria-hidden />
                      Editar
                    </button>
                  )}
                </div>

                <dl className="grid grid-cols-1 sm:[grid-template-columns:minmax(7.5rem,10rem)_1fr] gap-x-4 gap-y-3 text-sm mb-6 pb-6 border-b border-gray-100">
                  <dt className="text-gray-500 font-medium shrink-0 pt-0.5">
                    Nombre / alias
                  </dt>
                  <dd className="text-gray-900 font-semibold leading-snug min-w-0 break-words">
                    {trimmedName ? (
                      trimmedName
                    ) : (
                      <span className="text-gray-400 italic font-normal">Sin nombre registrado</span>
                    )}
                  </dd>

                  <dt className="text-gray-500 font-medium shrink-0 pt-0.5">Usuario IPTV</dt>
                  <dd className="min-w-0">
                    {trimmedUsername ? (
                      <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-1 text-xs sm:text-sm font-mono font-semibold text-slate-800 ring-1 ring-inset ring-slate-200/90">
                        {trimmedUsername}
                      </span>
                    ) : (
                      <span className="text-gray-400 italic">—</span>
                    )}
                  </dd>

                  <dt className="text-gray-500 font-medium shrink-0 pt-0.5">Email</dt>
                  <dd className="text-gray-800 min-w-0 break-all flex items-start gap-2">
                    <Mail size={14} className="text-gray-400 shrink-0 mt-0.5" aria-hidden />
                    <span>{client.email || <span className="text-gray-400 italic">Sin email</span>}</span>
                  </dd>

                  <dt className="text-gray-500 font-medium shrink-0 pt-0.5">Teléfono</dt>
                  <dd className="text-gray-800 flex items-start gap-2">
                    <Phone size={14} className="text-gray-400 shrink-0 mt-0.5" aria-hidden />
                    <span className="tabular-nums">{client.phone?.trim() ? client.phone : '—'}</span>
                  </dd>

                  <dt className="text-gray-500 font-medium shrink-0 pt-0.5">País</dt>
                  <dd className="text-gray-800 flex items-start gap-2">
                    <Globe size={14} className="text-gray-400 shrink-0 mt-0.5" aria-hidden />
                    <span>{client.country?.trim() ? client.country : '—'}</span>
                  </dd>
                </dl>

              {hasSavedNormalCreditCred ? (
                <div aria-label="Credenciales del panel activo">
                  <p className="text-xs font-bold uppercase tracking-wide text-emerald-800 mb-2">
                    Credenciales del panel activo
                  </p>
                  <p className="text-[11px] text-emerald-700/90 mb-4 leading-snug">
                    Último usuario y contraseña IPTV guardados desde ventas de crédito normal (asistencia técnica).
                  </p>
                  <ul className="space-y-2.5">
                    <li className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="text-xs font-semibold text-emerald-900 shrink-0 w-[8.5rem]">
                        Panel usuario
                      </span>
                      <code className="flex-1 min-w-0 text-sm font-mono text-slate-800 bg-white/80 px-2.5 py-1.5 rounded-lg border border-emerald-100 break-all">
                        {panelCredUser || '—'}
                      </code>
                      <button
                        type="button"
                        disabled={!panelCredUser}
                        title="Copiar usuario"
                        onClick={() => copyCredToClipboard('Usuario', panelCredUser)}
                        className="inline-flex items-center gap-1.5 shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-semibold
                                   text-emerald-800 bg-white border border-emerald-200 hover:bg-emerald-50
                                   disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Clipboard size={14} aria-hidden />
                        Copiar
                      </button>
                    </li>
                    <li className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="text-xs font-semibold text-emerald-900 shrink-0 w-[8.5rem]">
                        Contraseña
                      </span>
                      <code className="flex-1 min-w-0 text-sm font-mono text-slate-800 bg-white/80 px-2.5 py-1.5 rounded-lg border border-emerald-100 break-all">
                        {panelCredPass ? panelCredPass : '—'}
                      </code>
                      <button
                        type="button"
                        disabled={!panelCredPass}
                        title="Copiar contraseña"
                        onClick={() => copyCredToClipboard('Contraseña', panelCredPass)}
                        className="inline-flex items-center gap-1.5 shrink-0 px-2.5 py-1.5 rounded-lg text-xs font-semibold
                                   text-emerald-800 bg-white border border-emerald-200 hover:bg-emerald-50
                                   disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Clipboard size={14} aria-hidden />
                        Copiar
                      </button>
                    </li>
                  </ul>
                </div>
              ) : (
                <p className="text-sm text-gray-500 italic mb-0">No hay credenciales de panel IPTV guardadas.</p>
              )}
              </div>
            </div>

            {/* Columna derecha: nueva transacción + resumen */}
            <div className="lg:col-span-1 flex flex-col min-w-0">
              <div className="relative w-full mb-4 shrink-0" ref={txnMenuRef}>
                <button
                  type="button"
                  onClick={() => setTxnMenuOpen((o) => !o)}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-xl bg-emerald-600 text-white hover:bg-emerald-700 shadow-md transition-colors"
                  aria-expanded={txnMenuOpen}
                  aria-haspopup="menu"
                >
                  Nueva transacción
                  <ChevronDown
                    size={16}
                    className={`shrink-0 transition-transform ${txnMenuOpen ? 'rotate-180' : ''}`}
                    aria-hidden
                  />
                </button>
                {txnMenuOpen && (
                  <div
                    role="menu"
                    className="absolute left-0 right-0 z-40 mt-1 w-full rounded-xl border border-gray-200 bg-white py-1 text-sm shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full px-4 py-2.5 text-left text-gray-800 hover:bg-gray-50"
                      onClick={handleNewInvoice}
                    >
                      📄 Nueva factura
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="block w-full px-4 py-2.5 text-left text-gray-800 hover:bg-gray-50"
                      onClick={handleReceivePaymentForClient}
                    >
                      💰 Recibir pago
                    </button>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-sky-200 bg-sky-50/90 p-6 shadow-md">
                <div className="flex items-center gap-2 text-sky-900 font-semibold text-sm mb-5">
                  <span className="rounded-lg bg-sky-100 p-1.5 ring-1 ring-sky-200">
                    <DollarSign size={18} className="text-sky-700" aria-hidden />
                  </span>
                  Resumen financiero
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between items-baseline gap-4">
                    <span className="text-sm font-medium text-amber-700">Saldo pendiente</span>
                    <span className="text-sm font-semibold tabular-nums text-amber-800">
                      {saldoPendienteLabel}
                    </span>
                  </div>
                  {creditByCurrency.length > 0 ? (
                    <div className="flex justify-between items-baseline gap-4 border-t border-sky-200/80 pt-3">
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700">
                        <span
                          className="inline-flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_10px_theme(colors.emerald.400)]"
                          aria-hidden
                        />
                        Saldo a favor
                      </span>
                      <span className="text-sm font-semibold tabular-nums text-emerald-800 text-right">
                        {saldoFavorLabel}
                      </span>
                    </div>
                  ) : null}
                  <div className="flex justify-between items-baseline gap-4 border-t border-sky-200/80 pt-3">
                    <span className="text-sm font-medium text-red-700">Pago vencido</span>
                    <span className="text-sm font-semibold tabular-nums text-red-800">
                      {formatClientMoney(pagoVencido, client?.pending_balance_currency || 'USD')}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="border-b border-gray-200">
            <nav className="flex gap-6">
              <button
                type="button"
                onClick={() => setDetailTab('historial')}
                className={`inline-block pb-3 text-sm font-semibold -mb-px transition-colors ${
                  detailTab === 'historial'
                    ? 'text-gray-900 border-b-2 border-emerald-600'
                    : 'text-gray-500 border-b-2 border-transparent hover:text-gray-800'
                }`}
              >
                Historial (facturas, pagos y recargas BaaS)
              </button>
              <button
                type="button"
                onClick={() => setDetailTab('subclients')}
                className={`inline-block pb-3 text-sm font-semibold -mb-px transition-colors ${
                  detailTab === 'subclients'
                    ? 'text-gray-900 border-b-2 border-emerald-600'
                    : 'text-gray-500 border-b-2 border-transparent hover:text-gray-800'
                }`}
              >
                Red de Sub-clientes
              </button>
            </nav>
          </div>

          {detailTab === 'subclients' ? (
            <div className="rounded-xl border border-gray-200 bg-white shadow-md overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-gray-600 m-0">
                  Clientes creados bajo este distribuidor ({subClients.length})
                </p>
                <button
                  type="button"
                  onClick={() => void fetchSubClients()}
                  disabled={subClientsLoading}
                  className="text-sm font-medium text-emerald-600 hover:text-emerald-700 disabled:opacity-50"
                >
                  Actualizar
                </button>
              </div>
              {subClientsLoading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-gray-500">
                  <Loader2 className="animate-spin" size={20} />
                  Cargando sub-clientes…
                </div>
              ) : subClientsErr ? (
                <p className="px-4 py-8 text-sm text-red-700">{subClientsErr}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50/80 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">
                        <th className="px-4 py-3">Nombre</th>
                        <th className="px-4 py-3">Usuario IPTV</th>
                        <th className="px-4 py-3 text-right">Saldo BaaS</th>
                        <th className="px-4 py-3 text-right">Perfil</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {subClients.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-4 py-12 text-center text-gray-500">
                            Este cliente aún no tiene sub-clientes registrados.
                          </td>
                        </tr>
                      ) : (
                        subClients.map((sc) => {
                          const scName = (sc?.name ?? '').trim() || (sc?.username ?? '').trim() || '—'
                          const scUser = (sc?.username ?? '').trim() || '—'
                          const scBal = Number(sc?.wallet_balance) || 0
                          return (
                            <tr key={`sub-${sc.id}`} className="hover:bg-gray-50/70">
                              <td className="px-4 py-3 font-medium text-gray-900">{scName}</td>
                              <td className="px-4 py-3 font-mono text-xs text-slate-700">{scUser}</td>
                              <td className="px-4 py-3 text-right tabular-nums font-semibold text-violet-800">
                                {formatClientMoney(scBal, 'USD')}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <Link
                                  to={`/clientes/${sc.id}`}
                                  className="text-sm font-semibold text-emerald-600 hover:text-emerald-700"
                                >
                                  Ver perfil →
                                </Link>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
          <div className="rounded-xl border border-gray-200 bg-white shadow-md">
            <div className="overflow-x-auto w-full whitespace-nowrap">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50/80 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 border-b border-gray-200">
                    <th className="px-2 py-3 w-10" aria-label="Expandir fila" />
                    <th className="px-4 py-3 whitespace-nowrap">FECHA</th>
                    <th className="px-4 py-3 whitespace-nowrap">TIPO</th>
                    <th className="px-4 py-3 whitespace-nowrap">N.º</th>
                    <th className="px-4 py-3 text-right whitespace-nowrap">IMPORTE</th>
                    <th className="px-4 py-3 whitespace-nowrap">ESTADO</th>
                    <th className="px-4 py-3 text-center whitespace-nowrap w-[7.5rem]">COMPROBANTE</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {ledger.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-gray-500 whitespace-normal">
                        No hay movimientos en el historial de este cliente.
                      </td>
                    </tr>
                  )}
                  {paginatedLedger.map((entry) => {
                    const isPayment = entry.type === 'Pago'
                    const isRecharge =
                      entry.type === 'RECARGA'
                      || entry.type === 'Recarga BaaS'
                      || entry.entity_kind === 'wallet_recharge'
                      || entry.entity_kind === 'wallet_recharge_payment'
                    const isBaasTransfer =
                      entry.entity_kind === 'wallet_transfer'
                      && String(entry.type || '').toLowerCase().includes('transferencia baas')
                    const isTransferRevert =
                      entry.entity_kind === 'wallet_transfer'
                      && String(entry.type || '').toLowerCase().includes('reversión')
                    const related = Array.isArray(entry.related_docs) ? entry.related_docs : []
                    const saleForRow =
                      entry.entity_kind === 'sale'
                        ? sales.find((s) => Number(s.id) === Number(entry.entity_id))
                        : null
                    const rowHighlight = isPayment
                      ? 'bg-indigo-50/30 hover:bg-indigo-50/50'
                      : isRecharge
                        ? 'bg-fuchsia-50/25 hover:bg-fuchsia-50/40'
                        : isBaasTransfer || isTransferRevert
                          ? 'bg-orange-50/20 hover:bg-orange-50/35'
                          : 'hover:bg-gray-50/70'
                    const rowKey = entry.entity_kind === 'wallet_transfer'
                      ? `wt-${entry.wallet_transaction_id ?? entry.entity_id}`
                      : `${entry.entity_kind}-${entry.entity_id}`
                    const isExpanded = expandedRowId === rowKey
                    return (
                      <Fragment key={rowKey}>
                        <tr className={rowHighlight}>
                          <td className="px-2 py-3 text-center align-middle">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedRowId((prev) => (prev === rowKey ? null : rowKey))
                              }
                              className="inline-flex items-center justify-center rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800 transition-colors"
                              aria-expanded={isExpanded}
                              aria-label={isExpanded ? 'Contraer detalles' : 'Expandir detalles'}
                            >
                              {isExpanded ? (
                                <ChevronDown size={16} aria-hidden />
                              ) : (
                                <ChevronRight size={16} aria-hidden />
                              )}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                            {formatDateTimeEcuador(entry.date)}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <span
                              className={`text-xs font-bold uppercase px-2 py-0.5 rounded ${
                                isPayment
                                  ? 'bg-indigo-100 text-indigo-800'
                                  : isRecharge
                                    ? 'bg-fuchsia-100 text-fuchsia-900 ring-1 ring-fuchsia-200/80'
                                    : isBaasTransfer || isTransferRevert
                                      ? 'bg-orange-100 text-orange-900 ring-1 ring-orange-200/80'
                                      : 'bg-slate-100 text-slate-700'
                              }`}
                            >
                              {entry.type}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-900 font-medium whitespace-nowrap tabular-nums">
                            {entry.ref_number}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap font-semibold tabular-nums text-gray-900">
                            {formatLedgerMoney(entry.amount, entry.currency)}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap align-top">
                            <span
                              className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                                isPayment
                                  ? 'bg-sky-50 text-sky-800 ring-1 ring-sky-100'
                                  : isRecharge
                                    ? walletRechargeLedgerStatusClass(entry.status)
                                    : saleStatusBadgeClass(entry.status)
                              }`}
                            >
                              {isPayment ? entry.status : isRecharge ? entry.status : saleStatusLabel(entry.status)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center whitespace-nowrap align-middle w-[7.5rem]">
                            {saleForRow ? (
                              <SaleReceiptProofLink sale={saleForRow} />
                            ) : isPayment || isRecharge ? (
                              <PaymentReceiptProofLink receiptPath={entry.receipt_file_url} />
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-gray-50/80">
                            <td colSpan={7} className="px-4 py-4 whitespace-normal border-t border-gray-100">
                              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-sm">
                                <div className="sm:col-span-2 lg:col-span-2">
                                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">
                                    Nota
                                  </p>
                                  <p className="text-gray-700 text-xs leading-relaxed break-words">
                                    {entry.note || '—'}
                                  </p>
                                  {related.length > 0 && (
                                    <p className="mt-2 text-xs text-indigo-700 leading-relaxed break-words">
                                      {isPayment ? 'Aplicado a: ' : 'Pagos: '}
                                      {related
                                        .map((r) =>
                                          `${r.type} ${r.ref_number} (${formatLedgerMoney(r.amount, entry.currency)})`,
                                        )
                                        .join(' · ')}
                                    </p>
                                  )}
                                </div>
                                <div>
                                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">
                                    Créditos
                                  </p>
                                  <LedgerCreditsCell entry={entry} />
                                </div>
                                <div>
                                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">
                                    Acción
                                  </p>
                                  <div>
                                    {saleForRow ? (
                                      <button
                                        type="button"
                                        className="text-sm font-medium text-emerald-600 hover:text-emerald-700 px-2 py-1 rounded-lg hover:bg-emerald-50"
                                        onClick={() => setEditSale(saleForRow)}
                                      >
                                        {saleOpensReadOnly(saleForRow) ? 'Ver detalles' : 'Ver/editar'}
                                      </button>
                                    ) : isRecharge ? (
                                      <button
                                        type="button"
                                        disabled={walletRechargeModalLoadingId != null}
                                        className="text-sm font-medium text-fuchsia-700 hover:text-fuchsia-900 px-2 py-1 rounded-lg hover:bg-fuchsia-50 disabled:opacity-45 disabled:pointer-events-none"
                                        onClick={() => void openWalletRechargeViewer(Number(entry.entity_id))}
                                      >
                                        {walletRechargeModalLoadingId === Number(entry.entity_id) ? (
                                          <span className="inline-flex items-center gap-1.5 tabular-nums">
                                            <Loader2 size={14} className="animate-spin shrink-0" aria-hidden />
                                            Cargando…
                                          </span>
                                        ) : (
                                          'Ver detalles'
                                        )}
                                      </button>
                                    ) : isPayment ? (
                                      <button
                                        type="button"
                                        className="text-sm font-medium text-indigo-600 hover:text-indigo-700 px-2 py-1 rounded-lg hover:bg-indigo-50"
                                        onClick={() => handleViewLedgerPayment(entry)}
                                      >
                                        Ver detalles
                                      </button>
                                    ) : entry.can_revert ? (
                                      <button
                                        type="button"
                                        className="text-xs font-semibold text-red-700 hover:text-red-800 px-2 py-1 rounded-lg hover:bg-red-50 ring-1 ring-red-200/80"
                                        onClick={() => openRevertTransferModal(entry)}
                                      >
                                        Revertir
                                      </button>
                                    ) : (
                                      <span className="text-xs text-gray-400">—</span>
                                    )}
                                  </div>
                                </div>
                                <div className="sm:col-span-2 lg:col-span-3 pt-2 border-t border-gray-200/80">
                                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                                    Detalles técnicos
                                  </p>
                                  <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-2 text-xs">
                                    <div>
                                      <dt className="text-gray-500">Entidad</dt>
                                      <dd className="font-mono text-gray-800 mt-0.5">{entry.entity_kind || '—'}</dd>
                                    </div>
                                    <div>
                                      <dt className="text-gray-500">ID entidad</dt>
                                      <dd className="font-mono text-gray-800 mt-0.5 tabular-nums">{entry.entity_id ?? '—'}</dd>
                                    </div>
                                    {entry.wallet_transaction_id != null && (
                                      <div>
                                        <dt className="text-gray-500">ID transacción BaaS</dt>
                                        <dd className="font-mono text-gray-800 mt-0.5 tabular-nums">
                                          {entry.wallet_transaction_id}
                                        </dd>
                                      </div>
                                    )}
                                    <div>
                                      <dt className="text-gray-500">Moneda</dt>
                                      <dd className="font-mono text-gray-800 mt-0.5">{entry.currency || 'USD'}</dd>
                                    </div>
                                    <div>
                                      <dt className="text-gray-500">Estado (API)</dt>
                                      <dd className="font-mono text-gray-800 mt-0.5">{entry.status || '—'}</dd>
                                    </div>
                                  </dl>
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
            {ledger.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-gray-100 bg-gray-50/50">
                <button
                  type="button"
                  disabled={currentPage <= 1}
                  onClick={() => {
                    setCurrentPage((p) => Math.max(1, p - 1))
                    setExpandedRowId(null)
                  }}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                >
                  Anterior
                </button>
                <p className="text-sm text-gray-600 tabular-nums">
                  Página {currentPage} de {historyTotalPages}
                  <span className="text-gray-400 mx-1">·</span>
                  {ledger.length} movimiento{ledger.length === 1 ? '' : 's'}
                </p>
                <button
                  type="button"
                  disabled={currentPage >= historyTotalPages}
                  onClick={() => {
                    setCurrentPage((p) => Math.min(historyTotalPages, p + 1))
                    setExpandedRowId(null)
                  }}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                >
                  Siguiente
                </button>
              </div>
            )}
          </div>
          )}
        </>
      )}

      {revertConfirmOpen && revertModalParties && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/45">
          <div
            className="w-full max-w-md rounded-2xl bg-white shadow-xl ring-1 ring-gray-200 p-6 space-y-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="revert-transfer-title"
          >
            <h2 id="revert-transfer-title" className="text-lg font-bold text-gray-900">
              Confirmar reversión
            </h2>
            <p className="text-sm text-gray-700 leading-relaxed">
              ⚠️ Atención: Vas a revertir una transferencia de{' '}
              <strong>{formatLedgerMoney(revertModalParties.amount, 'USD')}</strong>. Se le descontará el
              saldo a <strong>{revertModalParties.receiver}</strong> y se le devolverá a{' '}
              <strong>{revertModalParties.sender}</strong>. ¿Estás seguro de proceder?
            </p>
            <div className="flex flex-wrap justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={revertLoading}
                onClick={closeRevertTransferModal}
                className="px-4 py-2 rounded-lg text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={revertLoading}
                onClick={() => void confirmRevertTransfer()}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {revertLoading ? (
                  <>
                    <Loader2 size={14} className="animate-spin" aria-hidden />
                    Revirtiendo…
                  </>
                ) : (
                  'Sí, revertir transferencia'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {canEdit && editHeaderOpen && client && (
        <EditModal
          client={client}
          onClose={() => setEditHeaderOpen(false)}
          onSave={handleSaveClient}
        />
      )}

      {walletRechargeViewerDetail ? (
        <VerRecargaModal
          open
          detail={walletRechargeViewerDetail}
          onClose={() => setWalletRechargeViewerDetail(null)}
        />
      ) : null}

      {editSale && (
        <NuevaVentaModal
          initialSale={editSale}
          readOnlyMode={saleOpensReadOnly(editSale)}
          prefillClientId={null}
          onClose={() => setEditSale(null)}
          onSuccess={async () => {
            setEditSale(null)
            await fetchSales()
            await fetchClient()
            await fetchLedger()
          }}
          onToast={(msg, variant) => {
            if (variant === 'error') window.alert(msg)
            else toastInfo(msg)
          }}
        />
      )}

      {devToast && (
        <DevToast message={devToast} onDone={() => setDevToast(null)} />
      )}
    </div>
  )
}
