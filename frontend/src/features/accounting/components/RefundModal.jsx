import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import SearchableSelect from '../../../components/ui/SearchableSelect'
import { todayIsoDateEcuador } from '../../../utils/datetime'

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-xl text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500'

/**
 * Reembolso a cliente (solo UI). El backend se conectará en un siguiente paso.
 *
 * @param {Array<{ id: number, name?: string, username?: string, email?: string }>} clients
 * @param {() => void} onClose
 */
export default function RefundModal({ clients, onClose }) {
  const [clientId, setClientId] = useState('')
  const [amount, setAmount] = useState('')
  const [txnDate, setTxnDate] = useState(todayIsoDateEcuador)
  const [notes, setNotes] = useState('')

  function handleSave(e) {
    e.preventDefault()
    console.log('[RefundModal] Guardar (stub)', {
      client_id: clientId ? Number(clientId) : null,
      monto: amount,
      fecha: txnDate,
      notas: notes.trim(),
    })
    onClose?.()
  }

  const list = Array.isArray(clients) ? clients : []

  const clientRefundOptions = useMemo(
    () =>
      list.map((c) => ({
        value: String(c.id),
        label:
          (c.name || '').trim() || c.username || c.email || `Cliente #${c.id}`,
      })),
    [list],
  )

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/45" aria-label="Cerrar" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">Reembolso</h2>
          <button type="button" className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSave} className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Cliente</label>
            <SearchableSelect
              value={clientId}
              onChange={(v) => setClientId(String(v))}
              options={clientRefundOptions}
              placeholder="Selecciona cliente…"
              clearLabel="Selecciona cliente…"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Monto a reembolsar</label>
            <input
              type="number"
              min="0.01"
              step="any"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={inputCls}
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Fecha</label>
            <input type="date" required value={txnDate} onChange={(e) => setTxnDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Notas</label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={`${inputCls} resize-y min-h-[4rem]`}
              placeholder="Motivo u observaciones…"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-600 rounded-xl bg-gray-100 hover:bg-gray-200"
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="px-4 py-2 text-sm font-semibold text-white rounded-xl bg-rose-600 hover:bg-rose-700"
            >
              Guardar
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
