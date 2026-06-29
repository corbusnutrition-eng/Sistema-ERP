import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  ShoppingCart,
  Banknote,
  CheckCircle2,
  Pencil,
  Trash2,
  MessageSquare,
  Ban,
  UploadCloud,
  XCircle,
  RefreshCw,
  Clock,
} from 'lucide-react'
import api from '../../api/axios'
import Swal from 'sweetalert2'
import { useInventoryData } from '../../context/InventoryDataContext'
import { useModal } from '../../context/ModalContext'
import NuevaVentaModal from './components/NuevaVentaModal'
import SaleActivationReviewModal from './components/SaleActivationReviewModal'
import {
  saleStaffReviewAction,
  staffReviewPrimaryLabel,
  staffReviewSuccessToast,
} from './saleStaffReview'
import {
  SaleAmountCell,
  SaleListNotesCell,
  SaleReceiptProofLink,
  saleOpensReadOnly,
  formatSaleDocNo,
  formatSaleTableDate,
  copySalePaymentLink,
  CopyPaymentLinkButton,
} from './saleTableHelpers'
import { isPortalSaldoCrossSinComprobante } from './portalCreditMeta'
import { SALES_CURRENCIES } from './salesCurrencies'
import SalesKPIs from './components/SalesKPIs'
import SalesFilters from './components/SalesFilters'
import SalesTabs from './components/SalesTabs'
import SalesTableSkeleton from './components/SalesTableSkeleton'
import { ecuadorDayEndMs, ecuadorDayStartMs } from '../../utils/datetime'
import { confirmVoidTransaction } from '../../utils/confirmVoidTransaction'
import OcrSecurityBadges, { pickOcrFlagsFromSale, pickOcrSecurityFlags } from '../../components/OcrSecurityBadges'

const ITEMS_PER_PAGE = 10

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null')
  } catch {
    return null
  }
}

/** Detalle legible de errores FastAPI (string, lista de validación, etc.) + trazas en consola. */
function formatApiError(err, fallback) {
  const st = err?.response?.status
  const data = err?.response?.data
  console.error('[API]', st, data, err)
  const d = data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d)) {
    const parts = d.map((x) =>
      typeof x === 'object' && x != null && 'msg' in x ? x.msg : JSON.stringify(x),
    )
    return parts.length ? parts.join(' · ') : fallback
  }
  if (d && typeof d === 'object' && typeof d.detail === 'string') return d.detail
  if (st === 404) return 'No se encontró el recurso (404). Comprueba URL del API y que el backend esté actualizado.'
  return fallback
}

function StatusBadge({ status }) {
  if (status === 'approved') {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold
                       bg-green-50 text-green-700 ring-1 ring-green-200"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
        Activado
      </span>
    )
  }
  if (status === 'pending') {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold
                       bg-amber-50 text-amber-800 ring-1 ring-amber-200"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
        Pendiente
      </span>
    )
  }
  if (status === 'expired') {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold
                       bg-orange-50 text-orange-900 ring-1 ring-orange-200"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
        Caducada
      </span>
    )
  }
  if (status === 'payment_submitted') {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold
                       bg-sky-50 text-sky-900 ring-1 ring-sky-200"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-sky-500" />
        En revisión
      </span>
    )
  }
  if (status === 'rejected') {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold
                       bg-red-50 text-red-800 ring-1 ring-red-200"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        Rechazado
      </span>
    )
  }
  if (status === 'annulled') {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold
                       bg-slate-100 text-slate-700 ring-1 ring-slate-200"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
        Cancelada
      </span>
    )
  }
  if (status === 'cancelled') {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold
                       bg-slate-100 text-slate-600 ring-1 ring-slate-200"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
        Anulado
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold
                     bg-gray-50 text-gray-600 ring-1 ring-gray-200"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
      {status || 'Estado'}
    </span>
  )
}

function PendingReservationCountdown({ expiresAt }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!expiresAt) return undefined
    const id = setInterval(() => setTick((x) => x + 1), 1000)
    return () => clearInterval(id)
  }, [expiresAt])
  if (!expiresAt) return null
  const end = new Date(expiresAt).getTime()
  if (Number.isNaN(end)) return null
  const ms = Math.max(0, end - Date.now())
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  const urgent = ms < 120000
  return (
    <div
      className={`mt-1 text-[10px] font-bold tabular-nums tracking-tight ${
        urgent ? 'text-red-600' : 'text-amber-800/90'
      }`}
    >
      Reserva {String(m).padStart(2, '0')}:{String(sec).padStart(2, '0')}
    </div>
  )
}

function Toast({ message, onDismiss }) {
  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-gray-900 text-white
                    text-sm px-4 py-3 rounded-xl shadow-2xl"
    >
      <CheckCircle2 size={16} className="text-green-400 shrink-0" />
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-2 text-gray-400 hover:text-white text-base leading-none"
      >
        ×
      </button>
    </div>
  )
}

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

const FILTERS = [
  { id: 'pending', label: 'Pendientes', apiStatus: 'pending', badgeClass: 'bg-amber-500' },
  {
    id: 'payment_submitted',
    label: 'En revisión',
    apiStatus: 'payment_submitted',
    badgeClass: 'bg-sky-500',
  },
  { id: 'approved', label: 'Activadas', apiStatus: 'approved', badgeClass: 'bg-emerald-500' },
  { id: 'rejected', label: 'Rechazadas', apiStatus: 'rejected', badgeClass: 'bg-red-500' },
  { id: 'cancelled', label: 'Canceladas', apiStatus: 'cancelled', badgeClass: 'bg-slate-500' },
  { id: 'expired', label: 'Caducadas', apiStatus: 'expired', badgeClass: 'bg-orange-500' },
]

function filterEmptyCopy(filterId) {
  if (filterId === 'pending') return 'pendientes'
  if (filterId === 'expired') return 'caducadas'
  if (filterId === 'payment_submitted') return 'en revisión'
  if (filterId === 'rejected') return 'rechazadas'
  if (filterId === 'cancelled') return 'canceladas'
  return 'activadas'
}

function SaleRowActions({
  sale,
  onActivate,
  onReject,
  onEdit,
  onDelete,
  onCancelApproved,
  onComment,
  onCopyCheckoutLink,
  onReactivate,
  activating,
  cancellingId,
  rejectingId,
  reactivatingId,
}) {
  const isPending = sale.status === 'pending'
  const isExpired = sale.status === 'expired'
  const awaitingStaff = sale.status === 'pending' || sale.status === 'payment_submitted'
  const staffAction = saleStaffReviewAction(sale)
  const staffPrimaryLabel = staffReviewPrimaryLabel(staffAction)
  const isApproved = sale.status === 'approved'
  const isVoidable = sale.status === 'approved' || sale.status === 'partially_paid'
  const archived = saleOpensReadOnly(sale)

  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {isPending && (sale.client_portal_token || sale.payment_token) && (
        <CopyPaymentLinkButton
          onClick={() => onCopyCheckoutLink?.(sale)}
          title={
            sale.client_portal_token
              ? 'Copiar enlace del portal del cliente (permanente)'
              : 'Copiar enlace de pago de esta venta (checkout)'
          }
        />
      )}
      {isExpired && (
        <button
          type="button"
          onClick={() => onReactivate?.(sale)}
          disabled={reactivatingId === sale.id}
          title="Reactivar reserva (10 min)"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg
                     bg-orange-600 text-white hover:bg-orange-700 shadow-sm
                     disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          {reactivatingId === sale.id ? (
            <span className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
          ) : (
            <RefreshCw size={14} strokeWidth={2.5} aria-hidden />
          )}
          Reactivar
        </button>
      )}
      {awaitingStaff && (
        <>
          <button
            type="button"
            onClick={() => onActivate(sale)}
            disabled={activating || rejectingId === sale.id}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg
                       bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {activating ? (
              <span className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
            ) : null}
            {staffPrimaryLabel}
          </button>
          <button
            type="button"
            onClick={() => onReject(sale)}
            disabled={activating || rejectingId === sale.id}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg
                       bg-red-600 text-white hover:bg-red-700 shadow-sm
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {rejectingId === sale.id ? (
              <span className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
            ) : null}
            Rechazar
          </button>
        </>
      )}

      <div className="flex items-center justify-end gap-0.5 shrink-0">
        <button
          type="button"
          onClick={() => onEdit(sale)}
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          title={
            archived
              ? 'Ver venta (solo lectura)'
              : isApproved
                ? 'Editar venta activada'
                : awaitingStaff
                  ? 'Editar venta pendiente / en revisión'
                  : 'Ver detalle de la venta'
          }
        >
          <Pencil size={14} />
        </button>
        <button
          type="button"
          onClick={() => onComment(sale)}
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          title="Comentario al cliente"
        >
          <MessageSquare size={14} />
        </button>
        {isVoidable && (
          <button
            type="button"
            disabled={cancellingId === sale.id}
            onClick={() => onCancelApproved(sale)}
            className="p-1.5 rounded-lg text-red-500 hover:text-red-700 hover:bg-red-50 transition-colors
                       disabled:opacity-40 disabled:cursor-not-allowed"
            title="Anular factura (reverso contable e inventario)"
          >
            {cancellingId === sale.id ? (
              <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-red-400 border-t-transparent animate-spin" />
            ) : (
              <Ban size={14} />
            )}
          </button>
        )}
        <button
          type="button"
          disabled={!isPending && !isExpired}
          onClick={() => (isPending || isExpired) && onDelete(sale)}
          className="p-1.5 rounded-lg text-gray-400 hover:text-slate-700 hover:bg-slate-100 transition-colors
                     disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400"
          title={
            isPending || isExpired ? 'Eliminar esta venta del listado' : 'Solo ventas pendientes o caducadas'
          }
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

export default function Sales() {
  const [sales, setSales] = useState([])
  /** Solo afecta el cuerpo de la tabla; KPIs/filtros/pestañas permanecen montados. */
  const [tableLoading, setTableLoading] = useState(true)
  const [fetchError, setFetchError] = useState(null)
  const salesFetchGenRef = useRef(0)
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  const isAdmin = getStoredUser()?.role === 'admin'
  const { openNewSale, openReceivePayment } = useModal()
  const [toast, setToast] = useState(null)
  const [filter, setFilter] = useState('approved')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [filterClientOrUser, setFilterClientOrUser] = useState('')
  const [filterNumber, setFilterNumber] = useState('')
  const [filterPaymentMethod, setFilterPaymentMethod] = useState('')
  const [filterCurrency, setFilterCurrency] = useState('')
  const [filterTags, setFilterTags] = useState('')
  const [paymentMethods, setPaymentMethods] = useState([])
  const [page, setPage] = useState(1)
  const [activatingId, setActivatingId] = useState(null)
  const [reactivatingId, setReactivatingId] = useState(null)
  const [rejectingId, setRejectingId] = useState(null)
  /** Modal rechazo motivo + evidencia (paso tras confirmación Swal). */
  const [rejectModalSale, setRejectModalSale] = useState(null)
  const [rejectReasonText, setRejectReasonText] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const rejectFileInputRef = useRef(null)
  const [cancellingId, setCancellingId] = useState(null)
  const [metrics, setMetrics] = useState({
    total: 0,
    pending: 0,
    expired: 0,
    review: 0,
    activated: 0,
    rejected: 0,
    voided: 0,
    revenueUsd: 0,
  })
  const { refreshInventoryData } = useInventoryData()
  const [editSale, setEditSale] = useState(null)

  const [extendTimerModalSale, setExtendTimerModalSale] = useState(null)
  const [extendTimerMinutes, setExtendTimerMinutes] = useState('10')
  const [extendTimerSubmitting, setExtendTimerSubmitting] = useState(false)

  const [pendingPayments, setPendingPayments] = useState([])
  // Modal de revisión consolidada (sale_id → muestra saldo+comprobante antes de activar)
  const [reviewActivateSale, setReviewActivateSale] = useState(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const deepLinkHandledRef = useRef(null)

  const pendingAbonosStandalone = useMemo(
    () => pendingPayments.filter((p) => !p.encapsulated_in_sale_review),
    [pendingPayments],
  )

  const salesTabCounts = useMemo(
    () => ({
      pending: metrics.pending,
      expired: metrics.expired,
      payment_submitted: metrics.review + pendingAbonosStandalone.length,
      approved: metrics.activated,
      rejected: metrics.rejected,
      cancelled: metrics.voided,
    }),
    [metrics, pendingAbonosStandalone.length],
  )

  const refreshPendingPayments = useCallback(async () => {
    try {
      const { data } = await api.get('/api/v1/payments/', {
        params: { status_filter: 'pending_review', review_queue: 'standalone' },
      })
      setPendingPayments(Array.isArray(data) ? data : [])
    } catch {
      setPendingPayments([])
    }
  }, [])

  const refreshMetrics = useCallback(async () => {
    try {
      const { data } = await api.get('/api/v1/sales/')
      const list = Array.isArray(data) ? data : []
      setMetrics({
        total: list.length,
        pending: list.filter((s) => s.status === 'pending').length,
        expired: list.filter((s) => s.status === 'expired').length,
        review: list.filter((s) => s.status === 'payment_submitted').length,
        activated: list.filter((s) => s.status === 'approved').length,
        rejected: list.filter((s) => s.status === 'rejected').length,
        voided: list.filter((s) => s.status === 'cancelled' || s.status === 'annulled').length,
        revenueUsd: list
          .filter((s) => s.status === 'approved')
          .reduce((acc, s) => acc + parseFloat(s.amount || 0), 0),
      })
    } catch {
      /* no bloquear la página */
    }
  }, [])

  const fetchSales = useCallback(async () => {
    const gen = ++salesFetchGenRef.current
    setTableLoading(true)
    setFetchError(null)
    try {
      const f = FILTERS.find((x) => x.id === filter)
      const params = { status: f?.apiStatus ?? 'approved' }
      const { data } = await api.get('/api/v1/sales/', { params })
      if (gen !== salesFetchGenRef.current) return
      setSales(Array.isArray(data) ? data : [])
      void refreshMetrics()
      if (filter === 'payment_submitted') void refreshPendingPayments()
      setHasLoadedOnce(true)
    } catch {
      if (gen !== salesFetchGenRef.current) return
      setFetchError('No se pudo cargar el historial de ventas. Verifica la conexión.')
    } finally {
      if (gen === salesFetchGenRef.current) {
        setTableLoading(false)
      }
    }
  }, [filter, refreshMetrics, refreshPendingPayments])

  useEffect(() => {
    void refreshMetrics()
  }, [refreshMetrics])

  const handleReviewPayment = useCallback(
    (payment) => {
      openReceivePayment(
        () => {
          fetchSales()
          refreshPendingPayments()
          refreshMetrics()
        },
        {
          paymentId: payment.id,
          paymentNumber: payment.payment_number,
          clientId: payment.client_id,
          amount: payment.amount,
          currency: payment.currency,
          receiptUrl: payment.receipt_file_url,
          paymentMethodId: payment.payment_method_id,
          depositAccountId: payment.deposit_account_id,
          referenceNumber: payment.reference_number,
          notes: payment.notes,
        },
      )
    },
    [openReceivePayment, fetchSales, refreshPendingPayments, refreshMetrics],
  )

  const handleRejectPayment = useCallback(
    async (id) => {
      if (!window.confirm('¿Rechazar este pago?')) return
      try {
        await api.patch(`/api/v1/payments/${id}/reject`)
        await refreshPendingPayments()
        await refreshMetrics()
        setToast('Pago rechazado.')
        setTimeout(() => setToast(null), 4000)
      } catch (err) {
        const d = err?.response?.data?.detail
        setToast(typeof d === 'string' ? d : 'No se pudo rechazar el pago.')
        setTimeout(() => setToast(null), 6000)
      }
    },
    [refreshPendingPayments, refreshMetrics],
  )

  useEffect(() => {
    fetchSales()
  }, [fetchSales])

  /**
   * Deep links:
   * - /ventas?open_sale=42 | ?sale_id=42 → modal aprobar pago (payment_submitted) o editar venta
   * - /ventas?payment_id=99 → modal aprobar abono CxC standalone
   * - /ventas?sale=42 | ?search=42 → editar venta (informes CxC, legacy)
   */
  useEffect(() => {
    const paymentRaw = searchParams.get('payment_id')
    if (paymentRaw) {
      const pid = parseInt(String(paymentRaw).replace(/\D/g, ''), 10)
      if (!Number.isFinite(pid) || pid < 1) return
      const linkKey = `payment:${pid}`
      if (deepLinkHandledRef.current === linkKey) return

      let cancelled = false
      ;(async () => {
        try {
          const { data: payment } = await api.get(`/api/v1/payments/${pid}`)
          if (cancelled || !payment?.id) return
          deepLinkHandledRef.current = linkKey
          setFilter('payment_submitted')
          openReceivePayment(
            () => {
              fetchSales()
              refreshPendingPayments()
              refreshMetrics()
            },
            {
              paymentId: payment.id,
              paymentNumber: payment.payment_number,
              clientId: payment.client_id,
              amount: payment.amount,
              currency: payment.currency,
              receiptUrl: payment.receipt_file_url,
              paymentMethodId: payment.payment_method_id,
              depositAccountId: payment.deposit_account_id,
              referenceNumber: payment.reference_number,
              notes: payment.notes,
            },
          )
          setSearchParams({}, { replace: true })
        } catch {
          if (!cancelled) {
            setToast(`No se encontró el pago #${pid}.`)
            setTimeout(() => setToast(null), 5000)
            setSearchParams({}, { replace: true })
          }
        }
      })()
      return () => {
        cancelled = true
      }
    }

    const openSaleRaw = searchParams.get('open_sale')
    const saleIdRaw = searchParams.get('sale_id')
    const notifySaleDeepLink = Boolean(openSaleRaw || saleIdRaw)
    const legacyRaw = searchParams.get('sale') || searchParams.get('search')
    const raw = openSaleRaw || saleIdRaw || legacyRaw
    if (!raw) {
      deepLinkHandledRef.current = null
      return
    }
    const sid = parseInt(String(raw).replace(/\D/g, ''), 10)
    if (!Number.isFinite(sid) || sid < 1) return
    const linkKey = openSaleRaw
      ? `open_sale:${sid}`
      : saleIdRaw
        ? `sale_notify:${sid}`
        : `sale_edit:${sid}`
    if (deepLinkHandledRef.current === linkKey) return

    let cancelled = false
    ;(async () => {
      try {
        const { data } = await api.get(`/api/v1/sales/${sid}`)
        if (cancelled || !data?.id) return
        deepLinkHandledRef.current = linkKey
        setFilterNumber(String(sid))

        if (notifySaleDeepLink && data.status === 'payment_submitted') {
          setFilter('payment_submitted')
          setReviewActivateSale(data)
        } else {
          setEditSale(data)
        }
        setSearchParams({}, { replace: true })
      } catch {
        if (!cancelled) {
          setFilterNumber(String(sid))
          setToast(`No se encontró la venta #${sid}.`)
          setTimeout(() => setToast(null), 5000)
          setSearchParams({}, { replace: true })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    searchParams,
    setSearchParams,
    openReceivePayment,
    fetchSales,
    refreshPendingPayments,
    refreshMetrics,
  ])

  /** Refresco por robot global (/sales/sync-web-credits desde catalogo-vip). */
  useEffect(() => {
    function onCatalogSync(ev) {
      const n = Number(ev?.detail?.sales?.count ?? 0)
      if (!Number.isFinite(n) || n < 1) return
      void fetchSales()
      void refreshPendingPayments()
      void refreshMetrics()
    }
    window.addEventListener('erp-web-catalog-sync', onCatalogSync)
    return () => window.removeEventListener('erp-web-catalog-sync', onCatalogSync)
  }, [fetchSales, refreshPendingPayments, refreshMetrics])

  useEffect(() => {
    let cancelled = false
    api
      .get('/api/v1/payment-methods/')
      .then(({ data }) => {
        if (!cancelled) setPaymentMethods(Array.isArray(data) ? data : [])
      })
      .catch(() => {
        if (!cancelled) setPaymentMethods([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const salesPaymentMethodFilterOptions = useMemo(
    () =>
      paymentMethods
        .filter((m) => m?.is_active !== false)
        .map((m) => ({ value: String(m.id), label: m.name })),
    [paymentMethods],
  )

  const salesCurrencyFilterOptions = useMemo(
    () => SALES_CURRENCIES.map((c) => ({ value: c.code, label: c.code })),
    [],
  )

  function handleOpenNewSale() {
    openNewSale(async () => {
      await fetchSales()
    })
  }

  async function handleCopyCheckoutLink(sale) {
    try {
      const kind = await copySalePaymentLink(sale)
      setToast(
        kind === 'portal' ? 'Enlace del portal del cliente copiado' : 'Enlace de pago de la venta copiado',
      )
      setTimeout(() => setToast(null), 2600)
    } catch {
      setToast('No se pudo copiar el enlace.')
      setTimeout(() => setToast(null), 5000)
    }
  }

  async function handleRejectPending(sale) {
    if (sale.status !== 'pending' && sale.status !== 'payment_submitted') return

    const confirmContinue = await Swal.fire({
      title: '¿Rechazar esta venta?',
      html: '<p class="text-sm text-slate-600 text-left">Se liberará el inventario reservado (créditos en catálogo y pantallas en bodega). Esta acción requiere una segunda confirmación con el motivo.</p>',
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: '#dc2626',
      cancelButtonColor: '#64748b',
      confirmButtonText: 'Continuar',
      cancelButtonText: 'Cancelar',
    })
    if (!confirmContinue.isConfirmed) return

    setRejectReasonText('')
    setSelectedFile(null)
    if (rejectFileInputRef.current) {
      rejectFileInputRef.current.value = ''
    }
    setRejectModalSale(sale)
  }

  function closeRejectModal() {
    setRejectModalSale(null)
    setRejectReasonText('')
    setSelectedFile(null)
    if (rejectFileInputRef.current) {
      rejectFileInputRef.current.value = ''
    }
  }

  async function submitRejectModal() {
    const sale = rejectModalSale
    if (!sale) return
    const reason = rejectReasonText.trim()
    if (!reason) {
      setToast('El motivo del rechazo es obligatorio.')
      setTimeout(() => setToast(null), 4500)
      return
    }
    const file = selectedFile

    setRejectingId(sale.id)
    try {
      if (file) {
        const fd = new FormData()
        fd.append('status', 'rejected')
        fd.append('rejection_reason', reason)
        fd.append('rejection_image', file)
        await api.put(`/api/v1/sales/${sale.id}/status`, fd)
      } else {
        await api.put(`/api/v1/sales/${sale.id}/status`, {
          status: 'rejected',
          rejection_reason: reason,
        })
      }
      closeRejectModal()
      await fetchSales()
      await refreshInventoryData()
      setFilter('rejected')
      setToast(`Venta rechazada. Motivo registrado.`)
      setTimeout(() => setToast(null), 4800)
    } catch (err) {
      const msg = formatApiError(err, 'No se pudo rechazar la venta.')
      setToast(msg)
      setTimeout(() => setToast(null), 7000)
    } finally {
      setRejectingId(null)
    }
  }

  async function handleReactivate(sale) {
    if (sale.status !== 'expired') return
    setReactivatingId(sale.id)
    try {
      await api.patch(`/api/v1/sales/${sale.id}/reactivate`)
      await fetchSales()
      await refreshInventoryData()
      setToast(`Pedido #${formatSaleDocNo(sale.id)} reactivado (nueva reserva 10 min).`)
      setTimeout(() => setToast(null), 4800)
    } catch (err) {
      const msg = formatApiError(err, 'No se pudo reactivar la venta.')
      setToast(msg)
      setTimeout(() => setToast(null), 7000)
    } finally {
      setReactivatingId(null)
    }
  }

  function openExtendTimerModal(sale) {
    setExtendTimerModalSale(sale)
    setExtendTimerMinutes('10')
  }

  function closeExtendTimerModal() {
    setExtendTimerModalSale(null)
    setExtendTimerMinutes('10')
  }

  async function submitExtendTimer() {
    const sale = extendTimerModalSale
    if (!sale) return
    const n = parseInt(String(extendTimerMinutes).trim(), 10)
    if (!Number.isFinite(n) || n < 1) {
      setToast('Indica un número de minutos válido (mínimo 1).')
      setTimeout(() => setToast(null), 5000)
      return
    }
    setExtendTimerSubmitting(true)
    try {
      await api.patch(`/api/v1/sales/${sale.id}/extend-timer`, { extra_minutes: n })
      closeExtendTimerModal()
      await fetchSales()
      setToast(`Reserva extendida ${n} minuto${n === 1 ? '' : 's'}.`)
      setTimeout(() => setToast(null), 4200)
    } catch (err) {
      const msg = formatApiError(err, 'No se pudo extender el temporizador.')
      setToast(msg)
      setTimeout(() => setToast(null), 7000)
    } finally {
      setExtendTimerSubmitting(false)
    }
  }

  async function handleActivate(sale) {
    // Comprobante en revisión: modal consolidado (activación o solo cobro según inventario).
    if (sale.status === 'payment_submitted') {
      setReviewActivateSale(sale)
      return
    }
    await _doActivateSale(sale)
  }

  async function _doActivateSale(sale) {
    const action = saleStaffReviewAction(sale)
    setActivatingId(sale.id)
    try {
      await api.patch(`/api/v1/sales/${sale.id}/activate`)
      await fetchSales()
      if (action !== 'approve_payment') {
        await refreshInventoryData()
        window.dispatchEvent(new CustomEvent('products:changed'))
      }
      setToast(staffReviewSuccessToast(sale, action))
      setTimeout(() => setToast(null), 4800)
    } catch (err) {
      const fallback =
        action === 'approve_payment' ? 'No se pudo aprobar el pago.' : 'No se pudo activar la venta.'
      const msg = formatApiError(err, fallback)
      setToast(msg)
      setTimeout(() => setToast(null), 7000)
    } finally {
      setActivatingId(null)
      setReviewActivateSale(null)
    }
  }

  async function handleCancelApproved(sale) {
    if (sale.status !== 'approved' && sale.status !== 'partially_paid') return

    const confirmed = await confirmVoidTransaction({
      entityLabel: `factura ${formatSaleDocNo(sale)}`,
      includeInventoryNote: true,
    })
    if (!confirmed) return

    setCancellingId(sale.id)
    try {
      await api.post(`/api/v1/sales/${sale.id}/void`)
      await fetchSales()
      await refreshInventoryData()
      setFilter('cancelled')
      setToast('Factura anulada. Inventario devuelto y asientos contables revertidos.')
      setTimeout(() => setToast(null), 4800)
    } catch (err) {
      const msg = formatApiError(err, 'No se pudo anular la factura.')
      setToast(msg)
      setTimeout(() => setToast(null), 7000)
    } finally {
      setCancellingId(null)
    }
  }

  async function handleDelete(sale) {
    if (
      !window.confirm(
        `¿Eliminar la venta pendiente #${sale.id} de ${sale.client_name}? Si había pantalla en bodega reservada, quedará libre.`,
      )
    ) {
      return
    }
    try {
      await api.delete(`/api/v1/sales/${sale.id}`)
      await fetchSales()
      await refreshInventoryData()
      setToast('Venta eliminada.')
      setTimeout(() => setToast(null), 3800)
    } catch (err) {
      const msg = err.response?.data?.detail || 'No se pudo eliminar.'
      setToast(typeof msg === 'string' ? msg : 'Error al eliminar.')
      setTimeout(() => setToast(null), 5000)
    }
  }

  async function handleComment(sale) {
    const text = window.prompt(`Comentario en la ficha de ${sale.client_name}:`)
    if (!text?.trim()) return
    try {
      await api.post('/api/v1/client-notes/', {
        client_id: sale.client_id,
        note: `[Ventas #${sale.id}] ${text.trim()}`,
      })
      setToast('Comentario guardado en el cliente.')
      setTimeout(() => setToast(null), 3800)
    } catch {
      setToast('No se pudo guardar el comentario.')
      setTimeout(() => setToast(null), 4000)
    }
  }

  const filteredSales = useMemo(() => {
    let result = Array.isArray(sales) ? [...sales] : []

    if (filterClientOrUser.trim()) {
      const term = filterClientOrUser.trim().toLowerCase()
      result = result.filter(
        (s) =>
          (s.client_name && String(s.client_name).toLowerCase().includes(term)) ||
          (s.iptv_username && String(s.iptv_username).toLowerCase().includes(term)) ||
          (s.client_email && String(s.client_email).toLowerCase().includes(term)),
      )
    }
    if (filterNumber.trim()) {
      const raw = filterNumber.trim().toLowerCase().replace(/\s+/g, '')
      result = result.filter((s) => {
        const doc = formatSaleDocNo(s.id).toLowerCase()
        const idStr = String(s.id)
        const stripped = raw.replace(/^0+/, '') || raw
        return doc.includes(raw) || idStr.includes(stripped)
      })
    }
    if (filterDateFrom) {
      const fromMs = ecuadorDayStartMs(filterDateFrom)
      if (!Number.isNaN(fromMs)) {
        result = result.filter((s) => new Date(s.created_at).getTime() >= fromMs)
      }
    }
    if (filterDateTo) {
      const toMs = ecuadorDayEndMs(filterDateTo)
      if (!Number.isNaN(toMs)) {
        result = result.filter((s) => new Date(s.created_at).getTime() <= toMs)
      }
    }
    if (filterPaymentMethod) {
      const pmId = Number(filterPaymentMethod)
      if (Number.isFinite(pmId)) {
        result = result.filter((s) => Number(s.payment_method_id) === pmId)
      }
    }
    if (filterCurrency) {
      const cur = filterCurrency.toUpperCase()
      result = result.filter((s) => String(s.currency || '').toUpperCase() === cur)
    }
    if (filterTags.trim()) {
      const term = filterTags.trim().toLowerCase()
      result = result.filter((s) => {
        const arr = Array.isArray(s.tags) ? s.tags : []
        return arr.some((name) => String(name).toLowerCase().includes(term))
      })
    }

    return result
  }, [
    sales,
    filterClientOrUser,
    filterNumber,
    filterDateFrom,
    filterDateTo,
    filterPaymentMethod,
    filterCurrency,
    filterTags,
  ])

  const totalFiltered = filteredSales.length
  const totalPages = Math.max(1, Math.ceil(totalFiltered / ITEMS_PER_PAGE))

  const paginatedSales = useMemo(() => {
    const safePage = Math.min(Math.max(1, page), totalPages)
    const start = (safePage - 1) * ITEMS_PER_PAGE
    return filteredSales.slice(start, start + ITEMS_PER_PAGE)
  }, [filteredSales, page, totalPages])

  useEffect(() => {
    setPage(1)
  }, [
    filter,
    filterDateFrom,
    filterDateTo,
    filterClientOrUser,
    filterNumber,
    filterPaymentMethod,
    filterCurrency,
    filterTags,
  ])

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages))
  }, [totalPages])

  function clearFilters() {
    setFilterDateFrom('')
    setFilterDateTo('')
    setFilterClientOrUser('')
    setFilterNumber('')
    setFilterPaymentMethod('')
    setFilterCurrency('')
    setFilterTags('')
  }

  const currentPage = Math.min(Math.max(1, page), totalPages)

  const showRejectReasonCol = filter === 'rejected'
  const tableColSpan = showRejectReasonCol ? 13 : 12

  return (
    <>
      {editSale && (
        <NuevaVentaModal
          initialSale={editSale}
          readOnlyMode={saleOpensReadOnly(editSale)}
          onClose={() => setEditSale(null)}
          onSuccess={async () => {
            await fetchSales()
            setEditSale(null)
          }}
          onToast={(msg) => {
            setToast(typeof msg === 'string' ? msg : String(msg ?? ''))
            setTimeout(() => setToast(null), 2600)
          }}
        />
      )}

      {toast && (
        <Toast message={typeof toast === 'string' ? toast : toast?.message ?? ''} onDismiss={() => setToast(null)} />
      )}

      {extendTimerModalSale && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !extendTimerSubmitting) closeExtendTimerModal()
          }}
        >
          <div
            role="dialog"
            aria-labelledby="extend-timer-title"
            aria-modal="true"
            className="relative w-full max-w-sm rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200/80 overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-6 pt-5 pb-2 border-b border-slate-100">
              <h2 id="extend-timer-title" className="text-lg font-semibold text-slate-900">
                Extender reserva
              </h2>
              <p className="text-sm text-slate-600 mt-1">
                Pedido #{formatSaleDocNo(extendTimerModalSale.id)}
                {extendTimerModalSale.client_name ? ` · ${extendTimerModalSale.client_name}` : ''}
              </p>
            </div>
            <div className="px-6 py-4 space-y-4">
              <label htmlFor="extend-timer-input" className="block text-sm font-medium text-slate-700">
                ¿Cuántos minutos extra deseas dar a esta reserva?
              </label>
              <input
                id="extend-timer-input"
                type="number"
                min={1}
                step={1}
                value={extendTimerMinutes}
                onChange={(e) => setExtendTimerMinutes(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400"
              />
            </div>
            <div className="px-6 py-4 bg-slate-50 flex justify-end gap-2 border-t border-slate-100">
              <button
                type="button"
                disabled={extendTimerSubmitting}
                onClick={closeExtendTimerModal}
                className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-200/60 rounded-lg transition-colors disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={extendTimerSubmitting}
                onClick={submitExtendTimer}
                className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm disabled:opacity-50 inline-flex items-center gap-2"
              >
                {extendTimerSubmitting ? (
                  <span className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                ) : null}
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      {rejectModalSale && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-[2px]"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeRejectModal()
          }}
        >
          <div
            role="dialog"
            aria-labelledby="reject-modal-title"
            aria-modal="true"
            className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl ring-1 ring-slate-200/80 overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="px-6 pt-5 pb-2 border-b border-slate-100">
              <h2 id="reject-modal-title" className="text-lg font-semibold text-slate-900">
                Motivo del rechazo
              </h2>
              <p className="text-sm text-slate-600 mt-1">
                Describe el motivo. Opcional: adjunta una imagen como evidencia (solo formatos admitidos por el
                servidor).
              </p>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div>
                <label htmlFor="reject-reason-ta" className="sr-only">
                  Motivo
                </label>
                <textarea
                  id="reject-reason-ta"
                  value={rejectReasonText}
                  onChange={(e) => setRejectReasonText(e.target.value)}
                  rows={4}
                  placeholder="Ej. Pago no conciliado, solicitud del cliente…"
                  className="w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm
                             text-slate-800 placeholder:text-slate-400 shadow-sm focus:outline-none
                             focus:ring-2 focus:ring-red-500/30 focus:border-red-400"
                />
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide mb-2">
                  Evidencia (opcional)
                </p>
                <input
                  ref={rejectFileInputRef}
                  id="reject-evidence-file"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null
                    setSelectedFile(f)
                  }}
                />
                <label
                  htmlFor="reject-evidence-file"
                  className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed
                    px-6 py-8 cursor-pointer transition-colors text-center select-none min-h-[148px]
                    ${selectedFile ? 'border-green-400/70 bg-green-50/80 hover:bg-green-50' : 'border-slate-300 bg-gray-50 hover:bg-gray-100'}`}
                >
                  {selectedFile ? (
                    <>
                      <CheckCircle2 className="text-green-600 shrink-0" size={34} aria-hidden strokeWidth={2} />
                      <div className="flex flex-col items-center gap-1 min-w-0 w-full px-1">
                        <span className="text-sm font-semibold text-slate-800 truncate max-w-full" title={selectedFile.name}>
                          {selectedFile.name}
                        </span>
                        <span className="text-xs text-green-700 font-medium">Archivo seleccionado</span>
                      </div>
                      <button
                        type="button"
                        className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold
                                   text-red-700 bg-red-50 hover:bg-red-100 ring-1 ring-red-200/70 transition-colors"
                        onClick={(evt) => {
                          evt.preventDefault()
                          evt.stopPropagation()
                          setSelectedFile(null)
                          if (rejectFileInputRef.current) {
                            rejectFileInputRef.current.value = ''
                          }
                        }}
                      >
                        <XCircle size={15} aria-hidden strokeWidth={2} />
                        Quitar archivo
                      </button>
                    </>
                  ) : (
                    <>
                      <UploadCloud className="text-slate-400 shrink-0" size={36} aria-hidden strokeWidth={1.5} />
                      <span className="text-sm font-medium text-slate-600 max-w-[250px]">
                        Haga clic para cargar una foto o un documento (opcional)
                      </span>
                      <span className="text-xs text-slate-500">
                        Solo imágenes por ahora · JPG, PNG, WEBP…
                      </span>
                    </>
                  )}
                </label>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-6 py-4 bg-slate-50/90 border-t border-slate-100">
              <button
                type="button"
                onClick={closeRejectModal}
                className="px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-white rounded-xl
                           ring-1 ring-slate-200 transition-colors"
              >
                Volver
              </button>
              <button
                type="button"
                disabled={rejectingId === rejectModalSale.id}
                onClick={() => submitRejectModal()}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-bold rounded-xl text-white
                           bg-red-600 hover:bg-red-700 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed
                           transition-colors"
              >
                {rejectingId === rejectModalSale.id ? (
                  <span className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                ) : null}
                Devolver venta
              </button>
            </div>
          </div>
        </div>
      )}

      {reviewActivateSale && (
        <SaleActivationReviewModal
          sale={reviewActivateSale}
          activating={activatingId === reviewActivateSale.id}
          onClose={() => { if (activatingId !== reviewActivateSale.id) setReviewActivateSale(null) }}
          onConfirm={() => _doActivateSale(reviewActivateSale)}
        />
      )}

      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Ventas</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {tableLoading && !hasLoadedOnce
                ? 'Cargando…'
                : tableLoading
                  ? 'Actualizando listado…'
                  : `${sales.length === filteredSales.length ? `${filteredSales.length} registro${filteredSales.length !== 1 ? 's' : ''} en esta vista` : `${filteredSales.length} mostrada${filteredSales.length !== 1 ? 's' : ''} · ${sales.length} en la pestaña`}${
                      totalFiltered > ITEMS_PER_PAGE
                        ? ` · ${ITEMS_PER_PAGE} por página (pág. ${currentPage} de ${totalPages})`
                        : ''
                    }`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openReceivePayment(() => fetchSales())}
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-[#2ca01c] text-[#1b5e20]
                         hover:bg-green-50 text-sm font-semibold rounded-lg shadow-sm transition-colors"
            >
              <Banknote size={16} />
              Recibir pago
            </button>
            <button
              type="button"
              onClick={handleOpenNewSale}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700
                         active:bg-blue-800 text-white text-sm font-medium rounded-lg shadow-sm transition-colors"
            >
              <ShoppingCart size={16} />
              Nueva Venta
            </button>
          </div>
        </div>

        {/* Shell fijo: nunca condicionado por tableLoading */}
        <SalesKPIs metrics={metrics} />

        <SalesFilters
          filterDateFrom={filterDateFrom}
          filterDateTo={filterDateTo}
          filterClientOrUser={filterClientOrUser}
          filterNumber={filterNumber}
          filterPaymentMethod={filterPaymentMethod}
          filterCurrency={filterCurrency}
          filterTags={filterTags}
          onFilterDateFromChange={setFilterDateFrom}
          onFilterDateToChange={setFilterDateTo}
          onFilterClientOrUserChange={setFilterClientOrUser}
          onFilterNumberChange={setFilterNumber}
          onFilterPaymentMethodChange={setFilterPaymentMethod}
          onFilterCurrencyChange={setFilterCurrency}
          onFilterTagsChange={setFilterTags}
          onClearFilters={clearFilters}
          paymentMethodOptions={salesPaymentMethodFilterOptions}
          currencyOptions={salesCurrencyFilterOptions}
        />

        <SalesTabs
          tabs={FILTERS}
          activeId={filter}
          onChange={setFilter}
          counts={salesTabCounts}
        />

        {/* Solo la tabla reacciona al fetch de la pestaña activa */}
        <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-100 overflow-hidden w-full min-h-[28rem] flex flex-col">
          <div className="w-full overflow-x-auto flex-1 min-h-[22rem]">
            <table className="w-full table-auto text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <ResizableTh>FECHA</ResizableTh>
                  <ResizableTh className="min-w-0">CLIENTE</ResizableTh>
                  <ResizableTh className="min-w-0">USUARIO</ResizableTh>
                  <ResizableTh className="!px-2 w-16">N.º</ResizableTh>
                  <ResizableTh className="min-w-0 max-w-[11rem]">NOTA</ResizableTh>
                  <ResizableTh>MÉTODO DE PAGO</ResizableTh>
                  <ResizableTh>MONEDA</ResizableTh>
                  <ResizableTh>ETIQUETAS</ResizableTh>
                  <ResizableTh align="right">IMPORTE</ResizableTh>
                  <ResizableTh className="min-w-[108px]">ESTADO</ResizableTh>
                  <ResizableTh className="w-14 text-center">COMPROBANTE</ResizableTh>
                  {showRejectReasonCol ? (
                    <ResizableTh className="min-w-[12rem] max-w-[18rem]">MOTIVO / EVIDENCIA</ResizableTh>
                  ) : null}
                  <ResizableTh align="right" className="min-w-[220px]">
                    ACCIONES
                  </ResizableTh>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-50">
                {tableLoading ? (
                  <SalesTableSkeleton colSpan={tableColSpan} isRefreshing={hasLoadedOnce} />
                ) : fetchError ? (
                  <tr>
                    <td colSpan={tableColSpan} className="px-3 py-12 text-center text-red-500 text-sm">
                      {fetchError}
                    </td>
                  </tr>
                ) : sales.length === 0 &&
                  !(filter === 'payment_submitted' && pendingAbonosStandalone.length > 0) ? (
                  <tr>
                    <td colSpan={tableColSpan} className="px-3 py-16 text-center">
                      <ShoppingCart size={32} className="mx-auto text-gray-200 mb-3" />
                      <p className="text-gray-400 text-sm font-medium">
                        Sin ventas {filterEmptyCopy(filter)}
                      </p>
                      <p className="text-gray-300 text-xs mt-1">Usa &quot;Nueva Venta&quot; o cambia de pestaña</p>
                    </td>
                  </tr>
                ) : sales.length > 0 && filteredSales.length === 0 ? (
                  <tr>
                    <td colSpan={tableColSpan} className="px-3 py-12 text-center text-gray-500 text-sm">
                      Ninguna venta coincide con los filtros. Prueba a limpiar o ampliar la búsqueda.
                    </td>
                  </tr>
                ) : (
                  <>
                  {paginatedSales.map((sale) => (
                    <tr
                      key={sale.id}
                      className={`hover:bg-gray-50/60 transition-colors group ${
                        sale.status === 'pending'
                          ? 'bg-amber-50/25'
                          : sale.status === 'payment_submitted'
                            ? 'bg-sky-50/30'
                            : sale.status === 'expired'
                              ? 'bg-orange-50/25'
                              : ''
                      }`}
                    >
                      <td className="px-3 py-2.5 whitespace-nowrap text-gray-600 text-sm align-middle">
                        {formatSaleTableDate(sale.created_at)}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap min-w-0 max-w-[11rem] align-middle">
                        <div className="flex items-center gap-2 min-w-0">
                          <div
                            className="w-6 h-6 rounded-full bg-blue-100 flex items-center
                                        justify-center shrink-0"
                          >
                            <span className="text-[10px] font-bold text-blue-600">
                              {(sale.client_name || '?').charAt(0).toUpperCase()}
                            </span>
                          </div>
                          <span className="font-medium text-gray-800 truncate">{sale.client_name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap min-w-0 max-w-[9rem] align-middle">
                        <span className="font-mono tabular-nums text-sm text-gray-700 truncate block">
                          {sale.iptv_username && String(sale.iptv_username).trim()
                            ? String(sale.iptv_username).trim()
                            : '—'}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 whitespace-nowrap w-16 font-medium text-gray-800 tabular-nums text-sm align-middle">
                        {formatSaleDocNo(sale.id)}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap min-w-0 max-w-[11rem] align-middle">
                        <SaleListNotesCell notes={sale.notes} />
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-gray-700 text-sm align-middle">
                        {sale.payment_method && String(sale.payment_method).trim()
                          ? String(sale.payment_method).trim()
                          : '—'}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap font-mono tabular-nums text-gray-800 text-sm align-middle">
                        {sale.currency ? String(sale.currency).toUpperCase() : '—'}
                      </td>
                      <td
                        className="px-3 py-2.5 whitespace-nowrap text-gray-700 text-sm align-middle max-w-[14rem] truncate"
                        title={
                          Array.isArray(sale.tags) && sale.tags.length
                            ? sale.tags.join(', ')
                            : undefined
                        }
                      >
                        <div className="flex flex-wrap items-center gap-1">
                          {/* 1. Badge Morado con el Nombre del Producto/Descripción */}
                          {(sale.product_name || (sale.invoice_lines && sale.invoice_lines[0]?.description)) ? (
                            <span className="inline-flex px-2 py-1 text-xs font-medium rounded-md bg-purple-50 text-purple-700 border border-purple-200 whitespace-nowrap shadow-sm">
                              {sale.product_name || sale.invoice_lines[0].description}
                            </span>
                          ) : null}

                          {/* 2. Las etiquetas normales (si existen) */}
                          {Array.isArray(sale.tags) && sale.tags.length > 0 ? (
                            sale.tags.map(tag => (
                              <span key={tag} className="inline-flex px-2 py-1 text-xs font-medium rounded-md bg-gray-100 text-gray-700 border border-gray-200 whitespace-nowrap">
                                {tag}
                              </span>
                            ))
                          ) : (!(sale.product_name || (sale.invoice_lines && sale.invoice_lines[0]?.description))) ? (
                            <span className="text-gray-400">-</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-right align-middle">
                        <div className="inline-block text-right">
                          <SaleAmountCell sale={sale} />
                        </div>
                      </td>
                      <td className="px-3 py-2.5 align-middle min-w-[108px] max-w-[220px]">
                        <div className="flex flex-col items-center gap-1 min-w-0">
                          <StatusBadge status={sale.status} />
                          {sale.status === 'payment_submitted' ? (
                            <OcrSecurityBadges
                              {...pickOcrFlagsFromSale(sale)}
                              layout="table"
                              illegibleLayout="compact"
                            />
                          ) : null}
                          {sale.status === 'pending' && sale.expires_at ? (
                            <PendingReservationCountdown expiresAt={sale.expires_at} />
                          ) : null}
                          {isAdmin && sale.status === 'pending' ? (
                            <button
                              type="button"
                              onClick={() => openExtendTimerModal(sale)}
                              className="mt-0.5 inline-flex items-center gap-1 rounded p-0.5 text-gray-400 hover:text-blue-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/50"
                              title="Extender tiempo de reserva"
                            >
                              <Clock size={13} strokeWidth={2} aria-hidden />
                              <span className="sr-only">Extender tiempo de reserva</span>
                            </button>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-center align-middle w-14">
                        <SaleReceiptProofLink sale={sale} />
                      </td>
                      {showRejectReasonCol ? (
                        <td className="px-3 py-2.5 align-top text-xs text-slate-700 max-w-[18rem]">
                          {sale.status === 'rejected' && sale.rejection_reason ? (
                            <span
                              className="line-clamp-4 whitespace-pre-wrap break-words"
                              title={sale.rejection_reason}
                            >
                              {sale.rejection_reason}
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                          {sale.status === 'rejected' && sale.rejection_image_url ? (
                            <a
                              href={`${API_BASE}${sale.rejection_image_url}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-2 inline-flex text-xs font-semibold text-blue-600 hover:text-blue-800 underline"
                            >
                              Ver evidencia
                            </a>
                          ) : null}
                        </td>
                      ) : null}
                      <td className="px-3 py-2.5 whitespace-nowrap text-right align-middle min-w-[220px]">
                        <SaleRowActions
                          sale={sale}
                          onActivate={handleActivate}
                          onReject={handleRejectPending}
                          onCopyCheckoutLink={handleCopyCheckoutLink}
                          onEdit={setEditSale}
                          onDelete={handleDelete}
                          onCancelApproved={handleCancelApproved}
                          onComment={handleComment}
                          onReactivate={handleReactivate}
                          activating={activatingId === sale.id}
                          cancellingId={cancellingId}
                          rejectingId={rejectingId}
                          reactivatingId={reactivatingId}
                        />
                      </td>
                    </tr>
                  ))}

                {filter === 'payment_submitted' &&
                  pendingAbonosStandalone.map((p) => {
                    let dtStr = '—'
                    try {
                      dtStr = formatSaleTableDate(p.created_at)
                    } catch {
                      /* noop */
                    }
                    const amt = parseFloat(p.amount ?? 0)
                    const portalSaldoOnly = isPortalSaldoCrossSinComprobante({
                      receiptFileUrlOrPath: p.receipt_file_url,
                      notes: p.notes,
                    })
                    return (
                      <tr key={`payment-${p.id}`} className="bg-indigo-50/35 hover:bg-indigo-50/55 transition-colors">
                        <td className="px-3 py-2.5 whitespace-nowrap text-gray-600 text-sm">{dtStr}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap min-w-0 max-w-[11rem]">
                          <span className="font-medium text-gray-800 truncate block">{p.client_name || '—'}</span>
                        </td>
                        <td className="px-3 py-2.5 text-gray-400 text-sm">—</td>
                        <td className="px-2 py-2.5 font-mono text-sm font-semibold text-indigo-800">
                          {p.payment_number || `PAG-${p.id}`}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-gray-600 max-w-[11rem] truncate" title={p.notes}>
                          {p.notes || 'Abono portal'}
                        </td>
                        <td className="px-3 py-2.5 text-sm">{p.payment_method || '—'}</td>
                        <td className="px-3 py-2.5 font-mono text-sm">{p.currency || 'USD'}</td>
                        <td className="px-3 py-2.5">
                          <span className="text-[10px] font-bold uppercase text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded">
                            Pago
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right font-bold tabular-nums text-sm">
                          {Number.isFinite(amt) ? amt.toFixed(2) : '—'}
                        </td>
                        <td className="px-3 py-2.5 max-w-[220px]">
                          <div className="flex flex-col items-center gap-1 min-w-0">
                            <span className="text-[11px] font-semibold text-sky-700 bg-sky-50 px-2 py-1 rounded-full ring-1 ring-sky-100">
                              En revisión
                            </span>
                            <OcrSecurityBadges
                              {...pickOcrSecurityFlags(p)}
                              amount={p?.amount_applied_to_sale ?? p?.amount}
                              portal_declared_payment_amount={p?.amount_applied_to_sale ?? p?.amount}
                              layout="table"
                              illegibleLayout="compact"
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {p.receipt_file_url ? (
                            <a
                              href={`${API_BASE}${p.receipt_file_url}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-blue-600 hover:underline font-semibold"
                            >
                              Ver
                            </a>
                          ) : portalSaldoOnly ? (
                            <span
                              className="mx-auto inline-block max-w-[9.5rem] rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1.5 text-center text-[10px] font-semibold leading-snug text-emerald-900"
                              title="Cruce solo con saldo a favor desde el portal — sin archivo"
                            >
                              🔄 SALDO — sin comprobante
                            </span>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          )}
                        </td>
                        {showRejectReasonCol ? <td className="px-3 py-2.5 text-gray-400">—</td> : null}
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => handleReviewPayment(p)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm mr-2"
                          >
                            Revisar Abono
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRejectPayment(p.id)}
                            className="inline-flex px-3 py-1.5 text-xs font-bold rounded-lg bg-red-100 text-red-700 hover:bg-red-200"
                          >
                            Rechazar
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                  </>
                )}
              </tbody>
            </table>
          </div>

          <div className="px-3 py-2 border-t border-gray-100 bg-gray-50/50 flex flex-wrap items-center justify-between gap-2 min-h-[2.75rem] shrink-0">
            {tableLoading ? (
              <span className="text-xs text-gray-400">Actualizando listado…</span>
            ) : fetchError ? (
              <span className="text-xs text-red-500">{fetchError}</span>
            ) : (
              <>
                <span className="text-xs text-gray-400">
                  {sales.length === 0 && filter === 'payment_submitted' && pendingAbonosStandalone.length > 0 ?
                    `${pendingAbonosStandalone.length} abono${pendingAbonosStandalone.length !== 1 ? 's' : ''} en revisión`
                  : filteredSales.length === sales.length
                    ? `${sales.length} venta${sales.length !== 1 ? 's' : ''} ${filterEmptyCopy(filter)}`
                    : `${filteredSales.length} de ${sales.length} ventas mostradas (filtros)`}
                  {totalFiltered > ITEMS_PER_PAGE ? (
                    <>
                      {' '}
                      · Filas {(currentPage - 1) * ITEMS_PER_PAGE + 1}–
                      {Math.min(currentPage * ITEMS_PER_PAGE, totalFiltered)} de {totalFiltered}
                    </>
                  ) : null}
                </span>
                {totalPages > 1 ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={currentPage <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="h-8 px-3 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-md shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      Anterior
                    </button>
                    <span className="text-xs text-gray-500 tabular-nums min-w-[4.5rem] text-center">
                      {currentPage} / {totalPages}
                    </span>
                    <button
                      type="button"
                      disabled={currentPage >= totalPages}
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      className="h-8 px-3 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-md shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      Siguiente
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>

      </div>
    </>
  )
}
