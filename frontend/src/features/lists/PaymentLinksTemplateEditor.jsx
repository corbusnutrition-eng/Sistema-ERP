import { Minus, Plus } from 'lucide-react'
import { emptyHotmartLinkRow } from '../../utils/hotmartLinks'

/**
 * Editor multi-fila de links (URL + monto) para plantillas en Listas.
 */
export default function PaymentLinksTemplateEditor({
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
    <div className={`space-y-2.5 ${className}`.trim()}>
      {list.map((row, index) => (
        <div key={row.id} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor={`tpl-url-${row.id}`}>
              URL{list.length > 1 ? ` #${index + 1}` : ''}
            </label>
            <input
              id={`tpl-url-${row.id}`}
              type="url"
              inputMode="url"
              placeholder="https://pay.hotmart.com/..."
              value={row.url}
              disabled={disabled}
              onChange={(e) => updateRow(row.id, { url: e.target.value })}
              className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-sm focus:border-emerald-500 focus:ring-emerald-500 disabled:bg-gray-100"
            />
          </div>
          <div className="w-full shrink-0 sm:w-28">
            <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor={`tpl-amt-${row.id}`}>
              Valor ({currencyCode})
            </label>
            <input
              id={`tpl-amt-${row.id}`}
              type="number"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              placeholder="0.00"
              value={row.amount}
              disabled={disabled}
              onChange={(e) => updateRow(row.id, { amount: e.target.value })}
              className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-sm tabular-nums focus:border-emerald-500 focus:ring-emerald-500 disabled:bg-gray-100"
            />
          </div>
          <div className="flex gap-1 sm:pb-0.5">
            <button
              type="button"
              disabled={disabled}
              onClick={addRow}
              title="Añadir otro link"
              aria-label="Añadir otro link"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            >
              <Plus size={16} aria-hidden />
            </button>
            <button
              type="button"
              disabled={disabled || list.length <= 1}
              onClick={() => removeRow(row.id)}
              title="Eliminar fila"
              aria-label="Eliminar link"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              <Minus size={16} aria-hidden />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
