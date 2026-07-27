import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import api from '../../api/axios'
import { useModal } from '../../context/ModalContext'
import { normalizeCurrencyCode } from '../../lib/currencyCode'
import { declaredDepositInputValueFromReview } from '../../components/OcrSecurityBadges'
import { DISCOUNT_TYPES } from '../../lib/financialSummaryUtils'
import NewRechargeModal, { normalizeClienteDesdeWebhook } from '../settings/NewRechargeModal'
import {
  isSubsequentCxcAbonoForRecharge,
  openReceivePaymentForRechargeAbono,
} from '../sales/receivePaymentRouting'

function rechargeLinesHydrateFromAdminRow(row) {
  const raw = row?.recharge_detail_lines
  const rid = row?.id != null ? String(row.id) : 'new'
  const reqCurrency = normalizeCurrencyCode(row?.recharge_currency ?? 'USD', 'USD')
  const disc = Number(row?.discount)
  const netAmt = Number(row?.amount_requested)
  const grossFallback =
    Number.isFinite(netAmt) && netAmt > 0
      ? Math.round((netAmt + (Number.isFinite(disc) && disc > 0 ? disc : 0)) * 100) / 100
      : 0

  const resolveLineCharge = (r) => {
    let charge = Number(r?.importe ?? r?.line_amount ?? r?.monto_linea)
    if (!Number.isFinite(charge) || charge <= 0) {
      charge = Number(r?.saldo_recargar ?? r?.balance_to_recharge ?? r?.virtual_balance)
    }
    return Number.isFinite(charge) && charge > 0 ? charge : NaN
  }

  const withTableCurrency = (lines) =>
    lines.map((li) => ({ ...li, tipo_moneda: reqCurrency }))

  if (Array.isArray(raw) && raw.length > 0) {
    const mapped = raw.map((r, idx) => {
      const chargeNum = resolveLineCharge(r)
      return {
        id: `rli-e-${rid}-${idx}`,
        producto: String(r?.producto ?? r?.product_name ?? r?.product ?? 'BaaS Balance'),
        saldo_recargar: Number.isFinite(chargeNum) ? String(chargeNum) : '',
      }
    })
    if (mapped.some((li) => String(li?.saldo_recargar ?? '').trim() !== '')) {
      return withTableCurrency(mapped)
    }
  }

  const amtStr = grossFallback > 0 ? String(grossFallback) : ''
  return withTableCurrency([
    { id: `rli-single-${rid}`, producto: 'BaaS Balance', saldo_recargar: amtStr },
  ])
}

function rechargeHasOpenCxcBalance(row) {
  const bp = Number(row?.balance_pending ?? 0)
  return Number.isFinite(bp) && bp > 1e-6
}

function buildDepositOptionsByMethodId(depositAccounts, paymentMethods, isDepositGroupingParent) {
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
        if (isParent) label = `${label} (${cur}) — Cuenta agrupadora · elija subcuenta`
        else if (par) label = `${String(par?.name ?? '—')} - ${label} (${cur})`
        else label = `${label} (${cur})`
        return { value: String(a?.id ?? ''), label, disabled: Boolean(isParent) }
      })
      .filter((o) => o.value !== '' && o.value !== 'undefined' && o.value !== 'null')

  const out = {}
  for (const pm of pms) {
    const key = String(pm?.id ?? '')
    if (!key) continue
    const methodLower = String(pm?.name ?? '').trim().toLowerCase()
    out[key] = buildForMethodLower(methodLower)
  }
  return out
}

/**
 * Abre la solicitud de recarga BaaS con el formulario original (mismo layout que BaaS / Ventas).
 */
export default function ClientHistoryRechargeModal({
  requestId,
  onClose,
  onAfterSave,
  onLoadComplete,
}) {
  const { openReceivePayment } = useModal()
  const onCloseRef = useRef(onClose)
  const onAfterSaveRef = useRef(onAfterSave)
  const onLoadCompleteRef = useRef(onLoadComplete)
  const openReceivePaymentRef = useRef(openReceivePayment)

  useEffect(() => {
    onCloseRef.current = onClose
    onAfterSaveRef.current = onAfterSave
    onLoadCompleteRef.current = onLoadComplete
    openReceivePaymentRef.current = openReceivePayment
  }, [onClose, onAfterSave, onLoadComplete, openReceivePayment])

  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [paymentMethods, setPaymentMethods] = useState([])
  const [depositAccounts, setDepositAccounts] = useState([])

  const [linkLineItems, setLinkLineItems] = useState([])
  const [linkDepositUsd, setLinkDepositUsd] = useState('')
  const [linkDiscount, setLinkDiscount] = useState('')
  const [linkDiscountType, setLinkDiscountType] = useState(DISCOUNT_TYPES.FIXED)
  const [linkComment, setLinkComment] = useState('')
  const [linkClientId, setLinkClientId] = useState('')
  const [selectedPaymentMethodIds, setSelectedPaymentMethodIds] = useState([])
  const [selectedDepositAccountIds, setSelectedDepositAccountIds] = useState([])

  const applyDetailToForm = useCallback((hydrated) => {
    if (!hydrated || typeof hydrated !== 'object') return
    setLinkLineItems(rechargeLinesHydrateFromAdminRow(hydrated))
    setLinkDepositUsd(declaredDepositInputValueFromReview(hydrated))
    setLinkDiscount(
      hydrated.discount != null && Number(hydrated.discount) > 0 ? String(hydrated.discount) : '',
    )
    setLinkDiscountType(DISCOUNT_TYPES.FIXED)
    setLinkComment(typeof hydrated.admin_note === 'string' ? hydrated.admin_note : '')
    const clientId = Number(hydrated.client_id)
    const email = String(hydrated.client_email ?? '').trim()
    setLinkClientId(Number.isFinite(clientId) && clientId > 0 ? String(clientId) : email)
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
  }, [])

  useEffect(() => {
    if (!requestId) return undefined
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setDetail(null)

    ;(async () => {
      try {
        const [wrRes, pmRes, depRes] = await Promise.all([
          api.get(`/api/v1/distributors/recharge-requests/${requestId}`),
          api.get('/api/v1/payment-methods/'),
          api.get('/api/v1/accounts/deposit-options'),
        ])
        if (cancelled) return
        const hydrated = wrRes.data
        setPaymentMethods(Array.isArray(pmRes.data) ? pmRes.data : [])
        setDepositAccounts(Array.isArray(depRes.data) ? depRes.data : [])

        const st = String(hydrated?.status ?? '').toLowerCase()
        if (st === 'in_review' && isSubsequentCxcAbonoForRecharge(hydrated)) {
          onLoadCompleteRef.current?.()
          onCloseRef.current?.()
          await openReceivePaymentForRechargeAbono(
            hydrated,
            openReceivePaymentRef.current,
            onAfterSaveRef.current,
          )
          return
        }

        setDetail(hydrated)
        applyDetailToForm(hydrated)
        onLoadCompleteRef.current?.()
      } catch (err) {
        if (!cancelled) {
          const d = err?.response?.data?.detail
          const msg = typeof d === 'string' ? d : 'No se pudo cargar el detalle de la recarga.'
          setLoadError(msg)
          window.alert(msg)
          onLoadCompleteRef.current?.()
          onCloseRef.current?.()
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [requestId, applyDetailToForm])

  const isDepositGroupingParent = useCallback(
    (accId) =>
      depositAccounts.some((x) => Number(x?.parent_id) === Number(accId)),
    [depositAccounts],
  )

  const salePaymentMethodOptions = useMemo(() => {
    return paymentMethods
      .filter((m) => m?.is_active !== false)
      .map((m) => ({ value: String(m?.id ?? ''), label: String(m?.name ?? '—') }))
      .filter((o) => o.value !== '' && o.value !== 'undefined')
  }, [paymentMethods])

  const depositAccountOptionsByMethodId = useMemo(
    () => buildDepositOptionsByMethodId(depositAccounts, paymentMethods, isDepositGroupingParent),
    [depositAccounts, paymentMethods, isDepositGroupingParent],
  )

  const clientSnapshotForEdit = useMemo(() => {
    if (!detail) return null
    const rawName = detail.client_name != null ? String(detail.client_name).trim() : ''
    return normalizeClienteDesdeWebhook({
      id: detail.client_id,
      name: rawName || 'Cliente',
      full_name: rawName || 'Cliente',
      email: detail.client_email,
      username: detail.client_username,
      iptv_username: detail.client_username,
    })
  }, [detail])

  const status = String(detail?.status ?? '').toLowerCase()
  const readOnly =
    status === 'rejected'
    || status === 'canceled'
    || ((status === 'approved' || status === 'partially_paid') && !rechargeHasOpenCxcBalance(detail))

  const togglePaymentMethodId = useCallback((id) => {
    const sid = String(id)
    setSelectedPaymentMethodIds((prev) =>
      prev.includes(sid) ? prev.filter((x) => x !== sid) : [...prev, sid],
    )
  }, [])

  const toggleDepositAccountId = useCallback((id) => {
    const sid = String(id)
    setSelectedDepositAccountIds((prev) =>
      prev.includes(sid) ? prev.filter((x) => x !== sid) : [...prev, sid],
    )
  }, [])

  if (!requestId) return null

  if (loading || !detail) {
    return (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"
        role="presentation"
      >
        <div className="flex items-center gap-3 rounded-xl bg-white px-5 py-4 shadow-xl ring-1 ring-gray-200">
          <Loader2 className="h-6 w-6 animate-spin text-emerald-600" aria-hidden />
          <p className="text-sm font-medium text-gray-700">Cargando solicitud de recarga…</p>
          <button
            type="button"
            onClick={() => {
              onLoadCompleteRef.current?.()
              onCloseRef.current?.()
            }}
            className="ml-2 text-xs font-semibold text-gray-500 hover:text-gray-800 underline"
          >
            Cancelar
          </button>
        </div>
      </div>
    )
  }

  if (loadError) return null

  const existingReceiptUrl =
    detail.receipt_url?.trim?.()
      ? String(detail.receipt_url).trim()
      : detail.admin_precheck_receipt_url?.trim?.()
        ? String(detail.admin_precheck_receipt_url).trim()
        : ''

  return (
    <NewRechargeModal
      key={`client-hist-wr-${detail.id}`}
      open
      onClose={onClose}
      editMode
      editTargetRequestId={detail.id}
      isReadOnly={readOnly}
      clientSnapshotForEdit={clientSnapshotForEdit}
      assignedPackagePricesPrefill={detail.assigned_package_prices ?? null}
      linkClientId={linkClientId}
      onLinkClientIdChange={setLinkClientId}
      rechargeLineItems={linkLineItems}
      onRechargeLineItemsChange={setLinkLineItems}
      depositUsd={linkDepositUsd}
      onDepositUsdChange={setLinkDepositUsd}
      discountBilling={linkDiscount}
      onDiscountBillingChange={setLinkDiscount}
      discountType={linkDiscountType}
      onDiscountTypeChange={setLinkDiscountType}
      rechargeComment={linkComment}
      onRechargeCommentChange={setLinkComment}
      salePaymentMethodOptions={salePaymentMethodOptions}
      depositAccountOptionsByMethodId={depositAccountOptionsByMethodId}
      selectedPaymentMethodIds={selectedPaymentMethodIds}
      togglePaymentMethodId={togglePaymentMethodId}
      selectedDepositAccountIds={selectedDepositAccountIds}
      toggleDepositAccountId={toggleDepositAccountId}
      existingReceiptUrl={existingReceiptUrl}
      summarySubtotalOverride={detail.amount_requested ?? null}
      summaryPaidOverride={detail.amount_paid ?? detail.paid_amount ?? null}
      summaryBalancePendingOverride={detail.balance_pending ?? detail.pending_amount ?? null}
      linkedPaymentsFromEdit={
        Array.isArray(detail.linked_payments) ? detail.linked_payments : []
      }
      rechargeInReview={status === 'in_review'}
      reviewDestinationRechargeRow={detail}
    />
  )
}
