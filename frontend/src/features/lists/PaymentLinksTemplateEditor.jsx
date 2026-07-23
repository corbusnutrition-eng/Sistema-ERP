import { FileText, ImageIcon, Loader2, Plus, Trash2, Video } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import PaymentLinkImageCropModal from './PaymentLinkImageCropModal'
import {
  emptyCustomHotmartLinkRow,
  emptyHotmartLinkRow,
  inferPaymentLinkMediaType,
  isCustomPaymentLinkBlock,
  uploadPaymentLinkMedia,
} from '../../utils/hotmartLinks'

const DELETE_ROW_CONFIRM = '¿Estás seguro de que deseas eliminar este bloque de cobro?'
const DELETE_FILE_CONFIRM_1 = '¿Eliminar el archivo adjunto de este bloque?'
const DELETE_FILE_CONFIRM_2 =
  'El archivo se quitará del bloque. Debes guardar la plantilla para aplicar el cambio. ¿Continuar?'

const ACCEPTED_MEDIA = 'image/*,video/*,application/pdf'

function StandardLinkRow({ row, index, listLength, disabled, currencyCode, onUpdate, onAdd, onRemove }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1">
        <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor={`tpl-url-${row.id}`}>
          URL{listLength > 1 ? ` #${index + 1}` : ''}
        </label>
        <input
          id={`tpl-url-${row.id}`}
          type="url"
          inputMode="url"
          placeholder="https://pay.hotmart.com/..."
          value={row.url}
          disabled={disabled}
          onChange={(e) => onUpdate(row.id, { url: e.target.value })}
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
          onChange={(e) => onUpdate(row.id, { amount: e.target.value })}
          className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-sm tabular-nums focus:border-emerald-500 focus:ring-emerald-500 disabled:bg-gray-100"
        />
      </div>
      <RowActions disabled={disabled} onAdd={onAdd} onRemove={() => onRemove(row.id)} />
    </div>
  )
}

function CustomLinkRow({ row, index, disabled, currencyCode, api, onUpdate, onAdd, onRemove }) {
  const fileInputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')
  const [cropSession, setCropSession] = useState(null)

  const mediaUrl = String(row.imagePreview || row.image_url || '').trim()
  const mediaType = inferPaymentLinkMediaType(row)
  const hasMedia = Boolean(mediaUrl)

  useEffect(
    () => () => {
      if (cropSession?.src) URL.revokeObjectURL(cropSession.src)
    },
    [cropSession?.src],
  )

  function closeCropSession() {
    setCropSession((prev) => {
      if (prev?.src) URL.revokeObjectURL(prev.src)
      return null
    })
  }

  async function uploadMediaFile(file) {
    if (!file || disabled) return
    setUploadErr('')
    setUploading(true)
    try {
      const { url, media_type } = await uploadPaymentLinkMedia(api, file)
      onUpdate(row.id, { image_url: url, imagePreview: url, media_type })
    } catch (err) {
      setUploadErr(err?.response?.data?.detail || err?.message || 'No se pudo subir el archivo.')
    } finally {
      setUploading(false)
    }
  }

  function handleMediaPick(file) {
    if (!file || disabled) return
    const isImage = /^image\//i.test(file.type || '')
    const isVideo = /^video\//i.test(file.type || '')
    const isPdf = file.type === 'application/pdf'
    if (!isImage && !isVideo && !isPdf) {
      setUploadErr('Solo imágenes, videos (MP4, WEBM, MOV) o PDF.')
      return
    }
    setUploadErr('')
    if (isImage) {
      setCropSession((prev) => {
        if (prev?.src) URL.revokeObjectURL(prev.src)
        return {
          src: URL.createObjectURL(file),
          fileName: file.name || 'imagen.jpg',
          mimeType: file.type || 'image/jpeg',
        }
      })
      return
    }
    void uploadMediaFile(file)
  }

  async function handleCropApply(croppedFile) {
    closeCropSession()
    await uploadMediaFile(croppedFile)
  }

  function requestRemoveMedia() {
    if (!hasMedia || disabled) return
    if (!window.confirm(DELETE_FILE_CONFIRM_1)) return
    if (!window.confirm(DELETE_FILE_CONFIRM_2)) return
    onUpdate(row.id, { image_url: '', imagePreview: null, media_type: '' })
    setUploadErr('')
  }

  function triggerChangeMedia() {
    if (disabled || uploading) return
    fileInputRef.current?.click()
  }

  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-violet-800">
          Bloque personalizado #{index + 1}
        </p>
        <RowActions disabled={disabled} onAdd={onAdd} onRemove={() => onRemove(row.id)} compact />
      </div>

      <div>
        <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor={`tpl-text-${row.id}`}>
          Texto descriptivo
        </label>
        <textarea
          id={`tpl-text-${row.id}`}
          rows={2}
          placeholder="Instrucciones o descripción para el cliente…"
          value={row.text}
          disabled={disabled}
          onChange={(e) => onUpdate(row.id, { text: e.target.value })}
          className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-sm focus:border-violet-500 focus:ring-violet-500 disabled:bg-gray-100"
        />
      </div>

      <div>
        <label className="block text-[11px] font-medium text-gray-600 mb-1">Archivo multimedia</label>
        <div className="flex flex-wrap items-start gap-3">
          {hasMedia ? (
            <MediaPreview url={mediaUrl} mediaType={mediaType} />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-gray-300 bg-white text-gray-400">
              <ImageIcon size={20} aria-hidden />
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-2">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_MEDIA}
              disabled={disabled || uploading}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                void handleMediaPick(f)
                e.target.value = ''
              }}
            />
            {hasMedia ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={disabled || uploading}
                  onClick={triggerChangeMedia}
                  className="rounded-md border border-violet-300 bg-white px-3 py-1.5 text-xs font-medium text-violet-800 hover:bg-violet-50 disabled:opacity-50"
                >
                  Cambiar archivo
                </button>
                <button
                  type="button"
                  disabled={disabled || uploading}
                  onClick={requestRemoveMedia}
                  className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  Eliminar archivo
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={disabled || uploading}
                onClick={triggerChangeMedia}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Subir imagen, video o PDF
              </button>
            )}
            {uploading ? (
              <p className="flex items-center gap-1 text-xs text-gray-500">
                <Loader2 size={12} className="animate-spin" aria-hidden />
                Subiendo archivo…
              </p>
            ) : null}
            {uploadErr ? <p className="text-xs text-red-600">{uploadErr}</p> : null}
            <p className="text-[10px] text-gray-500">Formatos: JPG, PNG, GIF, WEBP, MP4, WEBM, MOV, PDF (máx. 10 MB).</p>
          </div>
        </div>
      </div>

      {cropSession ? (
        <PaymentLinkImageCropModal
          imageSrc={cropSession.src}
          fileName={cropSession.fileName}
          mimeType={cropSession.mimeType}
          onCancel={closeCropSession}
          onApply={handleCropApply}
        />
      ) : null}

      <div className="grid gap-2 sm:grid-cols-[1fr_7rem]">
        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor={`tpl-curl-${row.id}`}>
            URL de pago
          </label>
          <input
            id={`tpl-curl-${row.id}`}
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={row.url}
            disabled={disabled}
            onChange={(e) => onUpdate(row.id, { url: e.target.value })}
            className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-sm focus:border-violet-500 focus:ring-violet-500 disabled:bg-gray-100"
          />
        </div>
        <div>
          <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor={`tpl-camt-${row.id}`}>
            Valor ({currencyCode})
          </label>
          <input
            id={`tpl-camt-${row.id}`}
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            placeholder="0.00"
            value={row.amount}
            disabled={disabled}
            onChange={(e) => onUpdate(row.id, { amount: e.target.value })}
            className="w-full rounded-md border border-gray-300 px-2.5 py-2 text-sm tabular-nums focus:border-violet-500 focus:ring-violet-500 disabled:bg-gray-100"
          />
        </div>
      </div>
    </div>
  )
}

function MediaPreview({ url, mediaType }) {
  if (mediaType === 'video') {
    return (
      <div className="flex h-20 w-28 items-center justify-center rounded-md border border-gray-200 bg-black/90">
        <Video size={22} className="text-violet-200" aria-hidden />
      </div>
    )
  }
  if (mediaType === 'pdf') {
    return (
      <div className="flex h-20 w-28 flex-col items-center justify-center gap-1 rounded-md border border-gray-200 bg-white px-2">
        <FileText size={22} className="text-red-600" aria-hidden />
        <span className="text-[10px] font-medium text-gray-600">PDF</span>
      </div>
    )
  }
  return (
    <img
      src={url}
      alt=""
      className="h-20 w-20 rounded-md border border-gray-200 object-cover bg-white"
    />
  )
}

function RowActions({ disabled, onAdd, onRemove, compact = false }) {
  return (
    <div className={`flex gap-1 ${compact ? '' : 'sm:pb-0.5'}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={onAdd}
        title="Añadir otro link"
        aria-label="Añadir otro link"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
      >
        <Plus size={16} aria-hidden />
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        title="Eliminar este bloque"
        aria-label="Eliminar este bloque"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-400 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 transition-colors"
      >
        <Trash2 size={16} aria-hidden />
      </button>
    </div>
  )
}

function EmptyActions({ disabled, onAddStandard, onAddCustom }) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        disabled={disabled}
        onClick={onAddStandard}
        className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
      >
        <Plus size={16} aria-hidden />
        Añadir link
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={onAddCustom}
        className="inline-flex items-center gap-2 rounded-lg border border-violet-300 bg-white px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50"
      >
        <Plus size={16} aria-hidden />
        Añadir bloque personalizado
      </button>
    </div>
  )
}

/**
 * Editor multi-fila de links y bloques personalizados para plantillas en Listas.
 */
export default function PaymentLinksTemplateEditor({
  rows = [],
  onChange,
  disabled = false,
  currencyCode = 'USD',
  className = '',
  api = null,
}) {
  const list = Array.isArray(rows) ? rows : []

  function updateRow(rowId, patch) {
    onChange?.(list.map((r) => (r.id === rowId ? { ...r, ...patch } : r)))
  }

  function addStandardRow() {
    onChange?.([...list, emptyHotmartLinkRow()])
  }

  function addCustomRow() {
    onChange?.([...list, emptyCustomHotmartLinkRow()])
  }

  function requestRemoveRow(rowId) {
    if (!window.confirm(DELETE_ROW_CONFIRM)) return
    onChange?.(list.filter((r) => r.id !== rowId))
  }

  if (!list.length) {
    return (
      <div className={`rounded-lg border border-dashed border-gray-200 bg-gray-50/80 p-4 ${className}`.trim()}>
        <p className="text-sm text-gray-600 mb-3">
          No hay links configurados. Al guardar se eliminará la plantilla de esta combinación.
        </p>
        <EmptyActions disabled={disabled} onAddStandard={addStandardRow} onAddCustom={addCustomRow} />
      </div>
    )
  }

  return (
    <div className={`space-y-3 ${className}`.trim()}>
      {list.map((row, index) =>
        isCustomPaymentLinkBlock(row) ? (
          <CustomLinkRow
            key={row.id}
            row={row}
            index={index}
            disabled={disabled}
            currencyCode={currencyCode}
            api={api}
            onUpdate={updateRow}
            onAdd={addStandardRow}
            onRemove={requestRemoveRow}
          />
        ) : (
          <StandardLinkRow
            key={row.id}
            row={row}
            index={index}
            listLength={list.length}
            disabled={disabled}
            currencyCode={currencyCode}
            onUpdate={updateRow}
            onAdd={addStandardRow}
            onRemove={requestRemoveRow}
          />
        ),
      )}
      <EmptyActions disabled={disabled} onAddStandard={addStandardRow} onAddCustom={addCustomRow} />
    </div>
  )
}
