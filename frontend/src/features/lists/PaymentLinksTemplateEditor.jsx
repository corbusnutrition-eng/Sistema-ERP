import { ImageIcon, Loader2, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import {
  emptyCustomHotmartLinkRow,
  emptyHotmartLinkRow,
  isCustomPaymentLinkBlock,
  uploadPaymentLinkImage,
} from '../../utils/hotmartLinks'

const DELETE_ROW_CONFIRM = '¿Estás seguro de que deseas eliminar este link de pago?'

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
  const [uploading, setUploading] = useState(false)
  const [uploadErr, setUploadErr] = useState('')

  async function handleImagePick(file) {
    if (!file || disabled) return
    const ok = /^image\/(jpeg|png|gif|webp)$/i.test(file.type || '')
    if (!ok) {
      setUploadErr('Solo JPG, PNG, GIF o WEBP.')
      return
    }
    setUploadErr('')
    setUploading(true)
    try {
      const url = await uploadPaymentLinkImage(api, file)
      onUpdate(row.id, { image_url: url, imagePreview: url })
    } catch (err) {
      setUploadErr(err?.response?.data?.detail || err?.message || 'No se pudo subir la imagen.')
    } finally {
      setUploading(false)
    }
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
        <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor={`tpl-img-${row.id}`}>
          Imagen
        </label>
        <div className="flex flex-wrap items-center gap-3">
          {row.imagePreview || row.image_url ? (
            <img
              src={row.imagePreview || row.image_url}
              alt=""
              className="h-16 w-16 rounded-md border border-gray-200 object-cover bg-white"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-md border border-dashed border-gray-300 bg-white text-gray-400">
              <ImageIcon size={20} aria-hidden />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <input
              id={`tpl-img-${row.id}`}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              disabled={disabled || uploading}
              onChange={(e) => {
                const f = e.target.files?.[0]
                void handleImagePick(f)
                e.target.value = ''
              }}
              className="block w-full text-xs text-gray-600 file:mr-3 file:rounded-md file:border-0 file:bg-violet-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-violet-800"
            />
            {uploading ? (
              <p className="mt-1 flex items-center gap-1 text-xs text-gray-500">
                <Loader2 size={12} className="animate-spin" aria-hidden />
                Subiendo imagen…
              </p>
            ) : null}
            {uploadErr ? <p className="mt-1 text-xs text-red-600">{uploadErr}</p> : null}
          </div>
        </div>
      </div>

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
