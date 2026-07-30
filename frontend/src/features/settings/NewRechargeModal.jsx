import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'
import FinancialSummarySidebar from '../../components/ui/FinancialSummarySidebar'
import OcrSecurityBadges, {
  IllegibleReceiptAlert,
  buildIllegibleCheckSource,
  isIllegibleDeclaredRecord,
} from '../../components/OcrSecurityBadges'
import PaymentReceiptAttachment from '../../components/ui/PaymentReceiptAttachment'
import api from '../../api/axios'
import { useModal } from '../../context/ModalContext'
import { financialSummaryFromRechargeLinkedPayments, computeDiscountAmount, DISCOUNT_TYPES } from '../../lib/financialSummaryUtils'
import { salesApiOrigin } from '../sales/saleTableHelpers'
import SearchableSelect from '../../components/ui/SearchableSelect'
import PaymentMethodsDepositCheckboxes from '../sales/components/PaymentMethodsDepositCheckboxes'
import HotmartLinksEditor from '../sales/components/HotmartLinksEditor'
import ReportedDepositDestinationAlert, {
  pickPendingReviewDepositDestination,
} from '../../components/ui/ReportedDepositDestinationAlert'
import { SALES_CURRENCIES, salesCurrencyDefaultRate } from '../sales/salesCurrencies'
import { normalizeCurrencyCode } from '../../lib/currencyCode'
import useExchangeRatesCatalog from '../../hooks/useExchangeRatesCatalog'
/** Fila nueva para la tabla multilinea (recarga BaaS; moneda unificada). */
export function newRechargeLineRow() {
  return {
    id: `rli-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    producto: 'BaaS Balance',
    tipo_moneda: 'USD',
    saldo_recargar: '',
  }
}

function parseLineNum(s) {
  const n = parseFloat(String(s ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

function formatFlujoLocalAmount(amount, currencyCode) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  return `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currencyCode}`
}

function formatConceptExchangeRate(xrStr, currencyCode) {
  const n = parseLineNum(xrStr)
  if (!Number.isFinite(n) || n <= 0) return currencyCode === 'USD' ? '1' : '—'
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

function conceptLineLocalTotal(usdRaw, xrStr, currencyCode) {
  const usd = parseLineNum(usdRaw)
  if (!Number.isFinite(usd) || usd <= 0) return '—'
  if (currencyCode === 'USD') return formatFlujoLocalAmount(usd, 'USD')
  const xr = parseLineNum(xrStr)
  if (!Number.isFinite(xr) || xr <= 0) return '—'
  return formatFlujoLocalAmount(Math.round(usd * xr * 100) / 100, currencyCode)
}

function usdPriceFromDraftRow(row) {
  const customUsd = row?.custom_price ?? row?.price_usd ?? row?.sale_price_usd
  if (customUsd != null && Number(customUsd) > 0) return Number(customUsd)
  const local = row?.local_price ?? row?.sale_price_local ?? row?.precio_venta_local
  const xr = Number(row?.exchange_rate)
  if (local != null && Number(local) > 0 && Number.isFinite(xr) && xr > 0) {
    return Math.round((Number(local) / xr) * 10000) / 10000
  }
  if (local != null && Number(local) > 0) return Number(local)
  return null
}

/** Convierte snapshot/API de precios Flujo al estado local del modal (packageId → USD texto). */
function draftFlujoPricingFromAssignedRows(rows) {
  const list = Array.isArray(rows) ? rows : []
  const prices = {}
  const exchangeRates = {}
  for (const row of list) {
    const pid = String(row?.package_catalog_id ?? row?.package_id ?? '').trim()
    if (!pid) continue
    const usd = usdPriceFromDraftRow(row)
    if (usd != null && usd > 0) {
      prices[pid] = String(usd)
    }
    const xr = row?.exchange_rate
    if (xr != null && Number(xr) > 0) {
      exchangeRates[pid] = String(xr)
    }
  }
  return { prices, exchangeRates, hasPrices: Object.keys(prices).length > 0 }
}

function inputClsBase() {
  return 'w-full px-3 py-2 border border-gray-200 rounded-xl text-gray-900 text-sm'
}

/**
 * Igual que `saleClientComboLabel` en `NuevaVentaModal.jsx` (lista y filtro del cliente).
 */
export function saleClientComboLabelRecarga(c, mode) {
  if (!c) return ''
  if (mode === 'nombre') {
    return String(c.full_name || c.name || 'Sin nombre')
  }
  return String(c.iptv_username || c.username || 'Sin usuario IPTV')
}

/**
 * Convierte un elemento del webhook listar-clientes a la forma del combobox.
 * El backend puede devolver objetos `{ id, nombre, … }` o strings (`correo@…`).
 */
export function normalizeClienteDesdeWebhook(row) {
  if (row == null) return null
  if (typeof row === 'string' || typeof row === 'number') {
    const email = String(row).trim()
    if (!email) return null
    return {
      id: email,
      name: email,
      full_name: email,
      email,
      username: '',
      iptv_username: email,
    }
  }
  if (typeof row !== 'object') return null
  const rawId = row.id ?? row.cliente_id ?? row.client_id ?? row.customer_id
  if (rawId === undefined || rawId === null || String(rawId).trim() === '') return null
  const idNum = Number(rawId)
  const idVal = Number.isFinite(idNum) ? idNum : String(rawId).trim()

  const name =
    String(row.full_name ?? row.name ?? row.nombre ?? row.cliente ?? row.razon_social ?? '').trim() || 'Sin nombre'
  const email = String(row.email ?? row.correo ?? row.mail ?? '').trim()
  const username = String(row.username ?? row.usuario ?? '').trim()
  const iptv = String(row.iptv_username ?? row.iptv_user ?? row.usuario_iptv ?? '').trim()

  return {
    id: idVal,
    name,
    full_name: name,
    email,
    username,
    iptv_username: iptv,
  }
}

/**
 * Opciones `{ value, label }` para `SearchableSelect`.
 */
export function clienteOptionsParaRecarga(clientes, clientSearchMode = 'nombre') {
  if (!Array.isArray(clientes)) return []
  const list = clientes.filter((c) => c != null && typeof c === 'object' && c.id != null)
  list.sort((a, b) =>
    saleClientComboLabelRecarga(a, clientSearchMode).localeCompare(
      saleClientComboLabelRecarga(b, clientSearchMode),
      'es',
      { sensitivity: 'base' },
    ),
  )
  return list.map((c) => ({
    value: String(c.id),
    label: saleClientComboLabelRecarga(c, clientSearchMode),
  }))
}

/**
 * Modal «Nueva solicitud de recarga» — layout multilinea y resumen lateral al estilo `NuevaVentaModal`.
 */
export default function NewRechargeModal({
  open,
  onClose,
  clientes: _clientesLegacy,
  clientesLoading: _clientesLoadingLegacy,
  clientesError: _clientesErrorLegacy,
  onReloadClientes: _onReloadClientesLegacy,
  linkClientId,
  onLinkClientIdChange,
  rechargeLineItems,
  onRechargeLineItemsChange,
  depositUsd,
  onDepositUsdChange,
  discountBilling = '',
  onDiscountBillingChange,
  discountType = DISCOUNT_TYPES.FIXED,
  onDiscountTypeChange,
  rechargeComment,
  onRechargeCommentChange,
  salePaymentMethodOptions = [],
  depositAccountOptionsByMethodId = {},
  selectedPaymentMethodIds,
  togglePaymentMethodId,
  selectedDepositAccountIds,
  toggleDepositAccountId,
  depositCurrencyMismatch = false,
  depositAccountCurrencyCode = '',
  showHotmartLinksEditor = false,
  hotmartLinkRows = [],
  onHotmartLinksChange,
  linkReceiptFile,
  onLinkReceiptFileChange,
  generatingLink,
  onSubmitGenerateLink,
  editMode = false,
  editTargetRequestId = null,
  clientSnapshotForEdit = null,
  prefillClientSnapshot = null,
  existingReceiptUrl = '',
  onSubmitUpdatePending,
  isReadOnly = false,
  readOnlyAuditBannerMessage = '',
  summarySubtotalOverride = null,
  summaryPaidOverride = null,
  summaryBalancePendingOverride = null,
  linkedPaymentsForReadOnly = null,
  linkedPaymentsFromEdit = null,
  readOnlyAuditRequestId = null,
  ocrIsManuallyEdited = false,
  ocrAiConfidenceScore = null,
  ocrPortalDeclaredAmount = null,
  assignedPackagePricesPrefill = null,
  rechargeInReview = false,
  reviewDestinationRechargeRow = null,
}) {
  const { openNewClient } = useModal()
  const [clientSearchMode, setClientSearchMode] = useState('nombre')
  const [clientesDesdeRender, setClientesDesdeRender] = useState([])
  const [renderClientesLoading, setRenderClientesLoading] = useState(false)
  const [renderClientesError, setRenderClientesError] = useState(null)
  const [renderClientesWarning, setRenderClientesWarning] = useState(null)
  const [existingReceiptCleared, setExistingReceiptCleared] = useState(false)
  const [clientCreditAvail, setClientCreditAvail] = useState(0)
  const [clientCreditLoading, setClientCreditLoading] = useState(false)
  const [editLinkedPaymentsFetched, setEditLinkedPaymentsFetched] = useState([])
  const [flujoPackages, setFlujoPackages] = useState([])
  const [flujoPackagesLoading, setFlujoPackagesLoading] = useState(false)
  const [flujoPackagesError, setFlujoPackagesError] = useState(null)
  /** package_catalog_id → precio de venta (texto) */
  const [flujoPriceByPackageId, setFlujoPriceByPackageId] = useState({})
  /** package_catalog_id → tipo de cambio (texto) */
  const [exchangeRates, setExchangeRates] = useState({})
  /** Tasa referencial de la moneda de facturación (Conceptos) */
  const [billingExchangeRateStr, setBillingExchangeRateStr] = useState('1')
  /** Admin: comprobante ilegible / OCR sin monto (persiste ai_confidence_score=0 en servidor). */
  const [ocrWithoutAmount, setOcrWithoutAmount] = useState(false)

  const apiOrigin = salesApiOrigin()

  /** Evita que efectos de catálogo/tasa borren precios ya hidratados en edición. */
  const editPricingHydratedRef = useRef(false)
  const prevBillingCurrencyRef = useRef(null)

  const catalogEnabled = open && !isReadOnly
  const { getActiveRate, loading: exchangeRatesLoading } = useExchangeRatesCatalog(catalogEnabled)

  const cargarClientesDesdeRender = useCallback(async ({ signal } = {}) => {
    try {
      setRenderClientesLoading(true)
      setRenderClientesError(null)
      setRenderClientesWarning(null)
      const { data } = await api.get('/api/v1/distributors/catalog-clients', { signal })
      const rows = Array.isArray(data?.clientes) ? data.clientes : []
      const mapped = rows.map(normalizeClienteDesdeWebhook).filter(Boolean)
      setClientesDesdeRender(mapped)
      const w = typeof data?.warning === 'string' ? data.warning.trim() : ''
      if (w) setRenderClientesWarning(w)
    } catch (error) {
      if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') return
      console.error('Error cargando clientes (ERP / catálogo):', error)
      setRenderClientesError(
        'No se pudo cargar la lista de clientes. Revisa la conexión con el servidor del ERP e inténtalo de nuevo.',
      )
      setClientesDesdeRender([])
    } finally {
      setRenderClientesLoading(false)
    }
  }, [])

  const mergeClienteRecarga = useCallback(
    (created) => {
      const normalized =
        normalizeClienteDesdeWebhook(created) ??
        (created?.id != null ?
          {
            id: created.id,
            name: String(created.name ?? '').trim() || 'Sin nombre',
            full_name: String(created.name ?? '').trim() || 'Sin nombre',
            email: String(created.email ?? '').trim(),
            username: String(created.username ?? '').trim(),
            iptv_username: String(created.username ?? created.iptv_username ?? '').trim(),
          }
        : null)
      if (!normalized?.id) return null
      setClientesDesdeRender((prev) => {
        const idStr = String(normalized.id)
        const next = [...prev.filter((c) => String(c?.id) !== idStr), normalized]
        next.sort((a, b) =>
          saleClientComboLabelRecarga(a, clientSearchMode).localeCompare(
            saleClientComboLabelRecarga(b, clientSearchMode),
            'es',
            { sensitivity: 'base' },
          ),
        )
        return next
      })
      return normalized
    },
    [clientSearchMode],
  )

  const handleAddNewClientFromPicker = useCallback(() => {
    openNewClient((createdClient) => {
      const merged = mergeClienteRecarga(createdClient)
      if (!merged?.id) return
      onLinkClientIdChange(String(merged.id))
      void cargarClientesDesdeRender()
    })
  }, [openNewClient, mergeClienteRecarga, onLinkClientIdChange, cargarClientesDesdeRender])

  useEffect(() => {
    if (!open || (!editMode && !isReadOnly) || !clientSnapshotForEdit) return undefined
    const normalized = normalizeClienteDesdeWebhook(clientSnapshotForEdit)
    if (!normalized) return undefined
    setClientesDesdeRender((prev) => {
      const idStr = String(normalized.id)
      if (prev.some((c) => String(c.id) === idStr)) return prev
      return [normalized, ...prev]
    })
    return undefined
  }, [open, editMode, isReadOnly, clientSnapshotForEdit])

  useEffect(() => {
    if (!open || editMode || isReadOnly || !prefillClientSnapshot) return undefined
    if (renderClientesLoading) return undefined
    const normalized = normalizeClienteDesdeWebhook(prefillClientSnapshot)
    if (!normalized) return undefined
    setClientesDesdeRender((prev) => {
      const idStr = String(normalized.id)
      if (prev.some((c) => String(c.id) === idStr)) return prev
      return [normalized, ...prev]
    })
    onLinkClientIdChange(String(normalized.id))
    return undefined
  }, [
    open,
    editMode,
    isReadOnly,
    prefillClientSnapshot,
    renderClientesLoading,
    onLinkClientIdChange,
  ])

  useEffect(() => {
    if (!open || editMode || isReadOnly) return undefined
    const ac = new AbortController()
    void cargarClientesDesdeRender({ signal: ac.signal })
    return () => ac.abort()
  }, [open, editMode, isReadOnly, cargarClientesDesdeRender])

  const selectedCliente = useMemo(
    () =>
      Array.isArray(clientesDesdeRender)
        ? clientesDesdeRender.find((c) => c?.id != null && String(c.id) === String(linkClientId))
        : null,
    [clientesDesdeRender, linkClientId],
  )

  const pricingClientId = useMemo(() => {
    const resolveNumericClientId = (raw) => {
      const n = Number(raw)
      return Number.isFinite(n) && n >= 1 ? n : null
    }

    if (editMode || isReadOnly) {
      const fromSnapshot = resolveNumericClientId(clientSnapshotForEdit?.client_id)
      if (fromSnapshot) return fromSnapshot
      return resolveNumericClientId(linkClientId)
    }

    const fromLink = resolveNumericClientId(linkClientId)
    if (fromLink) return fromLink

    if (selectedCliente) {
      const fromSel = resolveNumericClientId(selectedCliente.client_id ?? selectedCliente.id)
      if (fromSel) return fromSel
    }
    return null
  }, [editMode, isReadOnly, clientSnapshotForEdit, linkClientId, selectedCliente])

  /** Nueva solicitud y edición comparten este bloque dentro de Conceptos. */
  const showFlujoPricingTable = useMemo(() => {
    if (isReadOnly) return false
    if (editMode) return Boolean(pricingClientId || clientSnapshotForEdit)
    return Boolean(String(linkClientId || '').trim())
  }, [isReadOnly, editMode, pricingClientId, clientSnapshotForEdit, linkClientId])

  useEffect(() => {
    if (open) {
      setExistingReceiptCleared(false)
      editPricingHydratedRef.current = false
      prevBillingCurrencyRef.current = null
      return undefined
    }
    editPricingHydratedRef.current = false
    prevBillingCurrencyRef.current = null
    setFlujoPriceByPackageId({})
    setExchangeRates({})
    setBillingExchangeRateStr('1')
    return undefined
  }, [open])

  useEffect(() => {
    if (!open || isReadOnly) {
      setFlujoPackages([])
      setFlujoPackagesError(null)
      return undefined
    }
    const ac = new AbortController()
    setFlujoPackagesLoading(true)
    setFlujoPackagesError(null)
    api
      .get('/api/v1/distributors/screen-catalog-products', { signal: ac.signal })
      .then(({ data }) => {
        const catalog = Array.isArray(data) ? data : []
        console.log('Catálogo recibido:', catalog)
        setFlujoPackages(catalog)
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') return
        setFlujoPackagesError('No se pudo cargar la matriz de paquetes Flujo.')
        setFlujoPackages([])
      })
      .finally(() => setFlujoPackagesLoading(false))
    return () => ac.abort()
  }, [open, isReadOnly])

  useEffect(() => {
    if (!open || isReadOnly) return undefined

    let cancelled = false

    const applyPricingDraft = (rows, { lockEdit = false } = {}) => {
      const { prices, exchangeRates: xrDraft, hasPrices } = draftFlujoPricingFromAssignedRows(rows)
      if (!hasPrices) return false
      setFlujoPriceByPackageId(prices)
      setExchangeRates((prev) => ({ ...prev, ...xrDraft }))
      if (lockEdit && editMode) editPricingHydratedRef.current = true
      return true
    }

    const loadClientAssignedPrices = (clientId) => {
      if (!Number.isFinite(clientId) || clientId < 1) return Promise.resolve(false)
      return api
        .get(`/api/v1/admin/clients/${clientId}/assigned-package-prices`)
        .then(({ data }) => {
          if (cancelled || editPricingHydratedRef.current) return false
          return applyPricingDraft(data)
        })
        .catch(() => false)
    }

    const prefill = Array.isArray(assignedPackagePricesPrefill) ? assignedPackagePricesPrefill : []
    if (editMode && editTargetRequestId != null) {
      if (applyPricingDraft(prefill, { lockEdit: true })) {
        return () => {
          cancelled = true
        }
      }

      const ac = new AbortController()
      api
        .get(`/api/v1/distributors/recharge-requests/${editTargetRequestId}`, { signal: ac.signal })
        .then(({ data }) => {
          if (cancelled || editPricingHydratedRef.current) return undefined
          if (process.env.NODE_ENV !== 'production') {
            console.log('Datos recibidos del backend (edición recarga):', data)
          }
          if (applyPricingDraft(data?.assigned_package_prices, { lockEdit: true })) return undefined
          const cid = Number(data?.client_id)
          return loadClientAssignedPrices(cid)
        })
        .catch((err) => {
          if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') return
          const cid = Number(clientSnapshotForEdit?.client_id)
          if (Number.isFinite(cid) && cid > 0) void loadClientAssignedPrices(cid)
        })
      return () => {
        cancelled = true
        ac.abort()
      }
    }

    if (applyPricingDraft(prefill)) {
      return () => {
        cancelled = true
      }
    }

    const cid = pricingClientId
    if (!Number.isFinite(cid) || cid < 1) {
      if (!editPricingHydratedRef.current) setFlujoPriceByPackageId({})
      return undefined
    }

    const ac = new AbortController()
    api
      .get(`/api/v1/admin/clients/${cid}/assigned-package-prices`, { signal: ac.signal })
      .then(({ data }) => {
        if (cancelled || editPricingHydratedRef.current) return
        applyPricingDraft(data)
      })
      .catch(() => {
        if (!cancelled && !editPricingHydratedRef.current) setFlujoPriceByPackageId({})
      })
    return () => {
      cancelled = true
      ac.abort()
    }
  }, [
    open,
    isReadOnly,
    editMode,
    editTargetRequestId,
    pricingClientId,
    assignedPackagePricesPrefill,
    clientSnapshotForEdit?.client_id,
  ])

  useEffect(() => {
    if (!open || !editMode || editTargetRequestId == null) {
      setEditLinkedPaymentsFetched([])
      return undefined
    }
    const ac = new AbortController()
    api
      .get(`/api/v1/distributors/recharge-requests/${editTargetRequestId}`, { signal: ac.signal })
      .then(({ data }) => {
        setEditLinkedPaymentsFetched(
          Array.isArray(data?.linked_payments) ? data.linked_payments : [],
        )
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') return
        setEditLinkedPaymentsFetched([])
      })
    return () => ac.abort()
  }, [open, editMode, editTargetRequestId])

  useEffect(() => {
    if (!open) {
      setOcrWithoutAmount(false)
      return
    }
    if (editMode) {
      setOcrWithoutAmount(Number(ocrAiConfidenceScore) === 0)
    }
  }, [open, editMode, editTargetRequestId, ocrAiConfidenceScore])

  const clientOptions = useMemo(
    () => clienteOptionsParaRecarga(clientesDesdeRender, clientSearchMode),
    [clientesDesdeRender, clientSearchMode],
  )

  const lineBalanceCurrencyOptions = useMemo(
    () =>
      SALES_CURRENCIES.map((c) => ({
        value: normalizeCurrencyCode(c.code, 'USD'),
        label: `${c.flag ?? ''} ${c.label}`.trim(),
      })),
    [],
  )

  const tableBillingCurrency = useMemo(
    () => normalizeCurrencyCode(rechargeLineItems?.[0]?.tipo_moneda ?? 'USD', 'USD'),
    [rechargeLineItems],
  )

  const applyActiveRateToFlujo = useCallback(
    (currencyCode, { forceAllRows = false } = {}) => {
      const code = normalizeCurrencyCode(currencyCode || 'USD', 'USD')
      const active = getActiveRate(code)
      const rateStr =
        active != null && active > 0
          ? String(active)
          : code === 'USD'
            ? '1'
            : String(salesCurrencyDefaultRate(code))
      setBillingExchangeRateStr(rateStr)
      setExchangeRates((prev) => {
        const list = Array.isArray(flujoPackages) ? flujoPackages : []
        if (!list.length) return prev
        const next = forceAllRows ? {} : { ...prev }
        for (const pkg of list) {
          const pkgId = Number(pkg?.package_catalog_id)
          if (!Number.isFinite(pkgId)) continue
          const key = String(pkgId)
          if (forceAllRows || String(prev[key] ?? '').trim() === '') {
            next[key] = rateStr
          }
        }
        return next
      })
    },
    [flujoPackages, getActiveRate],
  )

  useEffect(() => {
    if (!catalogEnabled || exchangeRatesLoading) return undefined
    const cur = tableBillingCurrency
    const isCurrencyChange =
      prevBillingCurrencyRef.current != null && prevBillingCurrencyRef.current !== cur
    prevBillingCurrencyRef.current = cur

    if (editPricingHydratedRef.current && !isCurrencyChange) return undefined

    applyActiveRateToFlujo(cur, { forceAllRows: isCurrencyChange || !editPricingHydratedRef.current })
    return undefined
  }, [
    applyActiveRateToFlujo,
    catalogEnabled,
    exchangeRatesLoading,
    flujoPackages,
    tableBillingCurrency,
    getActiveRate,
  ])

  const leadLineId = useMemo(() => {
    const list = Array.isArray(rechargeLineItems) ? rechargeLineItems : []
    return list[0]?.id ?? null
  }, [rechargeLineItems])

  const safePmOptions = useMemo(
    () => (Array.isArray(salePaymentMethodOptions) ? salePaymentMethodOptions : []),
    [salePaymentMethodOptions],
  )
  const safeDepositByPm = useMemo(() => {
    const d = depositAccountOptionsByMethodId
    return d != null && typeof d === 'object' ? d : {}
  }, [depositAccountOptionsByMethodId])

  const displayCliente = useMemo(() => {
    if ((editMode || isReadOnly) && clientSnapshotForEdit) {
      const n = normalizeClienteDesdeWebhook(clientSnapshotForEdit)
      return n || selectedCliente
    }
    return selectedCliente
  }, [editMode, isReadOnly, clientSnapshotForEdit, selectedCliente])

  const linesSubtotalUsd = useMemo(() => {
    const list = Array.isArray(rechargeLineItems) ? rechargeLineItems : []
    const sum = list.reduce((acc, li) => {
      const s = parseLineNum(li?.saldo_recargar ?? '')
      return acc + (Number.isFinite(s) ? s : 0)
    }, 0)
    return Math.round(sum * 100) / 100
  }, [rechargeLineItems])

  const billingXrNum = useMemo(() => {
    const n = parseLineNum(billingExchangeRateStr)
    if (Number.isFinite(n) && n > 0) return n
    return tableBillingCurrency === 'USD' ? 1 : salesCurrencyDefaultRate(tableBillingCurrency)
  }, [billingExchangeRateStr, tableBillingCurrency])

  const linesSubtotalFiat = useMemo(() => {
    if (tableBillingCurrency === 'USD') return linesSubtotalUsd
    return Math.round(linesSubtotalUsd * billingXrNum * 100) / 100
  }, [linesSubtotalUsd, billingXrNum, tableBillingCurrency])

  const discountBillingNum = useMemo(() => {
    return computeDiscountAmount(linesSubtotalFiat, discountBilling, discountType)
  }, [linesSubtotalFiat, discountBilling, discountType])

  const netLinesTotal = useMemo(() => {
    return Math.max(0, Math.round((linesSubtotalFiat - discountBillingNum) * 100) / 100)
  }, [linesSubtotalFiat, discountBillingNum])

  const depositDeclaredNum = useMemo(() => {
    const raw = String(depositUsd ?? '').trim().replace(',', '.')
    if (!raw) return 0
    const n = parseFloat(raw)
    return Number.isFinite(n) && n > 0 ? n : 0
  }, [depositUsd])

  const depositInBilling = depositDeclaredNum

  const billingCode = tableBillingCurrency

  const creditAutoApplied = useMemo(() => {
    if (isReadOnly || editMode) return 0
    const avail = Number(clientCreditAvail)
    if (!Number.isFinite(avail) || avail <= 0) return 0
    return Math.min(avail, netLinesTotal)
  }, [isReadOnly, editMode, clientCreditAvail, netLinesTotal])

  const balanceRemainingInfo = useMemo(() => {
    if (isReadOnly && summaryBalancePendingOverride != null) {
      const bal = Number(summaryBalancePendingOverride)
      return Number.isFinite(bal) ? Math.max(0, Math.round(bal * 100) / 100) : 0
    }
    if (editMode && summaryBalancePendingOverride != null) {
      const bal = Number(summaryBalancePendingOverride)
      return Number.isFinite(bal) ? Math.max(0, Math.round(bal * 100) / 100) : 0
    }
    const afterCredit = Math.max(0, netLinesTotal - creditAutoApplied)
    const afterDeposit = Math.max(0, Math.round((afterCredit - depositInBilling) * 100) / 100)
    return afterDeposit
  }, [
    isReadOnly,
    editMode,
    summaryBalancePendingOverride,
    netLinesTotal,
    creditAutoApplied,
    depositInBilling,
  ])

  useEffect(() => {
    if (!open || editMode || isReadOnly) {
      setClientCreditAvail(0)
      return undefined
    }
    const email = String(displayCliente?.email ?? '').trim().toLowerCase()
    if (!email.includes('@')) {
      setClientCreditAvail(0)
      return undefined
    }
    const ac = new AbortController()
    setClientCreditLoading(true)
    api
      .get('/api/v1/distributors/client-credit-preview', {
        params: { email, currency: billingCode },
        signal: ac.signal,
      })
      .then(({ data }) => {
        const n = Number(data?.available_credit)
        setClientCreditAvail(Number.isFinite(n) && n > 0 ? n : 0)
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') return
        setClientCreditAvail(0)
      })
      .finally(() => setClientCreditLoading(false))
    return () => ac.abort()
  }, [open, editMode, isReadOnly, displayCliente?.email, billingCode])

  const readOnlyBannerText =
    (readOnlyAuditBannerMessage || '').trim() ||
    'Consulta de auditoría: los campos están bloqueados. Usa Cerrar para salir.'
  const subOv = summarySubtotalOverride != null ? Number(summarySubtotalOverride) : NaN
  const balOv = summaryBalancePendingOverride != null ? Number(summaryBalancePendingOverride) : NaN
  const lateralSubtotalDisplay =
    linesSubtotalFiat > 0 ? linesSubtotalFiat
    : (isReadOnly || editMode) && Number.isFinite(subOv) ?
      Math.round((subOv + discountBillingNum) * 100) / 100
    : linesSubtotalFiat
  const lateralTotalDisplay =
    linesSubtotalFiat > 0 ? netLinesTotal
    : (isReadOnly || editMode) && Number.isFinite(subOv) ?
      Math.max(0, Math.round(subOv * 100) / 100)
    : netLinesTotal

  const discountAutoDepositSkipRef = useRef(true)
  useEffect(() => {
    if (!open) {
      discountAutoDepositSkipRef.current = true
      return undefined
    }
    if (isReadOnly || typeof onDepositUsdChange !== 'function') return undefined
    if (editMode && rechargeInReview) return undefined
    if (discountAutoDepositSkipRef.current) {
      discountAutoDepositSkipRef.current = false
      return undefined
    }
    const net = netLinesTotal
    if (!Number.isFinite(net) || net < 0) return undefined
    onDepositUsdChange(net > 0 ? net.toFixed(2) : '')
    return undefined
  }, [open, isReadOnly, editMode, rechargeInReview, discountBilling, netLinesTotal, onDepositUsdChange])

  const financialLinkedRaw = useMemo(() => {
    if (isReadOnly && linkedPaymentsForReadOnly != null) return linkedPaymentsForReadOnly
    if (editMode) {
      if (editLinkedPaymentsFetched.length > 0) return editLinkedPaymentsFetched
      if (Array.isArray(linkedPaymentsFromEdit)) return linkedPaymentsFromEdit
    }
    return []
  }, [
    isReadOnly,
    editMode,
    linkedPaymentsForReadOnly,
    editLinkedPaymentsFetched,
    linkedPaymentsFromEdit,
  ])

  const { linkedPayments: financialApproved, pendingReviewPayments: financialPending } = useMemo(
    () => financialSummaryFromRechargeLinkedPayments(financialLinkedRaw),
    [financialLinkedRaw],
  )

  const reportedDepositDestination = useMemo(() => {
    if (!editMode || !rechargeInReview) return null
    return pickPendingReviewDepositDestination({
      linkedPayments: financialLinkedRaw,
      rechargeRow: reviewDestinationRechargeRow,
    })
  }, [editMode, rechargeInReview, financialLinkedRaw, reviewDestinationRechargeRow])

  const lateralBalancePendingDisplay = useMemo(() => {
    if (isReadOnly && Number.isFinite(balOv)) {
      return Math.max(0, Math.round(balOv * 100) / 100)
    }
    const approvedSum = (Array.isArray(financialApproved) ? financialApproved : []).reduce(
      (acc, row) => acc + (parseLineNum(row?.amount_applied ?? row?.amount) || 0),
      0,
    )
    const net = lateralTotalDisplay
    if (editMode) {
      return Math.max(0, Math.round((net - approvedSum - depositInBilling) * 100) / 100)
    }
    if (Number.isFinite(balOv)) {
      return Math.max(0, Math.round(balOv * 100) / 100)
    }
    return balanceRemainingInfo
  }, [
    isReadOnly,
    editMode,
    balOv,
    financialApproved,
    lateralTotalDisplay,
    depositInBilling,
    balanceRemainingInfo,
  ])

  const pendingReviewForOcr = useMemo(() => {
    const pending = Array.isArray(financialPending) ? financialPending : []
    return pending[0] ?? null
  }, [financialPending])

  const showIllegibleDepositAlert = useMemo(() => {
    if (!editMode) return false
    if (ocrWithoutAmount) return true
    const rawDep = String(depositUsd ?? '').trim().replace(',', '.')
    const parsedDep = rawDep !== '' && Number.isFinite(Number(rawDep)) ? Number(rawDep) : null
    return isIllegibleDeclaredRecord(
      buildIllegibleCheckSource({
        pendingPayment: pendingReviewForOcr,
        isManuallyEdited: ocrIsManuallyEdited,
        aiConfidenceScore: ocrAiConfidenceScore,
        declaredAmount: parsedDep ?? ocrPortalDeclaredAmount,
      }),
    )
  }, [
    editMode,
    depositUsd,
    pendingReviewForOcr,
    ocrIsManuallyEdited,
    ocrAiConfidenceScore,
    ocrPortalDeclaredAmount,
    ocrWithoutAmount,
  ])

  const showFinancialSummary = isReadOnly || editMode

  const portalConfigLocked = editMode && rechargeInReview

  function marginBelowLocalCostMessage(localCost) {
    const c = Number(localCost)
    const safe = Number.isFinite(c) ? c : 0
    return `El precio no puede ser menor al costo local (${safe.toFixed(2)} ${billingCode})`
  }

  function packageExchangeRateNum(packageCatalogId) {
    const raw = exchangeRates[String(packageCatalogId)]
    const n = parseLineNum(raw)
    if (Number.isFinite(n) && n > 0) return n
    const billing = parseLineNum(billingExchangeRateStr)
    if (Number.isFinite(billing) && billing > 0) return billing
    return billingCode === 'USD' ? 1 : salesCurrencyDefaultRate(billingCode)
  }

  function packageLocalCost(costUsd, packageCatalogId) {
    const cost = Number(costUsd)
    const safeCost = Number.isFinite(cost) ? cost : 0
    return Math.round(safeCost * packageExchangeRateNum(packageCatalogId) * 100) / 100
  }

  function packageLocalSalePrice(usdPrice, packageCatalogId) {
    const usd = Number(usdPrice)
    if (!Number.isFinite(usd)) return NaN
    if (billingCode === 'USD') return usd
    return Math.round(usd * packageExchangeRateNum(packageCatalogId) * 100) / 100
  }

  const showLocalSaleColumn = billingCode !== 'USD'

  function resolveBillingExchangeRate() {
    const billing = parseLineNum(billingExchangeRateStr)
    if (Number.isFinite(billing) && billing > 0) return billing
    const list = Array.isArray(flujoPackages) ? flujoPackages : []
    if (list.length > 0) {
      const xr = packageExchangeRateNum(list[0]?.package_catalog_id)
      if (Number.isFinite(xr) && xr > 0) return xr
    }
    return billingCode === 'USD' ? 1 : salesCurrencyDefaultRate(billingCode)
  }

  const flujoPriceRowsForSubmit = useMemo(() => {
    const list = Array.isArray(flujoPackages) ? flujoPackages : []
    const out = []
    for (const pkg of list) {
      const pkgId = Number(pkg?.package_catalog_id)
      if (!Number.isFinite(pkgId)) continue
      const raw = flujoPriceByPackageId[String(pkgId)]
      if (raw == null || String(raw).trim() === '') continue
      const usdPrice = parseLineNum(raw)
      if (!Number.isFinite(usdPrice) || usdPrice <= 0) continue
      const costUsd = Number(pkg?.reference_cost_usd ?? 0)
      const localCost = packageLocalCost(costUsd, pkgId)
      const localPrice = packageLocalSalePrice(usdPrice, pkgId)
      out.push({
        package_catalog_id: pkgId,
        product_id: Number(pkg?.product_id),
        custom_price: usdPrice,
        local_price: localPrice,
        local_cost: localCost,
        cost_usd: costUsd,
        exchange_rate: packageExchangeRateNum(pkgId),
        display_name: String(pkg?.display_name ?? pkg?.package_label ?? ''),
      })
    }
    return out
  }, [flujoPackages, flujoPriceByPackageId, exchangeRates, billingExchangeRateStr, billingCode])

  const priceAssignmentInvalid = useMemo(() => {
    for (const row of flujoPriceRowsForSubmit) {
      const localPrice = Number(row.local_price)
      const localCost = Number(row.local_cost ?? 0)
      if (localPrice + 1e-9 < localCost) {
        return marginBelowLocalCostMessage(localCost)
      }
    }
    const list = Array.isArray(flujoPackages) ? flujoPackages : []
    for (const pkg of list) {
      const pkgId = Number(pkg?.package_catalog_id)
      if (!Number.isFinite(pkgId)) continue
      const raw = flujoPriceByPackageId[String(pkgId)]
      if (raw == null || String(raw).trim() === '') continue
      const usdPrice = parseLineNum(raw)
      if (!Number.isFinite(usdPrice) || usdPrice <= 0) {
        return 'Cada precio de venta asignado debe ser un número mayor que cero.'
      }
      const xrRaw = exchangeRates[String(pkgId)]
      if (xrRaw != null && String(xrRaw).trim() !== '') {
        const xr = parseLineNum(xrRaw)
        if (!Number.isFinite(xr) || xr <= 0) {
          return 'Cada tipo de cambio debe ser un número mayor que cero.'
        }
      }
    }
    return null
  }, [flujoPriceRowsForSubmit, flujoPackages, flujoPriceByPackageId, exchangeRates, billingCode])

  function updateFlujoPackagePrice(packageCatalogId, value) {
    setFlujoPriceByPackageId((prev) => ({
      ...prev,
      [String(packageCatalogId)]: value,
    }))
  }

  function updatePackageExchangeRate(packageCatalogId, value) {
    setExchangeRates((prev) => ({
      ...prev,
      [String(packageCatalogId)]: value,
    }))
  }

  function updateLine(lineId, patch) {
    if (isReadOnly) return
    const list = Array.isArray(rechargeLineItems) ? rechargeLineItems : []
    if (patch.tipo_moneda !== undefined && lineId === leadLineId) {
      const c = normalizeCurrencyCode(patch.tipo_moneda, 'USD')
      onRechargeLineItemsChange(list.map((r) => ({ ...r, tipo_moneda: c })))
      return
    }
    onRechargeLineItemsChange(list.map((r) => (r.id === lineId ? { ...r, ...patch } : r)))
  }

  function addLine() {
    if (isReadOnly) return
    const list = Array.isArray(rechargeLineItems) ? rechargeLineItems : []
    const lead = normalizeCurrencyCode(list[0]?.tipo_moneda ?? 'USD', 'USD')
    const row = newRechargeLineRow()
    row.tipo_moneda = lead
    onRechargeLineItemsChange([...list, row])
  }

  function removeLine(lineId) {
    if (isReadOnly) return
    const list = Array.isArray(rechargeLineItems) ? rechargeLineItems : []
    if (list.length <= 1) return
    onRechargeLineItemsChange(list.filter((r) => r.id !== lineId))
  }

  function handleSubmitForm(e) {
    if (isReadOnly) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault()
      return
    }
    if (priceAssignmentInvalid) {
      if (e && typeof e.preventDefault === 'function') e.preventDefault()
      window.alert(priceAssignmentInvalid)
      return
    }
    const productPricesPayload = flujoPriceRowsForSubmit.map((r) => ({
      product_id: Number(r.product_id),
      package_catalog_id: Number(r.package_catalog_id),
      custom_price: Number(r.custom_price),
      local_price: Number(r.local_price),
      price_currency: billingCode,
      exchange_rate: Number(r.exchange_rate),
    }))
    const extra = {
      distributorEmail: displayCliente?.email,
      creditAppliedAmount: creditAutoApplied,
      productPrices: productPricesPayload,
      rechargeExchangeRate: resolveBillingExchangeRate(),
      amountUsd: linesSubtotalUsd,
      totalAmountLocal: linesSubtotalFiat,
      ocrWithoutAmount: editMode ? ocrWithoutAmount : undefined,
    }
    if (editMode && typeof onSubmitUpdatePending === 'function') {
      onSubmitUpdatePending(e, extra)
      return
    }
    onSubmitGenerateLink(e, extra)
  }

  if (!open) return null

  const icls = isReadOnly ? `${inputClsBase()} bg-gray-50 text-gray-800 cursor-default` : inputClsBase()

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-2 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Cerrar modal"
      />

      <div className="relative w-[95%] sm:w-full max-w-6xl bg-white rounded-2xl shadow-2xl z-10 max-h-[95dvh] flex flex-col min-h-0 overflow-hidden">
        <div className="flex items-start justify-between gap-2 p-3 sm:px-6 sm:py-4 border-b border-gray-100 bg-white rounded-t-2xl z-10 shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg sm:text-base font-semibold text-gray-900 leading-tight">
              {isReadOnly ?
                <>
                  Detalle de solicitud de recarga
                  {readOnlyAuditRequestId != null ?
                    <> (n.&nbsp;º {String(readOnlyAuditRequestId).padStart(4, '0')}) </>
                  : null}
                </>
              : editMode ?
                <>
                  Editar solicitud de recarga
                  {editTargetRequestId != null ?
                    <> (n.&nbsp;º {String(editTargetRequestId).padStart(4, '0')}) </>
                  : null}
                </>
              : 'Nueva solicitud de recarga'}
            </h2>
            <p className="text-xs text-gray-400 mt-0.5 leading-tight">
              {isReadOnly ?
                'Vista sólo lectura basada en el mismo diseño que «Nueva solicitud de recarga».'
              : editMode ?
                'Ajustes visibles para el cliente en el portal permanente.'
              : 'Líneas, resumen lateral y método/cuentas en el portal.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors shrink-0"
            aria-label="Cerrar"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={(e) => handleSubmitForm(e)} className="flex flex-col flex-1 min-h-0">
          <div className="modal-body p-3 sm:p-6">
          {isReadOnly ?
            <div className="mb-5 rounded-xl border border-gray-300 bg-gray-100 px-4 py-3 text-xs text-gray-800 leading-relaxed shadow-sm">
              {readOnlyBannerText}
            </div>
          : null}

          <div className="space-y-5">
              {!editMode && !isReadOnly ?
                <div>
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Modo de búsqueda de cliente:</label>
                    <div className="flex space-x-2">
                      <button
                        type="button"
                        onClick={() => setClientSearchMode('nombre')}
                        className={`px-4 py-1 rounded-full text-sm font-medium transition-colors ${
                          clientSearchMode === 'nombre'
                            ? 'bg-blue-600 text-white shadow'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        👤 Por Nombre
                      </button>
                      <button
                        type="button"
                        onClick={() => setClientSearchMode('usuario')}
                        className={`px-4 py-1 rounded-full text-sm font-medium transition-colors ${
                          clientSearchMode === 'usuario'
                            ? 'bg-blue-600 text-white shadow'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        📺 Por Usuario IPTV
                      </button>
                    </div>
                  </div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">Cliente / Distribuidor</label>
                  {renderClientesWarning && !renderClientesError ?
                    <div className="mb-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      {renderClientesWarning}
                    </div>
                  : null}
                  {renderClientesLoading ?
                    <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
                      Cargando clientes…
                    </div>
                  : renderClientesError ?
                    <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700 space-y-2">
                      <p>{renderClientesError}</p>
                      <button
                        type="button"
                        className="text-blue-700 font-medium hover:underline"
                        onClick={() => {
                          void cargarClientesDesdeRender()
                        }}
                      >
                        Reintentar
                      </button>
                    </div>
                  : (
                    <>
                      <SearchableSelect
                        key={`${clientSearchMode}-${clientesDesdeRender.length}`}
                        value={linkClientId || ''}
                        onChange={(v) => onLinkClientIdChange(v === undefined || v === null ? '' : String(v))}
                        options={clientOptions}
                        placeholder={clientOptions.length ? 'Buscar cliente…' : 'Sin clientes — agrega uno nuevo'}
                        disabled={generatingLink || renderClientesLoading}
                        hideClear
                        onAddNew={handleAddNewClientFromPicker}
                        addNewLabel="+ Agregar nuevo"
                        dropdownZClass="z-[6200]"
                        className="w-full"
                      />
                      {selectedCliente?.email ?
                        <div className="mt-2 p-2 bg-gray-50 border border-gray-200 rounded-md">
                          <span className="text-sm text-gray-600">📧 {String(selectedCliente.email)}</span>
                        </div>
                      : null}
                    </>
                  )}
                </div>
              : (
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">Cliente (bloqueado)</label>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm space-y-1">
                    <p className="font-semibold text-gray-900 truncate">
                      {displayCliente?.full_name || displayCliente?.name || '—'}
                    </p>
                    <p className="text-xs text-gray-600 break-all">{displayCliente?.email || '—'}</p>
                    <p className="text-xs font-mono text-gray-600">
                      Usuario IPTV: {displayCliente?.iptv_username || displayCliente?.username || '—'}
                    </p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-4 sm:gap-6 items-start border border-gray-100 rounded-2xl p-3 sm:p-4 bg-slate-50/40">
                <div className="space-y-3 min-w-0">
                  <p className="text-sm font-medium text-gray-800">Conceptos</p>
                  <div className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
                    {/* Encabezados de columna: solo escritorio */}
                    <div className="hidden md:grid md:grid-cols-[minmax(0,1.1fr)_minmax(6rem,0.75fr)_minmax(6rem,0.75fr)_minmax(5rem,0.65fr)_minmax(7rem,0.85fr)_2.5rem] gap-2 px-3 py-2.5 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-600 font-semibold border-b border-gray-100">
                      <span>Producto/servicio</span>
                      <span>Tipo de moneda</span>
                      <span>Saldo a recargar (USD)</span>
                      <span>Tipo de cambio</span>
                      <span>Total a pagar ({tableBillingCurrency})</span>
                      {!isReadOnly ? <span className="sr-only">Eliminar</span> : null}
                    </div>

                    <div className="divide-y divide-gray-100">
                      {(Array.isArray(rechargeLineItems) ? rechargeLineItems : []).map((line, rowIdx) => {
                        const rowKey =
                          line?.id != null && String(line.id) !== '' ?
                            String(line.id)
                          : `concepto-${rowIdx}`
                        const tm = normalizeCurrencyCode(line?.tipo_moneda ?? tableBillingCurrency, 'USD')
                        const isLead = rowIdx === 0 || line?.id === leadLineId
                        const lineLocalTotal = conceptLineLocalTotal(
                          line?.saldo_recargar ?? '',
                          billingExchangeRateStr,
                          tableBillingCurrency,
                        )
                        return (
                          <div
                            key={rowKey}
                            className="flex flex-col space-y-3 w-full p-3 md:space-y-0 md:grid md:grid-cols-[minmax(0,1.1fr)_minmax(6rem,0.75fr)_minmax(6rem,0.75fr)_minmax(5rem,0.65fr)_minmax(7rem,0.85fr)_2.5rem] md:items-center md:gap-2 md:px-3 md:py-2"
                          >
                            <div className="w-full min-w-0">
                              <label className="md:hidden block text-xs font-medium text-gray-500 mb-1">
                                Producto/servicio
                              </label>
                              <input
                                className={`${icls} w-full`}
                                value={line.producto ?? ''}
                                readOnly={isReadOnly}
                                disabled={generatingLink || isReadOnly}
                                onChange={(e) => updateLine(line.id, { producto: e.target.value })}
                                placeholder="BaaS Balance"
                              />
                            </div>
                            <div className="w-full min-w-0">
                              <label className="md:hidden block text-xs font-medium text-gray-500 mb-1">
                                Tipo de moneda
                              </label>
                              {isLead && !isReadOnly ?
                                <SearchableSelect
                                  value={tm}
                                  onChange={(v) =>
                                    updateLine(line.id, {
                                      tipo_moneda: normalizeCurrencyCode(v ?? 'USD', 'USD'),
                                    })
                                  }
                                  options={lineBalanceCurrencyOptions}
                                  placeholder="Moneda…"
                                  hideClear
                                  disabled={generatingLink}
                                  minPanelWidth={220}
                                  className="w-full [&_button]:min-h-9 [&_button]:text-xs [&_button]:py-1.5"
                                  dropdownZClass="z-[6000]"
                                />
                              : <span className="flex items-center min-h-[2.375rem] w-full px-3 py-2 text-sm text-gray-700 tabular-nums rounded-xl border border-gray-100 bg-slate-50/80">
                                  {tm}
                                </span>
                              }
                            </div>
                            <div className="w-full min-w-0">
                              <label className="md:hidden block text-xs font-medium text-gray-500 mb-1">
                                Saldo a recargar (USD)
                              </label>
                              <input
                                className={`${icls} w-full tabular-nums`}
                                inputMode="decimal"
                                value={line.saldo_recargar ?? ''}
                                readOnly={isReadOnly}
                                disabled={generatingLink || isReadOnly}
                                onChange={(e) => updateLine(line.id, { saldo_recargar: e.target.value })}
                                placeholder="0"
                              />
                            </div>
                            <div className="w-full min-w-0">
                              <label className="md:hidden block text-xs font-medium text-gray-500 mb-1">
                                Tipo de cambio
                              </label>
                              <span className="flex items-center min-h-[2.375rem] w-full px-3 py-2 text-sm text-gray-800 tabular-nums rounded-xl border border-gray-100 bg-slate-50/80">
                                {formatConceptExchangeRate(billingExchangeRateStr, tableBillingCurrency)}
                              </span>
                            </div>
                            <div className="w-full min-w-0">
                              <label className="md:hidden block text-xs font-medium text-gray-500 mb-1">
                                Total a pagar ({tableBillingCurrency})
                              </label>
                              <span className="flex items-center min-h-[2.375rem] w-full px-3 py-2 text-sm font-medium text-gray-800 tabular-nums rounded-xl border border-gray-100 bg-slate-50/80">
                                {lineLocalTotal}
                              </span>
                            </div>
                            {!isReadOnly ?
                              <div className="flex md:justify-center">
                                <button
                                  type="button"
                                  aria-label="Quitar línea"
                                  className="inline-flex items-center gap-1.5 p-1.5 rounded-md text-red-600 hover:bg-red-50 disabled:opacity-30 text-xs font-medium md:text-inherit md:gap-0"
                                  disabled={(rechargeLineItems?.length ?? 0) <= 1 || generatingLink}
                                  onClick={() => removeLine(line.id)}
                                >
                                  <Trash2 size={16} />
                                  <span className="md:hidden">Quitar línea</span>
                                </button>
                              </div>
                            : null}
                          </div>
                        )
                      })}
                    </div>

                    {!isReadOnly ?
                      <div className="px-3 py-2 border-t border-gray-100 bg-slate-50/60">
                        <button
                          type="button"
                          onClick={addLine}
                          disabled={generatingLink}
                          className="inline-flex items-center gap-2 text-sm font-semibold text-blue-700 hover:text-blue-900"
                        >
                          <Plus size={18} aria-hidden />+ Agregar producto o servicio
                        </button>
                      </div>
                    : null}

                    {showFlujoPricingTable ?
                      <div className="mt-4 pt-4 sm:mt-6 sm:pt-6 border-t border-gray-200 space-y-3 px-3 pb-3">
                        <div>
                          <p className="text-sm font-semibold text-gray-900 leading-tight">
                            Asignación de precios de venta — Flujo
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5 leading-tight">
                            Paquetes activos del catálogo Flujo. El precio de venta no puede ser menor al costo
                            local (costo base USD × tipo de cambio).
                          </p>
                        </div>
                        {flujoPackagesLoading ?
                          <p className="text-xs text-gray-500">Cargando paquetes Flujo…</p>
                        : flujoPackagesError ?
                          <p className="text-xs text-red-700">{flujoPackagesError}</p>
                        : flujoPackages.length === 0 ?
                          <p className="text-xs text-gray-500">No hay paquetes Flujo configurados en el catálogo.</p>
                        : (
                          <>
                            {/* Móvil: tarjetas apiladas */}
                            <div className="md:hidden space-y-3">
                              {flujoPackages.map((pkg) => {
                                const pkgId = Number(pkg?.package_catalog_id)
                                const cost = Number(pkg?.reference_cost_usd ?? 0)
                                const rawXr =
                                  exchangeRates[String(pkgId)] ??
                                  billingExchangeRateStr ??
                                  (billingCode === 'USD' ? '1' : String(salesCurrencyDefaultRate(billingCode)))
                                const rawPrice = flujoPriceByPackageId[String(pkgId)] ?? ''
                                const usdPriceNum = parseLineNum(rawPrice)
                                const localCost = packageLocalCost(cost, pkgId)
                                const localSalePrice = packageLocalSalePrice(usdPriceNum, pkgId)
                                const belowCost =
                                  rawPrice !== '' &&
                                  Number.isFinite(localSalePrice) &&
                                  localSalePrice + 1e-9 < localCost
                                const localSaleLabel =
                                  rawPrice === '' || !Number.isFinite(usdPriceNum)
                                    ? '—'
                                    : formatFlujoLocalAmount(localSalePrice, billingCode)
                                return (
                                  <div
                                    key={`flujo-pkg-card-${pkgId}`}
                                    className="rounded-xl border border-gray-200 bg-slate-50/50 p-3 space-y-3"
                                  >
                                    <div>
                                      <p className="font-medium text-gray-800 text-sm leading-tight">
                                        {String(pkg?.display_name ?? pkg?.package_label ?? '—')}
                                      </p>
                                      <p className="text-[11px] text-gray-500 mt-0.5">
                                        {String(pkg?.product_name ?? '')}
                                      </p>
                                      <p className="text-[11px] text-gray-600 mt-1.5 tabular-nums">
                                        Stock {Number(pkg?.free_stock ?? 0)} · Costo base ${cost.toFixed(2)} ·
                                        Costo local {formatFlujoLocalAmount(localCost, billingCode)}
                                      </p>
                                    </div>
                                    <div className="flex flex-col space-y-3 w-full">
                                      <div className="w-full">
                                        <label className="block text-xs font-medium text-gray-500 mb-1">
                                          Tipo de cambio
                                        </label>
                                        <input
                                          className={`${icls} w-full tabular-nums text-sm`}
                                          inputMode="decimal"
                                          value={rawXr}
                                          disabled={generatingLink}
                                          onChange={(e) => updatePackageExchangeRate(pkgId, e.target.value)}
                                          placeholder="1"
                                        />
                                      </div>
                                      <div className="w-full">
                                        <label className="block text-xs font-medium text-gray-500 mb-1">
                                          Precio venta (USD)
                                        </label>
                                        <input
                                          className={`${icls} w-full tabular-nums text-sm ${belowCost ? 'border-red-400 bg-red-50' : ''}`}
                                          inputMode="decimal"
                                          value={rawPrice}
                                          disabled={generatingLink}
                                          onChange={(e) => updateFlujoPackagePrice(pkgId, e.target.value)}
                                          placeholder="—"
                                          aria-invalid={belowCost}
                                        />
                                        {showLocalSaleColumn ? (
                                          <p className="mt-1.5 text-xs tabular-nums text-gray-600">
                                            Precio venta ({billingCode}):{' '}
                                            <span className="font-semibold text-gray-800">{localSaleLabel}</span>
                                          </p>
                                        ) : null}
                                        {belowCost ?
                                          <p className="mt-1 text-[11px] text-red-700 leading-snug">
                                            {marginBelowLocalCostMessage(localCost)}
                                          </p>
                                        : null}
                                      </div>
                                    </div>
                                  </div>
                                )
                              })}
                            </div>

                            {/* Escritorio: tabla con scroll horizontal suave */}
                            <div className="hidden md:block w-full overflow-x-auto scrollbar-hide">
                              <table className="w-full text-sm min-w-[720px]">
                                <thead>
                                  <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                                    <th className="px-2 py-2 font-semibold min-w-[140px]">Paquete Flujo</th>
                                    <th className="px-2 py-2 font-semibold w-14 text-center">Stock</th>
                                    <th className="px-2 py-2 font-semibold w-20">Costo base</th>
                                    <th className="px-2 py-2 font-semibold w-24">Tipo de cambio</th>
                                    <th className="px-2 py-2 font-semibold w-28">Costo local</th>
                                    <th className="px-2 py-2 font-semibold w-28">Precio venta (USD)</th>
                                    {showLocalSaleColumn ? (
                                      <th className="px-2 py-2 font-semibold w-32">
                                        Precio venta ({billingCode})
                                      </th>
                                    ) : null}
                                  </tr>
                                </thead>
                                <tbody>
                                  {flujoPackages.map((pkg) => {
                                    const pkgId = Number(pkg?.package_catalog_id)
                                    const cost = Number(pkg?.reference_cost_usd ?? 0)
                                    const rawXr =
                                      exchangeRates[String(pkgId)] ??
                                      billingExchangeRateStr ??
                                      (billingCode === 'USD' ? '1' : String(salesCurrencyDefaultRate(billingCode)))
                                    const rawPrice = flujoPriceByPackageId[String(pkgId)] ?? ''
                                    const usdPriceNum = parseLineNum(rawPrice)
                                    const localCost = packageLocalCost(cost, pkgId)
                                    const localSalePrice = packageLocalSalePrice(usdPriceNum, pkgId)
                                    const belowCost =
                                      rawPrice !== '' &&
                                      Number.isFinite(localSalePrice) &&
                                      localSalePrice + 1e-9 < localCost
                                    const localSaleLabel =
                                      rawPrice === '' || !Number.isFinite(usdPriceNum)
                                        ? '—'
                                        : formatFlujoLocalAmount(localSalePrice, billingCode)
                                    return (
                                      <tr key={`flujo-pkg-${pkgId}`} className="border-t border-gray-100 align-middle">
                                        <td className="px-2 py-2">
                                          <p className="font-medium text-gray-800 text-sm">
                                            {String(pkg?.display_name ?? pkg?.package_label ?? '—')}
                                          </p>
                                          <p className="text-[11px] text-gray-500">{String(pkg?.product_name ?? '')}</p>
                                        </td>
                                        <td className="px-2 py-2 tabular-nums text-gray-700 text-sm text-center">
                                          {Number(pkg?.free_stock ?? 0)}
                                        </td>
                                        <td className="px-2 py-2 tabular-nums text-gray-600 text-sm">${cost.toFixed(2)}</td>
                                        <td className="px-2 py-2">
                                          <input
                                            className={`${icls} tabular-nums text-sm w-20 min-w-[5rem] px-2 py-1.5`}
                                            inputMode="decimal"
                                            value={rawXr}
                                            disabled={generatingLink}
                                            onChange={(e) => updatePackageExchangeRate(pkgId, e.target.value)}
                                            placeholder="1"
                                          />
                                        </td>
                                        <td className="px-2 py-2 tabular-nums text-gray-700 text-sm whitespace-nowrap">
                                          {formatFlujoLocalAmount(localCost, billingCode)}
                                        </td>
                                        <td className="px-2 py-2">
                                          <input
                                            className={`${icls} tabular-nums text-sm w-24 min-w-[6rem] px-2 py-1.5 ${belowCost ? 'border-red-400 bg-red-50' : ''}`}
                                            inputMode="decimal"
                                            value={rawPrice}
                                            disabled={generatingLink}
                                            onChange={(e) => updateFlujoPackagePrice(pkgId, e.target.value)}
                                            placeholder="—"
                                            aria-invalid={belowCost}
                                          />
                                          {belowCost ?
                                            <p className="mt-1 text-[11px] text-red-700 leading-snug">
                                              {marginBelowLocalCostMessage(localCost)}
                                            </p>
                                          : null}
                                        </td>
                                        {showLocalSaleColumn ? (
                                          <td className="px-2 py-2 tabular-nums text-gray-800 text-sm font-medium whitespace-nowrap">
                                            {localSaleLabel}
                                          </td>
                                        ) : null}
                                      </tr>
                                    )
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </>
                        )}
                        {priceAssignmentInvalid ?
                          <p className="text-xs text-red-700 font-medium">{priceAssignmentInvalid}</p>
                        : null}
                      </div>
                    : null}

                    <div className="pt-4 mt-4 border-t border-gray-100 px-3 pb-3">
                      <FinancialSummarySidebar
                        subtotal={lateralSubtotalDisplay}
                        discount={discountBillingNum}
                        total={lateralTotalDisplay}
                        currency={billingCode}
                        linkedPayments={showFinancialSummary ? financialApproved : []}
                        pendingReviewPayments={showFinancialSummary ? financialPending : []}
                        balanceDue={lateralBalancePendingDisplay}
                        autoAppliedCredit={showFinancialSummary ? 0 : creditAutoApplied}
                        subtotalLabel={isReadOnly ? 'Monto original' : 'Subtotal'}
                        apiOrigin={apiOrigin}
                        showDiscountEditor={!isReadOnly}
                        discountInput={discountBilling}
                        discountType={discountType}
                        onDiscountInputChange={onDiscountBillingChange}
                        onDiscountTypeChange={onDiscountTypeChange}
                        discountEditorDisabled={generatingLink}
                        showDepositEditor={!isReadOnly}
                        depositValue={depositUsd}
                        onDepositChange={onDepositUsdChange}
                        depositEditorDisabled={generatingLink}
                        depositInputId="recharge-deposit-ref"
                        depositFooter={
                          <>
                            {!isReadOnly && !editMode ?
                              <>
                                {clientCreditLoading ?
                                  <p className="text-[10px] text-gray-400 text-right">Consultando saldo a favor…</p>
                                : null}
                                {!clientCreditLoading && clientCreditAvail > 1e-9 ?
                                  <p className="text-[10px] text-gray-600 text-right leading-snug">
                                    Saldo a favor disponible:{' '}
                                    <span className="font-semibold tabular-nums">
                                      {clientCreditAvail.toLocaleString('es-ES', { minimumFractionDigits: 2 })}{' '}
                                      {billingCode}
                                    </span>
                                    {creditAutoApplied > 1e-9 ? ' (se aplicará al crear la solicitud)' : null}
                                  </p>
                                : null}
                              </>
                            : null}
                            {editMode && showIllegibleDepositAlert ?
                              <div className="w-full text-right">
                                <IllegibleReceiptAlert className="inline-block max-w-md ml-auto" layout="block" />
                              </div>
                            : null}
                            {editMode ?
                              <OcrSecurityBadges
                                className="mt-2 max-w-md ml-auto"
                                suppressIllegibleAlert
                                is_manually_edited={ocrIsManuallyEdited}
                                ai_confidence_score={ocrWithoutAmount ? 0 : ocrAiConfidenceScore}
                                portal_declared_payment_amount={ocrPortalDeclaredAmount}
                                amount={ocrPortalDeclaredAmount}
                              />
                            : null}
                            {editMode ?
                              <label className="mt-3 flex items-start gap-2.5 rounded-xl border border-orange-200 bg-orange-50/80 px-3 py-2.5 cursor-pointer max-w-md ml-auto">
                                <input
                                  type="checkbox"
                                  className="mt-0.5 h-4 w-4 rounded border-orange-300 text-orange-600 focus:ring-orange-500"
                                  checked={ocrWithoutAmount}
                                  onChange={(e) => setOcrWithoutAmount(e.target.checked)}
                                  disabled={generatingLink}
                                />
                                <span className="min-w-0 text-[11px] leading-snug text-orange-950">
                                  <span className="font-semibold">OCR sin monto</span>
                                  {' — '}
                                  Marca si la IA no pudo leer el importe del comprobante.
                                </span>
                              </label>
                            : null}
                            {reportedDepositDestination ?
                              <ReportedDepositDestinationAlert
                                className="mt-3 max-w-md ml-auto"
                                depositAccountName={reportedDepositDestination.depositAccountName}
                                paymentMethodName={reportedDepositDestination.paymentMethodName}
                              />
                            : null}
                          </>
                        }
                      />
                    </div>
                  </div>
                </div>

                <aside className="space-y-3 xl:sticky xl:top-2 rounded-xl border border-gray-200 bg-white p-4 shadow-sm self-start w-full max-w-full">
                  {!isReadOnly ?
                    <>
                      {portalConfigLocked ?
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                          Configuración del enlace de pago (no confundir con el depósito de este comprobante)
                        </p>
                      : null}

                      <PaymentMethodsDepositCheckboxes
                        disabled={generatingLink || portalConfigLocked}
                        salePaymentMethodOptions={safePmOptions}
                        depositAccountOptionsByMethodId={safeDepositByPm}
                        selectedPaymentMethodIds={selectedPaymentMethodIds}
                        togglePaymentMethodId={togglePaymentMethodId}
                        selectedDepositAccountIds={selectedDepositAccountIds}
                        toggleDepositAccountId={toggleDepositAccountId}
                        depositCurrencyMismatch={depositCurrencyMismatch}
                        depositAccountCurrencyCode={depositAccountCurrencyCode}
                        saleCurrencyCode={billingCode}
                        titleHint={
                          portalConfigLocked ?
                            '(solo lectura · configuración del link)'
                          : '(obligatorio · portal)'
                        }
                        footerNote={
                          portalConfigLocked ?
                            'Estas opciones definen qué verá el cliente en futuros enlaces; la cuenta del depósito actual está arriba.'
                          : `Solo se muestran cuentas en ${billingCode}, alineadas con la moneda de la tabla.`
                        }
                      />
                      {showHotmartLinksEditor ? (
                        <HotmartLinksEditor
                          rows={hotmartLinkRows}
                          onChange={onHotmartLinksChange}
                          disabled={generatingLink}
                          currencyCode={billingCode}
                          className="mt-3"
                        />
                      ) : null}
                    </>
                  : null}
                </aside>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="recharge-notes">
                  Nota o comentario <span className="text-xs text-gray-500 font-normal">(opcional)</span>
                </label>
                <textarea
                  id="recharge-notes"
                  rows={3}
                  value={rechargeComment}
                  onChange={(e) => onRechargeCommentChange(e.target.value)}
                  maxLength={2048}
                  disabled={generatingLink || isReadOnly}
                  readOnly={isReadOnly}
                  className={`${icls} resize-y min-h-[80px]`}
                  placeholder="Referencia para el equipo o cliente…"
                />
                <div className="mt-1 text-[11px] text-gray-400 text-right">{rechargeComment?.length ?? 0}/2048</div>
              </div>

              {!isReadOnly ?
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Comprobante de pago <span className="text-xs text-gray-500 font-normal">(opcional)</span>
                  </label>
                  <PaymentReceiptAttachment
                    inputId="recharge-pay-proof"
                    existingReceiptUrl={existingReceiptUrl}
                    existingReceiptCleared={existingReceiptCleared}
                    receiptFile={linkReceiptFile}
                    onReceiptFileChange={onLinkReceiptFileChange}
                    onClearReceipt={() => {
                      onLinkReceiptFileChange?.(null)
                      setExistingReceiptCleared(true)
                    }}
                    disabled={generatingLink}
                    addButtonLabel="Añadir archivo adjunto"
                  />
                </div>
              : null}
          </div>
          </div>

          <div className="modal-footer">
            <div className="flex gap-2 justify-end">
                {!isReadOnly ?
                  <>
                    <button
                      type="button"
                      disabled={generatingLink}
                      onClick={onClose}
                      className="px-4 py-2 text-sm rounded-xl border border-gray-200 text-gray-700 hover:bg-gray-50"
                    >
                      Cancelar
                    </button>
                    <button
                      type="submit"
                      disabled={
                        generatingLink ||
                        Boolean(priceAssignmentInvalid) ||
                        (!editMode && renderClientesLoading) ||
                        (!editMode && !clientOptions.length) ||
                        (!editMode && !String(linkClientId || '').trim())
                      }
                      className="px-4 py-2 text-sm rounded-xl bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-60"
                    >
                      {generatingLink ?
                        editMode ?
                          'Guardando…'
                        : 'Creando…'
                      : editMode ?
                        'Guardar cambios'
                      : 'Crear solicitud'}
                    </button>
                  </>
                : (
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-5 py-2 text-sm rounded-xl bg-gray-900 text-white font-medium hover:bg-gray-800"
                  >
                    Cerrar
                  </button>
                )}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
