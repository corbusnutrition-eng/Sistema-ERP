import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  History,
  Settings,
  X,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
} from 'lucide-react'
import api from '../../api/axios'
import SearchableSelect from '../../components/ui/SearchableSelect'
import { currencyCodeFromAccountId } from '../../lib/accountCurrencyCascade'
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
    expense_account_id: '',
    description: '',
    amount: '',
  }
}

export default function ExpenseFormModal({ open, onClose, onSaved }) {
  const [users, setUsers] = useState([])
  const [accounts, setAccounts] = useState([])
  const [paymentMethods, setPaymentMethods] = useState([])
  const [loadingRefs, setLoadingRefs] = useState(true)

  const [payeeId, setPayeeId] = useState('')
  const [paymentAccountId, setPaymentAccountId] = useState('')
  const [paymentDate, setPaymentDate] = useState(() => todayIsoDateEcuador())
  const [paymentMethod, setPaymentMethod] = useState('')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [memo, setMemo] = useState('')
  const [lines, setLines] = useState([emptyLine()])
  const [categoryOpen, setCategoryOpen] = useState(true)
  const [pendingFiles, setPendingFiles] = useState([])
  const [saving, setSaving] = useState(false)

  const expenseCategoryAccounts = useMemo(
    () =>
      (accounts || []).filter((a) =>
        a.is_active !== false && ['expense', 'cost_of_sales'].includes(String(a.account_type || '').toLowerCase()),
      ),
    [accounts],
  )

  const selectedPaymentAcc = useMemo(
    () => accounts.find((a) => Number(a.id) === Number(paymentAccountId)),
    [accounts, paymentAccountId],
  )

  const payCurrency = normalizeCurrencyCode(
    currencyCodeFromAccountId(accounts, paymentAccountId, 'USD'),
    'USD',
  )

  const linesSubtotal = useMemo(() => {
    let s = 0
    for (const ln of lines) {
      const v = Number.parseFloat(String(ln.amount).replace(',', '.'))
      if (Number.isFinite(v)) s += v
    }
    return s
  }, [lines])

  const grandTotal = linesSubtotal

  const loadRefs = useCallback(async () => {
    setLoadingRefs(true)
    try {
      const [u, a, pm] = await Promise.all([
        api.get('/api/v1/users/', { params: { limit: 200 } }),
        api.get('/api/v1/accounts/', { params: { include_inactive: false } }),
        api.get('/api/v1/payment-methods/'),
      ])
      setUsers(Array.isArray(u.data) ? u.data : [])
      setAccounts(Array.isArray(a.data) ? a.data : [])
      setPaymentMethods(Array.isArray(pm.data) ? pm.data : [])
    } catch {
      setUsers([])
      setAccounts([])
      setPaymentMethods([])
    } finally {
      setLoadingRefs(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    loadRefs()
    setPayeeId('')
    setPaymentAccountId('')
    setPaymentDate(todayIsoDateEcuador())
    setPaymentMethod('')
    setReferenceNumber('')
    setMemo('')
    setLines([emptyLine()])
    setPendingFiles([])
    setCategoryOpen(true)
  }, [open, loadRefs])

  function updateLine(i, patch) {
    setLines((prev) => prev.map((row, j) => (j === i ? { ...row, ...patch } : row)))
  }

  function addLines() {
    setLines((prev) => [...prev, emptyLine()])
  }

  function removeLine(index) {
    setLines((prev) => {
      const next = prev.filter((_, j) => j !== index)
      return next.length ? next : [emptyLine()]
    })
  }

  async function uploadFiles() {
    const urls = []
    for (const file of pendingFiles) {
      const fd = new FormData()
      fd.append('file', file)
      const { data } = await api.post('/api/v1/expenses/attachments/upload', fd)
      if (data?.url) urls.push(data.url)
    }
    return urls
  }

  async function handleAddPayeeInline() {
    const name = window.prompt('Nombre del trabajador')
    if (!name || !String(name).trim()) return
    const email = window.prompt('Email')
    if (!email || !String(email).trim()) return
    const password = window.prompt('Contraseña (mín. 6 caracteres)')
    if (!password || String(password).length < 6) {
      window.alert('La contraseña debe tener al menos 6 caracteres.')
      return
    }
    try {
      const { data } = await api.post('/api/v1/users/', {
        name: String(name).trim(),
        email: String(email).trim(),
        password: String(password),
        role: 'worker',
      })
      setUsers((prev) =>
        [...prev, data].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
      )
      setPayeeId(String(data.id))
    } catch (e) {
      const d = e?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo crear el usuario.')
    }
  }

  async function handleAddPaymentAccountInline() {
    const name = window.prompt('Nombre de la cuenta de pago (banco / efectivo)')
    if (!name || !String(name).trim()) return
    const curIn = window.prompt('Moneda (código 3–5 letras, ej. USD, USDT)', payCurrency || 'USD')
    const currency = normalizeCurrencyCode(curIn || payCurrency || 'USD', 'USD')
    try {
      const { data } = await api.post('/api/v1/accounts/', {
        name: String(name).trim(),
        account_type: 'asset',
        detail_type: 'cash_bank',
        currency,
      })
      setAccounts((prev) =>
        [...prev, data].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
      )
      setPaymentAccountId(String(data.id))
    } catch (e) {
      const d = e?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo crear la cuenta.')
    }
  }

  async function handleAddPaymentMethodInline() {
    const name = window.prompt('Nombre del método de pago')
    if (!name || !String(name).trim()) return
    try {
      const { data } = await api.post('/api/v1/payment-methods/', {
        name: String(name).trim(),
      })
      setPaymentMethods((prev) =>
        [...prev, data].sort((a, b) => String(a.name).localeCompare(String(b.name))),
      )
      setPaymentMethod(data.name)
    } catch (e) {
      const d = e?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo crear el método de pago.')
    }
  }

  async function handleAddExpenseCategoryForRow(lineIndex) {
    const name = window.prompt('Nombre de la categoría de gasto')
    if (!name || !String(name).trim()) return
    const curDefault = payCurrency || 'USD'
    const curIn = window.prompt(`Moneda de la categoría (código 3–5 letras)`, curDefault)
    const currency = normalizeCurrencyCode(curIn || curDefault, 'USD')
    try {
      const { data } = await api.post('/api/v1/accounts/', {
        name: String(name).trim(),
        account_type: 'expense',
        currency,
      })
      setAccounts((prev) =>
        [...prev, data].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
      )
      updateLine(lineIndex, { expense_account_id: String(data.id) })
    } catch (e) {
      const d = e?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo crear la categoría.')
    }
  }

  const userOptions = useMemo(
    () => users.map((u) => ({ value: String(u.id), label: `${u.name} (${u.email})` })),
    [users],
  )

  const paymentAccountOptions = useMemo(
    () =>
      accounts.map((a) => ({
        value: String(a.id),
        label: `${a.name} · ${String(a.currency || 'USD').toUpperCase()}`,
      })),
    [accounts],
  )

  const paymentMethodOptions = useMemo(
    () => paymentMethods.map((p) => ({ value: p.name, label: p.name })),
    [paymentMethods],
  )

  const categoryRowOptions = useMemo(
    () =>
      expenseCategoryAccounts.map((a) => ({
        value: String(a.id),
        label: a.name,
      })),
    [expenseCategoryAccounts],
  )

  async function submit(closeAfter) {
    if (!payeeId || !paymentAccountId) {
      window.alert('Selecciona beneficiario y cuenta de pago.')
      return
    }
    const payloadLines = []
    for (const ln of lines) {
      const acc = Number(ln.expense_account_id)
      const amt = Number.parseFloat(String(ln.amount).replace(',', '.'))
      if (!acc || !Number.isFinite(amt) || amt <= 0) continue
      payloadLines.push({
        expense_account_id: acc,
        description: ln.description?.trim() || null,
        amount: amt,
      })
    }
    if (!payloadLines.length) {
      window.alert('Agrega al menos una línea con categoría e importe válidos.')
      return
    }
    setSaving(true)
    try {
      let attachment_urls = []
      if (pendingFiles.length) {
        attachment_urls = await uploadFiles()
      }
      await api.post('/api/v1/expenses/', {
        payee_id: Number(payeeId),
        payment_account_id: Number(paymentAccountId),
        payment_date: paymentDate,
        payment_method: paymentMethod?.trim() || null,
        reference_number: referenceNumber?.trim() || null,
        memo: memo?.trim() || null,
        tax_amount: 0,
        lines: payloadLines,
        attachment_urls,
      })
      onSaved?.()
      if (closeAfter) onClose()
    } catch (e) {
      const d = e?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo guardar el gasto.')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const payBal = selectedPaymentAcc?.system_balance ?? selectedPaymentAcc?.current_balance ?? 0

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/45">
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[96vh] flex flex-col overflow-hidden border border-gray-200"
        role="dialog"
        aria-labelledby="expense-modal-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0 bg-white">
          <div className="flex items-center gap-2 min-w-0">
            <History size={22} className="text-gray-500 shrink-0" aria-hidden />
            <h2 id="expense-modal-title" className="text-lg font-semibold text-gray-900 truncate">
              Gasto
            </h2>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              aria-label="Configuración"
              title="Configuración"
            >
              <Settings size={20} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-gray-500 hover:bg-gray-100"
              aria-label="Cerrar"
            >
              <X size={22} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Top grid */}
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-4 items-start">
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">
                    Beneficiario
                  </label>
                  <SearchableSelect
                    value={payeeId}
                    onChange={setPayeeId}
                    options={userOptions}
                    placeholder="Selecciona beneficiario…"
                    clearLabel="— Equipo / trabajadores —"
                    disabled={loadingRefs}
                    onAddNew={handleAddPayeeInline}
                    minPanelWidth={280}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">
                    Cuenta de pago
                  </label>
                  <SearchableSelect
                    value={paymentAccountId}
                    onChange={setPaymentAccountId}
                    options={paymentAccountOptions}
                    placeholder="— Plan de cuentas —"
                    clearLabel="— Plan de cuentas —"
                    disabled={loadingRefs}
                    onAddNew={handleAddPaymentAccountInline}
                    minPanelWidth={280}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Saldo <span className="font-medium text-gray-700">{money(payBal, payCurrency)}</span>
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Fecha de pago</label>
                  <input
                    type="date"
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="w-full h-10 px-3 rounded-md border border-gray-300 text-sm text-gray-900 bg-white outline-none focus:outline-none focus:ring-0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Método de pago</label>
                  <SearchableSelect
                    value={paymentMethod}
                    onChange={setPaymentMethod}
                    options={paymentMethodOptions}
                    placeholder="—"
                    clearLabel="—"
                    onAddNew={handleAddPaymentMethodInline}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">N.º de referencia</label>
                  <input
                    type="text"
                    value={referenceNumber}
                    onChange={(e) => setReferenceNumber(e.target.value)}
                    className="w-full h-10 px-3 rounded-md border border-gray-300 text-sm text-gray-900 bg-white outline-none focus:outline-none focus:ring-0"
                    placeholder="Ej. CHEQUE-1024"
                  />
                </div>
              </div>
            </div>
            <div className="text-right lg:pt-1">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Importe</p>
              <p className="text-4xl sm:text-5xl font-bold tabular-nums text-gray-900">
                {money(grandTotal, payCurrency)}
              </p>
            </div>
          </div>

          {/* Category details */}
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <button
              type="button"
              onClick={() => setCategoryOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 text-left hover:bg-gray-100/80 transition-colors"
            >
              <span className="text-sm font-semibold text-gray-800 flex items-center gap-2">
                {categoryOpen ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
                Detalles de la categoría
              </span>
            </button>
            {categoryOpen && (
              <div className="p-3 overflow-x-auto">
                <table className="w-full text-sm min-w-[480px]">
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-gray-500 border-b border-gray-100">
                      <th className="py-2 px-2 w-10">#</th>
                      <th className="py-2 px-2 min-w-[160px]">Categoría</th>
                      <th className="py-2 px-2 min-w-[140px]">Descripción</th>
                      <th className="py-2 px-2 w-28">Importe ({payCurrency})</th>
                      <th className="py-2 px-2 w-12 text-center" aria-label="Eliminar línea"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {lines.map((ln, i) => (
                      <tr key={ln._key}>
                        <td className="py-2 px-2 text-gray-500">{i + 1}</td>
                        <td className="py-2 px-2 align-top">
                  <SearchableSelect
                    value={ln.expense_account_id}
                            onChange={(v) => updateLine(i, { expense_account_id: v })}
                            options={categoryRowOptions}
                            placeholder="— Categoría —"
                            clearLabel="— Categoría —"
                            minPanelWidth={200}
                            onAddNew={() => handleAddExpenseCategoryForRow(i)}
                          />
                        </td>
                        <td className="py-2 px-2">
                          <input
                            value={ln.description}
                            onChange={(e) => updateLine(i, { description: e.target.value })}
                            className="w-full h-9 px-2 rounded-md border border-gray-300 text-xs outline-none focus:outline-none focus:ring-0"
                            placeholder="Descripción"
                          />
                        </td>
                        <td className="py-2 px-2">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={ln.amount}
                            onChange={(e) => updateLine(i, { amount: e.target.value })}
                            className="w-full h-9 px-2 rounded-md border border-gray-300 text-xs text-right tabular-nums outline-none focus:outline-none focus:ring-0"
                            placeholder="0.00"
                          />
                        </td>
                        <td className="py-2 px-2 text-center align-middle">
                          <button
                            type="button"
                            className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-red-600"
                            aria-label={`Eliminar línea ${i + 1}`}
                            title="Eliminar línea"
                            onClick={() => removeLine(i)}
                          >
                            <Trash2 size={17} aria-hidden />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex flex-wrap gap-2 mt-3 px-1">
                  <button
                    type="button"
                    onClick={addLines}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium border border-gray-300 hover:bg-gray-50 text-gray-800"
                  >
                    <Plus size={16} /> Agregar líneas
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Memo + attachments */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Nota</label>
              <textarea
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                rows={5}
                className="w-full px-3 py-2 rounded-md border border-gray-300 text-sm resize-y min-h-[120px] outline-none focus:outline-none focus:ring-0"
                placeholder="Memo visible en el equipo…"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-2">Archivos adjuntos</label>
              <label className="flex flex-col items-center justify-center min-h-[140px] border-2 border-dashed border-gray-300 rounded-xl bg-gray-50/80 cursor-pointer hover:border-green-500/50 hover:bg-green-50/30 transition-colors px-4 text-center">
                <input
                  type="file"
                  className="hidden"
                  multiple
                  accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
                  onChange={(e) => {
                    const files = Array.from(e.target.files || [])
                    const next = [...pendingFiles]
                    for (const f of files) {
                      if (f.size > 20 * 1024 * 1024) {
                        window.alert(`${f.name} supera 20 MB.`)
                        continue
                      }
                      next.push(f)
                    }
                    setPendingFiles(next)
                    e.target.value = ''
                  }}
                />
                <span className="text-sm text-gray-600">
                  Arrastra archivos aquí o haz clic para seleccionar
                </span>
                <span className="text-xs text-gray-400 mt-2">
                  Máx. 20 MB por archivo · JPG, PNG, GIF, WEBP, PDF
                </span>
              </label>
              {pendingFiles.length > 0 && (
                <ul className="mt-2 text-xs text-gray-600 space-y-1">
                  {pendingFiles.map((f, idx) => (
                    <li key={`${f.name}-${idx}`} className="flex justify-between gap-2">
                      <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        className="text-red-600 shrink-0"
                        onClick={() => setPendingFiles((p) => p.filter((_, j) => j !== idx))}
                      >
                        Quitar
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 bg-white px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="order-2 sm:order-1 px-4 py-2.5 rounded-lg text-sm font-semibold border-2 bg-white hover:bg-gray-50"
            style={{ borderColor: QB_GREEN, color: QB_GREEN }}
          >
            Cancelar
          </button>
          <div className="order-1 sm:order-2 flex flex-wrap items-center justify-center gap-4 text-sm font-semibold">
            <button type="button" className="hover:underline" style={{ color: QB_GREEN }} onClick={() => window.print()}>
              Imprimir
            </button>
            <button
              type="button"
              className="hover:underline opacity-60 cursor-not-allowed"
              style={{ color: QB_GREEN }}
              title="Próximamente"
              disabled
            >
              Hacer recurrente
            </button>
          </div>
          <div className="order-3 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => submit(false)}
              className="px-4 py-2.5 rounded-lg text-sm font-semibold border-2 bg-white hover:bg-green-50 disabled:opacity-50"
              style={{ borderColor: QB_GREEN, color: QB_GREEN }}
            >
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => submit(true)}
              className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-50"
              style={{ backgroundColor: QB_GREEN }}
            >
              {saving ? 'Guardando…' : 'Guardar y cerrar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
