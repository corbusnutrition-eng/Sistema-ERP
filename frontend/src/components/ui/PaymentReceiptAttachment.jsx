import { useEffect, useMemo } from 'react'
import { Eye, FileText, Trash2 } from 'lucide-react'
import { salesApiOrigin } from '../../features/sales/saleTableHelpers'

function receiptLooksPdf(file, urlPath) {
  if (file?.type === 'application/pdf') return true
  return String(urlPath || '')
    .toLowerCase()
    .endsWith('.pdf')
}

function absMediaUrl(urlPath) {
  if (!urlPath) return ''
  const s = String(urlPath).trim()
  if (!s || /^https?:\/\//i.test(s)) return s
  if (/^\/chat-media/i.test(s)) {
    const cat = 'https://catalogo-vip.onrender.com'.replace(/\/$/, '')
    return s.startsWith('/') ? `${cat}${s}` : `${cat}/${s}`
  }
  const origin = salesApiOrigin()
  return `${origin}${s.startsWith('/') ? '' : '/'}${s}`
}

/**
 * Visualizador / carga de comprobante (mismo diseño que ``NuevaVentaModal``).
 */
export default function PaymentReceiptAttachment({
  inputId = 'payment-receipt-input',
  existingReceiptUrl = '',
  existingReceiptCleared = false,
  receiptFile = null,
  onReceiptFileChange,
  onClearReceipt,
  disabled = false,
  addButtonLabel = 'Añadir archivo adjunto',
}) {
  const existingAbsUrl = useMemo(() => {
    if (existingReceiptCleared || !existingReceiptUrl) return ''
    return absMediaUrl(existingReceiptUrl)
  }, [existingReceiptCleared, existingReceiptUrl])

  const receiptBlobImgUrl = useMemo(() => {
    if (!receiptFile || receiptFile.type === 'application/pdf') return null
    return URL.createObjectURL(receiptFile)
  }, [receiptFile])

  useEffect(() => {
    return () => {
      if (receiptBlobImgUrl) URL.revokeObjectURL(receiptBlobImgUrl)
    }
  }, [receiptBlobImgUrl])

  const showPdfPreview =
    (receiptFile && receiptFile.type === 'application/pdf') ||
    (!receiptFile && existingAbsUrl && receiptLooksPdf(null, existingReceiptUrl))
  const showImagePreview =
    (receiptFile && receiptFile.type !== 'application/pdf') ||
    (!receiptFile && existingAbsUrl && !receiptLooksPdf(null, existingReceiptUrl))
  const hasPreview =
    receiptFile || (!existingReceiptCleared && Boolean(existingReceiptUrl))

  function onFileChosen(ev) {
    const f = ev.target.files?.[0]
    onReceiptFileChange?.(f ?? null)
    ev.target.value = ''
  }

  if (!hasPreview) {
    return (
      <div className="flex flex-col items-stretch gap-1">
        <input
          type="file"
          accept="image/*,.pdf,application/pdf"
          className="hidden"
          id={inputId}
          disabled={disabled}
          onChange={onFileChosen}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => document.getElementById(inputId)?.click()}
          className="w-full py-2.5 px-4 rounded-lg border border-blue-500 text-blue-600 text-sm font-medium
                     bg-white hover:bg-blue-50/80 transition-colors text-center disabled:opacity-50"
        >
          {addButtonLabel}
        </button>
        <p className="text-center text-[11px] text-gray-500">Tamaño máximo de archivo: 20 MB</p>
      </div>
    )
  }

  const imgSrc =
    receiptFile && receiptFile.type !== 'application/pdf'
      ? receiptBlobImgUrl
      : !receiptFile
        ? existingAbsUrl
        : null

  return (
    <div className="flex items-start gap-3">
      <input
        type="file"
        accept="image/*,.pdf,application/pdf"
        className="hidden"
        id={inputId}
        disabled={disabled}
        onChange={onFileChosen}
      />
      <div className="shrink-0">
        {showPdfPreview ?
          <div className="w-20 h-20 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center">
            <FileText size={36} className="text-red-600" aria-hidden />
          </div>
        : showImagePreview && imgSrc ?
          <img
            src={imgSrc}
            alt="Comprobante"
            className="w-20 h-20 object-cover rounded-lg border border-gray-200 bg-white"
          />
        : null}
      </div>
      <div className="flex flex-col gap-2 min-w-0 flex-1">
        {receiptFile ?
          <span className="text-xs text-gray-600 truncate" title={receiptFile.name}>
            {receiptFile.name}
          </span>
        : null}
        {!receiptFile && existingAbsUrl ?
          <span className="text-xs text-gray-500">Comprobante guardado</span>
        : null}
        <div className="flex flex-wrap items-center gap-2">
          {existingAbsUrl ?
            <a
              href={existingAbsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600
                         hover:text-blue-800 hover:bg-blue-50 px-2 py-1 rounded-lg transition-colors border border-blue-100"
            >
              <Eye size={14} aria-hidden />
              Ver comprobante
            </a>
          : null}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onClearReceipt?.()}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600
                       hover:text-red-700 hover:bg-red-50 px-2 py-1 rounded-lg transition-colors disabled:opacity-50"
          >
            <Trash2 size={14} aria-hidden />
            Eliminar
          </button>
        </div>
      </div>
    </div>
  )
}
