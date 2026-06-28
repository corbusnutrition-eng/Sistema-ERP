import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  RefreshCw,
  Wallet,
  Building2,
  PlusCircle,
  ClipboardList,
  Users,
  CheckCircle,
  XCircle,
  Sparkles,
  Ban,
  MessageSquare,
  Pencil,
  X,
  Search,
  Bell,
} from 'lucide-react'

import api from '../../api/axios'
import usePermissions from '../../hooks/usePermissions'
import {
  BAAS_TAB_PERMISSIONS,
  PERMS,
} from '../../lib/permissions'
import { useAuth } from '../../context/AuthContext'
import { notifyAccountsReceivableStale } from '../../utils/arReportEvents'
import StatusFilterTabs from '../../components/ui/StatusFilterTabs'
import NewRechargeModal, { normalizeClienteDesdeWebhook, newRechargeLineRow } from './NewRechargeModal'
import UpdateClientPricesModal from './UpdateClientPricesModal'
import { currencyFromLastSelectedDepositIds } from '../../lib/accountCurrencyCascade'
import { normalizeCurrencyCode } from '../../lib/currencyCode'
import { salesCurrencyExchangeRateString } from '../sales/salesCurrencies'
import {
  formatSaleTableDate,
  formatSaleDocNo,
  SaleListNotesCell,
  SaleReceiptProofLink,
  RechargeAmountCell,
  CopyPaymentLinkButton,
  copyClientPortalLink,
} from '../sales/saleTableHelpers'
import OcrSecurityBadges, {
  pickOcrFlagsFromRecharge,
  isIllegibleDeclaredRecord,
  IllegibleReceiptAlert,
  declaredDepositInputValueFromReview,
  pickPendingReviewLinkedPayment,
} from '../../components/OcrSecurityBadges'

const NotificationManagementPanel = lazy(() => import('./NotificationManagementPanel'))

function ResizableTh({ children, align = 'left', className = '' }) {
  const ta =
    align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
  return (
    <th
      className={`px-3 py-2 ${ta} text-[11px] font-semibold text-gray-500 uppercase tracking-wider ${className}`}
    >
      <div className="resize-x overflow-hidden whitespace-nowrap min-w-[100px] inline-block align-middle">
        {children}
      </div>
    </th>
  )
}

/** Pestañas de estado BaaS — mismo componente que Ventas (`StatusFilterTabs`). */
const RECHARGE_FILTERS = [
  { id: 'pending', label: 'Pendientes', apiStatus: 'pending', badgeClass: 'bg-amber-500' },
  { id: 'in_review', label: 'En revisión', apiStatus: 'in_review', badgeClass: 'bg-sky-500' },
  { id: 'approved', label: 'Activado', apiStatus: 'approved', badgeClass: 'bg-emerald-500' },
  { id: 'rejected', label: 'Rechazado', apiStatus: 'rejected', badgeClass: 'bg-red-500' },
  { id: 'canceled', label: 'Cancelado', apiStatus: 'canceled', badgeClass: 'bg-slate-500' },
]

function normalizeRechargeStatus(status) {
  return String(status ?? '')
    .trim()
    .toLowerCase()
}

/** Filtro estricto por pestaña sobre el estado maestro (sin mezclar estados). */
function rechargeRequestMatchesTab(row, tabId) {
  const st = normalizeRechargeStatus(row?.status)
  switch (tabId) {
    case 'pending':
      return st === 'pending'
    case 'in_review':
      return st === 'in_review'
    case 'approved':
      return st === 'approved' || st === 'partially_paid'
    case 'rejected':
      return st === 'rejected'
    case 'canceled':
      return st === 'canceled'
    default:
      return false
  }
}

function dedupeRechargeRequestsById(rows) {
  const byId = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.id == null) continue
    const id = row.id
    const prev = byId.get(id)
    byId.set(id, prev ? { ...prev, ...row } : row)
  }
  return Array.from(byId.values()).sort((a, b) => {
    const ta = new Date(a?.created_at ?? 0).getTime()
    const tb = new Date(b?.created_at ?? 0).getTime()
    return tb - ta
  })
}

function upsertRechargeRequestInList(prev, updated) {
  if (updated?.id == null) return dedupeRechargeRequestsById(prev)
  const id = updated.id
  const idx = prev.findIndex((r) => r.id === id)
  if (idx >= 0) {
    return dedupeRechargeRequestsById(prev.map((r) => (r.id === id ? { ...r, ...updated } : r)))
  }
  return dedupeRechargeRequestsById([updated, ...prev])
}

function rechargeHasOpenCxcBalance(row) {
  const bp = Number(row?.balance_pending ?? 0)
  return Number.isFinite(bp) && bp > 1e-6
}

function rechargeAwaitingClientReceipt(row) {
  const st = String(row?.status ?? '').toLowerCase()
  return (st === 'approved' || st === 'partially_paid') && rechargeHasOpenCxcBalance(row)
}

function rechargeFilterEmptyCopy(tabId) {
  if (tabId === 'pending') return 'pendientes'
  if (tabId === 'in_review') return 'en revisión'
  if (tabId === 'rejected') return 'rechazadas'
  if (tabId === 'canceled') return 'canceladas'
  return 'activadas'
}

function RechargeStatusBadge({ status }) {
  const cfg = {
    pending: { label: 'Pendiente', cls: 'bg-amber-50 text-amber-900 ring-amber-200/80' },
    in_review: { label: 'En revisión', cls: 'bg-sky-50 text-sky-800 ring-sky-100' },
    partially_paid: { label: 'Parcial', cls: 'bg-amber-50 text-amber-900 ring-amber-200/80' },
    approved: { label: 'Activado', cls: 'bg-emerald-50 text-emerald-900 ring-emerald-100' },
    rejected: { label: 'Rechazado', cls: 'bg-red-50 text-red-800 ring-red-100' },
    canceled: { label: 'Cancelado', cls: 'bg-slate-100 text-slate-700 ring-slate-200' },
  }
  const x = cfg[status] || {
    label: status ? String(status) : '—',
    cls: 'bg-gray-50 text-gray-700 ring-gray-100',
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${x.cls}`}
    >
      {x.label}
    </span>
  )
}

/** Restaura líneas del modal desde la solicitud ERP (snapshot JSON o fallback una fila). */
function rechargeLinesHydrateFromAdminRow(row) {
  const raw = row?.recharge_detail_lines
  const rid = row?.id != null ? String(row.id) : 'new'
  const reqCurrency = normalizeCurrencyCode(row?.recharge_currency ?? 'USD', 'USD')

  const withTableCurrency = (lines) =>
    lines.map((li) => ({
      ...li,
      tipo_moneda: reqCurrency,
    }))

  if (Array.isArray(raw) && raw.length > 0) {
    const mapped = raw.map((r, idx) => {
      const qtyNum = Number(r?.qty)
      const rateNum = Number(r?.rate)
      // Migración líneas viejas / API (subtotal efectivo derivado sólo si falta saldo_recargar)
      let legacyLineCharge = Number(r?.line_amount ?? r?.monto_linea)
      if (!Number.isFinite(legacyLineCharge) || legacyLineCharge <= 0) {
        legacyLineCharge =
          Number.isFinite(qtyNum) &&
          qtyNum > 0 &&
          Number.isFinite(rateNum) &&
          rateNum > 0 ?
            Math.round(qtyNum * rateNum * 100) / 100
          : NaN
      }
      let saldoNum = Number(r?.saldo_recargar ?? r?.balance_to_recharge ?? r?.virtual_balance)
      if (!Number.isFinite(saldoNum) || saldoNum <= 0) {
        saldoNum = Number.isFinite(qtyNum) && qtyNum > 0 ? qtyNum : NaN
      }
      if (!Number.isFinite(saldoNum) || saldoNum <= 0) {
        saldoNum = Number.isFinite(legacyLineCharge) ? legacyLineCharge : NaN
      }
      const saldoStr = Number.isFinite(saldoNum) && saldoNum > 0 ? String(saldoNum) : ''

      return {
        id: `rli-e-${rid}-${idx}`,
        producto: String(r.producto ?? r.product_name ?? r.product ?? 'BaaS Balance'),
        saldo_recargar: saldoStr,
      }
    })
    return withTableCurrency(mapped)
  }
  const amt = row?.amount_requested
  const amtStr =
    amt != null && Number.isFinite(Number(amt)) && Number(amt) > 0 ? String(Number(amt)) : ''
  return withTableCurrency([
    {
      id: `rli-single-${rid}`,
      producto: 'BaaS Balance',
      saldo_recargar: amtStr,
    },
  ])
}

/** Arma líneas + subtotal válidos para `generate-recharge-link` / PATCH (moneda unificada; cobrar = saldo por línea). */
function buildWalletRechargeApiPayload(linkLineItems) {
  const linePayload = []
  let subtotal = 0
  const rows = Array.isArray(linkLineItems) ? linkLineItems : []
  if (!rows.length) return { ok: false, msg: 'Añade al menos una línea.' }

  const leadCur = normalizeCurrencyCode(rows[0]?.tipo_moneda ?? 'USD', 'USD')

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const rowCur = normalizeCurrencyCode(row?.tipo_moneda ?? 'USD', 'USD')
    if (rowCur !== leadCur) {
      return { ok: false, msg: `Línea ${i + 1}: la moneda debe coincidir con la primera fila (${leadCur}).` }
    }

    const saldo = Number(String(row?.saldo_recargar ?? '').replace(',', '.'))
    if (!Number.isFinite(saldo) || saldo <= 0) {
      return {
        ok: false,
        msg: `Línea ${i + 1}: indica saldo a recargar (>0) en ${leadCur}.`,
      }
    }
    const lineAmt = Math.round(saldo * 100) / 100
    subtotal += lineAmt

    // `importe` en API = cargo por línea; en UI sólo existe saldo_recargar (+ tipo_moneda)
    linePayload.push({
      product_name: String(row.producto ?? 'BaaS Balance').trim() || 'BaaS Balance',
      tipo_moneda: leadCur,
      saldo_recargar: Math.round(saldo * 100000000) / 100000000,
      importe: lineAmt,
    })
  }
  subtotal = Math.round(subtotal * 100) / 100
  if (subtotal <= 0) return { ok: false, msg: 'El subtotal debe ser mayor que cero.' }
  return { ok: true, linePayload, subtotal, currency: leadCur }
}

export default function DistributorsBaaSPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const wrDeepLinkHandledRef = useRef(null)
  const { hasPermission } = usePermissions()
  const { isAdmin } = useAuth()

  const allowedTabs = useMemo(() => {
    const tabs = []
    if (hasPermission(BAAS_TAB_PERMISSIONS.users)) tabs.push('users')
    if (hasPermission(BAAS_TAB_PERMISSIONS.requests)) tabs.push('requests')
    if (hasPermission(BAAS_TAB_PERMISSIONS.notifications)) tabs.push('notifications')
    return tabs
  }, [hasPermission])

  const canCreateRecharge = hasPermission(PERMS.BAAS_RECHARGE_REQUESTS_CREATE)
  const canEditRecharge = hasPermission(PERMS.BAAS_RECHARGE_REQUESTS_EDIT)
  const canApproveRecharge = hasPermission(PERMS.BAAS_RECHARGE_REQUESTS_APPROVE)
  const canViewTree = hasPermission(PERMS.BAAS_TREE_VIEW)

  const [tab, setTab] = useState(() => allowedTabs[0] ?? 'users')

  const [users, setUsers] = useState([])
  const [loadingUsers, setLoadingUsers] = useState(true)
  const [baasSearch, setBaasSearch] = useState('')

  /** Estado maestro: todas las solicitudes; cada pestaña filtra en derivado. */
  const [rechargeRequests, setRechargeRequests] = useState([])
  const [loadingRequests, setLoadingRequests] = useState(false)
  const rechargeFetchGenRef = useRef(0)
  /** Coincide con valores canónicos del backend (pending, in_review, …). */
  const [rechargeActiveTab, setRechargeActiveTab] = useState('in_review')

  const [toast, setToast] = useState('')
  const [processingReqId, setProcessingReqId] = useState(null)

  const [linkModalOpen, setLinkModalOpen] = useState(false)
  /** Cliente BaaS seleccionado para gestión de precios (modal 🏷️ Precios). */
  const [pricesModalClient, setPricesModalClient] = useState(null)
  /** Cliente CRM preseleccionado al abrir el modal desde «Recargar billetera». */
  const [linkModalPrefillClient, setLinkModalPrefillClient] = useState(null)
  /** Lista para efectos del padre (valor por defecto de link): GET ERP con fallback local. */
  const [clientes, setClientes] = useState([])
  const [clientesLoading, setClientesLoading] = useState(false)
  const [clientesError, setClientesError] = useState(null)
  const [linkClientId, setLinkClientId] = useState('')
  const [linkLineItems, setLinkLineItems] = useState(() => [newRechargeLineRow()])
  const [linkDepositUsd, setLinkDepositUsd] = useState('')
  const [linkComment, setLinkComment] = useState('')
  const [generatingLink, setGeneratingLink] = useState(false)
  const [linkReceiptFile, setLinkReceiptFile] = useState(null)

  const [paymentMethods, setPaymentMethods] = useState([])
  const [depositAccounts, setDepositAccounts] = useState([])
  const [selectedPaymentMethodIds, setSelectedPaymentMethodIds] = useState([])
  const [selectedDepositAccountIds, setSelectedDepositAccountIds] = useState([])

  const [editRechargeRow, setEditRechargeRow] = useState(null)

  const [noteModalOpen, setNoteModalOpen] = useState(false)
  const [noteModalRow, setNoteModalRow] = useState(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [savingNote, setSavingNote] = useState(false)

  const [approveModalOpen, setApproveModalOpen] = useState(false)
  const [approveRow, setApproveRow] = useState(null)
  const [approveReceived, setApproveReceived] = useState('')

  const [reqMetrics, setReqMetrics] = useState({
    pending: 0,
    in_review: 0,
    approved: 0,
    rejected: 0,
    canceled: 0,
  })

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(''), 4000)
  }

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true)
    try {
      const { data } = await api.get('/api/v1/distributors/users')
      // API: solo clientes con solicitud de recarga o movimiento en billetera BaaS.
      const rows = Array.isArray(data) ? data : []
      rows.sort((a, b) => {
        const balA = Number(a?.wallet_balance ?? 0)
        const balB = Number(b?.wallet_balance ?? 0)
        if (balA !== balB) return balA - balB
        return Number(a?.id ?? 0) - Number(b?.id ?? 0)
      })
      setUsers(rows)
    } catch {
      setUsers([])
      showToast('No se pudo cargar la lista de clientes BaaS.')
    } finally {
      setLoadingUsers(false)
    }
  }, [])

  const fetchRechargeRequests = useCallback(async (opts = {}) => {
    const silentToast = opts.silentToast === true
    const gen = ++rechargeFetchGenRef.current
    setLoadingRequests(true)
    try {
      const { data } = await api.get('/api/v1/distributors/recharge-requests', {
        params: { status: 'all' },
      })
      if (gen !== rechargeFetchGenRef.current) return
      setRechargeRequests(dedupeRechargeRequestsById(Array.isArray(data) ? data : []))
    } catch {
      if (gen !== rechargeFetchGenRef.current) return
      setRechargeRequests([])
      if (!silentToast) {
        showToast('No se pudo cargar las solicitudes de recarga.')
      }
    } finally {
      if (gen === rechargeFetchGenRef.current) {
        setLoadingRequests(false)
      }
    }
  }, [])

  const patchRechargeRequestInState = useCallback((updated) => {
    if (!updated || updated.id == null) return
    setRechargeRequests((prev) => upsertRechargeRequestInList(prev, updated))
  }, [])

  const fetchRechargeMetrics = useCallback(async () => {
    try {
      const { data } = await api.get('/api/v1/distributors/recharge-requests/metrics')
      setReqMetrics({
        pending: Number(data?.pending ?? 0) || 0,
        in_review: Number(data?.in_review ?? 0) || 0,
        approved: Number(data?.approved ?? 0) || 0,
        rejected: Number(data?.rejected ?? 0) || 0,
        canceled: Number(data?.canceled ?? 0) || 0,
      })
    } catch {
      setReqMetrics({
        pending: 0,
        in_review: 0,
        approved: 0,
        rejected: 0,
        canceled: 0,
      })
    }
  }, [])

  /** Evita solapar peticiones concurrentes desde el robot o el botón manual */
  const syncWebInFlightRef = useRef(false)
  const [syncingWeb, setSyncingWeb] = useState(false)

  const sincronizarConWeb = useCallback(
    async (silent = false) => {
      if (syncWebInFlightRef.current) return
      syncWebInFlightRef.current = true
      if (!silent) setSyncingWeb(true)
      try {
        await api.get('/api/v1/distributors/sync-recharges')
        await fetchRechargeRequests({ silentToast: silent })
        void fetchRechargeMetrics()
        if (!silent) {
          showToast('Sincronizado con Render.')
        }
      } catch (err) {
        console.warn('[sync-recharges]', err)
        const msg =
          err?.response?.data?.detail ??
          (typeof err?.response?.data === 'string' ? err.response.data : null) ??
          'No se pudo sincronizar con el portal.'
        if (!silent) {
          showToast(typeof msg === 'string' ? msg : 'No se pudo sincronizar con el portal.')
        }
      } finally {
        syncWebInFlightRef.current = false
        if (!silent) setSyncingWeb(false)
      }
    },
    [fetchRechargeRequests, fetchRechargeMetrics],
  )

  useEffect(() => {
    if (allowedTabs.length === 0) return
    if (!allowedTabs.includes(tab)) {
      setTab(allowedTabs[0])
    }
  }, [allowedTabs, tab])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  /**
   * Deep link desde notificaciones / CxC:
   * - ?open_recharge=<id> (campanita)
   * - ?wr_request=<id> (legacy ClientDetail / informes)
   */
  useEffect(() => {
    const raw = searchParams.get('open_recharge') ?? searchParams.get('wr_request')
    const wrId = Number(raw)
    if (!Number.isFinite(wrId) || wrId < 1 || String(raw ?? '').trim() === '') {
      wrDeepLinkHandledRef.current = null
      return
    }
    if (!hasPermission(BAAS_TAB_PERMISSIONS.requests)) {
      setSearchParams({}, { replace: true })
      return
    }
    const linkKey = `open_recharge:${wrId}`
    if (wrDeepLinkHandledRef.current === linkKey) return

    let cancelled = false

    ;(async () => {
      try {
        const { data: row } = await api.get(`/api/v1/distributors/recharge-requests/${wrId}`)
        if (cancelled || !row?.id) return

        wrDeepLinkHandledRef.current = linkKey
        const status = row?.status ? String(row.status).toLowerCase() : ''
        const normalizedStatus = status === 'partially_paid' ? 'approved' : status
        const tabMatch = RECHARGE_FILTERS.find((f) => f.apiStatus === normalizedStatus)
        setTab('requests')
        setRechargeActiveTab(tabMatch?.id ?? 'in_review')

        if (status === 'in_review') {
          let hydrated = row
          try {
            const { data: detail } = await api.get(`/api/v1/distributors/recharge-requests/${row.id}`)
            if (detail && typeof detail === 'object') hydrated = { ...row, ...detail }
          } catch {
            hydrated = row
          }
          setApproveRow(hydrated)
          setApproveReceived(defaultReceivedAmountForApprove(hydrated))
          setApproveModalOpen(true)
        } else {
          setEditRechargeRow(row)
        }

        setSearchParams({}, { replace: true })
      } catch (_) {
        if (!cancelled) {
          setTab('requests')
          setRechargeActiveTab('in_review')
          setSearchParams({}, { replace: true })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [searchParams, setSearchParams, hasPermission])

  useEffect(() => {
    if (tab === 'requests') {
      fetchRechargeRequests()
      fetchRechargeMetrics()
    }
  }, [tab, fetchRechargeRequests, fetchRechargeMetrics])

  /** Escucha sincronización global (robot en MainLayout): refresca lista si hay recargas nuevas desde Render. */
  useEffect(() => {
    function onCatalogSync(ev) {
      const n = Number(ev?.detail?.recharges?.count ?? 0)
      if (Number.isFinite(n) && n > 0 && tab === 'requests') {
        void fetchRechargeRequests({ silentToast: true })
        void fetchRechargeMetrics()
      }
    }
    window.addEventListener('erp-web-catalog-sync', onCatalogSync)
    return () => window.removeEventListener('erp-web-catalog-sync', onCatalogSync)
  }, [tab, fetchRechargeRequests, fetchRechargeMetrics])

  /** Al entrar en «Solicitudes de recarga», un pull silencioso (además del robot global). */
  useEffect(() => {
    if (tab !== 'requests') return undefined
    void sincronizarConWeb(true)
    return undefined
  }, [tab, sincronizarConWeb])

  const cargarClientesModalRecarga = useCallback(async () => {
    setClientesLoading(true)
    setClientesError(null)
    try {
      const { data } = await api.get('/api/v1/distributors/catalog-clients')
      const rows = Array.isArray(data?.clientes) ? data.clientes : []
      const mapped = rows.map(normalizeClienteDesdeWebhook).filter(Boolean)
      setClientes(mapped)
    } catch (err) {
      console.error('Error cargando clientes (ERP / catálogo):', err)
      const status = err.response?.status
      const resData = err.response?.data
      const detail =
        (typeof resData?.detail === 'string' && resData.detail.trim()
          ? resData.detail.trim()
          : null) || err.message
      setClientesError(status === 401 ? `No autorizado: ${detail}` : 'No se pudieron cargar los clientes.')
      setClientes([])
    } finally {
      setClientesLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!linkModalOpen) return
    let cancelled = false

    cargarClientesModalRecarga()

    api
      .get('/api/v1/payment-methods/')
      .then(({ data }) => {
        if (cancelled) return
        const list = Array.isArray(data) ? data : []
        list.sort((a, b) =>
          String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'es', { sensitivity: 'base' }),
        )
        setPaymentMethods(list)
      })
      .catch(() => {
        if (!cancelled) setPaymentMethods([])
      })
    api
      .get('/api/v1/accounts/deposit-options')
      .then(({ data }) => {
        if (cancelled) return
        const list = Array.isArray(data) ? data : []
        list.sort((a, b) =>
          String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'es', { sensitivity: 'base' }),
        )
        setDepositAccounts(list)
      })
      .catch(() => {
        if (!cancelled) setDepositAccounts([])
      })
    return () => {
      cancelled = true
    }
  }, [linkModalOpen, cargarClientesModalRecarga])

  useEffect(() => {
    if (!linkModalOpen || clientesLoading) return
    console.log('Clientes cargados en modal recarga:', clientes)
  }, [linkModalOpen, clientes, clientesLoading])

  const isDepositGroupingParent = useCallback(
    (accId) =>
      (Array.isArray(depositAccounts) ? depositAccounts : []).some(
        (x) => Number(x?.parent_id) === Number(accId),
      ),
    [depositAccounts],
  )

  const salePaymentMethodOptions = useMemo(() => {
    const pms = Array.isArray(paymentMethods) ? paymentMethods : []
    return pms
      .filter((m) => m?.is_active !== false)
      .map((m) => ({ value: String(m?.id ?? ''), label: String(m?.name ?? '—') }))
      .filter((o) => o.value !== '' && o.value !== 'undefined' && o.value !== 'null')
  }, [paymentMethods])

  /** Moneda única de la solicitud (primera fila de conceptos). */
  const rechargeBillingCurrency = useMemo(() => {
    const lines = Array.isArray(linkLineItems) ? linkLineItems : []
    return normalizeCurrencyCode(lines[0]?.tipo_moneda ?? 'USD', 'USD')
  }, [linkLineItems])

  const depositAccountOptionsByMethodId = useMemo(() => {
    const accs = Array.isArray(depositAccounts) ? depositAccounts : []
    const pms = Array.isArray(paymentMethods) ? paymentMethods : []
    const byId = Object.fromEntries(
      accs
        .map((a) => [Number(a?.id), a])
        .filter(([id]) => Number.isFinite(id) && Number(id) > 0),
    )
    const buildForMethodLower = (methodLower) =>
      accs
        .filter((acc) => {
          const lm = String(acc?.linked_payment_method ?? '').trim().toLowerCase()
          if (lm && lm === methodLower) return true
          const pid = acc?.parent_id != null ? Number(acc.parent_id) : NaN
          if (!Number.isFinite(pid) || pid < 1) return false
          const parent = byId[pid]
          if (!parent) return false
          const plm = String(parent.linked_payment_method ?? '').trim().toLowerCase()
          return Boolean(plm && plm === methodLower)
        })
        .map((a) => {
          const isParent = isDepositGroupingParent(a?.id)
          const pid = a?.parent_id != null ? Number(a.parent_id) : NaN
          const par = Number.isFinite(pid) && pid >= 1 ? byId[pid] : null
          const cur = String(a?.currency ?? '')
          let label = String(a?.name ?? '—')
          if (isParent) {
            label = `${label} (${cur}) — Cuenta agrupadora · elija subcuenta`
          } else if (par) {
            label = `${String(par?.name ?? '—')} - ${label} (${cur})`
          } else {
            label = `${label} (${cur})`
          }
          return {
            value: String(a?.id ?? ''),
            label,
            disabled: Boolean(isParent),
          }
        })
        .filter((o) => o.value !== '' && o.value !== 'undefined' && o.value !== 'null')

    const out = {}
    for (const m of pms) {
      if (m?.is_active === false) continue
      const ml = String(m?.name ?? '').trim().toLowerCase()
      if (!ml) continue
      out[String(m.id)] = buildForMethodLower(ml)
    }
    return out
  }, [depositAccounts, isDepositGroupingParent, paymentMethods])

  const filteredDepositAccountOptionsByMethodId = useMemo(() => {
    const cur = rechargeBillingCurrency
    const accs = Array.isArray(depositAccounts) ? depositAccounts : []
    const base =
      depositAccountOptionsByMethodId != null && typeof depositAccountOptionsByMethodId === 'object' ?
        depositAccountOptionsByMethodId
      : {}
    const out = {}
    for (const pmId of Object.keys(base)) {
      const acctOpts = Array.isArray(base[pmId]) ? base[pmId] : []
      out[pmId] = acctOpts.filter((aOpt) => {
        if (aOpt == null || aOpt.value == null) return false
        const aid = Number(aOpt?.value)
        if (!Number.isFinite(aid)) return false
        const acc = accs.find((a) => Number(a?.id) === aid)
        if (!acc) return false
        const accCur = normalizeCurrencyCode(String(acc?.currency ?? '').trim() || 'USD', 'USD')
        return accCur === cur
      })
    }
    return out
  }, [depositAccountOptionsByMethodId, depositAccounts, rechargeBillingCurrency])

  const filteredSalePaymentMethodOptions = useMemo(() => {
    const opts = Array.isArray(salePaymentMethodOptions) ? salePaymentMethodOptions : []
    const fMap = filteredDepositAccountOptionsByMethodId ?? {}
    return opts.filter((opt) => {
      const xs = Array.isArray(fMap[String(opt?.value)]) ? fMap[String(opt.value)] : []
      return xs.length > 0
    })
  }, [salePaymentMethodOptions, filteredDepositAccountOptionsByMethodId])

  const depositAccountCurrencyCode = useMemo(() => {
    const sel = Array.isArray(selectedDepositAccountIds) ? selectedDepositAccountIds : []
    const accs = Array.isArray(depositAccounts) ? depositAccounts : []
    if (!sel.length) return ''
    const bad = new Set()
    const cur = rechargeBillingCurrency
    for (const did of sel) {
      const acc = accs.find((a) => Number(a?.id) === Number(did))
      if (!acc || isDepositGroupingParent(acc.id)) continue
      const c = normalizeCurrencyCode(String(acc?.currency ?? '').trim() || 'USD', 'USD')
      if (cur && c !== cur) bad.add(c)
    }
    return [...bad].join(', ')
  }, [depositAccounts, isDepositGroupingParent, rechargeBillingCurrency, selectedDepositAccountIds])

  const depositCurrencyMismatch = Boolean(depositAccountCurrencyCode)

  const rechargeModalCurrencyPrevRef = useRef(null)
  useEffect(() => {
    if (!linkModalOpen) {
      rechargeModalCurrencyPrevRef.current = null
      return undefined
    }
    const prev = rechargeModalCurrencyPrevRef.current
    rechargeModalCurrencyPrevRef.current = rechargeBillingCurrency
    if (prev == null || prev === rechargeBillingCurrency) return undefined

    const depMap =
      filteredDepositAccountOptionsByMethodId != null &&
      typeof filteredDepositAccountOptionsByMethodId === 'object' ?
        filteredDepositAccountOptionsByMethodId
      : {}
    setSelectedDepositAccountIds((selRaw) => {
      const sel = Array.isArray(selRaw) ? selRaw : []
      return sel.filter((idStr) => {
        const aid = Number(idStr)
        if (!Number.isFinite(aid)) return false
        return Object.values(depMap).some((list) =>
          (Array.isArray(list) ? list : []).some(
            (o) => o != null && Number(o.value) === aid && !o.disabled,
          ),
        )
      })
    })
    setSelectedPaymentMethodIds((prevPmRaw) => {
      const prevPm = Array.isArray(prevPmRaw) ? prevPmRaw : []
      return prevPm.filter((mid) => (Array.isArray(depMap[String(mid)]) ? depMap[String(mid)] : []).length > 0)
    })
    return undefined
  }, [linkModalOpen, rechargeBillingCurrency, filteredDepositAccountOptionsByMethodId])

  const togglePaymentMethodId = useCallback((rawId) => {
    const n = Number(rawId)
    if (!Number.isFinite(n)) return
    setSelectedPaymentMethodIds((prevRaw) => {
      const prev = Array.isArray(prevRaw) ? prevRaw : []
      return prev.some((x) => Number(x) === n) ? prev.filter((x) => Number(x) !== n) : [...prev, n]
    })
  }, [])

  const syncRechargeCurrencyFromDepositAccounts = useCallback(
    (selectedIds) => {
      if (!linkModalOpen) return
      const nextCur = currencyFromLastSelectedDepositIds(
        depositAccounts,
        selectedIds,
        isDepositGroupingParent,
      )
      if (!nextCur) return
      setLinkLineItems((prev) => {
        const list = Array.isArray(prev) ? prev : []
        if (!list.length) return prev
        const lead = normalizeCurrencyCode(list[0]?.tipo_moneda ?? 'USD', 'USD')
        if (lead === nextCur) return prev
        return list.map((r) => ({ ...r, tipo_moneda: nextCur }))
      })
    },
    [depositAccounts, isDepositGroupingParent, linkModalOpen],
  )

  const toggleDepositAccountId = useCallback(
    (rawId, disabled) => {
      if (disabled) return
      const n = Number(rawId)
      if (!Number.isFinite(n)) return
      setSelectedDepositAccountIds((prevRaw) => {
        const prev = Array.isArray(prevRaw) ? prevRaw : []
        const next = prev.some((x) => Number(x) === n)
          ? prev.filter((x) => Number(x) !== n)
          : [...prev, n]
        syncRechargeCurrencyFromDepositAccounts(next)
        return next
      })
    },
    [syncRechargeCurrencyFromDepositAccounts],
  )

  useEffect(() => {
    syncRechargeCurrencyFromDepositAccounts(selectedDepositAccountIds)
  }, [selectedDepositAccountIds, syncRechargeCurrencyFromDepositAccounts])

  function resetLinkModalForm() {
    setLinkLineItems([newRechargeLineRow()])
    setLinkDepositUsd('')
    setLinkComment('')
    setLinkClientId('')
    setSelectedPaymentMethodIds([])
    setSelectedDepositAccountIds([])
    setLinkReceiptFile(null)
  }

  function openLinkModal() {
    setEditRechargeRow(null)
    setLinkModalPrefillClient(null)
    resetLinkModalForm()
    setLinkModalOpen(true)
  }

  function openPricesModalForClient(row) {
    if (!row?.id) return
    setPricesModalClient(row)
  }

  function closePricesModal() {
    setPricesModalClient(null)
  }

  function openLinkModalForClient(row) {
    if (!row) return
    const em = String(row.email ?? '').trim()
    if (!em.includes('@')) {
      showToast('Este cliente no tiene correo válido para la solicitud de recarga.')
      return
    }
    const displayName =
      String(row.name ?? '').trim() || em.split('@')[0] || 'Cliente'
    setEditRechargeRow(null)
    setLinkModalPrefillClient({
      id: row.id,
      email: em,
      nombre: displayName,
      full_name: displayName,
      name: displayName,
      username: String(row.username ?? '').trim(),
      iptv_username: String(row.username ?? '').trim(),
    })
    resetLinkModalForm()
    setLinkClientId(String(row.id))
    setLinkModalOpen(true)
  }

  function closeLinkModal() {
    setLinkModalOpen(false)
    setEditRechargeRow(null)
    setLinkModalPrefillClient(null)
  }

  async function handleCopyRechargePortalLink(row) {
    const token = String(row?.client_payment_token ?? '').trim()
    if (!token) {
      showToast('Este cliente no tiene enlace de portal disponible.')
      return
    }
    try {
      await copyClientPortalLink(token)
      showToast('Enlace del portal del cliente copiado')
    } catch {
      showToast('No se pudo copiar el enlace.')
    }
  }

  useEffect(() => {
    if (!linkModalOpen || linkModalPrefillClient) return
    if (clientesLoading) return
    if (!clientes.length) return
    setLinkClientId((prev) => (prev ? prev : String(clientes[0].id)))
  }, [linkModalOpen, linkModalPrefillClient, clientesLoading, clientes])

  function handleRefresh() {
    if (tab === 'users' || tab === 'notifications') fetchUsers()
    if (tab === 'requests') {
      fetchRechargeRequests()
      fetchRechargeMetrics()
    }
  }

  async function submitGenerateLink(e, extra) {
    e.preventDefault()
    const built = buildWalletRechargeApiPayload(linkLineItems)
    if (!built.ok) {
      showToast(built.msg || 'Completa todas las líneas de la tabla.')
      return
    }
    const { linePayload, subtotal, currency: builtCur } = built

    const fromRow =
      extra?.distributorEmail && String(extra.distributorEmail).trim().includes('@') ?
        String(extra.distributorEmail).trim().toLowerCase()
      : ''
    const email = fromRow || String(linkClientId || '').trim().toLowerCase()
    if (!email || !email.includes('@')) {
      showToast('Selecciona un distribuidor con correo válido.')
      return
    }
    const pmIds = selectedPaymentMethodIds.map(Number).filter(Number.isFinite)
    if (!pmIds.length) {
      showToast('Marca al menos un método de pago para el portal.')
      return
    }
    const depSel = selectedDepositAccountIds.map(Number).filter(Number.isFinite)

    const cur = normalizeCurrencyCode(builtCur ?? rechargeBillingCurrency, 'USD')
    const xrFromModal = Number(extra?.rechargeExchangeRate)
    const xrImplicit =
      Number.isFinite(xrFromModal) && xrFromModal > 0 ?
        xrFromModal
      : Number(salesCurrencyExchangeRateString(cur))
    if (!Number.isFinite(xrImplicit) || xrImplicit <= 0) {
      showToast('No se pudo determinar la tasa referencial para la moneda de la tabla.')
      return
    }

    let depositUsdNum
    const depRaw = String(linkDepositUsd ?? '').trim().replace(',', '.')
    if (depRaw !== '') {
      const depositBilling = Number(depRaw)
      if (!Number.isFinite(depositBilling) || depositBilling < 0) {
        showToast(`El depósito declarado debe ser un importe válido en ${cur}.`)
        return
      }
      if (depositBilling > 0) {
        depositUsdNum = depositBilling / xrImplicit
      }
    }

    setGeneratingLink(true)
    try {
      let admin_precheck_receipt_url
      if (linkReceiptFile instanceof File) {
        const fdUpload = new FormData()
        fdUpload.append('file', linkReceiptFile)
        try {
          const { data: up } = await api.post('/api/v1/uploads/receipt', fdUpload, {
            headers: { 'Content-Type': 'multipart/form-data' },
          })
          admin_precheck_receipt_url =
            typeof up?.receipt_url === 'string' && up.receipt_url.trim() ? up.receipt_url.trim() : undefined
        } catch {
          showToast('No se pudo subir el comprobante previo. Intenta otro archivo o omitir el adjunto.')
          return
        }
      }

      const noteTrim = String(linkComment ?? '').trim()
      const body = {
        distributor_email: email,
        amount: subtotal,
        line_items: linePayload,
        allowed_payment_methods: pmIds,
        allowed_deposit_account_ids: depSel.length ? depSel : undefined,
        currency: cur,
        exchange_rate: xrImplicit,
        admin_precheck_receipt_url,
        ...(depositUsdNum != null ? { deposit_amount_usd: depositUsdNum } : {}),
        ...(noteTrim.length ? { creation_note: noteTrim } : {}),
        ...(extra?.creditAppliedAmount > 1e-9 ?
          { credit_applied_amount: extra.creditAppliedAmount }
        : {}),
        ...(Array.isArray(extra?.productPrices) && extra.productPrices.length ?
          { client_product_prices: extra.productPrices }
        : {}),
      }
      await api.post('/api/v1/distributors/generate-recharge-link', body)
      closeLinkModal()
      showToast('Solicitud creada')
      setTab('requests')
      setRechargeActiveTab('pending')
      fetchRechargeRequests({ silentToast: true })
      fetchUsers()
      fetchRechargeMetrics()
    } catch (err) {
      const msg =
        err?.response?.data?.detail ??
        (typeof err?.response?.data === 'string' ? err.response.data : null) ??
        'No se pudo generar el enlace.'
      showToast(typeof msg === 'string' ? msg : 'No se pudo generar el enlace.')
    } finally {
      setGeneratingLink(false)
    }
  }

  function declaredAmountForRechargeApprove(row) {
    if (!row) return null
    const portalRaw =
      row.portal_declared_payment_amount != null ? Number(row.portal_declared_payment_amount) : NaN
    if (Number.isFinite(portalRaw) && portalRaw > 0) return portalRaw

    const linked = Array.isArray(row.linked_payments) ? row.linked_payments : []
    const inReview = linked.find(
      (p) =>
        p?.kind === 'receipt_under_review' ||
        String(p?.status_label ?? '')
          .toLowerCase()
          .includes('revisión'),
    )
    if (inReview) {
      const fromLinked = Number(inReview.amount_applied ?? inReview.amount ?? 0)
      if (Number.isFinite(fromLinked) && fromLinked > 0) return fromLinked
    }

    const dusd = row.declared_deposit_usd != null ? Number(row.declared_deposit_usd) : NaN
    const xr =
      row.recharge_exchange_rate != null && Number.isFinite(Number(row.recharge_exchange_rate)) ?
        Number(row.recharge_exchange_rate)
      : 1
    if (Number.isFinite(dusd) && dusd > 0) return Math.round(dusd * xr * 100) / 100

    return null
  }

  function defaultReceivedAmountForApprove(row) {
    if (!row) return ''
    if (isIllegibleDeclaredRecord(pickOcrFlagsFromRecharge(row))) return ''
    const decl = declaredAmountForRechargeApprove(row)
    if (decl != null) return String(decl)
    const pendingPay = pickPendingReviewLinkedPayment(row?.linked_payments)
    if (pendingPay) {
      const raw = pendingPay.amount_applied ?? pendingPay.amount
      if (raw != null && Number.isFinite(Number(raw))) return String(Number(raw))
    }
    const pendRaw = row.balance_pending != null ? Number(row.balance_pending) : NaN
    const pend = Number.isFinite(pendRaw) ? pendRaw : NaN
    const target = Number(row.amount_requested)
    const pendOk = Number.isFinite(pend) ? pend : Number.isFinite(target) ? target : NaN
    return Number.isFinite(pendOk) ? String(pendOk) : ''
  }

  function canApproveRechargeRow(row) {
    const decl = declaredAmountForRechargeApprove(row)
    return decl != null && Number(decl) > 0
  }

  async function openApproveModal(row) {
    if (!row || row.status !== 'in_review') return
    let hydrated = row
    try {
      const { data } = await api.get(`/api/v1/distributors/recharge-requests/${row.id}`)
      if (data && typeof data === 'object') hydrated = { ...row, ...data }
    } catch {
      hydrated = row
    }
    setApproveRow(hydrated)
    setApproveReceived(defaultReceivedAmountForApprove(hydrated))
    setApproveModalOpen(true)
  }

  function closeApproveModal() {
    setApproveModalOpen(false)
    setApproveRow(null)
    setApproveReceived('')
  }

  async function submitApproveRecharge(ev) {
    ev?.preventDefault?.()
    const id = approveRow?.id
    if (id == null) return
    const recv = Number(String(approveReceived).replace(',', '.'))
    if (!Number.isFinite(recv) || recv <= 0) {
      showToast('Indica un monto percibido válido mayor que cero.')
      return
    }
    setProcessingReqId(id)
    try {
      const { data } = await api.post(`/api/v1/distributors/approve-recharge/${id}`, {
        received_amount: recv,
      })
      const pendingAfter = Number(data?.request?.balance_pending ?? data?.request?.pending_amount ?? 0)
      const pendBefore = Number(approveRow?.balance_pending ?? 0)
      const surplus =
        Number.isFinite(recv) && Number.isFinite(pendBefore) ? Math.max(0, recv - Math.min(recv, pendBefore)) : 0
      if (Number.isFinite(surplus) && surplus > 1e-6) {
        showToast(
          `Recarga activada. ${formatMoney(surplus)} ${approveRow?.recharge_currency ? String(approveRow.recharge_currency).toUpperCase() : ''} quedó como saldo a favor del cliente.`,
        )
      } else if (Number.isFinite(pendingAfter) && pendingAfter > 1e-6) {
        showToast(
          'Recarga activada: billetera actualizada; el saldo CxC restante queda pendiente hasta nuevo comprobante.',
        )
      } else {
        showToast('Recarga activada: deuda CxC de la solicitud liquidada.')
      }
      closeApproveModal()
      if (data?.request) {
        patchRechargeRequestInState(data.request)
      }
      fetchRechargeRequests({ silentToast: true })
      fetchRechargeMetrics()
      fetchUsers()
      notifyAccountsReceivableStale()
    } catch (err) {
      const d = err?.response?.data?.detail
      showToast(typeof d === 'string' ? d : 'No se pudo aprobar el abono.')
    } finally {
      setProcessingReqId(null)
    }
  }

  async function rejectRequest(reqId) {
    if (!window.confirm('¿Rechazar esta solicitud? El saldo del distribuidor no cambiará.')) return
    setProcessingReqId(reqId)
    try {
      await api.post(`/api/v1/distributors/reject-recharge/${reqId}`)
      showToast('Solicitud rechazada.')
      fetchRechargeRequests()
      fetchRechargeMetrics()
    } catch (err) {
      const d = err?.response?.data?.detail
      showToast(typeof d === 'string' ? d : 'No se pudo rechazar la solicitud.')
    } finally {
      setProcessingReqId(null)
    }
  }

  async function cancelRequest(reqId) {
    if (!window.confirm('¿Cancelar esta solicitud pendiente (sin acreditación)?')) return
    setProcessingReqId(reqId)
    try {
      await api.post(`/api/v1/distributors/cancel-recharge/${reqId}`)
      showToast('Solicitud cancelada.')
      fetchRechargeRequests()
      fetchRechargeMetrics()
    } catch (err) {
      const d = err?.response?.data?.detail
      showToast(typeof d === 'string' ? d : 'No se pudo cancelar la solicitud.')
    } finally {
      setProcessingReqId(null)
    }
  }

  function openNoteModal(row) {
    if (!row || !['in_review', 'approved', 'partially_paid'].includes(row.status)) return
    setNoteModalRow(row)
    setNoteDraft(typeof row.admin_note === 'string' ? row.admin_note : '')
    setNoteModalOpen(true)
  }

  function closeNoteModal() {
    setNoteModalOpen(false)
    setNoteModalRow(null)
    setNoteDraft('')
    setSavingNote(false)
  }

  async function submitRechargeAdminNote(ev) {
    ev?.preventDefault?.()
    const id = noteModalRow?.id
    if (id == null) return
    setSavingNote(true)
    try {
      const { data } = await api.patch(`/api/v1/distributors/recharge-requests/${id}/note`, {
        note: noteDraft,
      })
      showToast('Nota guardada.')
      patchRechargeRequestInState(data)
      closeNoteModal()
    } catch (err) {
      const msg =
        err?.response?.data?.detail ??
        (typeof err?.response?.data === 'string' ? err.response.data : null) ??
        'No se pudo guardar la nota.'
      showToast(typeof msg === 'string' ? msg : 'No se pudo guardar la nota.')
    } finally {
      setSavingNote(false)
    }
  }

  async function openEditRechargeModal(row) {
    if (
      !row
      || !['pending', 'in_review', 'partially_paid', 'approved'].includes(row.status)
      || (row.status === 'approved' && !rechargeHasOpenCxcBalance(row))
    ) {
      return
    }
    const email = String(row.client_email ?? '').trim()
    if (!email.includes('@')) {
      showToast('Esta solicitud no tiene correo de distribuidor para editar.')
      return
    }
    let hydrated = row
    try {
      const { data } = await api.get(`/api/v1/distributors/recharge-requests/${row.id}`)
      if (data && typeof data === 'object') hydrated = { ...row, ...data }
    } catch {
      hydrated = row
    }
    setLinkLineItems(rechargeLinesHydrateFromAdminRow(hydrated))
    setLinkDepositUsd(declaredDepositInputValueFromReview(hydrated))
    setLinkComment(typeof hydrated.admin_note === 'string' ? hydrated.admin_note : '')
    setLinkClientId(email)
    setSelectedPaymentMethodIds(
      Array.isArray(hydrated.allowed_payment_methods)
        ? hydrated.allowed_payment_methods.map((id) => String(id))
        : [],
    )
    setSelectedDepositAccountIds(() => {
      const depIds = Array.isArray(hydrated.allowed_deposit_account_ids)
        ? hydrated.allowed_deposit_account_ids.map((id) => String(id))
        : []
      const submitted = hydrated.portal_submitted_deposit_account_id
      if (submitted != null && !depIds.includes(String(submitted))) {
        depIds.push(String(submitted))
      }
      return depIds
    })
    setLinkReceiptFile(null)
    setEditRechargeRow(hydrated)
    setLinkModalOpen(true)
  }

  async function submitUpdatePending(e, extra) {
    e.preventDefault()
    const rid = editRechargeRow?.id
    if (rid == null) return

    const built = buildWalletRechargeApiPayload(linkLineItems)
    if (!built.ok) {
      showToast(built.msg || 'Completa todas las líneas de la tabla.')
      return
    }
    const { linePayload, subtotal, currency: builtCur } = built

    const fromRow =
      extra?.distributorEmail && String(extra.distributorEmail).trim().includes('@')
        ? String(extra.distributorEmail).trim().toLowerCase()
        : ''
    const email = fromRow || String(linkClientId || '').trim().toLowerCase()
    if (!email || !email.includes('@')) {
      showToast('Selecciona un distribuidor con correo válido.')
      return
    }
    const pmIds = selectedPaymentMethodIds.map(Number).filter(Number.isFinite)
    if (!pmIds.length) {
      showToast('Marca al menos un método de pago para el portal.')
      return
    }
    const depSel = selectedDepositAccountIds.map(Number).filter(Number.isFinite)

    const cur = normalizeCurrencyCode(builtCur ?? rechargeBillingCurrency, 'USD')
    const xrFromModal = Number(extra?.rechargeExchangeRate)
    const xrImplicit =
      Number.isFinite(xrFromModal) && xrFromModal > 0 ?
        xrFromModal
      : Number(salesCurrencyExchangeRateString(cur))
    if (!Number.isFinite(xrImplicit) || xrImplicit <= 0) {
      showToast('No se pudo determinar la tasa referencial para la moneda de la tabla.')
      return
    }

    let depositUsdNum
    let portalDeclaredBilling
    const depRaw = String(linkDepositUsd ?? '').trim().replace(',', '.')
    if (depRaw !== '') {
      const depositBilling = Number(depRaw)
      if (!Number.isFinite(depositBilling) || depositBilling < 0) {
        showToast(`El depósito declarado debe ser un importe válido en ${cur}.`)
        return
      }
      if (depositBilling > 0) {
        portalDeclaredBilling = depositBilling
        depositUsdNum = depositBilling / xrImplicit
      }
    }

    setGeneratingLink(true)
    try {
      let admin_precheck_receipt_url
      if (linkReceiptFile instanceof File) {
        const fdUpload = new FormData()
        fdUpload.append('file', linkReceiptFile)
        try {
          const { data: up } = await api.post('/api/v1/uploads/receipt', fdUpload, {
            headers: { 'Content-Type': 'multipart/form-data' },
          })
          admin_precheck_receipt_url =
            typeof up?.receipt_url === 'string' && up.receipt_url.trim() ? up.receipt_url.trim() : undefined
        } catch {
          showToast('No se pudo subir el comprobante previo. Intenta otro archivo u omitir el adjunto.')
          return
        }
      }

      const noteTrim = String(linkComment ?? '').trim()
      const body = {
        amount: subtotal,
        line_items: linePayload,
        allowed_payment_methods: pmIds,
        allowed_deposit_account_ids: depSel.length ? depSel : undefined,
        currency: cur,
        exchange_rate: xrImplicit,
        ...(admin_precheck_receipt_url != null ? { admin_precheck_receipt_url } : {}),
        ...(portalDeclaredBilling != null ?
          {
            portal_declared_payment_amount: portalDeclaredBilling,
            declared_deposit_usd: depositUsdNum,
          }
        : {}),
        ...(noteTrim.length ? { admin_note: noteTrim } : {}),
      }
      const { data } = await api.patch(`/api/v1/distributors/recharge-requests/${rid}`, body)
      closeLinkModal()
      showToast('Solicitud actualizada.')
      patchRechargeRequestInState(data)
      fetchRechargeRequests({ silentToast: true })
      fetchRechargeMetrics()
    } catch (err) {
      const msg =
        err?.response?.data?.detail ??
        (typeof err?.response?.data === 'string' ? err.response.data : null) ??
        'No se pudo guardar los cambios.'
      showToast(typeof msg === 'string' ? msg : 'No se pudo guardar los cambios.')
    } finally {
      setGeneratingLink(false)
    }
  }

  function formatMoney(n) {
    const x = Number(n)
    if (!Number.isFinite(x)) return '—'
    return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  function formatBaasBalance(balance, currency) {
    const x = Number(balance)
    const cur =
      String(currency || 'USD')
        .trim()
        .toUpperCase()
        .slice(0, 10) || 'USD'
    if (!Number.isFinite(x)) return '—'
    try {
      return new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency: cur,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(x)
    } catch {
      return `${cur} ${formatMoney(x)}`
    }
  }

  const filteredUsers = useMemo(() => {
    const q = baasSearch.trim().toLowerCase()
    if (!q) {
      return users.filter((u) => u.parent_id == null)
    }
    return users.filter((u) => {
      const name = (u.name ?? '').toLowerCase()
      const email = (u.email ?? '').toLowerCase()
      const username = (u.username ?? '').toLowerCase()
      return name.includes(q) || email.includes(q) || username.includes(q)
    })
  }, [users, baasSearch])

  const firstLineUserCount = useMemo(
    () => users.filter((u) => u.parent_id == null).length,
    [users],
  )

  const visibleRechargeRequests = useMemo(
    () => rechargeRequests.filter((r) => rechargeRequestMatchesTab(r, rechargeActiveTab)),
    [rechargeRequests, rechargeActiveTab],
  )

  const rechargeTabCounts = useMemo(() => {
    const counts = {
      pending: 0,
      in_review: 0,
      approved: 0,
      rejected: 0,
      canceled: 0,
    }
    for (const r of rechargeRequests) {
      for (const f of RECHARGE_FILTERS) {
        if (rechargeRequestMatchesTab(r, f.id)) {
          counts[f.id] += 1
          break
        }
      }
    }
    if (rechargeRequests.length === 0) {
      return {
        pending: Number(reqMetrics.pending ?? 0) || 0,
        in_review: Number(reqMetrics.in_review ?? 0) || 0,
        approved: Number(reqMetrics.approved ?? 0) || 0,
        rejected: Number(reqMetrics.rejected ?? 0) || 0,
        canceled: Number(reqMetrics.canceled ?? 0) || 0,
      }
    }
    return counts
  }, [rechargeRequests, reqMetrics])

  const clientSnapshotForEdit = useMemo(() => {
    if (!editRechargeRow) return null
    const em = String(editRechargeRow.client_email ?? '').trim()
    return {
      id: em,
      email: em,
      nombre: editRechargeRow.client_name,
      full_name: editRechargeRow.client_name,
      username: editRechargeRow.client_username,
      iptv_username: editRechargeRow.client_username,
    }
  }, [editRechargeRow])

  return (
    <div className="p-6 space-y-8">
      {toast && (
        <div className="fixed top-5 right-5 z-50 flex items-center gap-2 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg">
          <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
          {toast}
        </div>
      )}

      {allowedTabs.length === 0 ? (
        <div className="rounded-2xl border border-amber-100 bg-amber-50 px-6 py-8 text-center">
          <h2 className="text-base font-semibold text-amber-900">Sin permisos en Billeteras BaaS</h2>
          <p className="text-sm text-amber-800 mt-2">
            Tu cuenta no tiene pestañas asignadas en este módulo. Contacta al administrador.
          </p>
        </div>
      ) : (
        <>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <Link
            to={isAdmin ? '/equipo' : '/clientes'}
            className="mt-1 p-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
            aria-label={isAdmin ? 'Volver a Equipo' : 'Volver a Clientes'}
          >
            <ArrowLeft size={18} />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <Building2 size={22} className="text-blue-600" />
              <h1 className="text-2xl font-bold text-gray-900">Distribuidores BaaS</h1>
            </div>
            <p className="text-sm text-gray-500 mt-0.5">
              Saldo virtual, solicitudes de recarga en el portal permanente del cliente y revisión por comprobante.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 justify-end">
          {tab === 'users' && canCreateRecharge && (
            <button
              type="button"
              onClick={() => openLinkModal()}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 shadow-sm"
            >
              <Sparkles size={15} />
              Nueva solicitud de recarga
            </button>
          )}
          <button
            type="button"
            onClick={() => handleRefresh()}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 self-start sm:self-center"
          >
            <RefreshCw size={14} />
            Actualizar
          </button>
        </div>
      </div>

      {/* Pestañas */}
      <div className="flex gap-2 border-b border-gray-200 pb-px">
        {hasPermission(BAAS_TAB_PERMISSIONS.users) && (
        <button
          type="button"
          onClick={() => setTab('users')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
            tab === 'users'
              ? 'border-blue-600 text-blue-700 bg-blue-50/50'
              : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <Users size={16} />
          Usuarios y billetera
        </button>
        )}
        {hasPermission(BAAS_TAB_PERMISSIONS.requests) && (
        <button
          type="button"
          onClick={() => setTab('requests')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
            tab === 'requests'
              ? 'border-blue-600 text-blue-700 bg-blue-50/50'
              : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <ClipboardList size={16} />
          Solicitudes de recarga
        </button>
        )}
        {hasPermission(BAAS_TAB_PERMISSIONS.notifications) && (
        <button
          type="button"
          onClick={() => setTab('notifications')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
            tab === 'notifications'
              ? 'border-blue-600 text-blue-700 bg-blue-50/50'
              : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <Bell size={16} />
          Gestión de Notificaciones
        </button>
        )}
      </div>

      {tab === 'users' && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <Wallet size={18} className="text-emerald-600" />
              <h2 className="text-base font-semibold text-gray-800">Clientes y Distribuidores (BaaS)</h2>
            </div>
            <span className="text-xs text-gray-400">
              {loadingUsers
                ? '…'
                : baasSearch.trim()
                  ? `${filteredUsers.length} de ${users.length} en la red`
                  : `${filteredUsers.length} de ${firstLineUserCount} directos`}
            </span>
          </div>

          {!loadingUsers && users.length > 0 && (
            <div className="px-6 py-3 border-b border-gray-50 bg-gray-50/40">
              <div className="relative max-w-md">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
                />
                <input
                  type="search"
                  value={baasSearch}
                  onChange={(e) => setBaasSearch(e.target.value)}
                  placeholder="Buscar por cliente, email o usuario IPTV…"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-gray-200 rounded-lg text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400"
                />
              </div>
            </div>
          )}

          {loadingUsers ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 rounded-xl animate-pulse" />
              ))}
            </div>
          ) : users.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <Wallet size={40} className="mb-3 opacity-25" />
              <p className="text-sm font-medium">Sin clientes con historial BaaS</p>
              <p className="text-xs mt-1 text-gray-400 max-w-sm text-center">
                Solo aparecen quienes tienen solicitudes de recarga o movimientos en billetera.
              </p>
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <Search size={32} className="mb-2 opacity-30" />
              <p className="text-sm font-medium">Ningún cliente coincide con la búsqueda</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-6 py-3 font-semibold">Cliente</th>
                    <th className="text-left px-4 py-3 font-semibold">Email</th>
                    <th className="text-left px-4 py-3 font-semibold">Usuario IPTV</th>
                    <th className="text-right px-4 py-3 font-semibold">Saldo BaaS</th>
                    <th className="text-right px-6 py-3 font-semibold">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredUsers.map((u) => {
                    const displayName = u.name?.trim?.() ? u.name.trim() : u.email
                    const treeUuid = u.payment_token ?? u.portal_token
                    const treeHref =
                      canViewTree && treeUuid
                        ? `/equipo/distribuidores/${treeUuid}/arbol`
                        : null
                    return (
                    <tr key={u.id} className="hover:bg-gray-50/80">
                      <td className="px-6 py-3">
                        {treeHref ? (
                          <Link
                            to={treeHref}
                            className="font-medium text-emerald-700 hover:text-emerald-800 hover:underline"
                          >
                            {displayName}
                          </Link>
                        ) : (
                          <span className="font-medium text-gray-900">{displayName}</span>
                        )}
                        <span className="block text-xs text-gray-400">#{u.id}</span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{u.email}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-700">
                        {u.username?.trim?.() ? u.username.trim() : '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-emerald-700 font-semibold">
                        {formatBaasBalance(u.wallet_balance, u.currency)}
                      </td>
                      <td className="px-6 py-3 text-right">
                        <div className="inline-flex flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => openPricesModalForClient(u)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-violet-800 bg-violet-50 hover:bg-violet-100 border border-violet-200"
                          >
                            🏷️ Precios
                          </button>
                          <button
                            type="button"
                            onClick={() => openLinkModalForClient(u)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700"
                          >
                            <PlusCircle size={14} />
                            Recargar billetera
                          </button>
                        </div>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'notifications' && (
        <Suspense
          fallback={
            <div className="flex items-center justify-center rounded-2xl border border-gray-100 bg-white py-16 text-sm text-gray-500">
              Cargando gestión de notificaciones…
            </div>
          }
        >
          <NotificationManagementPanel
            clients={Array.isArray(users) ? users : []}
            onToast={showToast}
          />
        </Suspense>
      )}

      {tab === 'requests' && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <ClipboardList size={18} className="text-amber-600" />
              <h2 className="text-base font-semibold text-gray-800">Solicitudes de recarga</h2>
            </div>
            <span className="text-xs text-gray-400">
              {loadingRequests ? '…' : `${visibleRechargeRequests.length} solicitudes`}
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 mx-6 mt-4 mb-2">
            <StatusFilterTabs
              tabs={RECHARGE_FILTERS}
              activeId={rechargeActiveTab}
              onChange={setRechargeActiveTab}
              counts={rechargeTabCounts}
              wrap
            />
            <button
              type="button"
              disabled={syncingWeb}
              onClick={() => void sincronizarConWeb(false)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-sky-800 bg-sky-50 border border-sky-200 rounded-lg hover:bg-sky-100 disabled:opacity-50 whitespace-nowrap"
            >
              <RefreshCw size={14} className={syncingWeb ? 'animate-spin' : ''} aria-hidden />
              ☁️ Sincronizar (Auto)
            </button>
          </div>

          {loadingRequests ? (
            <div className="p-6 space-y-3">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-14 bg-gray-100 rounded-xl animate-pulse" />
              ))}
            </div>
          ) : visibleRechargeRequests.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400">
              <ClipboardList size={40} className="mb-3 opacity-25" />
              <p className="text-sm font-medium">
                No hay solicitudes {rechargeFilterEmptyCopy(rechargeActiveTab)}
              </p>
              <p className="text-xs mt-1 text-gray-400 max-w-md text-center">
                Pendientes: esperando comprobante del cliente. En revisión: listas para aprobar o rechazar por administración.
              </p>
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="w-full table-auto text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <ResizableTh>FECHA</ResizableTh>
                    <ResizableTh className="min-w-0">CLIENTE</ResizableTh>
                    <ResizableTh className="min-w-0">USUARIO</ResizableTh>
                    <ResizableTh className="!px-2 w-16">N.º REF</ResizableTh>
                    <ResizableTh className="min-w-0 max-w-[11rem]">NOTA</ResizableTh>
                    <ResizableTh>MÉTODO DE PAGO</ResizableTh>
                    <ResizableTh>MONEDA</ResizableTh>
                    <ResizableTh>ETIQUETAS</ResizableTh>
                    <ResizableTh align="right">IMPORTE</ResizableTh>
                    <ResizableTh className="min-w-[108px]">ESTADO</ResizableTh>
                    <ResizableTh className="w-14 text-center">COMPROBANTE</ResizableTh>
                    <ResizableTh align="right" className="min-w-[200px]">
                      ACCIONES
                    </ResizableTh>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {visibleRechargeRequests.map((r) => (
                    <tr
                      key={r.id}
                      className={`hover:bg-gray-50/60 transition-colors ${
                        r.status === 'pending' || r.status === 'partially_paid'
                          ? 'bg-amber-50/25'
                          : r.status === 'in_review'
                            ? 'bg-sky-50/30'
                          : rechargeAwaitingClientReceipt(r)
                            ? 'bg-emerald-50/20'
                          : ''
                      }`}
                    >
                      <td className="px-3 py-2.5 whitespace-nowrap text-gray-600 text-sm align-middle">
                        {formatSaleTableDate(r.created_at)}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap min-w-0 max-w-[11rem] align-middle">
                        <div className="flex items-center gap-2 min-w-0">
                          <div
                            className="w-6 h-6 rounded-full bg-blue-100 flex items-center
                                        justify-center shrink-0"
                          >
                            <span className="text-[10px] font-bold text-blue-600">
                              {(r.client_name || '?').charAt(0).toUpperCase()}
                            </span>
                          </div>
                          <span className="font-medium text-gray-800 truncate">
                            {r.client_name?.trim?.() ? r.client_name.trim() : '—'}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap min-w-0 max-w-[9rem] align-middle">
                        <span className="font-mono tabular-nums text-sm text-gray-700 truncate block">
                          {r.client_username && String(r.client_username).trim()
                            ? String(r.client_username).trim()
                            : '—'}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 whitespace-nowrap w-16 font-medium text-gray-800 tabular-nums text-sm align-middle">
                        {formatSaleDocNo(r.id)}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap min-w-0 max-w-[11rem] align-middle">
                        <SaleListNotesCell notes={r.notes_preview} />
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-gray-700 text-sm align-middle">
                        {r.payment_methods_display?.trim?.() ? r.payment_methods_display.trim() : '—'}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap font-mono tabular-nums text-gray-800 text-sm align-middle">
                        {r.recharge_currency ? String(r.recharge_currency).toUpperCase() : '—'}
                      </td>
                      <td
                        className="px-3 py-2.5 whitespace-nowrap text-gray-700 text-sm align-middle max-w-[14rem] truncate"
                        title="Recarga, BaaS"
                      >
                        Recarga, BaaS
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-right align-middle">
                        <RechargeAmountCell row={r} />
                      </td>
                      <td className="px-3 py-2.5 align-middle min-w-[108px] max-w-[220px]">
                        <div className="flex flex-col items-center gap-1 min-w-0">
                          <RechargeStatusBadge status={r.status} />
                          {r.status === 'in_review' ? (
                            <OcrSecurityBadges
                              {...pickOcrFlagsFromRecharge(r)}
                              layout="table"
                              illegibleLayout="compact"
                            />
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-center align-middle w-14">
                        <SaleReceiptProofLink
                          sale={{
                            payment_receipt: r.receipt_url || r.admin_precheck_receipt_url,
                          }}
                        />
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap align-middle min-w-[200px]">
                        <div className="flex flex-wrap items-center justify-end gap-3">
                          {r.status === 'pending' ? (
                            <>
                              {r.client_payment_token ?
                                <CopyPaymentLinkButton
                                  onClick={() => handleCopyRechargePortalLink(r)}
                                  disabled={Boolean(processingReqId) || generatingLink}
                                  title="Copiar enlace del portal del cliente (permanente)"
                                />
                              : null}
                              <button
                                type="button"
                                disabled={Boolean(processingReqId) || generatingLink}
                                onClick={() => openEditRechargeModal(r)}
                                className="inline-flex items-center justify-center p-1.5 rounded-lg text-xs font-medium text-indigo-800 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 disabled:opacity-50"
                                title="Editar solicitud"
                              >
                                <Pencil size={14} aria-hidden strokeWidth={2} />
                                <span className="sr-only">Editar solicitud</span>
                              </button>
                              <button
                                type="button"
                                disabled={processingReqId === r.id}
                                onClick={() => cancelRequest(r.id)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 disabled:opacity-50"
                              >
                                <Ban size={14} />
                                Cancelar
                              </button>
                            </>
                          ) : null}
                          {r.status === 'in_review' ? (
                            <div className="flex flex-col items-end gap-1.5 max-w-[min(100%,20rem)]">
                              <div className="flex flex-wrap gap-2 justify-end">
                                {canApproveRecharge && (
                                  <button
                                    type="button"
                                    disabled={processingReqId === r.id}
                                    onClick={() => openApproveModal(r)}
                                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50"
                                  >
                                    <CheckCircle size={14} />
                                    Aprobar
                                  </button>
                                )}
                                {canEditRecharge && (
                                  <button
                                    type="button"
                                    disabled={processingReqId === r.id}
                                    onClick={() => rejectRequest(r.id)}
                                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
                                  >
                                    <XCircle size={14} />
                                    Rechazar
                                  </button>
                                )}
                              </div>
                              {canEditRecharge && (
                              <div className="flex items-center justify-end gap-0.5">
                                <button
                                  type="button"
                                  disabled={(processingReqId != null && processingReqId === r.id) || generatingLink}
                                  onClick={() => openEditRechargeModal(r)}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-40"
                                  title="Corregir importe, moneda o métodos de pago"
                                >
                                  <Pencil size={14} strokeWidth={2} aria-hidden />
                                  <span className="sr-only">Editar solicitud en revisión</span>
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    (processingReqId != null && processingReqId === r.id)
                                    || (savingNote && noteModalRow?.id === r.id)
                                  }
                                  onClick={() => openNoteModal(r)}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-40"
                                  title="Nota administrativa (columna NOTA)"
                                >
                                  <MessageSquare size={14} strokeWidth={2} aria-hidden />
                                  <span className="sr-only">Comentario o nota</span>
                                </button>
                              </div>
                              )}
                            </div>
                          ) : null}
                          {rechargeAwaitingClientReceipt(r) ? (
                            <div className="flex flex-col items-end gap-1">
                              <p className="text-[10px] text-emerald-900 font-medium text-right max-w-[12rem]">
                                CxC pendiente {formatMoney(Number(r.balance_pending ?? 0))}: el cliente puede adjuntar
                                nuevo comprobante.
                              </p>
                              <div className="flex items-center justify-end gap-0.5">
                                <button
                                  type="button"
                                  disabled={(processingReqId != null && processingReqId === r.id) || generatingLink}
                                  onClick={() => openEditRechargeModal(r)}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-40"
                                  title="Corregir objetivo o métodos"
                                >
                                  <Pencil size={14} strokeWidth={2} aria-hidden />
                                  <span className="sr-only">Editar solicitud activada con saldo</span>
                                </button>
                                <button
                                  type="button"
                                  disabled={
                                    (processingReqId != null && processingReqId === r.id)
                                    || (savingNote && noteModalRow?.id === r.id)
                                  }
                                  onClick={() => openNoteModal(r)}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-40"
                                  title="Nota administrativa"
                                >
                                  <MessageSquare size={14} strokeWidth={2} aria-hidden />
                                  <span className="sr-only">Nota</span>
                                </button>
                              </div>
                            </div>
                          ) : null}
                          {!['pending', 'in_review'].includes(r.status) && !rechargeAwaitingClientReceipt(r) ?
                            <span className="text-xs text-gray-400">—</span>
                          : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {approveModalOpen && approveRow ? (
        <div className="fixed inset-0 z-[61] flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Registrar abono recibido</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Ref.&nbsp;
                  <span className="font-mono tabular-nums">{formatSaleDocNo(approveRow.id)}</span>
                  {' · Saldo pendiente de la solicitud: '}
                  <span className="font-semibold tabular-nums text-violet-800">
                    {formatMoney(Number(approveRow.balance_pending ?? approveRow.amount_requested ?? 0))}
                  </span>
                  {' '}
                  {approveRow.recharge_currency ? String(approveRow.recharge_currency).toUpperCase() : ''}
                </p>
              </div>
              <button
                type="button"
                className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                onClick={() => closeApproveModal()}
                aria-label="Cerrar"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-xs text-gray-600 leading-relaxed">
              Confirma el importe real que ingresó al banco. Puede ser mayor al saldo pendiente (sobrepago): se liquida la
              deuda CxC de la solicitud y el excedente queda como <strong>saldo a favor</strong> del cliente. Si es menor,
              el saldo virtual ya entregado se mantiene y el resto sigue como deuda CxC.
            </p>
            {isIllegibleDeclaredRecord(approveRow) ? (
              <IllegibleReceiptAlert className="w-full" />
            ) : null}
            {declaredAmountForRechargeApprove(approveRow) != null ?
              <p className="text-xs text-sky-800 bg-sky-50 border border-sky-100 rounded-lg px-3 py-2">
                Cliente declaró{' '}
                <span className="font-semibold tabular-nums">
                  {formatMoney(declaredAmountForRechargeApprove(approveRow))}
                </span>{' '}
                {approveRow.recharge_currency ? String(approveRow.recharge_currency).toUpperCase() : ''} en el
                comprobante.
              </p>
            : null}
            {(() => {
              const linked = Array.isArray(approveRow?.linked_payments) ? approveRow.linked_payments : []
              const creditRow = linked.find(
                (p) =>
                  Number(p?.credit_portion ?? 0) > 0 ||
                  String(p?.kind ?? '').includes('credit') ||
                  String(p?.status_label ?? '').toLowerCase().includes('saldo a favor'),
              )
              if (!creditRow) return null
              const creditAmt = Number(creditRow.credit_portion ?? creditRow.amount ?? 0)
              if (!(creditAmt > 0)) return null
              return (
                <p className="text-xs text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  Incluye{' '}
                  <strong>cruce de Saldo a Favor</strong>:{' '}
                  <span className="font-semibold tabular-nums">{formatMoney(creditAmt)}</span>
                  {approveRow.recharge_currency ? ` ${String(approveRow.recharge_currency).toUpperCase()}` : ''}
                  {' '}(pendiente de tu confirmación).
                </p>
              )
            })()}
            <form onSubmit={submitApproveRecharge} className="space-y-3">
              <div>
                <label htmlFor="recharge-admin-received" className="block text-xs font-medium text-gray-500 mb-1">
                  Monto real recibido (banco / medio de pago)
                </label>
                <input
                  id="recharge-admin-received"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={approveReceived}
                  onChange={(e) => setApproveReceived(e.target.value)}
                  placeholder={
                    declaredAmountForRechargeApprove(approveRow) != null ?
                      String(declaredAmountForRechargeApprove(approveRow))
                    : 'Ej. 12.00'
                  }
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-gray-900 font-mono tabular-nums"
                />
              </div>
              <div className="flex gap-2 justify-end pt-1">
                <button
                  type="button"
                  className="px-3 py-2 text-sm rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50"
                  onClick={() => closeApproveModal()}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={processingReqId === approveRow.id || !canApproveRechargeRow(approveRow)}
                  className="px-3 py-2 text-sm rounded-xl bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-60"
                >
                  {processingReqId === approveRow.id ?
                    'Procesando…'
                  : !canApproveRechargeRow(approveRow) ?
                    'Requiere monto para aprobar'
                  : 'Confirmar abono'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {noteModalOpen && noteModalRow ? (
        <div className="fixed inset-0 z-[61] flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Nota de la solicitud</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Ref.&nbsp;
                  <span className="font-mono tabular-nums">{formatSaleDocNo(noteModalRow.id)}</span>
                  {' · '}
                  {noteModalRow.client_name?.trim?.() ? noteModalRow.client_name.trim() : 'Sin nombre'}
                </p>
              </div>
              <button
                type="button"
                className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                onClick={() => closeNoteModal()}
                aria-label="Cerrar"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-xs text-gray-500">
              El texto guardado sustituye el contenido automático en la columna NOTA hasta que lo borres.
            </p>
            <form onSubmit={submitRechargeAdminNote} className="space-y-3">
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value.slice(0, 2048))}
                placeholder="Ej. Error al validar en el banco; pago retenido…"
                rows={5}
                maxLength={2048}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl text-gray-900 text-sm outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500 resize-y min-h-[100px]"
              />
              <div className="flex flex-wrap gap-2 justify-between items-center pt-1">
                <span className="text-[11px] text-gray-400 tabular-nums">{noteDraft.length}/2048</span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="px-3 py-2 text-sm rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50"
                    onClick={() => closeNoteModal()}
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={savingNote}
                    className="px-3 py-2 text-sm rounded-xl bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-60"
                  >
                    {savingNote ? 'Guardando…' : 'Guardar nota'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

        </>
      )}

      <UpdateClientPricesModal
        open={Boolean(pricesModalClient)}
        client={pricesModalClient}
        onClose={closePricesModal}
        onSaved={() => fetchUsers()}
        onToast={showToast}
      />

      <NewRechargeModal
        open={linkModalOpen}
        onClose={closeLinkModal}
        clientes={clientes}
        clientesLoading={clientesLoading}
        clientesError={clientesError}
        onReloadClientes={cargarClientesModalRecarga}
        linkClientId={linkClientId}
        onLinkClientIdChange={setLinkClientId}
        rechargeLineItems={linkLineItems}
        onRechargeLineItemsChange={setLinkLineItems}
        depositUsd={linkDepositUsd}
        onDepositUsdChange={setLinkDepositUsd}
        rechargeComment={linkComment}
        onRechargeCommentChange={setLinkComment}
        salePaymentMethodOptions={filteredSalePaymentMethodOptions}
        depositAccountOptionsByMethodId={filteredDepositAccountOptionsByMethodId}
        selectedPaymentMethodIds={selectedPaymentMethodIds}
        togglePaymentMethodId={togglePaymentMethodId}
        selectedDepositAccountIds={selectedDepositAccountIds}
        toggleDepositAccountId={toggleDepositAccountId}
        depositCurrencyMismatch={depositCurrencyMismatch}
        depositAccountCurrencyCode={depositAccountCurrencyCode}
        linkReceiptFile={linkReceiptFile}
        onLinkReceiptFileChange={setLinkReceiptFile}
        generatingLink={generatingLink}
        onSubmitGenerateLink={submitGenerateLink}
        editMode={Boolean(editRechargeRow)}
        editTargetRequestId={editRechargeRow?.id ?? null}
        clientSnapshotForEdit={clientSnapshotForEdit}
        prefillClientSnapshot={linkModalPrefillClient}
        existingReceiptUrl={
          editRechargeRow?.receipt_url?.trim?.()
            ? String(editRechargeRow.receipt_url).trim()
            : editRechargeRow?.admin_precheck_receipt_url?.trim?.()
              ? String(editRechargeRow.admin_precheck_receipt_url).trim()
              : ''
        }
        onSubmitUpdatePending={submitUpdatePending}
        summarySubtotalOverride={editRechargeRow?.amount_requested ?? null}
        summaryPaidOverride={editRechargeRow?.amount_paid ?? editRechargeRow?.paid_amount ?? null}
        summaryBalancePendingOverride={
          editRechargeRow?.balance_pending ?? editRechargeRow?.pending_amount ?? null
        }
        linkedPaymentsFromEdit={
          Array.isArray(editRechargeRow?.linked_payments) ? editRechargeRow.linked_payments : []
        }
        ocrIsManuallyEdited={
          Boolean(
            pickPendingReviewLinkedPayment(editRechargeRow?.linked_payments)?.is_manually_edited ??
              editRechargeRow?.is_manually_edited,
          )
        }
        ocrAiConfidenceScore={
          pickPendingReviewLinkedPayment(editRechargeRow?.linked_payments)?.ai_confidence_score ??
          editRechargeRow?.ai_confidence_score ??
          null
        }
        ocrPortalDeclaredAmount={
          pickPendingReviewLinkedPayment(editRechargeRow?.linked_payments)?.amount_applied ??
          pickPendingReviewLinkedPayment(editRechargeRow?.linked_payments)?.amount ??
          editRechargeRow?.portal_declared_payment_amount ??
          null
        }
      />

    </div>
  )
}
