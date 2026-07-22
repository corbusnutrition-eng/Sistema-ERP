import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import Select from 'react-select'

function parseAmount(raw) {
  const n = parseFloat(String(raw ?? '').trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

function portalSelectStyles() {
  return {
    control: (base, state) => ({
      ...base,
      minHeight: 40,
      borderRadius: 10,
      borderColor: state.isFocused ? 'rgba(129,140,248,0.65)' : 'rgba(71,85,105,0.85)',
      backgroundColor: 'rgb(2,6,23)',
      boxShadow: state.isFocused ? '0 0 0 1px rgba(129,140,248,0.35)' : 'none',
      '&:hover': { borderColor: 'rgba(129,140,248,0.55)' },
    }),
    menu: (base) => ({
      ...base,
      borderRadius: 10,
      backgroundColor: 'rgb(15,23,42)',
      border: '1px solid rgba(71,85,105,0.75)',
      zIndex: 60,
    }),
    option: (base, state) => ({
      ...base,
      fontSize: 13,
      backgroundColor: state.isSelected ? 'rgba(99,102,241,0.35)' : state.isFocused ? 'rgba(51,65,85,0.85)' : 'transparent',
      color: '#e2e8f0',
    }),
    singleValue: (base) => ({ ...base, color: '#f8fafc' }),
    input: (base) => ({ ...base, color: '#f8fafc' }),
    placeholder: (base) => ({ ...base, color: '#64748b' }),
  }
}

/**
 * Modal para crear o editar una solicitud de recarga BaaS desde el portal.
 */
export default function ClientRechargeRequestModal({
  open,
  onClose,
  token,
  api,
  currency = 'USD',
  assignedPaymentMethods = [],
  onSuccess,
  mode = 'create',
  rechargeId = null,
  initialAmount = null,
}) {
  const isEditMode = mode === 'edit'
  const [amount, setAmount] = useState('')
  const [paymentOptions, setPaymentOptions] = useState([])
  const [optionsLoading, setOptionsLoading] = useState(false)
  const [optionsErr, setOptionsErr] = useState('')
  const [methodId, setMethodId] = useState('')
  const [accountId, setAccountId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState('')

  const loadOptions = useCallback(async () => {
    if (!token || isEditMode) return
    setOptionsLoading(true)
    setOptionsErr('')
    try {
      const { data } = await api.get(
        `/api/v1/portal/${encodeURIComponent(token)}/recharge-payment-options`,
      )
      const rows = Array.isArray(data) ? data : []
      if (rows.length > 0) {
        setPaymentOptions(rows)
        return
      }
      const fallback = Array.isArray(assignedPaymentMethods) ? assignedPaymentMethods : []
      setPaymentOptions(fallback)
      if (fallback.length === 0) {
        setOptionsErr('No hay métodos de pago disponibles. Contacta a soporte.')
      }
    } catch (err) {
      const detail = err?.response?.data?.detail
      setOptionsErr(typeof detail === 'string' ? detail : 'No se pudieron cargar los métodos de pago.')
      setPaymentOptions(Array.isArray(assignedPaymentMethods) ? assignedPaymentMethods : [])
    } finally {
      setOptionsLoading(false)
    }
  }, [api, assignedPaymentMethods, isEditMode, token])

  useEffect(() => {
    if (!open) return
    const seed =
      initialAmount != null && Number.isFinite(Number(initialAmount)) && Number(initialAmount) > 0
        ? String(initialAmount)
        : ''
    setAmount(seed)
    setMethodId('')
    setAccountId('')
    setSubmitErr('')
    void loadOptions()
  }, [open, loadOptions, initialAmount])

  const methodOptions = useMemo(
    () =>
      (Array.isArray(paymentOptions) ? paymentOptions : [])
        .filter((m) => (m?.deposit_accounts?.length ?? 0) > 0 || Number.isFinite(Number(m?.id)))
        .map((m) => ({
          value: String(m.id),
          label: String(m.name || `Método #${m.id}`),
        })),
    [paymentOptions],
  )

  const depositAccounts = useMemo(() => {
    const mid = String(methodId || '').trim()
    if (!mid) return []
    const node = (Array.isArray(paymentOptions) ? paymentOptions : []).find((m) => String(m.id) === mid)
    return Array.isArray(node?.deposit_accounts) ? node.deposit_accounts : []
  }, [methodId, paymentOptions])

  const accountOptions = useMemo(
    () =>
      depositAccounts.map((d) => ({
        value: String(d.id),
        label: [d.bank_name, d.account_number, d.currency].filter(Boolean).join(' · '),
      })),
    [depositAccounts],
  )

  useEffect(() => {
    if (isEditMode) return
    if (depositAccounts.length === 1) {
      setAccountId(String(depositAccounts[0].id))
    } else if (depositAccounts.length === 0) {
      setAccountId('')
    } else if (!depositAccounts.some((d) => String(d.id) === String(accountId))) {
      setAccountId('')
    }
  }, [depositAccounts, accountId, isEditMode])

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitErr('')
    const amt = parseAmount(amount)
    if (!Number.isFinite(amt) || !(amt > 0)) {
      setSubmitErr('Indica un monto válido mayor a cero.')
      return
    }

    if (isEditMode) {
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

    const pm = Number(methodId)
    if (!Number.isFinite(pm) || pm < 1) {
      setSubmitErr('Selecciona un método de pago.')
      return
    }
    if (depositAccounts.length > 1 && !String(accountId || '').trim()) {
      setSubmitErr('Selecciona la cuenta bancaria donde realizarás el depósito.')
      return
    }

    setSubmitting(true)
    try {
      const body = {
        amount: amt,
        payment_method_id: pm,
        currency: String(currency || 'USD').trim().toUpperCase().slice(0, 10),
      }
      const dep = Number(accountId)
      if (Number.isFinite(dep) && dep > 0) body.deposit_account_id = dep

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

  const curLabel = String(currency || 'USD').trim().toUpperCase().slice(0, 10)

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
                : 'Crearemos tu pedido y te llevaremos al formulario de pago para subir el comprobante.'}
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
          <div>
            <label htmlFor="client-recharge-amount" className="mb-1.5 block text-xs font-semibold text-slate-300">
              Monto a recargar ({curLabel})
            </label>
            <input
              id="client-recharge-amount"
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              value={amount}
              onChange={(ev) => setAmount(ev.target.value)}
              placeholder="0.00"
              className="w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-white tabular-nums"
              disabled={submitting}
            />
          </div>

          {!isEditMode ? (
            <>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-slate-300">Método de pago</label>
                {optionsLoading ? (
                  <p className="m-0 flex items-center gap-2 text-sm text-slate-400">
                    <Loader2 size={14} className="animate-spin" />
                    Cargando métodos…
                  </p>
                ) : (
                  <Select
                    options={methodOptions}
                    value={methodOptions.find((o) => o.value === String(methodId)) ?? null}
                    onChange={(opt) => setMethodId(opt?.value ?? '')}
                    isDisabled={submitting || methodOptions.length === 0}
                    styles={portalSelectStyles()}
                    placeholder="Selecciona cómo pagarás…"
                    className="text-sm"
                    classNamePrefix="portal-recharge-method"
                  />
                )}
                {optionsErr ? <p className="mt-1.5 mb-0 text-xs text-amber-300">{optionsErr}</p> : null}
              </div>

              {depositAccounts.length > 1 ? (
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-300">Cuenta bancaria</label>
                  <Select
                    options={accountOptions}
                    value={accountOptions.find((o) => o.value === String(accountId)) ?? null}
                    onChange={(opt) => setAccountId(opt?.value ?? '')}
                    isDisabled={submitting}
                    styles={portalSelectStyles()}
                    placeholder="Selecciona la cuenta receptora…"
                    className="text-sm"
                    classNamePrefix="portal-recharge-account"
                  />
                </div>
              ) : depositAccounts.length === 1 ? (
                <p className="m-0 text-xs text-slate-400">
                  Cuenta:{' '}
                  <span className="font-semibold text-slate-200">
                    {[depositAccounts[0].bank_name, depositAccounts[0].account_number].filter(Boolean).join(' · ')}
                  </span>
                </p>
              ) : null}
            </>
          ) : null}

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
              disabled={submitting || (!isEditMode && (optionsLoading || methodOptions.length === 0))}
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
