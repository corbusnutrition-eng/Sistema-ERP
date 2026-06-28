import { useCallback, useEffect, useMemo, useState } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'
import FinancialSummarySidebar from '../../components/ui/FinancialSummarySidebar'
import OcrSecurityBadges, {
  IllegibleReceiptAlert,
  buildIllegibleCheckSource,
  isIllegibleDeclaredRecord,
} from '../../components/OcrSecurityBadges'
import PaymentReceiptAttachment from '../../components/ui/PaymentReceiptAttachment'
import api from '../../api/axios'
import { financialSummaryFromRechargeLinkedPayments } from '../../lib/financialSummaryUtils'
import { salesApiOrigin } from '../sales/saleTableHelpers'
import SearchableSelect from '../../components/ui/SearchableSelect'
import PaymentMethodsDepositCheckboxes from '../sales/components/PaymentMethodsDepositCheckboxes'
import { SALES_CURRENCIES, salesCurrencyDefaultRate } from '../sales/salesCurrencies'
import { normalizeCurrencyCode } from '../../lib/currencyCode'
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
}) {
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

  const apiOrigin = salesApiOrigin()

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
    if (!open) return undefined
    setExistingReceiptCleared(false)
    setFlujoPriceByPackageId({})
    setExchangeRates({})
    setBillingExchangeRateStr('1')
    return undefined
  }, [open, existingReceiptUrl])

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
    const cid = pricingClientId
    if (!Number.isFinite(cid) || cid < 1) {
      setFlujoPriceByPackageId({})
      return undefined
    }
    const ac = new AbortController()
    api
      .get(`/api/v1/admin/clients/${cid}/assigned-package-prices`, { signal: ac.signal })
      .then(({ data }) => {
        const list = Array.isArray(data) ? data : []
        const draft = {}
        for (const row of list) {
          const pid = String(row?.package_catalog_id ?? row?.package_id ?? '')
          const existing = row?.sale_price_local
          if (pid && existing != null && Number(existing) > 0) {
            draft[pid] = String(existing)
          }
        }
        setFlujoPriceByPackageId(draft)
      })
      .catch(() => {
        setFlujoPriceByPackageId({})
      })
    return () => ac.abort()
  }, [open, isReadOnly, pricingClientId])

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

  useEffect(() => {
    if (!open || isReadOnly) return undefined
    const cur = tableBillingCurrency
    const ac = new AbortController()
    api
      .get('/api/v1/sales/last-exchange-rate', {
        params: { currency: cur },
        signal: ac.signal,
      })
      .then(({ data }) => {
        const rate = Number(data?.exchange_rate)
        const xr = Number.isFinite(rate) && rate > 0 ? rate : cur === 'USD' ? 1 : salesCurrencyDefaultRate(cur)
        const xrStr = String(xr)
        setBillingExchangeRateStr(xrStr)
        setExchangeRates((prev) => {
          const list = Array.isArray(flujoPackages) ? flujoPackages : []
          if (!list.length) return prev
          const next = { ...prev }
          for (const pkg of list) {
            const pkgId = Number(pkg?.package_catalog_id)
            if (!Number.isFinite(pkgId)) continue
            next[String(pkgId)] = xrStr
          }
          return next
        })
      })
      .catch((err) => {
        if (err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') return
        const fallback = cur === 'USD' ? '1' : String(salesCurrencyDefaultRate(cur))
        setBillingExchangeRateStr(fallback)
        setExchangeRates((prev) => {
          const list = Array.isArray(flujoPackages) ? flujoPackages : []
          if (!list.length) return prev
          const next = { ...prev }
          for (const pkg of list) {
            const pkgId = Number(pkg?.package_catalog_id)
            if (!Number.isFinite(pkgId)) continue
            next[String(pkgId)] = fallback
          }
          return next
        })
      })
    return () => ac.abort()
  }, [open, isReadOnly, tableBillingCurrency, flujoPackages])

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

  const linesSubtotal = useMemo(() => {
    const list = Array.isArray(rechargeLineItems) ? rechargeLineItems : []
    const sum = list.reduce((acc, li) => {
      const s = parseLineNum(li?.saldo_recargar ?? '')
      return acc + (Number.isFinite(s) ? s : 0)
    }, 0)
    return Math.round(sum * 100) / 100
  }, [rechargeLineItems])

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
    return Math.min(avail, linesSubtotal)
  }, [isReadOnly, editMode, clientCreditAvail, linesSubtotal])

  const balanceRemainingInfo = useMemo(() => {
    if (isReadOnly && summaryBalancePendingOverride != null) {
      const bal = Number(summaryBalancePendingOverride)
      return Number.isFinite(bal) ? Math.max(0, Math.round(bal * 100) / 100) : 0
    }
    if (editMode && summaryBalancePendingOverride != null) {
      const bal = Number(summaryBalancePendingOverride)
      return Number.isFinite(bal) ? Math.max(0, Math.round(bal * 100) / 100) : 0
    }
    const afterCredit = Math.max(0, linesSubtotal - creditAutoApplied)
    const afterDeposit = Math.max(0, Math.round((afterCredit - depositInBilling) * 100) / 100)
    return afterDeposit
  }, [
    isReadOnly,
    editMode,
    summaryBalancePendingOverride,
    linesSubtotal,
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
    (isReadOnly || editMode) && Number.isFinite(subOv) ?
      Math.round(subOv * 100) / 100
    : linesSubtotal
  const lateralBalancePendingDisplay =
    (isReadOnly || editMode) && Number.isFinite(balOv) ?
      Math.max(0, Math.round(balOv * 100) / 100)
    : balanceRemainingInfo

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

  const pendingReviewForOcr = useMemo(() => {
    const pending = Array.isArray(financialPending) ? financialPending : []
    return pending[0] ?? null
  }, [financialPending])

  const showIllegibleDepositAlert = useMemo(() => {
    if (!editMode) return false
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
  ])

  const showFinancialSummary = isReadOnly || editMode

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

  function salePriceToUsd(localPrice, packageCatalogId) {
    const price = Number(localPrice)
    if (!Number.isFinite(price)) return NaN
    if (billingCode === 'USD') return price
    const xr = packageExchangeRateNum(packageCatalogId)
    return Math.round((price / xr) * 10000) / 10000
  }

  const flujoPriceRowsForSubmit = useMemo(() => {
    const list = Array.isArray(flujoPackages) ? flujoPackages : []
    const out = []
    for (const pkg of list) {
      const pkgId = Number(pkg?.package_catalog_id)
      if (!Number.isFinite(pkgId)) continue
      const raw = flujoPriceByPackageId[String(pkgId)]
      if (raw == null || String(raw).trim() === '') continue
      const localPrice = parseLineNum(raw)
      if (!Number.isFinite(localPrice) || localPrice <= 0) continue
      const costUsd = Number(pkg?.reference_cost_usd ?? 0)
      const localCost = packageLocalCost(costUsd, pkgId)
      const usdPrice = salePriceToUsd(localPrice, pkgId)
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
      const localPrice = parseLineNum(raw)
      if (!Number.isFinite(localPrice) || localPrice <= 0) {
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
    }))
    const extra = {
      distributorEmail: displayCliente?.email,
      creditAppliedAmount: creditAutoApplied,
      productPrices: productPricesPayload,
      rechargeExchangeRate: resolveBillingExchangeRate(),
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
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Cerrar modal"
      />

      <div className="relative w-full max-w-6xl bg-white rounded-2xl shadow-2xl z-10 max-h-[95vh] flex flex-col min-h-0">
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-gray-100 sticky top-0 bg-white rounded-t-2xl z-10 shrink-0">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-gray-900">
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
              : 'Nueva solicitud de recarga (portal permanente)'}
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {isReadOnly ?
                'Vista sólo lectura basada en el mismo diseño que «Nueva solicitud de recarga».'
              : editMode ?
                'Ajustes visibles para el cliente en el portal permanente.'
              : 'Misma experiencia que ventas: tabla de líneas, resumen lateral y método/cuentas en el portal.'}
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

        <div className="px-6 py-5 overflow-y-auto min-h-0 flex-1">
          {isReadOnly ?
            <div className="mb-5 rounded-xl border border-gray-300 bg-gray-100 px-4 py-3 text-xs text-gray-800 leading-relaxed shadow-sm">
              {readOnlyBannerText}
            </div>
          : null}

          <form onSubmit={(e) => handleSubmitForm(e)} className="space-y-5">
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
                  <label className="block text-xs font-medium text-gray-500 mb-1.5">Distribuidor</label>
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
                        placeholder={clientOptions.length ? 'Buscar cliente…' : 'Sin clientes (catálogo)'}
                        disabled={!clientOptions.length || generatingLink}
                        hideClear
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

              <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-6 items-start border border-gray-100 rounded-2xl p-4 bg-slate-50/40">
                <div className="space-y-3 min-w-0">
                  <p className="text-sm font-medium text-gray-800">Conceptos</p>
                  <div className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm min-w-[560px]">
                        <thead>
                          <tr className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-600">
                            <th className="px-2 py-2.5 font-semibold min-w-[140px]">Producto/servicio</th>
                            <th className="px-2 py-2.5 font-semibold min-w-[112px]">Tipo de moneda</th>
                            <th className="px-2 py-2.5 font-semibold min-w-[120px]">Saldo a recargar</th>
                            {!isReadOnly ?
                              <th className="w-10 px-1" aria-label="Eliminar" />
                            : null}
                          </tr>
                        </thead>
                        <tbody>
                          {(Array.isArray(rechargeLineItems) ? rechargeLineItems : []).map((line, rowIdx) => {
                            const rowKey =
                              line?.id != null && String(line.id) !== '' ?
                                String(line.id)
                              : `concepto-${rowIdx}`
                            const tm = normalizeCurrencyCode(line?.tipo_moneda ?? tableBillingCurrency, 'USD')
                            const isLead = rowIdx === 0 || line?.id === leadLineId
                            return (
                              <tr key={rowKey} className="border-t border-gray-100 align-top">
                                <td className="px-2 py-2">
                                  <input
                                    className={icls}
                                    value={line.producto ?? ''}
                                    readOnly={isReadOnly}
                                    disabled={generatingLink || isReadOnly}
                                    onChange={(e) => updateLine(line.id, { producto: e.target.value })}
                                    placeholder="BaaS Balance"
                                  />
                                </td>
                                <td className="px-2 py-2">
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
                                      className="[&_button]:min-h-9 [&_button]:text-xs [&_button]:py-1.5"
                                      dropdownZClass="z-[6000]"
                                    />
                                  : <span className="flex items-center min-h-[2.375rem] px-3 py-2 text-sm text-gray-700 tabular-nums rounded-xl border border-gray-100 bg-slate-50/80">
                                      {tm}
                                    </span>
                                  }
                                </td>
                                <td className="px-2 py-2">
                                  <input
                                    className={`${icls} tabular-nums`}
                                    inputMode="decimal"
                                    value={line.saldo_recargar ?? ''}
                                    readOnly={isReadOnly}
                                    disabled={generatingLink || isReadOnly}
                                    onChange={(e) => updateLine(line.id, { saldo_recargar: e.target.value })}
                                    placeholder="0"
                                  />
                                </td>
                                {!isReadOnly ?
                                  <td className="px-1 py-2 text-center">
                                    <button
                                      type="button"
                                      aria-label="Quitar línea"
                                      className="p-1 rounded-md text-red-600 hover:bg-red-50 disabled:opacity-30"
                                      disabled={(rechargeLineItems?.length ?? 0) <= 1 || generatingLink}
                                      onClick={() => removeLine(line.id)}
                                    >
                                      <Trash2 size={16} />
                                    </button>
                                  </td>
                                : null}
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
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
                      <div className="mt-6 pt-6 border-t border-gray-200 space-y-3 px-3 pb-3">
                        <div>
                          <p className="text-sm font-semibold text-gray-900">Asignación de precios de venta — Flujo</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Todos los paquetes activos del catálogo Flujo (incluye productos nuevos sin precio). El
                            precio de venta no puede ser menor al costo local (costo base USD × tipo de cambio).
                          </p>
                        </div>
                        {flujoPackagesLoading ?
                          <p className="text-xs text-gray-500">Cargando paquetes Flujo…</p>
                        : flujoPackagesError ?
                          <p className="text-xs text-red-700">{flujoPackagesError}</p>
                        : flujoPackages.length === 0 ?
                          <p className="text-xs text-gray-500">No hay paquetes Flujo configurados en el catálogo.</p>
                        : (
                          <div className="overflow-x-auto -mx-1">
                            <table className="w-full text-sm min-w-[640px]">
                              <thead>
                                <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                                  <th className="px-2 py-2 font-semibold min-w-[140px]">Paquete Flujo</th>
                                  <th className="px-2 py-2 font-semibold w-14 text-center">Stock</th>
                                  <th className="px-2 py-2 font-semibold w-20">Costo base</th>
                                  <th className="px-2 py-2 font-semibold w-24">Tipo de cambio</th>
                                  <th className="px-2 py-2 font-semibold w-24">Costo local</th>
                                  <th className="px-2 py-2 font-semibold w-28">Precio venta ({billingCode})</th>
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
                                  const priceNum = parseLineNum(rawPrice)
                                  const localCost = packageLocalCost(cost, pkgId)
                                  const belowCost =
                                    rawPrice !== '' && Number.isFinite(priceNum) && priceNum + 1e-9 < localCost
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
                                        {localCost.toLocaleString('es-ES', {
                                          minimumFractionDigits: 2,
                                          maximumFractionDigits: 2,
                                        })}{' '}
                                        {billingCode}
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
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {priceAssignmentInvalid ?
                          <p className="text-xs text-red-700 font-medium">{priceAssignmentInvalid}</p>
                        : null}
                      </div>
                    : null}
                  </div>
                </div>

                <aside className="space-y-3 xl:sticky xl:top-2 rounded-xl border border-gray-200 bg-white p-4 shadow-sm self-start w-full max-w-full">
                  {showFinancialSummary ?
                    <FinancialSummarySidebar
                      subtotal={lateralSubtotalDisplay}
                      currency={billingCode}
                      linkedPayments={financialApproved}
                      pendingReviewPayments={financialPending}
                      balanceDue={lateralBalancePendingDisplay}
                      subtotalLabel={isReadOnly ? 'Monto original' : 'Subtotal'}
                      subtotalSize="sm"
                      apiOrigin={apiOrigin}
                    />
                  : (
                    <>
                      <FinancialSummarySidebar
                        subtotal={lateralSubtotalDisplay}
                        currency={billingCode}
                        linkedPayments={[]}
                        pendingReviewPayments={[]}
                        balanceDue={lateralBalancePendingDisplay}
                        autoAppliedCredit={creditAutoApplied}
                        subtotalLabel="Subtotal"
                        subtotalSize="sm"
                        apiOrigin={apiOrigin}
                      />
                      {clientCreditLoading ?
                        <p className="text-[10px] text-gray-400">Consultando saldo a favor…</p>
                      : null}
                      {!clientCreditLoading && clientCreditAvail > 1e-9 ?
                        <p className="text-[10px] text-emerald-800 leading-snug">
                          Saldo a favor disponible:{' '}
                          <span className="font-semibold tabular-nums">
                            {clientCreditAvail.toLocaleString('es-ES', { minimumFractionDigits: 2 })} {billingCode}
                          </span>
                          {creditAutoApplied > 1e-9 ? ' (se aplicará al crear la solicitud)' : null}
                        </p>
                      : null}
                    </>
                  )}

                  {!isReadOnly ?
                    <>
                      <div>
                        {editMode && showIllegibleDepositAlert ? (
                          <div className="mb-2.5">
                            <IllegibleReceiptAlert className="w-full" layout="block" />
                          </div>
                        ) : null}
                        <label
                          className="block text-[11px] font-medium text-gray-600 mb-1"
                          htmlFor="recharge-deposit-ref"
                        >
                          Depósito declarado ({billingCode})
                        </label>
                        <input
                          id="recharge-deposit-ref"
                          type="text"
                          inputMode="decimal"
                          value={depositUsd}
                          onChange={(e) => onDepositUsdChange(e.target.value)}
                          placeholder={`Opcional · misma moneda que la tabla (${billingCode})`}
                          disabled={generatingLink}
                          className={icls}
                        />
                        <p className="mt-1 text-[10px] text-gray-500 leading-snug">
                          {editMode ?
                            'Corrija aquí si la lectura automática del comprobante fue incorrecta. Al guardar, el monto se aplicará al cobro en revisión.'
                          : depositDeclaredNum > 0 ?
                            <>
                              Comparado contra el subtotal:{' '}
                              {depositInBilling.toLocaleString('es-ES', { minimumFractionDigits: 2 })} {billingCode}.
                            </>
                          : 'Sin depósito declarado hasta que indiques un importe (opcional).'}
                        </p>
                        {editMode ? (
                          <OcrSecurityBadges
                            className="mt-2"
                            suppressIllegibleAlert
                            is_manually_edited={ocrIsManuallyEdited}
                            ai_confidence_score={ocrAiConfidenceScore}
                            portal_declared_payment_amount={ocrPortalDeclaredAmount}
                            amount={ocrPortalDeclaredAmount}
                          />
                        ) : null}
                      </div>

                      <PaymentMethodsDepositCheckboxes
                        disabled={generatingLink}
                        salePaymentMethodOptions={safePmOptions}
                        depositAccountOptionsByMethodId={safeDepositByPm}
                        selectedPaymentMethodIds={selectedPaymentMethodIds}
                        togglePaymentMethodId={togglePaymentMethodId}
                        selectedDepositAccountIds={selectedDepositAccountIds}
                        toggleDepositAccountId={toggleDepositAccountId}
                        depositCurrencyMismatch={depositCurrencyMismatch}
                        depositAccountCurrencyCode={depositAccountCurrencyCode}
                        saleCurrencyCode={billingCode}
                        titleHint="(obligatorio · portal)"
                        footerNote={`Solo se muestran cuentas en ${billingCode}, alineadas con la moneda de la tabla.`}
                      />
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

              <div className="flex gap-2 justify-end pt-2">
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
            </form>
        </div>
      </div>
    </div>
  )
}
