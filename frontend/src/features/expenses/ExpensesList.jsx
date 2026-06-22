import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import api from '../../api/axios'
import { useModal } from '../../context/ModalContext'

const QB_GREEN = '#2ca01c'

function fmtMoney(n, currency = 'USD') {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
    }).format(Number(n) || 0)
  } catch {
    return `${Number(n || 0).toFixed(2)}`
  }
}

function fmtDate(iso) {
  if (!iso) return '—'
  const [y, m, d] = String(iso).slice(0, 10).split('-')
  return d && m && y ? `${d}/${m}/${y}` : iso
}

export default function ExpensesList() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(() => new Set())
  const [openMenuId, setOpenMenuId] = useState(null)
  const { openNewExpense } = useModal()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await api.get('/api/v1/expenses/')
      setRows(Array.isArray(data) ? data : [])
    } catch {
      setRows([])
    } finally {
      setLoading(false)
      setSelected(new Set())
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const onExpenseChanged = () => load()
    window.addEventListener('expenses:changed', onExpenseChanged)
    return () => window.removeEventListener('expenses:changed', onExpenseChanged)
  }, [load])

  function toggleRow(id) {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  function toggleAll() {
    if (selected.size === rows.length) setSelected(new Set())
    else setSelected(new Set(rows.map((r) => r.id)))
  }

  async function handleDelete(id) {
    if (!window.confirm('¿Eliminar este gasto y sus movimientos contables?')) return
    try {
      await api.delete(`/api/v1/expenses/${id}`)
      await load()
    } catch (e) {
      const d = e?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo eliminar.')
    }
    setOpenMenuId(null)
  }

  async function handleVoid(id) {
    if (!window.confirm('¿Anular este gasto? Se revertirán los asientos AUTO-EXP.')) return
    try {
      await api.patch(`/api/v1/expenses/${id}/void`)
      await load()
    } catch (e) {
      const d = e?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo anular.')
    }
    setOpenMenuId(null)
  }

  return (
    <div className="min-h-screen bg-slate-50/90 pb-12">
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 pt-6">
        <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-200 overflow-hidden">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-6 py-5 border-b border-gray-100">
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Gastos</h1>
            <button
              type="button"
              onClick={() => openNewExpense()}
              className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg text-sm font-semibold text-white shadow-sm hover:brightness-110 transition-all shrink-0"
              style={{ backgroundColor: QB_GREEN }}
            >
              Nueva transacción
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left min-w-[1100px]">
              <thead>
                <tr className="bg-gray-50/90 text-[11px] font-bold uppercase tracking-wide text-gray-500 border-b border-gray-200">
                  <th className="px-3 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={rows.length > 0 && selected.size === rows.length}
                      onChange={toggleAll}
                      className="rounded border-gray-300"
                      aria-label="Seleccionar todos"
                    />
                  </th>
                  <th className="px-3 py-3 whitespace-nowrap">Fecha</th>
                  <th className="px-3 py-3">Tipo</th>
                  <th className="px-3 py-3">N.º</th>
                  <th className="px-3 py-3">Beneficiario</th>
                  <th className="px-3 py-3 min-w-[160px]">Categoría</th>
                  <th className="px-3 py-3 text-right whitespace-nowrap">Total antes del impuesto…</th>
                  <th className="px-3 py-3 text-right whitespace-nowrap">Impuesto s/ ventas</th>
                  <th className="px-3 py-3 text-right">Total</th>
                  <th className="px-3 py-3 text-right w-40">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading && (
                  <tr>
                    <td colSpan={10} className="px-6 py-16 text-center text-gray-500">
                      <Loader2 className="inline animate-spin text-green-600 mr-2" size={20} />
                      Cargando…
                    </td>
                  </tr>
                )}
                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-6 py-14 text-center text-gray-400">
                      No hay gastos registrados.
                    </td>
                  </tr>
                )}
                {!loading &&
                  rows.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50/80">
                      <td className="px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggleRow(r.id)}
                          className="rounded border-gray-300"
                        />
                      </td>
                      <td className="px-3 py-2.5 text-gray-800 whitespace-nowrap">{fmtDate(r.payment_date)}</td>
                      <td className="px-3 py-2.5 text-gray-700">{r.type_label}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-blue-700">{r.reference_number}</td>
                      <td className="px-3 py-2.5 text-gray-900 font-medium">{r.payee_name}</td>
                      <td className="px-3 py-2.5 text-gray-600 max-w-xs truncate" title={r.category_label}>
                        {r.category_label}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-800">
                        {fmtMoney(r.subtotal_amount, r.currency)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-gray-600">
                        {fmtMoney(r.tax_amount ?? 0, r.currency)}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-gray-900">
                        {fmtMoney(r.total_amount, r.currency)}
                      </td>
                      <td className="px-3 py-2.5 text-right relative">
                        <div className="inline-flex flex-col items-end gap-1">
                          <button
                            type="button"
                            onClick={() => setOpenMenuId((id) => (id === r.id ? null : r.id))}
                            className="text-sm font-semibold flex items-center gap-1 hover:underline"
                            style={{ color: QB_GREEN }}
                          >
                            Ver/editar
                            <ChevronDown size={14} className={openMenuId === r.id ? 'rotate-180' : ''} />
                          </button>
                          {openMenuId === r.id && (
                            <ul className="absolute right-3 top-full mt-1 z-30 min-w-[160px] rounded-lg border border-gray-200 bg-white shadow-xl py-1 text-left">
                              <li>
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                                  onClick={() => {
                                    window.print()
                                    setOpenMenuId(null)
                                  }}
                                >
                                  Imprimir
                                </button>
                              </li>
                              <li>
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-sm text-gray-400 cursor-not-allowed"
                                  disabled
                                  title="Próximamente"
                                >
                                  Copiar
                                </button>
                              </li>
                              <li>
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-sm text-red-700 hover:bg-red-50"
                                  onClick={() => handleDelete(r.id)}
                                  disabled={r.status === 'voided'}
                                >
                                  Eliminar
                                </button>
                              </li>
                              <li>
                                <button
                                  type="button"
                                  className="w-full px-3 py-2 text-sm text-amber-800 hover:bg-amber-50"
                                  onClick={() => handleVoid(r.id)}
                                  disabled={r.status === 'voided'}
                                >
                                  Anular
                                </button>
                              </li>
                            </ul>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </div>
  )
}
