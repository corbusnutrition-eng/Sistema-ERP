import { Minus, Plus } from 'lucide-react'
import { emptyHotmartLinkRow } from '../../../utils/hotmartLinks'

/**
 * Editor de links Hotmart dinámicos (URL + monto) para ventas y recargas BaaS.
 */
export default function HotmartLinksEditor({
  rows = [],
  onChange,
  disabled = false,
  currencyCode = 'USD',
  className = '',
}) {
  const list = Array.isArray(rows) && rows.length ? rows : [emptyHotmartLinkRow()]

  function updateRow(rowId, patch) {
    onChange?.(list.map((r) => (r.id === rowId ? { ...r, ...patch } : r)))
  }

  function addRow() {
    onChange?.([...list, emptyHotmartLinkRow()])
  }

  function removeRow(rowId) {
    const next = list.filter((r) => r.id !== rowId)
    onChange?.(next.length ? next : [emptyHotmartLinkRow()])
  }

  return (
    <div className={`rounded-lg border border-orange-200 bg-orange-50/60 p-3 ${className}`.trim()}>
      <p className="text-sm font-medium text-orange-950 mb-0.5">Links de pago Hotmart</p>
      <p className="text-[11px] text-orange-900/80 mb-3 leading-snug">
        Añade uno o más enlaces de pago. El cliente los verá al elegir un método Hotmart en su portal.
      </p>
      <div className="space-y-2.5">
        {list.map((row, index) => (
          <div key={row.id} className="grid grid-cols-1 sm:grid-cols-[1fr_8rem_auto] gap-2 items-end">
            <div>
              <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor={`hm-url-${row.id}`}>
                URL de pago {list.length > 1 ? `#${index + 1}` : ''}
              </label>
              <input
                id={`hm-url-${row.id}`}
                type="url"
                inputMode="url"
                placeholder="https://pay.hotmart.com/..."
                value={row.url}
                disabled={disabled}
                onChange={(e) => updateRow(row.id, { url: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-sm focus:border-orange-400 focus:ring-orange-400 disabled:bg-gray-100"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor={`hm-amt-${row.id}`}>
                Valor ({currencyCode})
              </label>
              <input
                id={`hm-amt-${row.id}`}
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                placeholder="0.00"
                value={row.amount}
                disabled={disabled}
                onChange={(e) => updateRow(row.id, { amount: e.target.value })}
                className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-sm tabular-nums focus:border-orange-400 focus:ring-orange-400 disabled:bg-gray-100"
              />
            </div>
            <div className="flex gap-1 sm:pb-0.5">
              <button
                type="button"
                disabled={disabled}
                onClick={addRow}
                title="Añadir otro link"
                aria-label="Añadir otro link Hotmart"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-orange-300 bg-white text-orange-700 hover:bg-orange-100 disabled:opacity-50"
              >
                <Plus size={16} aria-hidden />
              </button>
              <button
                type="button"
                disabled={disabled || list.length <= 1}
                onClick={() => removeRow(row.id)}
                title="Eliminar fila"
                aria-label="Eliminar link Hotmart"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                <Minus size={16} aria-hidden />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
