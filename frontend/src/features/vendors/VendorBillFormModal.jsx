import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, FileText, Loader2, Plus, Trash2, X } from 'lucide-react'
import api from '../../api/axios'
import SearchableSelect from '../../components/ui/SearchableSelect'
import { normalizeCurrencyCode } from '../../lib/currencyCode'
import { todayIsoDateEcuador } from '../../utils/datetime'

const QB_GREEN = '#2ca01c'

function money(n, cur = 'USD') {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: cur || 'USD',
      minimumFractionDigits: 2,
    }).format(Number(n) || 0)
  } catch {
    return `${Number(n || 0).toFixed(2)} ${cur}`
  }
}

function emptyLine() {
  return {
    _key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    account_id: '',
    description: '',
    amount: '',
  }
}

export default function VendorBillFormModal({ open, onClose, onSaved, prefillVendorId = null }) {
  const [vendors, setVendors] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loadingRefs, setLoadingRefs] = useState(false)

  const [vendorId, setVendorId] = useState('')
  const [billNumber, setBillNumber] = useState('')
  const [billDate, setBillDate] = useState(todayIsoDateEcuador)
  const [dueDate, setDueDate] = useState('')
  const [terms, setTerms] = useState('')
  const [memo, setMemo] = useState('')
  const [lines, setLines] = useState([emptyLine()])
  const [categoryOpen, setCategoryOpen] = useState(true)
  const [saving, setSaving] = useState(false)

  const vendorOptions = useMemo(
    () =>
      (vendors || []).map((v) => ({
        value: String(v.id),
        label: v.company_name ? `${v.name} — ${v.company_name}` : v.name,
      })),
    [vendors],
  )

  const selectedVendor = useMemo(
    () => vendors.find((v) => Number(v.id) === Number(vendorId)),
    [vendors, vendorId],
  )

  const payCurrency = normalizeCurrencyCode(selectedVendor?.currency ?? 'USD', 'USD')

  const categoryRowOptions = useMemo(() => {
    return (accounts || [])
      .filter((a) => {
        if (a.is_active === false) return false
        const cur = normalizeCurrencyCode(a.currency || 'USD', 'USD')
        if (cur !== payCurrency) return false
        const t = String(a.account_type || '').toLowerCase()
        const dt = String(a.detail_type || '').toLowerCase()
        if (t === 'expense' || t === 'cost_of_sales') return true
        if (t === 'asset' && dt === 'inventario') return true
        return false
      })
      .map((a) => ({
        value: String(a.id),
        label: a.name || `Cuenta ${a.id}`,
      }))
  }, [accounts, payCurrency])

  const linesSubtotal = useMemo(() => {
    let s = 0
    for (const ln of lines) {
      const v = Number.parseFloat(String(ln.amount).replace(',', '.'))
      if (Number.isFinite(v)) s += v
    }
    return s
  }, [lines])

  const loadRefs = useCallback(async () => {
    setLoadingRefs(true)
    try {
      const [v, a] = await Promise.all([
        api.get('/api/v1/vendors/'),
        api.get('/api/v1/accounts/', { params: { include_inactive: false } }),
      ])
      setVendors(Array.isArray(v.data) ? v.data : [])
      setAccounts(Array.isArray(a.data) ? a.data : [])
    } catch {
      setVendors([])
      setAccounts([])
    } finally {
      setLoadingRefs(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    loadRefs()
    setVendorId(prefillVendorId != null ? String(prefillVendorId) : '')
    setBillNumber('')
    setBillDate(todayIsoDateEcuador())
    setDueDate('')
    setTerms('')
    setMemo('')
    setLines([emptyLine()])
    setCategoryOpen(true)
  }, [open, loadRefs, prefillVendorId])

  function updateLine(i, patch) {
    setLines((prev) => prev.map((row, j) => (j === i ? { ...row, ...patch } : row)))
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()])
  }

  function removeLine(i) {
    setLines((prev) => {
      const next = prev.filter((_, j) => j !== i)
      return next.length ? next : [emptyLine()]
    })
  }

  async function handleSave() {
    if (!vendorId) {
      window.alert('Selecciona un proveedor.')
      return
    }
    const payloadLines = []
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]
      const acc = ln.account_id
      const amt = Number.parseFloat(String(ln.amount).replace(',', '.'))
      if ((!acc || !amt) && !ln.description.trim()) continue
      if (!acc || !Number.isFinite(amt) || amt <= 0) {
        window.alert(`Línea ${i + 1}: categoría e importe válidos son obligatorios.`)
        return
      }
      payloadLines.push({
        account_id: Number(acc),
        description: ln.description.trim() || null,
        amount: amt,
      })
    }
    if (!payloadLines.length) {
      window.alert('Agrega al menos una línea con categoría e importe.')
      return
    }
    setSaving(true)
    try {
      await api.post('/api/v1/vendor-bills/', {
        vendor_id: Number(vendorId),
        bill_number: billNumber.trim() || null,
        bill_date: billDate,
        due_date: dueDate || null,
        terms: terms.trim() || null,
        memo: memo.trim() || null,
        lines: payloadLines,
      })
      onSaved?.()
      onClose()
      window.dispatchEvent(new CustomEvent('vendors:changed'))
    } catch (e) {
      const d = e?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo registrar la factura.')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[88] flex items-center justify-center p-4 bg-black/45">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[96vh] flex flex-col overflow-hidden border border-gray-200">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileText size={22} className="text-gray-500 shrink-0" />
            <h2 className="text-lg font-semibold text-gray-900 truncate">Factura de proveedor</h2>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-lg text-gray-500 hover:bg-gray-100" aria-label="Cerrar">
            <X size={22} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 items-start">
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Proveedor</label>
                  <SearchableSelect
                    value={vendorId}
                    onChange={setVendorId}
                    options={vendorOptions}
                    placeholder="Selecciona proveedor…"
                    clearLabel="—"
                    disabled={loadingRefs}
                    minPanelWidth={300}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">N.º de factura</label>
                  <input
                    type="text"
                    value={billNumber}
                    onChange={(e) => setBillNumber(e.target.value)}
                    className="w-full h-10 px-3 rounded-md border border-gray-300 text-sm outline-none focus:ring-0"
                    placeholder="Opcional"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Fecha de factura</label>
                  <input
                    type="date"
                    value={billDate}
                    onChange={(e) => setBillDate(e.target.value)}
                    className="w-full h-10 px-3 rounded-md border border-gray-300 text-sm outline-none focus:ring-0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Fecha de vencimiento</label>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full h-10 px-3 rounded-md border border-gray-300 text-sm outline-none focus:ring-0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Términos</label>
                  <input
                    type="text"
                    value={terms}
                    onChange={(e) => setTerms(e.target.value)}
                    className="w-full h-10 px-3 rounded-md border border-gray-300 text-sm outline-none focus:ring-0"
                    placeholder="Ej. Pago en 60 días"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Memo</label>
                <input
                  type="text"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                  className="w-full h-10 px-3 rounded-md border border-gray-300 text-sm outline-none focus:ring-0"
                />
              </div>
            </div>
            <div className="text-right lg:pt-1">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Total</p>
              <p className="text-4xl sm:text-5xl font-bold tabular-nums text-gray-900">{money(linesSubtotal, payCurrency)}</p>
              <p className="text-xs text-gray-500 mt-1">Moneda {payCurrency}</p>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <button
              type="button"
              onClick={() => setCategoryOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 text-left hover:bg-gray-100/80"
            >
              <span className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                {categoryOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
                Detalles de la categoría
              </span>
            </button>
            {categoryOpen && (
              <div className="p-3 overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-gray-500 border-b border-gray-100">
                      <th className="py-2 px-2 w-10">#</th>
                      <th className="py-2 px-2 min-w-[200px]">Categoría</th>
                      <th className="py-2 px-2 min-w-[180px]">Descripción</th>
                      <th className="py-2 px-2 w-32">Importe ({payCurrency})</th>
                      <th className="py-2 px-2 w-12" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {lines.map((ln, i) => (
                      <tr key={ln._key}>
                        <td className="py-2 px-2 text-gray-500">{i + 1}</td>
                        <td className="py-2 px-2 align-top">
                          <SearchableSelect
                            value={ln.account_id}
                            onChange={(v) => updateLine(i, { account_id: v })}
                            options={categoryRowOptions}
                            placeholder="— Categoría —"
                            clearLabel="—"
                            minPanelWidth={220}
                            disabled={!vendorId}
                          />
                        </td>
                        <td className="py-2 px-2">
                          <input
                            value={ln.description}
                            onChange={(e) => updateLine(i, { description: e.target.value })}
                            className="w-full h-9 px-2 rounded-md border border-gray-300 text-xs outline-none focus:ring-0"
                            placeholder="Descripción"
                          />
                        </td>
                        <td className="py-2 px-2">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={ln.amount}
                            onChange={(e) => updateLine(i, { amount: e.target.value })}
                            className="w-full h-9 px-2 rounded-md border border-gray-300 text-xs text-right tabular-nums outline-none focus:ring-0"
                            placeholder="0.00"
                          />
                        </td>
                        <td className="py-2 px-2 text-center">
                          <button
                            type="button"
                            onClick={() => removeLine(i)}
                            className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50"
                            aria-label="Eliminar línea"
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  type="button"
                  onClick={addLine}
                  className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-800"
                >
                  <Plus size={16} /> Añadir línea
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-100 bg-white shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            style={{ backgroundColor: QB_GREEN }}
            className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-md text-white disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? 'Guardando…' : 'Guardar y cerrar'}
          </button>
        </div>
      </div>
    </div>
  )
}
