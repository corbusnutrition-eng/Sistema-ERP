import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import api from '../../api/axios'

function ModalShell({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/45" aria-label="Cerrar" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-gray-100 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} className="p-2 rounded-lg text-gray-400 hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {object | null} props.methodToEdit
 * @param {() => void} props.onClose
 * @param {() => Promise<void> | void} [props.onSuccess]
 * @param {(msg: string) => void} [props.onError] — toast de error (mensaje ya legible)
 */
export default function NewPaymentMethodModal({
  isOpen,
  methodToEdit,
  onClose,
  onSuccess,
  onError,
}) {
  const [nombre, setNombre] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (methodToEdit) {
      setNombre(methodToEdit.name ?? '')
    } else {
      setNombre('')
    }
  }, [methodToEdit])

  if (!isOpen) return null

  async function handleSubmit(e) {
    e.preventDefault()
    const n = nombre.trim()
    if (!n) return
    setSaving(true)
    try {
      if (methodToEdit?.id != null) {
        await api.put(`/api/v1/payment-methods/${methodToEdit.id}`, { name: n })
      } else {
        await api.post('/api/v1/payment-methods/', { name: n })
      }
      await Promise.resolve(onSuccess?.())
      onClose?.()
    } catch (err) {
      const d = err?.response?.data?.detail
      const msg = typeof d === 'string' ? d : 'No se pudo guardar.'
      if (typeof onError === 'function') {
        onError(msg)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell
      title={methodToEdit ? 'Editar método de pago' : 'Nuevo método de pago'}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Nombre</label>
          <input
            autoFocus
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
            placeholder="Ej. Transferencia bancaria"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="px-3 py-2 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving || !nombre.trim()}
            className="px-3 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg disabled:opacity-50"
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
