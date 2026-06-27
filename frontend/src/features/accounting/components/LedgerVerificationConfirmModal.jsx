import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import {
  LEDGER_UNCONFIRM_PIN,
  LEDGER_VERIFICATION_CONFIRMED,
  verificationStatusLabel,
} from '../ledgerVerificationConstants'

/**
 * Doble confirmación al cambiar estado de verificación bancaria.
 * Si el estado actual es «Confirmado», exige PIN de autorización.
 *
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {string | null} currentStatus
 * @param {string | null} nextStatus
 * @param {() => void | Promise<void>} onConfirm
 * @param {boolean} [confirming]
 */
export default function LedgerVerificationConfirmModal({
  open,
  onClose,
  currentStatus,
  nextStatus,
  onConfirm,
  confirming = false,
}) {
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState('')

  const requiresPin =
    String(currentStatus ?? '').trim().toLowerCase() === LEDGER_VERIFICATION_CONFIRMED

  const nextLabel = verificationStatusLabel(nextStatus)

  useEffect(() => {
    if (!open) return
    setPin('')
    setPinError('')
  }, [open, currentStatus, nextStatus])

  if (!open) return null

  async function handleAccept() {
    if (requiresPin) {
      if (pin !== LEDGER_UNCONFIRM_PIN) {
        setPinError('Contraseña incorrecta')
        return
      }
    }
    setPinError('')
    await onConfirm?.()
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/45"
        aria-label="Cerrar"
        onClick={confirming ? undefined : onClose}
        disabled={confirming}
      />

      <div
        role="dialog"
        aria-labelledby="ledger-verify-confirm-title"
        aria-modal="true"
        className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden"
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100">
          <h2 id="ledger-verify-confirm-title" className="text-base font-semibold text-gray-900 pr-6">
            Confirmar cambio de estado
          </h2>
          <button
            type="button"
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 shrink-0 disabled:opacity-40"
            onClick={onClose}
            disabled={confirming}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-gray-700">
            ¿Estás seguro de cambiar el estado de esta transacción a{' '}
            <span className="font-semibold text-gray-900">{nextLabel}</span>?
          </p>

          {requiresPin ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 space-y-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={18} className="text-red-600 shrink-0 mt-0.5" aria-hidden />
                <p className="text-sm font-medium text-red-800 leading-snug">
                  Esta transacción ya sumó al saldo confirmado. Para revertirla o cambiar su estado, ingresa el PIN de
                  autorización.
                </p>
              </div>
              <div>
                <label htmlFor="ledger-unconfirm-pin" className="block text-xs font-medium text-red-900 mb-1">
                  PIN de autorización
                </label>
                <input
                  id="ledger-unconfirm-pin"
                  type="password"
                  autoComplete="off"
                  value={pin}
                  onChange={(e) => {
                    setPin(e.target.value)
                    if (pinError) setPinError('')
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !confirming) {
                      e.preventDefault()
                      handleAccept()
                    }
                  }}
                  disabled={confirming}
                  className={`w-full px-3 py-2 text-sm border rounded-xl text-gray-800 focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-500 ${
                    pinError ? 'border-red-400 bg-red-50/50' : 'border-red-200 bg-white'
                  }`}
                  placeholder="Ingresa el PIN"
                />
                {pinError ? <p className="mt-1.5 text-xs font-medium text-red-700">{pinError}</p> : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-4 border-t border-gray-100 bg-slate-50/50">
          <button
            type="button"
            onClick={onClose}
            disabled={confirming}
            className="px-4 py-2 rounded-xl text-sm font-medium text-gray-700 border border-gray-200 bg-white hover:bg-gray-50 disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleAccept}
            disabled={confirming}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-40"
          >
            {confirming ? <Loader2 size={16} className="animate-spin shrink-0" aria-hidden /> : null}
            Aceptar
          </button>
        </div>
      </div>
    </div>
  )
}
