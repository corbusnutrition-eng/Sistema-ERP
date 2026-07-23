import { emptyHotmartLinkRow } from '../../../utils/hotmartLinks'

/**
 * Editor de link Hotmart (URL + monto) para ventas y recargas BaaS.
 * Una sola fila; el payload al backend sigue siendo un array de un objeto.
 */
export default function HotmartLinksEditor({
  rows = [],
  onChange,
  disabled = false,
  currencyCode = 'USD',
  className = '',
}) {
  const row = (Array.isArray(rows) && rows.length ? rows[0] : null) ?? emptyHotmartLinkRow()

  function updateRow(patch) {
    onChange?.([{ ...row, ...patch }])
  }

  return (
    <div className={`rounded-lg border border-orange-200 bg-orange-50/60 p-3 ${className}`.trim()}>
      <p className="text-sm font-medium text-orange-950 mb-0.5">Link de pago Hotmart</p>
      <p className="text-[11px] text-orange-900/80 mb-3 leading-snug">
        El cliente verá este enlace al elegir un método Hotmart en su portal.
      </p>
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor={`hm-url-${row.id}`}>
            URL
          </label>
          <input
            id={`hm-url-${row.id}`}
            type="url"
            inputMode="url"
            placeholder="https://pay.hotmart.com/..."
            value={row.url}
            disabled={disabled}
            onChange={(e) => updateRow({ url: e.target.value })}
            className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-sm focus:border-orange-400 focus:ring-orange-400 disabled:bg-gray-100"
          />
        </div>
        <div className="w-full shrink-0 sm:w-28">
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
            onChange={(e) => updateRow({ amount: e.target.value })}
            className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-sm tabular-nums focus:border-orange-400 focus:ring-orange-400 disabled:bg-gray-100"
          />
        </div>
      </div>
    </div>
  )
}
