import { useState, useRef, useEffect, useCallback } from 'react'
import { Bell, X, CreditCard, Clock, Wallet } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import api from '../../api/axios'

const POLL_INTERVAL_MS = 30_000

function notificationKey(item) {
  return `${item?.kind ?? 'unknown'}:${item?.id ?? ''}`
}

function kindIcon(kind) {
  if (kind === 'wallet_recharge') {
    return <Wallet size={14} className="text-violet-600" />
  }
  return <CreditCard size={14} className="text-amber-600" />
}

function kindIconBg(kind) {
  if (kind === 'wallet_recharge') return 'bg-violet-100'
  if (kind === 'client_payment') return 'bg-sky-100'
  return 'bg-amber-100'
}

/** Ruta deep-link según tipo de notificación (IDs del API). */
function notificationTargetPath(item) {
  const id = Number(item?.id)
  if (!Number.isFinite(id) || id < 1) return '/ventas'
  const kind = String(item?.kind ?? '').toLowerCase()
  if (kind === 'wallet_recharge') {
    return `/equipo/distribuidores?open_recharge=${id}`
  }
  if (kind === 'sale') {
    return `/ventas?open_sale=${id}`
  }
  if (kind === 'client_payment') {
    return `/ventas?payment_id=${id}`
  }
  return String(item?.path || '/ventas')
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [dismissedKeys, setDismissedKeys] = useState(() => new Set())
  const panelRef = useRef(null)
  const navigate = useNavigate()

  const fetchPending = useCallback(async () => {
    try {
      const { data } = await api.get('/api/v1/notifications/pending-payments')
      const list = Array.isArray(data?.items) ? data.items : []
      setItems(list)
    } catch {
      // silently ignore – user may not be logged in yet
    }
  }, [])

  useEffect(() => {
    fetchPending()
    const timer = setInterval(fetchPending, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [fetchPending])

  // Refrescar al abrir el panel y cuando la pestaña vuelve a estar visible
  useEffect(() => {
    if (open) fetchPending()
  }, [open, fetchPending])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchPending()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [fetchPending])

  useEffect(() => {
    const onRefresh = () => fetchPending()
    window.addEventListener('notifications:refresh-payments', onRefresh)
    return () => window.removeEventListener('notifications:refresh-payments', onRefresh)
  }, [fetchPending])

  useEffect(() => {
    function handleClickOutside(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const visibleItems = items.filter((item) => !dismissedKeys.has(notificationKey(item)))
  const count = visibleItems.length

  function dismiss(item) {
    const key = notificationKey(item)
    setDismissedKeys((prev) => new Set(prev).add(key))
  }

  function goToItem(item) {
    setOpen(false)
    navigate(notificationTargetPath(item))
  }

  function goToDefaultModule() {
    setOpen(false)
    navigate('/ventas')
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        aria-label="Notificaciones"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <Bell size={18} />
        {count > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 px-0.5 flex items-center justify-center text-[10px] font-bold bg-red-500 text-white rounded-full leading-none">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-2xl shadow-xl ring-1 ring-gray-200 z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-gray-900">Pagos pendientes</h3>
              {count > 0 && (
                <span className="px-1.5 py-0.5 text-[10px] font-bold bg-red-100 text-red-600 rounded-full">
                  {count} nuevos
                </span>
              )}
            </div>
            <button
              onClick={goToDefaultModule}
              className="text-xs text-blue-600 hover:text-blue-700 font-medium transition-colors"
            >
              Ir a Ventas →
            </button>
          </div>

          <ul className="max-h-80 overflow-y-auto divide-y divide-gray-50">
            {count === 0 && (
              <li className="px-4 py-8 text-center text-sm text-gray-400">
                Sin pagos pendientes de aprobación
              </li>
            )}

            {visibleItems.map((item) => {
              const key = notificationKey(item)
              const amount = Number(item.amount)
              const amountLabel = Number.isFinite(amount) ? amount.toFixed(2) : '—'
              const currency = String(item.currency || 'USD')
              const label = String(item.label || 'Pago pendiente')
              const clientName = String(item.client_name || 'Cliente')

              return (
                <li
                  key={key}
                  className="flex items-start gap-3 px-4 py-3 bg-amber-50/40 hover:bg-amber-50 transition-colors"
                >
                  <div
                    className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${kindIconBg(item.kind)}`}
                  >
                    {kindIcon(item.kind)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-1">
                      <p className="text-xs font-semibold text-gray-900 truncate">
                        {clientName}
                      </p>
                      <button
                        onClick={() => dismiss(item)}
                        className="shrink-0 p-0.5 text-gray-300 hover:text-gray-500 rounded transition-colors"
                        title="Descartar"
                        type="button"
                      >
                        <X size={12} />
                      </button>
                    </div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mt-0.5">
                      {label}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {amountLabel} {currency} · Pendiente de revisión
                    </p>
                    <button
                      type="button"
                      onClick={() => goToItem(item)}
                      className="mt-1.5 text-[10px] font-semibold text-amber-600 hover:text-amber-700 transition-colors inline-flex items-center gap-1"
                    >
                      <Clock size={10} />
                      Aprobar pago
                    </button>
                  </div>
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0 mt-2" />
                </li>
              )
            })}
          </ul>

          <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50/50">
            <p className="text-center text-xs text-gray-400">
              Actualización automática cada 30 segundos
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
