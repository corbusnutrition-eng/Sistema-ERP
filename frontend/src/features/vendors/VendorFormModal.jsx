import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import api from '../../api/axios'
import SearchableSelect from '../../components/ui/SearchableSelect'
import { normalizeCurrencyCode } from '../../lib/currencyCode'

const QB_GREEN = '#2ca01c'

const CURRENCY_OPTS = ['USD', 'USDT', 'BOB', 'PEN'].map((c) => ({ value: c, label: c }))

export default function VendorFormModal({ open, onClose, initialVendor = null, onSaved }) {
  const isEdit = Boolean(initialVendor?.id)
  const [name, setName] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => {
    if (!open) return
    setErr(null)
    setName(String(initialVendor?.name ?? ''))
    setCompanyName(String(initialVendor?.company_name ?? ''))
    setEmail(String(initialVendor?.email ?? ''))
    setPhone(String(initialVendor?.phone ?? ''))
    setAddress(String(initialVendor?.address ?? ''))
    setCurrency(normalizeCurrencyCode(initialVendor?.currency ?? 'USD', 'USD'))
    setNotes(String(initialVendor?.notes ?? ''))
  }, [open, initialVendor])

  const inputCls =
    'w-full h-10 px-3 text-sm bg-white border border-gray-300 rounded-md text-gray-900 placeholder-gray-400 outline-none focus:ring-0'

  const currencyOptions = useMemo(() => CURRENCY_OPTS.map((o) => ({ ...o })), [])

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault()
      const nm = name.trim()
      if (!nm) {
        setErr('El nombre del proveedor es obligatorio.')
        return
      }
      setSaving(true)
      setErr(null)
      try {
        const body = {
          name: nm,
          company_name: companyName.trim() || null,
          email: email.trim() || null,
          phone: phone.trim() || null,
          address: address.trim() || null,
          currency: normalizeCurrencyCode(currency || 'USD', 'USD'),
          notes: notes.trim() || null,
        }
        if (isEdit) {
          await api.patch(`/api/v1/vendors/${initialVendor.id}`, body)
        } else {
          await api.post('/api/v1/vendors/', body)
        }
        onSaved?.()
        onClose()
      } catch (ex) {
        const d = ex?.response?.data?.detail
        setErr(typeof d === 'string' ? d : 'No se pudo guardar el proveedor.')
      } finally {
        setSaving(false)
      }
    },
    [
      name,
      companyName,
      email,
      phone,
      address,
      currency,
      notes,
      isEdit,
      initialVendor?.id,
      onClose,
      onSaved,
    ],
  )

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-gray-900/55 backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && !saving && onClose()}
      role="presentation"
    >
      <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl ring-1 ring-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">
            {isEdit ? 'Editar proveedor' : 'Nuevo proveedor'}
          </h2>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100"
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3 max-h-[85vh] overflow-y-auto">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Nombre / contacto</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Razón social</label>
            <input className={inputCls} value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Correo electrónico</label>
              <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Teléfono</label>
              <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Moneda</label>
            <SearchableSelect value={currency} onChange={setCurrency} options={currencyOptions} hideClear />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Dirección</label>
            <textarea
              className="w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded-md outline-none focus:ring-0 resize-none"
              rows={2}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Notas</label>
            <textarea
              className="w-full px-3 py-2 text-sm bg-white border border-gray-300 rounded-md outline-none focus:ring-0 resize-none"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {err && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p>
          )}
          <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
            <button
              type="button"
              onClick={() => !saving && onClose()}
              className="px-4 py-2 text-sm font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{ backgroundColor: QB_GREEN }}
              className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-md text-white disabled:opacity-50"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {saving ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Crear proveedor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
