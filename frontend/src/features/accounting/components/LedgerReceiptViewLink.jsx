import { Eye } from 'lucide-react'
import { ledgerReceiptIsPdf, receiptAbsoluteUrl } from '../ledgerReceiptUtils'

/**
 * Botón «Ver» para abrir comprobante (imagen o PDF) en nueva pestaña.
 */
export default function LedgerReceiptViewLink({ receiptUrl, compact = false }) {
  const href = receiptUrl ? receiptAbsoluteUrl(receiptUrl) : null

  if (!href) {
    return <span className="text-gray-400 text-sm tabular-nums">—</span>
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={
        ledgerReceiptIsPdf(receiptUrl)
          ? 'Abrir comprobante PDF en nueva pestaña'
          : 'Abrir comprobante en nueva pestaña'
      }
      title="Ver comprobante"
      className={`inline-flex items-center gap-1 font-semibold rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 ring-1 ring-slate-200 transition-colors ${
        compact ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-xs'
      }`}
    >
      <Eye size={compact ? 12 : 13} aria-hidden />
      Ver
    </a>
  )
}
