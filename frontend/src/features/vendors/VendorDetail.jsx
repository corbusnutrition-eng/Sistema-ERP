import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Building2,
  ChevronDown,
  Mail,
  MapPin,
  Phone,
  Search,
} from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import api from '../../api/axios'
import { useModal } from '../../context/ModalContext'
import { normalizeCurrencyCode } from '../../lib/currencyCode'
import VendorFormModal from './VendorFormModal'

const QB_GREEN = '#2ca01c'

function moneySigned(n, cur = 'USD') {
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: cur || 'USD',
      minimumFractionDigits: 2,
      signDisplay: 'exceptZero',
    }).format(Number(n) || 0)
  } catch {
    const v = Number(n) || 0
    const sign = v < 0 ? '−' : ''
    return `${sign}${Math.abs(v).toFixed(2)} ${cur}`
  }
}

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

export default function VendorDetail() {
  const { vendorId } = useParams()
  const navigate = useNavigate()
  const { openVendorBillModal, openPayBillsModal } = useModal()
  const id = Number(vendorId)

  const [vendor, setVendor] = useState(null)
  const [loadErr, setLoadErr] = useState(null)
  const [allVendors, setAllVendors] = useState([])
  const [ledger, setLedger] = useState([])
  const [tab, setTab] = useState('transactions')
  const [vq, setVq] = useState('')
  const [ledgerFrom, setLedgerFrom] = useState('')
  const [ledgerTo, setLedgerTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [txnMenu, setTxnMenu] = useState(false)
  const [editVendorOpen, setEditVendorOpen] = useState(false)
  const txnRef = useRef(null)

  const loadVendor = useCallback(async () => {
    if (!id || !Number.isFinite(id)) return null
    const { data } = await api.get(`/api/v1/vendors/${id}`)
    setVendor(data)
    setLoadErr(null)
    return data
  }, [id])

  const loadAll = useCallback(async () => {
    const { data } = await api.get('/api/v1/vendors/')
    setAllVendors(Array.isArray(data) ? data : [])
  }, [])

  const loadLedger = useCallback(async () => {
    if (!id || !Number.isFinite(id)) return
    const params = {}
    if (ledgerFrom) params.date_from = ledgerFrom
    if (ledgerTo) params.date_to = ledgerTo
    const { data } = await api.get(`/api/v1/vendors/${id}/ledger/`, { params })
    setLedger(Array.isArray(data) ? data : [])
  }, [id, ledgerFrom, ledgerTo])

  useEffect(() => {
    let ok = true
    ;(async () => {
      setLoading(true)
      setLoadErr(null)
      try {
        await loadAll()
        if (!ok) return
        await loadVendor()
        if (!ok) return
        await loadLedger()
      } catch {
        if (ok) {
          setLoadErr('No se pudo cargar el proveedor.')
          setVendor(null)
        }
      } finally {
        if (ok) setLoading(false)
      }
    })()
    return () => {
      ok = false
    }
  }, [id, loadVendor, loadLedger, loadAll])

  useEffect(() => {
    function onCh() {
      loadVendor()
      loadAll()
      loadLedger()
    }
    window.addEventListener('vendors:changed', onCh)
    return () => window.removeEventListener('vendors:changed', onCh)
  }, [loadVendor, loadAll, loadLedger])

  useEffect(() => {
    if (!txnMenu) return
    function onDoc(e) {
      if (txnRef.current && !txnRef.current.contains(e.target)) setTxnMenu(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [txnMenu])

  const cur = normalizeCurrencyCode(vendor?.currency ?? 'USD', 'USD')

  const vidListFiltered = useMemo(() => {
    const q = vq.trim().toLowerCase()
    const lst = [...allVendors].sort((a, b) => String(a.name).localeCompare(String(b.name)))
    if (!q) return lst
    return lst.filter(
      (v) =>
        String(v.name).toLowerCase().includes(q) ||
        String(v.company_name || '').toLowerCase().includes(q),
    )
  }, [allVendors, vq])

  if (!vendorId || !Number.isFinite(id)) return null

  if (loading && !vendor) {
    return <div className="text-gray-500 text-sm py-16 text-center">Cargando proveedor…</div>
  }

  if (loadErr || !vendor) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center space-y-3">
        <p className="text-gray-600">{loadErr || 'Proveedor no encontrado.'}</p>
        <button
          type="button"
          onClick={() => navigate('/contabilidad/proveedores')}
          className="text-blue-600 font-medium hover:underline"
        >
          Volver a Proveedores
        </button>
      </div>
    )
  }

  const pending = Number(vendor.balance_pending ?? 0)
  const overdue = ledger.some((r) => r.row_kind === 'vendor_bill' && r.overdue)

  return (
    <div className="flex flex-col lg:flex-row gap-0 min-h-[calc(100vh-7rem)] -m-6">
      <aside className="lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-gray-200 bg-white lg:sticky lg:top-0 lg:self-start lg:max-h-[calc(100vh-7rem)] flex flex-col">
        <div className="p-3 border-b border-gray-100">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              value={vq}
              onChange={(e) => setVq(e.target.value)}
              placeholder="Buscar…"
              className="w-full pl-9 pr-2 py-2 text-sm rounded-lg border border-gray-200 outline-none focus:ring-0"
            />
          </div>
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-2 text-xs font-medium text-blue-600 hover:text-blue-800"
            onClick={() => navigate('/contabilidad/proveedores')}
          >
            <ArrowLeft size={14} /> Lista de proveedores
          </button>
        </div>
        <div className="overflow-y-auto flex-1 divide-y divide-gray-50">
          {vidListFiltered.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => navigate(`/contabilidad/proveedores/${v.id}`)}
              className={`w-full text-left px-4 py-2.5 text-sm hover:bg-gray-50 ${
                v.id === id ? 'bg-blue-50 border-l-[3px] border-blue-500 pl-[13px]' : ''
              }`}
            >
              <p className="font-medium text-gray-900 truncate">{v.name}</p>
              <p
                className={`text-[11px] tabular-nums ${
                  Number(v.balance_pending) > 0 ? 'text-orange-700' : 'text-gray-500'
                }`}
              >
                Saldo {money(v.balance_pending, v.currency)}
              </p>
            </button>
          ))}
        </div>
      </aside>

      <div className="flex-1 min-w-0 p-4 lg:p-6 bg-gray-50/60">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="text-blue-600" size={26} strokeWidth={1.75} />
              <h1 className="text-xl font-semibold text-gray-900">{vendor.name}</h1>
            </div>
            {vendor.company_name && <p className="text-sm text-gray-600">{vendor.company_name}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setEditVendorOpen(true)}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 bg-white text-gray-800 hover:bg-gray-50"
            >
              Editar
            </button>
            <div className="relative" ref={txnRef}>
              <button
                type="button"
                style={{ backgroundColor: QB_GREEN }}
                className="inline-flex items-center gap-1 px-4 py-2 text-sm font-semibold rounded-lg text-white"
                onClick={() => setTxnMenu((x) => !x)}
              >
                Nueva transacción <ChevronDown size={16} />
              </button>
              {txnMenu && (
                <div className="absolute right-0 z-40 mt-1 w-56 bg-white rounded-lg shadow-xl border border-gray-100 py-1 text-sm">
                  <button
                    type="button"
                    className="block w-full text-left px-3 py-2 hover:bg-gray-50 text-gray-800"
                    onClick={() => {
                      setTxnMenu(false)
                      openVendorBillModal({ vendorId: id })
                    }}
                  >
                    Factura de proveedor
                  </button>
                  <button
                    type="button"
                    className="block w-full text-left px-3 py-2 hover:bg-gray-50 text-gray-800"
                    onClick={() => {
                      setTxnMenu(false)
                      openPayBillsModal({ vendorId: id })
                    }}
                  >
                    Pagar facturas
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
          <div className="xl:col-span-2 rounded-2xl border border-gray-200 bg-white shadow-sm p-5 space-y-2 text-sm">
            <p className="text-xs font-bold uppercase text-gray-400 tracking-wide">Empresa</p>
            {vendor.phone && (
              <p className="flex items-center gap-2 text-gray-800">
                <Phone size={16} className="text-gray-400 shrink-0" /> {vendor.phone}
              </p>
            )}
            {vendor.email && (
              <p className="flex items-center gap-2 text-gray-800">
                <Mail size={16} className="text-gray-400 shrink-0" /> {vendor.email}
              </p>
            )}
            {vendor.address && (
              <p className="flex items-start gap-2 text-gray-800">
                <MapPin size={16} className="text-gray-400 shrink-0 mt-0.5" /> {vendor.address}
              </p>
            )}
            {!vendor.phone && !vendor.email && !vendor.address && (
              <p className="text-gray-500 italic">Completa datos de contacto con Editar.</p>
            )}
          </div>
          <div
            className={`rounded-2xl border shadow-sm p-5 ${
              pending > 0 && overdue
                ? 'border-orange-300 bg-orange-50/70'
                : pending > 0
                  ? 'border-amber-200 bg-white'
                  : 'border-green-200 bg-green-50/50'
            }`}
          >
            <p className="text-xs font-bold uppercase text-gray-500 tracking-wide mb-2">Saldo pendiente</p>
            <p
              className={`text-3xl font-bold tabular-nums ${
                pending > 0 && overdue ? 'text-orange-800' : pending > 0 ? 'text-amber-900' : 'text-green-800'
              }`}
            >
              {money(pending, cur)}
            </p>
            <p className="text-xs text-gray-600 mt-2">Moneda proveedor · {cur}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="flex border-b border-gray-100 text-sm font-medium bg-gray-50/80 overflow-x-auto">
            {[
              ['transactions', 'Transacciones'],
              ['details', 'Detalles del proveedor'],
              ['notes', 'Notas'],
            ].map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                className={`px-6 py-3 border-b-2 shrink-0 ${
                  tab === k ? 'border-blue-500 text-blue-700 bg-white' : 'border-transparent text-gray-500 hover:text-gray-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="p-4 lg:p-5">
            {tab === 'transactions' && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="block text-[10px] uppercase font-semibold text-gray-500 mb-1">Desde</label>
                    <input
                      type="date"
                      value={ledgerFrom}
                      onChange={(e) => setLedgerFrom(e.target.value)}
                      className="h-10 px-2 rounded-lg border border-gray-200 text-sm outline-none focus:ring-0"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase font-semibold text-gray-500 mb-1">Hasta</label>
                    <input
                      type="date"
                      value={ledgerTo}
                      onChange={(e) => setLedgerTo(e.target.value)}
                      className="h-10 px-2 rounded-lg border border-gray-200 text-sm outline-none focus:ring-0"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => loadLedger()}
                    className="h-10 px-4 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-800"
                  >
                    Actualizar
                  </button>
                </div>

                <div className="overflow-x-auto rounded-xl border border-gray-100">
                  <table className="w-full text-sm text-left min-w-[860px]">
                    <thead className="text-[11px] font-semibold uppercase text-gray-500 bg-gray-50 border-b border-gray-100">
                      <tr>
                        <th className="px-3 py-2">Fecha</th>
                        <th className="px-3 py-2">Tipo</th>
                        <th className="px-3 py-2">N.º</th>
                        <th className="px-3 py-2 hidden md:table-cell">Beneficiario</th>
                        <th className="px-3 py-2 hidden lg:table-cell">Categoría</th>
                        <th className="px-3 py-2 text-right">Importe</th>
                        <th className="px-3 py-2 text-right">Saldo factura</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {ledger.map((row) => (
                        <tr key={`${row.row_kind}-${row.record_id}`}>
                          <td className="px-3 py-2 tabular-nums text-gray-800">{row.date}</td>
                          <td className="px-3 py-2 text-gray-700">{row.transaction_type_label}</td>
                          <td className="px-3 py-2 font-mono text-xs text-gray-900">{row.reference_display}</td>
                          <td className="px-3 py-2 hidden md:table-cell text-gray-700">{row.beneficiary_label}</td>
                          <td className="px-3 py-2 hidden lg:table-cell text-gray-600 truncate max-w-[180px]" title={row.category_label}>
                            {row.category_label}
                          </td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums font-medium ${
                              Number(row.amount_signed) < 0 ? 'text-red-700' : 'text-gray-900'
                            }`}
                          >
                            {moneySigned(row.amount_signed, cur)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                            {row.bill_balance_due != null ? money(Number(row.bill_balance_due), cur) : '—'}
                          </td>
                        </tr>
                      ))}
                      {!ledger.length && (
                        <tr>
                          <td colSpan={7} className="px-3 py-8 text-center text-gray-500 text-sm">
                            Sin movimientos en el rango.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {tab === 'details' && (
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-gray-400 text-xs font-semibold uppercase">Nombre</dt>
                  <dd className="text-gray-900 font-medium">{vendor.name}</dd>
                </div>
                <div>
                  <dt className="text-gray-400 text-xs font-semibold uppercase">Razón social</dt>
                  <dd className="text-gray-800">{vendor.company_name || '—'}</dd>
                </div>
                <div>
                  <dt className="text-gray-400 text-xs font-semibold uppercase">Moneda</dt>
                  <dd className="font-mono text-gray-900">{cur}</dd>
                </div>
              </dl>
            )}

            {tab === 'notes' && (
              <pre className="whitespace-pre-wrap text-sm text-gray-800 rounded-xl bg-gray-50 border border-gray-100 p-4 min-h-[120px]">
                {vendor.notes?.trim()
                  ? vendor.notes.trim()
                  : 'Sin notas. Agrégalas al editar el proveedor.'}
              </pre>
            )}
          </div>
        </div>
      </div>

      <VendorFormModal
        open={editVendorOpen}
        initialVendor={vendor}
        onClose={() => setEditVendorOpen(false)}
        onSaved={() => {
          loadVendor()
          loadAll()
        }}
      />
    </div>
  )
}
