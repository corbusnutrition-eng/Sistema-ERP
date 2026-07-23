import { useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'

function parseAmount(raw) {
  const n = parseFloat(String(raw ?? '').trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

/**
 * Modal para crear o editar una solicitud de recarga BaaS desde el portal.
 * En creación solo pide el monto; el método de pago se elige en la vista del pedido.
 */
export default function ClientRechargeRequestModal({
  open,
  onClose,
  token,
  api,
  currency = 'USD',
  onSuccess,
  mode = 'create',
  rechargeId = null,
  initialAmount = null,
}) {
  const isEditMode = mode === 'edit'
  const [amount, setAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitErr, setSubmitErr] = useState('')

  useEffect(() => {
    if (!open) return
    const seed =
      initialAmount != null && Number.isFinite(Number(initialAmount)) && Number(initialAmount) > 0
        ? String(initialAmount)
        : ''
    setAmount(seed)
    setSubmitErr('')
  }, [open, initialAmount])

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

    setSubmitting(true)
    try {
      const body = {
        amount: amt,
        currency: String(currency || 'USD').trim().toUpperCase().slice(0, 10),
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
                : 'Indica el monto y te llevaremos al formulario de pago para elegir cómo pagar.'}
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
              autoFocus
            />
          </div>

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
              disabled={submitting}
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
