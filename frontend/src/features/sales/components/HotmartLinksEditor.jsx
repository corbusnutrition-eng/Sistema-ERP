import { ImageIcon } from 'lucide-react'
import {
  emptyHotmartLinkRow,
  formatPaymentLinkAmount,
  isCustomPaymentLinkBlock,
} from '../../../utils/hotmartLinks'

const READONLY_INPUT_CLASS =
  'w-full rounded-md border border-gray-200 bg-gray-100 px-2.5 py-2 text-sm text-gray-500 cursor-not-allowed focus:border-gray-200 focus:outline-none focus:ring-0 read-only:bg-gray-100 read-only:cursor-not-allowed read-only:text-gray-500 disabled:opacity-60'

function CustomBlockReadOnlySummary({ row, currencyCode, index }) {
  const text = String(row?.text ?? '').trim()
  const imageUrl = String(row?.image_url ?? row?.imagePreview ?? '').trim()
  const url = String(row?.url ?? '').trim()
  const amountLabel =
    row?.amount != null && String(row.amount).trim() !== ''
      ? formatPaymentLinkAmount(row.amount, currencyCode)
      : null

  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/70 px-3 py-2.5">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-violet-800">
        Bloque personalizado #{index + 1}
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
        <ImageIcon size={14} className="shrink-0 text-violet-500" aria-hidden />
        {imageUrl ? (
          <img src={imageUrl} alt="" className="h-10 w-10 rounded border border-gray-200 object-cover" />
        ) : (
          <span className="text-gray-400">Sin imagen</span>
        )}
        {text ? <span className="text-gray-700">· {text}</span> : null}
        {url ? <span className="truncate text-gray-500">· {url}</span> : null}
        {amountLabel ? <span className="font-medium tabular-nums text-gray-800">· {amountLabel}</span> : null}
      </div>
    </div>
  )
}

/**
 * Vista de bloques de cobro para ventas y recargas BaaS (solo lectura).
 */
export default function HotmartLinksEditor({
  rows = [],
  onChange,
  disabled = false,
  currencyCode = 'USD',
  className = '',
}) {
  const list = Array.isArray(rows) && rows.length ? rows : [emptyHotmartLinkRow()]
  const hasCustom = list.some(isCustomPaymentLinkBlock)

  return (
    <div className={`rounded-lg border border-orange-200 bg-orange-50/60 p-3 ${className}`.trim()}>
      <p className="text-sm font-medium text-orange-950 mb-0.5">
        {list.length > 1 ? 'Bloques de cobro' : 'Bloque de cobro'}
      </p>
      <p className="text-[11px] text-orange-900/80 mb-3 leading-snug">
        Los bloques se autocompletan desde el Gestor. Para modificarlos, ve a Informes {'>'} Administrar Listas {'>'}{' '}
        Links de pago.
      </p>
      <div className="space-y-2.5">
        {list.map((row, index) =>
          isCustomPaymentLinkBlock(row) ? (
            <CustomBlockReadOnlySummary key={row.id} row={row} currencyCode={currencyCode} index={index} />
          ) : (
            <div key={row.id} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor={`hm-url-${row.id}`}>
                  URL{list.length > 1 ? ` #${index + 1}` : ''}
                </label>
                <input
                  id={`hm-url-${row.id}`}
                  type="url"
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
                  value={row.amount}
                  readOnly
                  disabled={disabled}
                  aria-readonly="true"
                  tabIndex={-1}
                  className={`${READONLY_INPUT_CLASS} tabular-nums`}
                />
              </div>
            </div>
          ),
        )}
      </div>
      {hasCustom ? (
        <p className="mt-2 mb-0 text-[10px] text-orange-900/70">
          Los bloques personalizados se muestran al cliente en el portal con imagen, texto y botón de pago según
          configuración.
        </p>
      ) : null}
    </div>
  )
}
