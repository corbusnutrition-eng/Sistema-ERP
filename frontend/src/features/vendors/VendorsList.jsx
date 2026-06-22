import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDown,
  MoreHorizontal,
  Building2,
  Plus,
  Search,
  Mail,
  Phone,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import Swal from 'sweetalert2'
import api from '../../api/axios'
import { useModal } from '../../context/ModalContext'
import { normalizeCurrencyCode } from '../../lib/currencyCode'

const QB_GREEN = '#2ca01c'
const MENU_GAP = 8
const MENU_APPROX_HEIGHT = 220

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

function VendorRowMenu({ vendor, onEdit, onDelete, onCreateBill, onPayBills, onViewDetail }) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef(null)
  const anchorRef = useRef(null)
  const menuPortalRef = useRef(null)
  const [menuStyle, setMenuStyle] = useState(null)

  const items = [
    { label: 'Editar', onClick: onEdit },
    { label: 'Eliminar', onClick: onDelete, danger: true },
    { label: 'Ver detalle', onClick: onViewDetail },
    { label: 'Crear factura', onClick: onCreateBill },
    { label: 'Pagar facturas', onClick: onPayBills },
  ]

  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(null)
      return
    }
    const anchor = anchorRef.current
    if (!anchor) return

    const computePosition = () => {
      const rect = anchor.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP
      const spaceAbove = rect.top - MENU_GAP
      const openUpward = spaceBelow < MENU_APPROX_HEIGHT && spaceAbove > spaceBelow

      setMenuStyle({
        position: 'fixed',
        right: Math.max(MENU_GAP, window.innerWidth - rect.right),
        zIndex: 9999,
        minWidth: 176,
        ...(openUpward
          ? { bottom: window.innerHeight - rect.top + MENU_GAP }
          : { top: rect.bottom + MENU_GAP }),
      })
    }

    computePosition()
    window.addEventListener('scroll', computePosition, true)
    window.addEventListener('resize', computePosition)
    return () => {
      window.removeEventListener('scroll', computePosition, true)
      window.removeEventListener('resize', computePosition)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function handlePointerDown(e) {
      const t = e.target
      if (wrapperRef.current?.contains(t)) return
      if (menuPortalRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const menuNode =
    open &&
    menuStyle &&
    typeof document !== 'undefined' &&
    createPortal(
      <div
        ref={menuPortalRef}
        role="menu"
        style={menuStyle}
        className="py-1 bg-white rounded-lg shadow-xl border border-gray-100 text-sm"
      >
        {items.map(({ label, onClick, danger }) => (
          <button
            key={label}
            type="button"
            role="menuitem"
            className={`w-full text-left px-3 py-2 transition-colors ${
              danger ? 'text-red-700 hover:bg-red-50' : 'text-gray-800 hover:bg-gray-50'
            }`}
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
              onClick?.()
            }}
          >
            {label}
          </button>
        ))}
      </div>,
      document.body,
    )

  return (
    <div ref={wrapperRef} className="relative inline-block text-left">
      <button
        type="button"
        ref={anchorRef}
        className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-600"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((x) => !x)
        }}
        aria-label="Acciones"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <MoreHorizontal size={16} />
      </button>
      {menuNode}
    </div>
  )
}

export default function VendorsList() {
  const navigate = useNavigate()
  const { openVendorBillModal, openPayBillsModal, openVendorForm } = useModal()

  const [rows, setRows] = useState([])
  const [stats, setStats] = useState({ never_billed: 0, with_open_balance: 0, paid_up: 0 })
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [hdrOpen, setHdrOpen] = useState(false)
  const hdrRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [l, s] = await Promise.all([
        api.get('/api/v1/vendors/'),
        api.get('/api/v1/vendors/stats/dashboard/'),
      ])
      setRows(Array.isArray(l.data) ? l.data : [])
      setStats({
        never_billed: Number(s?.data?.never_billed ?? 0),
        with_open_balance: Number(s?.data?.with_open_balance ?? 0),
        paid_up: Number(s?.data?.paid_up ?? 0),
      })
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    function onVendorChanged() {
      load()
    }
    window.addEventListener('vendors:changed', onVendorChanged)
    return () => window.removeEventListener('vendors:changed', onVendorChanged)
  }, [load])

  useEffect(() => {
    if (!hdrOpen) return
    function onDoc(e) {
      if (hdrRef.current && !hdrRef.current.contains(e.target)) setHdrOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [hdrOpen])

  const ql = q.trim().toLowerCase()
  const filtered = !ql
    ? rows
    : rows.filter((r) => {
        const blob = `${r.name} ${r.company_name || ''} ${r.email || ''} ${r.phone || ''}`.toLowerCase()
        return blob.includes(ql)
      })

  async function handleDeleteVendor(vendor) {
    const hasHistory = Number(vendor.bill_count ?? 0) > 0
    const html = hasHistory
      ? `<p class="text-sm text-left text-slate-700">«${vendor.name}» tiene facturas o pagos registrados y no puede eliminarse desde aquí.</p>`
      : `<p class="text-sm text-left text-slate-700">Se eliminará permanentemente a <strong>${vendor.name}</strong>. Esta acción no se puede deshacer.</p>`

    const result = await Swal.fire({
      title: hasHistory ? 'No se puede eliminar' : '¿Eliminar proveedor?',
      html,
      icon: hasHistory ? 'info' : 'warning',
      showCancelButton: !hasHistory,
      confirmButtonColor: hasHistory ? '#2563eb' : '#dc2626',
      cancelButtonColor: '#64748b',
      confirmButtonText: hasHistory ? 'Entendido' : 'Sí, eliminar',
      cancelButtonText: 'Cancelar',
    })

    if (hasHistory || !result.isConfirmed) return

    try {
      await api.delete(`/api/v1/vendors/${vendor.id}`)
      setRows((prev) => prev.filter((r) => Number(r.id) !== Number(vendor.id)))
      await load()
      window.dispatchEvent(new CustomEvent('vendors:changed'))
      await Swal.fire({
        icon: 'success',
        title: 'Proveedor eliminado',
        timer: 2200,
        showConfirmButton: false,
      })
    } catch (err) {
      const d = err?.response?.data?.detail
      await Swal.fire({
        icon: 'error',
        title: 'No se pudo eliminar',
        text: typeof d === 'string' ? d : 'Intenta de nuevo más tarde.',
      })
    }
  }

  return (
    <div className="space-y-6 pb-16">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Proveedores</h1>
        <p className="text-sm text-gray-500 mt-1">Cuentas por pagar · facturas y pagos</p>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div ref={hdrRef} className="relative">
            <button
              type="button"
              style={{ backgroundColor: QB_GREEN }}
              className="inline-flex items-center gap-2 text-white px-5 py-2.5 rounded-md font-semibold text-sm shadow-sm hover:opacity-95"
              onClick={() => setHdrOpen((o) => !o)}
            >
              Nuevo proveedor <ChevronDown size={18} strokeWidth={2.25} />
            </button>
            {hdrOpen && (
              <div className="absolute left-0 z-50 mt-2 w-64 bg-white rounded-lg shadow-xl border border-gray-100 py-2 text-sm">
                <button
                  type="button"
                  className="w-full text-left px-4 py-2.5 hover:bg-gray-50 font-medium flex items-center gap-2 text-gray-800"
                  onClick={() => {
                    setHdrOpen(false)
                    openVendorForm({ afterSave: () => load() })
                  }}
                >
                  <Building2 size={15} className="text-gray-400" /> Agregar proveedor
                </button>
                <button
                  type="button"
                  className="w-full text-left px-4 py-2.5 hover:bg-gray-50 font-medium flex items-center gap-2 text-gray-800"
                  onClick={() => {
                    setHdrOpen(false)
                    openVendorBillModal({})
                  }}
                >
                  <Plus size={15} className="text-gray-400" /> Factura de proveedor
                </button>
                <button
                  type="button"
                  className="w-full text-left px-4 py-2.5 hover:bg-gray-50 font-medium flex items-center gap-2 text-gray-800"
                  onClick={() => {
                    setHdrOpen(false)
                    openPayBillsModal({})
                  }}
                >
                  <Plus size={15} className="text-gray-400" /> Pagar facturas
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="relative w-full md:w-auto md:min-w-[280px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={17} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar proveedores…"
            className="w-full pl-10 pr-3 h-10 rounded-lg border border-gray-200 bg-white text-sm outline-none focus:ring-0"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border border-blue-200 bg-gradient-to-br from-blue-600 to-blue-500 text-white shadow-sm px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide opacity-90">Sin facturas</p>
          <p className="text-4xl font-bold tabular-nums mt-1">{stats.never_billed}</p>
          <p className="text-[11px] opacity-95 mt-1">Sin factura registrada · sin movimiento CxP</p>
        </div>
        <div className="rounded-xl border border-orange-200 bg-gradient-to-br from-orange-600 to-orange-500 text-white shadow-sm px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide opacity-90">Sin pagar</p>
          <p className="text-4xl font-bold tabular-nums mt-1">{stats.with_open_balance}</p>
          <p className="text-[11px] opacity-95 mt-1">Saldo pendiente en facturas de proveedor</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-700 to-green-600 text-white shadow-sm px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide opacity-90">Pagadas · al día</p>
          <p className="text-4xl font-bold tabular-nums mt-1">{stats.paid_up}</p>
          <p className="text-[11px] opacity-95 mt-1">Con facturas y saldo cero actual</p>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-visible">
        <div className="overflow-x-auto overflow-y-visible">
          <table className="w-full text-sm text-left min-w-[960px]">
            <thead className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="px-4 py-3 w-12">
                  <input type="checkbox" disabled className="rounded border-gray-300" aria-label="Seleccionar todos" />
                </th>
                <th className="px-4 py-3">Proveedor</th>
                <th className="px-4 py-3 hidden lg:table-cell">Razón social</th>
                <th className="px-4 py-3 hidden md:table-cell">Teléfono</th>
                <th className="px-4 py-3 hidden lg:table-cell">Correo</th>
                <th className="px-4 py-3">Moneda</th>
                <th className="px-4 py-3 text-right">Saldo pendiente</th>
                <th className="px-4 py-3 text-right">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-500">
                    Cargando…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-gray-500">
                    Sin proveedores con este criterio.
                  </td>
                </tr>
              ) : (
                filtered.map((v) => (
                  <tr
                    key={v.id}
                    className={`hover:bg-gray-50 cursor-pointer ${v.has_overdue ? 'bg-orange-50/40' : ''}`}
                    onClick={() => navigate(`/contabilidad/proveedores/${v.id}`)}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="rounded border-gray-300" disabled aria-label={`Sel ${v.name}`} />
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">{v.name}</td>
                    <td className="px-4 py-3 hidden lg:table-cell text-gray-600">{v.company_name || '—'}</td>
                    <td className="px-4 py-3 hidden md:table-cell text-gray-600">
                      <span className="inline-flex items-center gap-1">
                        <Phone size={13} className="text-gray-400 shrink-0" />
                        {v.phone || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-gray-600 truncate max-w-[200px]" title={v.email || ''}>
                      <span className="inline-flex items-center gap-1">
                        <Mail size={13} className="text-gray-400 shrink-0" />
                        {v.email || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-800">{normalizeCurrencyCode(v.currency || 'USD', 'USD')}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">
                      <span className={Number(v.balance_pending) > 0 ? 'text-orange-700' : 'text-gray-800'}>
                        {money(v.balance_pending, v.currency)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <VendorRowMenu
                        vendor={v}
                        onEdit={() =>
                          openVendorForm({
                            vendor: v,
                            afterSave: () => load(),
                          })
                        }
                        onDelete={() => void handleDeleteVendor(v)}
                        onViewDetail={() => navigate(`/contabilidad/proveedores/${v.id}`)}
                        onCreateBill={() => openVendorBillModal({ vendorId: v.id })}
                        onPayBills={() => openPayBillsModal({ vendorId: v.id })}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
