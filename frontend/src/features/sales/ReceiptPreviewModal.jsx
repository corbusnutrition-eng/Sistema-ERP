import { ExternalLink, X } from 'lucide-react'
import { saleReceiptHref } from './saleTableHelpers'

export function receiptIsPdf(sale) {
  return String(sale?.receipt_url || '')
    .toLowerCase()
    .endsWith('.pdf')
}

/** Vista previa de comprobante (imagen o PDF) — misma UX que la tabla de Ventas. */
export function ReceiptPreviewModal({ sale, onClose }) {
  if (!sale?.receipt_url) return null
  const url = saleReceiptHref(sale)
  if (!url) return null
  const pdf = receiptIsPdf(sale)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-sm font-bold text-gray-900">Comprobante de pago</h2>
            <p className="text-xs text-gray-500 mt-0.5">{sale.client_name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 flex flex-col items-stretch gap-3">
          {pdf ? (
            <iframe
              src={url}
              title="Comprobante PDF"
              className="w-full h-[min(70vh,420px)] rounded-xl border border-gray-100 bg-gray-50"
            />
          ) : (
            <img
              src={url}
              alt="Comprobante"
              className="w-full max-h-72 object-contain rounded-xl border border-gray-100 bg-gray-50"
            />
          )}

          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 py-2.5 text-sm font-medium text-blue-700
                       bg-blue-50 hover:bg-blue-100 rounded-xl ring-1 ring-blue-200 transition-colors"
          >
            <ExternalLink size={15} />
            Abrir en nueva pestaña
          </a>
        </div>
      </div>
    </div>
  )
}
