import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { ArrowLeft, BarChart3, ChevronDown, CreditCard, Plus } from 'lucide-react'
import api from '../../api/axios'
import NewPaymentMethodModal from './NewPaymentMethodModal'

const MENU_APPROX_HEIGHT = 120
const MENU_GAP = 8

function PaymentMethodRowActions({
  method,
  onEdit,
  onToggleActive,
  onReport,
}) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef(null)
  const anchorRef = useRef(null)
  const menuPortalRef = useRef(null)
  const [menuStyle, setMenuStyle] = useState(null)

  const isActive = method?.is_active !== false

  const menuItems = isActive
    ? [
        { label: 'Editar', onClick: () => onEdit?.(method.id) },
        { label: 'Desactivar', onClick: () => onToggleActive?.(method.id, false), danger: true },
      ]
    : [
        { label: 'Activar', onClick: () => onToggleActive?.(method.id, true) },
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
        minWidth: 168,
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
        className="py-1 bg-white rounded-xl shadow-xl ring-1 ring-gray-200 border border-gray-100 text-sm"
      >
        {menuItems.map(({ label, onClick, danger }) => (
          <button
            key={label}
            type="button"
            role="menuitem"
            className={`w-full px-3 py-2.5 text-left transition-colors ${
              danger
                ? 'text-red-700 hover:bg-red-50'
                : 'text-gray-800 hover:bg-gray-50'
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
    <div
      ref={wrapperRef}
      className="inline-flex rounded-xl shadow-sm"
      data-payment-method-row-actions
    >
      <button
        type="button"
        onClick={() => {
          onReport?.(method)
          setOpen(false)
        }}
        className="inline-flex items-center px-3 py-2 rounded-l-xl border border-gray-200 bg-white text-xs font-semibold text-gray-800 hover:bg-gray-50"
      >
        Generar informe
      </button>
      <div className="relative flex border-l border-gray-200" ref={anchorRef}>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="inline-flex items-center px-2 py-2 rounded-r-xl border border-l-0 border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100"
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <ChevronDown size={16} />
        </button>
      </div>
      {menuNode}
    </div>
  )
}

export default function PaymentMethodsList() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)

  const [methodToEdit, setMethodToEdit] = useState(null)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [togglingId, setTogglingId] = useState(null)

  const fetchMethods = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { data } = await api.get('/api/v1/payment-methods/', { params: { include_inactive: true } })
      setRows(Array.isArray(data) ? data : [])
    } catch {
      setError('No se pudieron cargar los métodos de pago.')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchMethods()
  }, [fetchMethods])

  function showToast(msg, ok = true) {
    setToast({ msg, ok })
    window.setTimeout(() => setToast(null), 4000)
  }

  async function handleToggleActive(methodId, nextActive) {
    const method = rows.find((r) => Number(r.id) === Number(methodId))
    if (!method) return

    const actionLabel = nextActive ? 'activar' : 'desactivar'
    if (!window.confirm(`¿Desea ${actionLabel} el método «${method.name}»?`)) return

    setTogglingId(methodId)
    try {
      const { data } = await api.patch(`/api/v1/payment-methods/${methodId}`, {
        is_active: nextActive,
      })
      setRows((prev) =>
        prev.map((r) =>
          Number(r.id) === Number(methodId)
            ? { ...r, is_active: data?.is_active ?? nextActive }
            : r,
        ),
      )
      showToast(nextActive ? 'Método activado.' : 'Método desactivado.')
    } catch (err) {
      const d = err?.response?.data?.detail
      showToast(typeof d === 'string' ? d : `No se pudo ${actionLabel} el método.`, false)
    } finally {
      setTogglingId(null)
    }
  }

  function handleEditById(methodId) {
    const method = rows.find((r) => Number(r.id) === Number(methodId))
    if (!method || method.is_active === false) return
    setMethodToEdit(method)
    setIsModalOpen(true)
  }

  function handleReport(method) {
    showToast(`Informe de «${method?.name ?? 'método'}» en desarrollo.`, true)
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12 px-4">
      <div className="flex flex-wrap items-center gap-4 justify-between">
        <Link
          to="/listas"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
        >
          <ArrowLeft size={16} />
          Volver a Listas
        </Link>
        <button
          type="button"
          onClick={() => {
            setMethodToEdit(null)
            setIsModalOpen(true)
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 shadow-sm shrink-0"
        >
          <Plus size={18} />
          + Nuevo
        </button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <Link to="/listas" className="text-blue-600 hover:text-blue-800 font-medium">
              Listas
            </Link>
            <span className="text-gray-300">/</span>
            <span className="text-gray-700 font-medium">Métodos de pago</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-xl bg-violet-50 flex items-center justify-center ring-1 ring-violet-100">
              <CreditCard size={20} className="text-violet-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Métodos de Pago</h1>
              <p className="text-sm text-gray-500 mt-0.5">Clasificación de cobros (QuickBooks-style).</p>
            </div>
          </div>
        </div>
      </div>

      {toast && (
        <div
          className={`rounded-xl px-4 py-3 text-sm font-medium ring-1 ${
            toast.ok ? 'bg-green-50 text-green-800 ring-green-200' : 'bg-red-50 text-red-800 ring-red-200'
          }`}
        >
          {toast.msg}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-visible">
        <div className="px-6 py-3 border-b border-gray-100 bg-gray-50/80 flex items-center gap-2">
          <BarChart3 size={14} className="text-gray-400" />
          <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Lista</span>
        </div>
        <div className="px-6 py-3 border-b border-gray-100 bg-white">
          <div className="grid grid-cols-12 gap-2 text-[11px] font-bold uppercase tracking-wider text-gray-500">
            <div className="col-span-8">Nombre</div>
            <div className="col-span-4 text-right">Acción</div>
          </div>
        </div>

        {loading ? (
          <div className="p-10 text-center text-gray-400 text-sm">Cargando…</div>
        ) : error ? (
          <div className="p-10 text-center text-red-600 text-sm">{error}</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-gray-500 text-sm">
            No hay métodos. Pulsa «+ Nuevo» para crear el primero.
          </div>
        ) : (
          <ul className="divide-y divide-gray-50 overflow-visible">
            {rows.map((method) => {
              const isActive = method?.is_active !== false
              return (
                <li
                  key={method.id}
                  className={`grid grid-cols-12 gap-2 items-center px-6 py-3.5 text-sm ${
                    isActive ? '' : 'bg-gray-50/80'
                  }`}
                >
                  <div className="col-span-8 flex items-center gap-2 min-w-0">
                    <span
                      className={`font-medium truncate ${
                        isActive ? 'text-gray-900' : 'text-gray-500 line-through decoration-gray-400'
                      }`}
                    >
                      {method.name}
                    </span>
                    {!isActive ? (
                      <span className="shrink-0 inline-flex items-center rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-600">
                        Inactivo
                      </span>
                    ) : null}
                  </div>
                  <div className="col-span-4 flex justify-end">
                    <PaymentMethodRowActions
                      method={method}
                      onEdit={handleEditById}
                      onToggleActive={handleToggleActive}
                      onReport={handleReport}
                    />
                    {togglingId === method.id ? (
                      <span className="sr-only">Actualizando estado…</span>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <NewPaymentMethodModal
        isOpen={isModalOpen}
        methodToEdit={methodToEdit}
        onClose={() => {
          setIsModalOpen(false)
          setMethodToEdit(null)
        }}
        onSuccess={fetchMethods}
        onError={(msg) => showToast(msg, false)}
      />
    </div>
  )
}
