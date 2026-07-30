import { useEffect, useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import useExchangeRatesCatalog from '../../hooks/useExchangeRatesCatalog'
import { normalizeCurrencyCode } from '../../lib/currencyCode'
import { SALES_CURRENCIES } from '../sales/salesCurrencies'
import PortalCustomSelect from './PortalCustomSelect'

function parseAmount(raw) {
  const n = parseFloat(String(raw ?? '').trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

function formatFiatAmount(amount, currency) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  const cur = normalizeCurrencyCode(currency, 'USD')
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: cur.length === 3 ? cur : 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`
  }
}

/**
 * Modal para crear o editar una solicitud de recarga BaaS desde el portal.
 * Creación: monto en USD + moneda de pago + total fiat calculado con tasas ERP.
 */
export default function ClientRechargeRequestModal({
  open,
  onClose,
  token,
  api,
  clientBaseCurrency = 'USD',
  onSuccess,
  mode = 'create',
  rechargeId = null,
  initialAmount = null,
  currency: editCurrency = 'USD',
}) {
  const isEditMode = mode === 'edit'
  const [amountUsd, setAmountUsd] = useState('')
  const [paymentCurrency, setPaymentCurrency] = useState('USD')
  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState('')

  const { rates, loading: ratesLoading, getActiveRate } = useExchangeRatesCatalog(open && !isEditMode, {
    portalToken: token,
    portalApi: api,
  })

  const paymentCurrencyOptions = useMemo(() => {
    const codes = new Set(['USD'])
    for (const row of rates) {
      const code = normalizeCurrencyCode(row?.currency_code, '')
      if (code) codes.add(code)
    }
    const base = normalizeCurrencyCode(clientBaseCurrency, 'USD')
    if (base) codes.add(base)
    return [...codes].sort((a, b) => a.localeCompare(b)).map((code) => {
      const meta = SALES_CURRENCIES.find((c) => c.code === code)
      return {
        value: code,
        label: meta ? `${meta.flag ?? ''} ${meta.label}`.trim() : code,
      }
    })
  }, [rates, clientBaseCurrency])

  const paymentCurrencyCodes = useMemo(
    () => paymentCurrencyOptions.map((o) => o.value),
    [paymentCurrencyOptions],
  )

  const activeRate = useMemo(() => {
    const rate = getActiveRate(paymentCurrency)
    return Number.isFinite(rate) && rate > 0 ? rate : null
  }, [getActiveRate, paymentCurrency])

  const amountUsdNum = parseAmount(amountUsd)
  const totalFiat = useMemo(() => {
    if (!(amountUsdNum > 0) || activeRate == null) return null
    return Math.round(amountUsdNum * activeRate * 100) / 100
  }, [amountUsdNum, activeRate])

  useEffect(() => {
    if (!open) return
    setSubmitErr('')
    if (isEditMode) {
      const seed =
        initialAmount != null && Number.isFinite(Number(initialAmount)) && Number(initialAmount) > 0
          ? String(initialAmount)
          : ''
      setAmountUsd(seed)
      setPaymentCurrency(normalizeCurrencyCode(editCurrency, 'USD'))
      return
    }
    setAmountUsd('')
  }, [open, initialAmount, isEditMode, editCurrency])

  useEffect(() => {
    if (!open || isEditMode || ratesLoading) return
    const base = normalizeCurrencyCode(clientBaseCurrency, 'USD')
    setPaymentCurrency((prev) => {
      if (prev && paymentCurrencyCodes.includes(prev)) return prev
      if (paymentCurrencyCodes.includes(base)) return base
      return paymentCurrencyCodes[0] || 'USD'
    })
  }, [open, isEditMode, ratesLoading, clientBaseCurrency, paymentCurrencyCodes])

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitErr('')

    if (isEditMode) {
      const amt = parseAmount(amountUsd)
      if (!Number.isFinite(amt) || !(amt > 0)) {
        setSubmitErr('Indica un monto válido mayor a cero.')
        return
      }
      const rid = Number(rechargeId)
      if (!Number.isFinite(rid) || rid < 1) {
        setSubmitErr('Solicitud de recarga inválida.')
        return
      }
      setSubmitting(true)
      try {
        const { data } = await api.patch(
          `/api/v1/portal/${encodeURIComponent(token)}/recharges/${rid}`,
          { amount: amt },
        )
        onSuccess?.(data)
      } catch (err) {
        const detail = err?.response?.data?.detail
        setSubmitErr(
          typeof detail === 'string'
            ? detail
            : Array.isArray(detail)
              ? detail.map((x) => x?.msg || x).join('; ')
              : 'No se pudo actualizar la solicitud de recarga.',
        )
      } finally {
        setSubmitting(false)
      }
      return
    }

    const usd = parseAmount(amountUsd)
    if (!Number.isFinite(usd) || !(usd > 0)) {
      setSubmitErr('Indica un monto USD válido mayor a cero.')
      return
    }
    const payCur = normalizeCurrencyCode(paymentCurrency, 'USD')
    if (!payCur) {
      setSubmitErr('Selecciona la moneda de pago.')
      return
    }
    const xr = getActiveRate(payCur)
    if (xr == null || !(xr > 0)) {
      setSubmitErr(`No hay tasa activa configurada para ${payCur}. Contacta a soporte.`)
      return
    }
    const fiatTotal = Math.round(usd * xr * 100) / 100

    setSubmitting(true)
    try {
      const body = {
        amount_usd: usd,
        currency: payCur,
        exchange_rate: xr,
        total_fiat_amount: fiatTotal,
        amount: fiatTotal,
      }

      const { data } = await api.post(
        `/api/v1/portal/${encodeURIComponent(token)}/recharges`,
        body,
      )
      onSuccess?.(data)
    } catch (err) {
      const detail = err?.response?.data?.detail
      setSubmitErr(
        typeof detail === 'string'
          ? detail
          : Array.isArray(detail)
            ? detail.map((x) => x?.msg || x).join('; ')
            : 'No se pudo crear la solicitud de recarga.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  const editCurLabel = normalizeCurrencyCode(editCurrency, 'USD')

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Cerrar"
        className="absolute inset-0 bg-slate-950/72 backdrop-blur-sm"
        onClick={() => !submitting && onClose?.()}
      />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-indigo-400/35 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-700/50 px-5 py-4">
          <div>
            <h2 className="m-0 text-lg font-extrabold text-indigo-50">
              {isEditMode ? 'Editar solicitud de recarga' : 'Solicitar recarga BaaS'}
            </h2>
            <p className="m-1 mb-0 text-xs text-slate-400">
              {isEditMode
                ? 'Puedes cambiar el monto mientras no hayas enviado ningún pago.'
                : 'Indica cuánto saldo USD deseas y en qué moneda pagarás. Te llevaremos al formulario de pago.'}
            </p>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={() => onClose?.()}
            className="rounded-lg p-1 text-slate-400 hover:text-white disabled:opacity-45"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4 px-5 py-4">
          {isEditMode ? (
            <div>
              <label htmlFor="client-recharge-amount" className="mb-1.5 block text-xs font-semibold text-slate-300">
                Monto a recargar ({editCurLabel})
              </label>
              <input
                id="client-recharge-amount"
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={amountUsd}
                onChange={(ev) => setAmountUsd(ev.target.value)}
                placeholder="0.00"
                className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white tabular-nums"
                disabled={submitting}
                autoFocus
              />
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="client-recharge-usd" className="mb-1.5 block text-xs font-semibold text-slate-300">
                  Monto a recargar (USD)
                </label>
                <input
                  id="client-recharge-usd"
                  type="number"
                  min="0.01"
                  step="0.01"
                  inputMode="decimal"
                  value={amountUsd}
                  onChange={(ev) => setAmountUsd(ev.target.value)}
                  placeholder="100.00"
                  className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white tabular-nums"
                  disabled={submitting || ratesLoading}
                  autoFocus
                />
              </div>

              <div>
                <label htmlFor="client-recharge-pay-currency" className="mb-1.5 block text-xs font-semibold text-slate-300">
                  Moneda de pago
                </label>
                <PortalCustomSelect
                  id="client-recharge-pay-currency"
                  required
                  value={paymentCurrency}
                  onChange={setPaymentCurrency}
                  options={paymentCurrencyOptions}
                  disabled={submitting || ratesLoading}
                  buttonClassName="rounded-lg border-slate-600 bg-slate-950 text-sm"
                />
                {ratesLoading ? (
                  <p className="mt-1.5 mb-0 flex items-center gap-1.5 text-[11px] text-slate-400">
                    <Loader2 size={12} className="animate-spin" aria-hidden />
                    Cargando tasas del ERP…
                  </p>
                ) : activeRate == null && paymentCurrency !== 'USD' ? (
                  <p className="mt-1.5 mb-0 text-[11px] text-amber-300">
                    No hay tasa activa para {paymentCurrency}. Elige otra moneda o contacta soporte.
                  </p>
                ) : null}
              </div>

              {totalFiat != null && totalFiat > 0 ? (
                <div className="rounded-xl border border-cyan-400/30 bg-cyan-950/25 px-4 py-3">
                  <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-cyan-200/80">
                    Total a pagar
                  </p>
                  <p className="m-0 mt-1 text-lg font-bold tabular-nums text-cyan-50">
                    {formatFiatAmount(totalFiat, paymentCurrency)}
                  </p>
                  {activeRate != null && paymentCurrency !== 'USD' ? (
                    <p className="m-0 mt-1 text-[11px] text-slate-400 tabular-nums">
                      {amountUsdNum.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD
                      × {activeRate.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}

          {submitErr ? <p className="m-0 text-sm text-red-300">{submitErr}</p> : null}

          <div className="flex justify-end gap-2 border-t border-slate-700/50 pt-4">
            <button
              type="button"
              disabled={submitting}
              onClick={() => onClose?.()}
              className="rounded-xl border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-45"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting || (!isEditMode && ratesLoading)}
              className="inline-flex items-center gap-2 rounded-xl border-0 bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 px-4 py-2 text-sm font-bold text-slate-950 shadow-[0_10px_28px_rgba(99,102,241,0.35)] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  {isEditMode ? 'Guardando…' : 'Creando…'}
                </>
              ) : isEditMode ? (
                'Guardar cambios'
              ) : (
                'Continuar al pago'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
