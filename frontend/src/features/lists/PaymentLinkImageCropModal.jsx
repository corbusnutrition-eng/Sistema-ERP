import { Loader2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useState } from 'react'
import Cropper from 'react-easy-crop'
import { getCroppedImageFile } from '../../utils/cropImage'

const ASPECT_OPTIONS = [
  { id: 'free', label: 'Libre', value: undefined },
  { id: '16:9', label: '16:9', value: 16 / 9 },
  { id: '4:3', label: '4:3', value: 4 / 3 },
  { id: '1:1', label: '1:1', value: 1 },
]

/**
 * Modal de recorte antes de subir imágenes de bloques personalizados al portal.
 */
export default function PaymentLinkImageCropModal({
  imageSrc,
  fileName = 'imagen.jpg',
  mimeType = 'image/jpeg',
  onCancel,
  onApply,
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [aspectId, setAspectId] = useState('free')
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')

  const aspect = ASPECT_OPTIONS.find((o) => o.id === aspectId)?.value

  const onCropComplete = useCallback((_croppedArea, croppedPixels) => {
    setCroppedAreaPixels(croppedPixels)
  }, [])

  async function handleApply() {
    if (!croppedAreaPixels) {
      setError('Ajusta el encuadre antes de aplicar.')
      return
    }
    setError('')
    setApplying(true)
    try {
      const file = await getCroppedImageFile(imageSrc, croppedAreaPixels, fileName, mimeType)
      await onApply?.(file)
    } catch (err) {
      setError(err?.message || 'No se pudo aplicar el recorte.')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={applying ? undefined : onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="crop-modal-title"
        className="relative flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-violet-200 bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h2 id="crop-modal-title" className="text-base font-semibold text-gray-900">
              Encuadrar imagen
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Arrastra para centrar, usa la rueda o el control de zoom. Solo se subirá el área recortada.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={applying}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 disabled:opacity-50"
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="relative h-[min(52vh,420px)] bg-slate-900">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={aspect}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
            objectFit="contain"
            showGrid
          />
        </div>

        <div className="space-y-4 border-t border-gray-100 px-5 py-4">
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">Proporción</p>
            <div className="flex flex-wrap gap-2">
              {ASPECT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  disabled={applying}
                  onClick={() => setAspectId(opt.id)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                    aspectId === opt.id
                      ? 'border-violet-500 bg-violet-50 text-violet-800'
                      : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Zoom</p>
              <span className="text-xs tabular-nums text-gray-600">{Math.round(zoom * 100)}%</span>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={applying || zoom <= 1}
                onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.1) * 10) / 10))}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                aria-label="Alejar"
              >
                <ZoomOut size={16} />
              </button>
              <input
                type="range"
                min={1}
                max={3}
                step={0.05}
                value={zoom}
                disabled={applying}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="min-w-0 flex-1 accent-violet-600"
                aria-label="Nivel de zoom"
              />
              <button
                type="button"
                disabled={applying || zoom >= 3}
                onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.1) * 10) / 10))}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                aria-label="Acercar"
              >
                <ZoomIn size={16} />
              </button>
            </div>
          </div>

          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              disabled={applying}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={applying}
              className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {applying ? (
                <>
                  <Loader2 size={16} className="animate-spin" aria-hidden />
                  Procesando…
                </>
              ) : (
                'Aplicar recorte'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
