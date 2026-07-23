import { emptyHotmartLinkRow } from '../../../utils/hotmartLinks'

const READONLY_INPUT_CLASS =
  'w-full rounded-md border border-gray-200 bg-gray-100 px-2.5 py-2 text-sm text-gray-500 cursor-not-allowed focus:border-gray-200 focus:outline-none focus:ring-0 read-only:bg-gray-100 read-only:cursor-not-allowed read-only:text-gray-500 disabled:opacity-60'

/**
 * Vista de links Hotmart (URL + monto) para ventas y recargas BaaS.
 * Solo lectura: los valores se autocompletan desde el Gestor de Links.
 */
export default function HotmartLinksEditor({
  rows = [],
  onChange,
  disabled = false,
  currencyCode = 'USD',
  className = '',
}) {
  const list = Array.isArray(rows) && rows.length ? rows : [emptyHotmartLinkRow()]

  return (
    <div className={`rounded-lg border border-orange-200 bg-orange-50/60 p-3 ${className}`.trim()}>
      <p className="text-sm font-medium text-orange-950 mb-0.5">
        {list.length > 1 ? 'Links de pago Hotmart' : 'Link de pago Hotmart'}
      </p>
      <p className="text-[11px] text-orange-900/80 mb-3 leading-snug">
        Los links se autocompletan desde el Gestor. Para modificarlos, ve a Informes {'>'} Administrar
        Listas {'>'} Links de pago.
      </p>
      <div className="space-y-2.5">
        {list.map((row, index) => (
          <div key={row.id} className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor={`hm-url-${row.id}`}>
                URL{list.length > 1 ? ` #${index + 1}` : ''}
              </label>
              <input
                id={`hm-url-${row.id}`}
                type="url"
                inputMode="url"
                placeholder="https://pay.hotmart.com/..."
                value={row.url}
                readOnly
                disabled={disabled}
                aria-readonly="true"
                tabIndex={-1}
                className={READONLY_INPUT_CLASS}
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
                readOnly
                disabled={disabled}
                aria-readonly="true"
                tabIndex={-1}
                className={`${READONLY_INPUT_CLASS} tabular-nums`}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
