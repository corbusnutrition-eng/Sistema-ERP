import { useMemo } from 'react'
import { Clock, Loader2, X } from 'lucide-react'
import { formatSaleLedgerDateParts } from '../../sales/saleTableHelpers'

function formatMoney(n, currency) {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(n) || 0)
  } catch {
    return `${Number(n || 0).toFixed(2)} ${currency}`
  }
}

function pendingPayeeLabel(line) {
  const name = String(line?.client_name ?? '').trim()
  if (name) return name
  const user = String(line?.iptv_username ?? '').trim()
  if (user) return user
  return '—'
}

function pendingAmount(line) {
  const raw = line?.charge_amount ?? line?.deposit
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Bandeja de transferencias interbancarias pendientes de acreditación.
 *
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {Array} transactions — líneas del libro mayor de la cuenta
 * @param {string} [currency]
 * @param {(lineId: number) => void | Promise<void>} onConfirm
 * @param {number | null} [confirmingLineId]
 */
export default function PendingInterbankModal({
  open,
  onClose,
  transactions = [],
  currency = 'USD',
  onConfirm,
  confirmingLineId = null,
}) {
  const pendingTxs = useMemo(
    () =>
      (Array.isArray(transactions) ? transactions : []).filter(
        (tx) => String(tx.verification_status ?? '').toLowerCase() === 'interbank',
      ),
    [transactions],
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center p-4 sm:p-6">
      <button type="button" className="absolute inset-0 bg-black/45" aria-label="Cerrar" onClick={onClose} />

      <div
        role="dialog"
        aria-labelledby="pending-interbank-title"
        className="relative w-full max-w-2xl max-h-[min(88vh,720px)] flex flex-col rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden"
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100 shrink-0 bg-amber-50/60">
          <div className="flex items-start gap-3 min-w-0">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
              <Clock size={18} aria-hidden />
            </div>
            <div className="min-w-0">
              <h2 id="pending-interbank-title" className="text-base font-semibold text-gray-900">
                Transferencias interbancarias pendientes
              </h2>
              <p className="text-xs text-amber-900/80 mt-0.5">
                Acreditaciones en tránsito que aún no aparecen en el estado de cuenta del banco.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="p-1.5 rounded-lg text-gray-400 hover:bg-white/80 shrink-0"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {pendingTxs.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <p className="text-sm text-gray-500">
                No hay transferencias interbancarias pendientes de acreditación.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-slate-50/80">
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                      Fecha
                    </th>
                    <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                      Beneficiario / usuario
                    </th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                      Monto
                    </th>
                    <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-slate-600 w-[8.5rem]">
                      Acción
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {pendingTxs.map((line) => {
                    const lineId = line.ledger_transaction_id
                    const { dateLine, timeLine } = formatSaleLedgerDateParts(line.occurred_at)
                    const amt = pendingAmount(line)
                    const saving = confirmingLineId != null && confirmingLineId === lineId

                    return (
                      <tr key={lineId ?? `${line.occurred_at}-${line.reference_number}`} className="hover:bg-slate-50/50">
                        <td className="px-4 py-3 align-top whitespace-nowrap">
                          <div className="text-gray-900">{dateLine}</div>
                          {timeLine ? <div className="text-xs text-gray-400 tabular-nums">{timeLine}</div> : null}
                        </td>
                        <td className="px-4 py-3 align-top min-w-0">
                          <div className="font-medium text-gray-900 truncate" title={pendingPayeeLabel(line)}>
                            {pendingPayeeLabel(line)}
                          </div>
                          {line.transaction_reason?.trim() ? (
                            <div className="text-xs text-gray-500 truncate mt-0.5" title={line.transaction_reason}>
                              {line.transaction_reason}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 align-top text-right tabular-nums font-medium text-gray-900 whitespace-nowrap">
                          {amt != null ? formatMoney(amt, currency) : '—'}
                        </td>
                        <td className="px-4 py-3 align-top text-right">
                          <button
                            type="button"
                            disabled={lineId == null || saving || confirmingLineId != null}
                            onClick={() => onConfirm?.(lineId)}
                            className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                          >
                            {saving ? <Loader2 size={13} className="animate-spin shrink-0" aria-hidden /> : null}
                            ✅ Confirmar
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {pendingTxs.length > 0 ? (
          <div className="px-5 py-3 border-t border-gray-100 bg-slate-50/50 shrink-0">
            <p className="text-xs text-gray-500">
              {pendingTxs.length === 1
                ? '1 transferencia pendiente de acreditación.'
                : `${pendingTxs.length} transferencias pendientes de acreditación.`}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
