import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'

/**
 * Recuadro arrastrar/soltar para una imagen (logotipo). Controlado por `file`.
 */
export default function ImageDropZone({
  file,
  onFileChange,
  disabled = false,
  accept = 'image/jpeg,image/png,image/gif,image/webp',
  hint = 'PNG, JPG, GIF o WEBP · máx. 10 MB',
  /** URL absoluta para mostrar logotipo ya guardado (modo edición). */
  remotePreviewUrl = null,
  /** Al quitar vista previa remota (sin archivo nuevo). */
  onClearRemote = null,
}) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const [preview, setPreview] = useState(null)

  useEffect(() => {
    if (!file) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const circleImgSrc = preview || (!file && remotePreviewUrl ? remotePreviewUrl : null)
  const showClearRow = Boolean(file || remotePreviewUrl)

  function handleClear(e) {
    e.stopPropagation()
    if (file) {
      onFileChange?.(null)
    } else if (remotePreviewUrl) {
      onClearRemote?.()
    }
  }

  const pickFiles = useCallback(
    (list) => {
      if (!list?.length || disabled) return
      const f = list[0]
      if (!f || !/^image\/(jpeg|png|gif|webp)$/i.test(f.type)) return
      onFileChange?.(f)
    },
    [disabled, onFileChange],
  )

  const onInputChange = useCallback(
    (e) => {
      pickFiles(e.target.files)
      e.target.value = ''
    },
    [pickFiles],
  )

  const onDrop = useCallback(
    (e) => {
      e.preventDefault()
      setDragOver(false)
      pickFiles(e.dataTransfer.files)
    },
    [pickFiles],
  )

  const onDragOver = useCallback((e) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const onDragLeave = useCallback(() => setDragOver(false), [])

  return (
    <div className="space-y-1.5">
      <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={onInputChange} disabled={disabled} />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        className={`relative w-full rounded-lg border-2 border-dashed px-3 py-4 text-left transition-colors ${
          dragOver ? 'border-emerald-500 bg-emerald-50/50' : 'border-gray-300 bg-gray-50/80 hover:bg-gray-50'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-gray-200 bg-white">
            {circleImgSrc ? (
              <img src={circleImgSrc} alt="" className="h-full w-full object-cover" />
            ) : (
              <ImagePlus size={22} className="text-gray-400" strokeWidth={1.75} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-800">
              Arrastra el logotipo aquí o haz clic para elegir
            </p>
            <p className="mt-0.5 text-[11px] text-gray-500">{hint}</p>
          </div>
        </div>
      </button>
      {showClearRow ? (
        <div className="flex items-center justify-between gap-2 text-xs text-gray-600">
          <span className="truncate font-medium">{file ? file.name : 'Logotipo actual'}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={handleClear}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-gray-500 hover:bg-gray-100 hover:text-gray-800"
          >
            <X size={14} />
            Quitar
          </button>
        </div>
      ) : null}
    </div>
  )
}
