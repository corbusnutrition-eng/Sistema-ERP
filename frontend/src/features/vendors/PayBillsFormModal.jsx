import { useCallback, useEffect, useMemo, useState } from 'react'
import { Landmark, Loader2, X } from 'lucide-react'
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

function todayISO() {
  return todayIsoDateEcuador()
}

export default function PayBillsFormModal({ open, onClose, onSaved, prefillVendorId = null }) {
  const [vendors, setVendors] = useState([])
  const [depositAccounts, setDepositAccounts] = useState([])
  const [loading, setLoading] = useState(false)

  const [vendorFilterId, setVendorFilterId] = useState('')
  const [paymentAccountId, setPaymentAccountId] = useState('')
  const [paymentDate, setPaymentDate] = useState(todayISO)
  const [referenceNumber, setReferenceNumber] = useState('')
  const [memo, setMemo] = useState('')
  const [rows, setRows] = useState([])
  const [saving, setSaving] = useState(false)

  const vendorOpts = useMemo(
    () => [
      { value: '', label: 'Todos los proveedores' },
      ...vendors.map((v) => ({
        value: String(v.id),
        label: v.company_name ? `${v.name} (${v.company_name})` : v.name,
      })),
    ],
    [vendors],
  )

  const bankOpts = useMemo(
    () =>
      (depositAccounts || []).map((a) => ({
        value: String(a.id),
        label: `${a.name} (${normalizeCurrencyCode(a.currency || 'USD', 'USD')})`,
      })),
    [depositAccounts],
  )

  const refresh = useCallback(async () => {
    if (!open) return
    setLoading(true)
    try {
      const [vRes, dRes] = await Promise.all([
        api.get('/api/v1/vendors/'),
        api.get('/api/v1/accounts/deposit-options'),
      ])
      const vList = Array.isArray(vRes.data) ? vRes.data : []
      const dList = Array.isArray(dRes.data) ? dRes.data : []
      setVendors(vList)
      setDepositAccounts(dList)

      const params = {}
      const vf = vendorFilterId ? Number(vendorFilterId) : null
      if (vf) params.vendor_id = vf

      const { data } = await api.get('/api/v1/vendor-bills/open/', { params })
      const list = Array.isArray(data) ? data : []
      const curOf = (vid) => normalizeCurrencyCode(vList.find((x) => Number(x.id) === Number(vid))?.currency ?? 'USD', 'USD')

      setRows(
        list.map((b) => ({
          billId: b.id,
          vendorId: b.vendor_id,
          beneficiary: b.vendor_name || '—',
          ref: b.bill_number || `FB-${b.id}`,
          due: b.due_date,
          currency: curOf(b.vendor_id),
          balance: Number(b.balance_due),
          paymentInput: '',
        })),
      )
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [open, vendorFilterId])

  useEffect(() => {
    if (!open) return
    setVendorFilterId(prefillVendorId != null ? String(prefillVendorId) : '')
    setPaymentAccountId('')
    setPaymentDate(todayISO())
    setReferenceNumber('')
    setMemo('')
  }, [open, prefillVendorId])

  useEffect(() => {
    if (!open) return
    refresh()
  }, [open, refresh])

  const selectedBankCurrency = useMemo(() => {
    const a = depositAccounts.find((x) => Number(x.id) === Number(paymentAccountId))
    return normalizeCurrencyCode(a?.currency ?? 'USD', 'USD')
  }, [depositAccounts, paymentAccountId])

  const totalPayment = useMemo(() => {
    let s = 0
    for (const r of rows) {
      const v = Number.parseFloat(String(r.paymentInput).replace(',', '.'))
      if (Number.isFinite(v) && v > 0) s += v
    }
    return s
  }, [rows])

  function setPay(i, val) {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, paymentInput: val } : r)))
  }

  async function handleSubmit() {
    if (!paymentAccountId) {
      window.alert('Selecciona la cuenta de pago (banco).')
      return
    }
    const lines = []
    for (const r of rows) {
      const amt = Number.parseFloat(String(r.paymentInput).replace(',', '.'))
      if (!Number.isFinite(amt) || amt <= 0) continue
      lines.push({ bill_id: r.billId, amount_applied: amt })
    }
    if (!lines.length) {
      window.alert('Indica al menos un importe de pago mayor que cero.')
      return
    }
    const explicitVendor = vendorFilterId ? Number(vendorFilterId) : null
    const touchedVendors = new Set(
      rows
        .filter((r) => {
          const amt = Number.parseFloat(String(r.paymentInput).replace(',', '.'))
          return Number.isFinite(amt) && amt > 0
        })
        .map((r) => Number(r.vendorId)),
    )

    let payVendor = explicitVendor
    if (!payVendor) {
      if (touchedVendors.size !== 1) {
        window.alert(
          'Selecciona un proveedor en el filtro, o aplica pagos solo a facturas del mismo proveedor.',
        )
        return
      }
      payVendor = [...touchedVendors][0]
    }

    const mixedCurrency = lines.some((ln) => {
      const row = rows.find((r) => r.billId === ln.bill_id)
      return row && row.currency !== selectedBankCurrency
    })
    if (mixedCurrency) {
      window.alert('La moneda del banco debe coincidir con la de las facturas seleccionadas.')
      return
    }

    setSaving(true)
    try {
      await api.post('/api/v1/vendor-payments/', {
        vendor_id: payVendor,
        payment_account_id: Number(paymentAccountId),
        payment_date: paymentDate,
        reference_number: referenceNumber.trim() || null,
        memo: memo.trim() || null,
        lines,
      })
      onSaved?.()
      onClose()
      window.dispatchEvent(new CustomEvent('vendors:changed'))
    } catch (e) {
      const d = e?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo registrar el pago.')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const today = todayISO()

  return (
    <div className="fixed inset-0 z-[89] flex items-center justify-center p-4 bg-black/45">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[96vh] flex flex-col overflow-hidden border border-gray-200">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2">
            <Landmark size={22} className="text-gray-500" />
            <h2 className="text-lg font-semibold text-gray-900">Pagar facturas de proveedores</h2>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-lg text-gray-500 hover:bg-gray-100" aria-label="Cerrar">
            <X size={22} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 border-b border-gray-100 bg-gray-50/60">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr_auto] gap-3 items-end">
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Proveedor</label>
              <SearchableSelect
                value={vendorFilterId}
                onChange={(v) => setVendorFilterId(v ?? '')}
                options={vendorOpts}
                placeholder="Todos…"
                clearLabel="Todos los proveedores"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">Cuenta de pago</label>
              <SearchableSelect
                value={paymentAccountId}
                onChange={setPaymentAccountId}
                options={bankOpts}
                placeholder="— Banco —"
                clearLabel="—"
              />
            </div>
            <div className="text-right">
              <p className="text-[10px] font-bold uppercase text-gray-500">Importe de pago total</p>
              <p className="text-2xl font-bold tabular-nums text-gray-900">
                {money(totalPayment, selectedBankCurrency)}
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
                className="w-full h-10 px-3 rounded-md border border-gray-300 text-sm outline-none focus:ring-0"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1">N.º de referencia</label>
              <input
                type="text"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                className="w-full h-10 px-3 rounded-md border border-gray-300 text-sm outline-none focus:ring-0"
              />
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
        </div>

        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex justify-center py-12 text-gray-500 text-sm">Cargando facturas abiertas…</div>
          ) : !rows.length ? (
            <p className="text-sm text-gray-500 text-center py-10">No hay facturas con saldo pendiente.</p>
          ) : (
            <table className="w-full text-sm min-w-[900px]">
              <thead>
                <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-2">Beneficiario</th>
                  <th className="py-2 pr-2">N.º ref</th>
                  <th className="py-2 pr-2">Vencimiento</th>
                  <th className="py-2 pr-2">Estado</th>
                  <th className="py-2 pr-2 text-right">Saldo pendiente</th>
                  <th className="py-2 pr-2 text-right">Crédito aplicado</th>
                  <th className="py-2 pr-2 text-right w-36">Pago</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r, i) => {
                  const overdue = r.due && r.due < today && r.balance > 0
                  return (
                    <tr key={r.billId} className="hover:bg-gray-50/80">
                      <td className="py-2 pr-2 font-medium text-gray-900">{r.beneficiary}</td>
                      <td className="py-2 pr-2 text-gray-700">{r.ref}</td>
                      <td className="py-2 pr-2 tabular-nums text-gray-600">{r.due || '—'}</td>
                      <td className="py-2 pr-2">
                        {overdue ? (
                          <span className="text-xs font-semibold text-orange-700 bg-orange-50 px-2 py-0.5 rounded">
                            Vencido
                          </span>
                        ) : (
                          <span className="text-xs text-gray-500">Pendiente</span>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-right tabular-nums">{money(r.balance, r.currency)}</td>
                      <td className="py-2 pr-2 text-right text-gray-400">—</td>
                      <td className="py-2 pr-2">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={r.paymentInput}
                          onChange={(e) => setPay(i, e.target.value)}
                          className="w-full h-9 px-2 rounded-md border border-gray-300 text-right tabular-nums text-sm outline-none focus:ring-0"
                          placeholder="0.00"
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-100 bg-white shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving}
            style={{ backgroundColor: QB_GREEN }}
            className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-md text-white disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? 'Guardando…' : 'Registrar pago'}
          </button>
        </div>
      </div>
    </div>
  )
}
