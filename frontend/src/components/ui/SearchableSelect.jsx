import { createPortal } from 'react-dom'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ChevronDown } from 'lucide-react'

/** Panel alineado con ERP: mismo shadow en todos los desplegables. */
export const SEARCHABLE_SELECT_PANEL_CLASSES =
  'bg-white border border-gray-300 rounded-md shadow-lg overflow-hidden flex flex-col max-h-[min(280px,50vh)]'

const TRIGGER_CLASSES =
  'box-border w-full min-h-[40px] h-10 px-3 flex items-center justify-between gap-2 rounded-md border border-gray-300 bg-white text-left text-sm text-gray-900 focus:outline-none focus-visible:outline-none focus-visible:ring-0'

function triggerClasses(disabled) {
  return `${TRIGGER_CLASSES} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:border-gray-400'}`
}

/**
 * Combobox estándar del ERP (buscador, portal contra recortes en modales, opción "+ Agregar nuevo").
 * Altura uniforme `h-10`, borde gris, sin anillo azul de foco del navegador.
 *
 * `options[].searchText`: si existe, la caja «Buscar…» filtra por este texto en lugar del `label` (compat. modo nombre/IPTV como Nueva venta).
 */
export default function SearchableSelect({
  value,
  onChange,
  options = [],
  placeholder = '',
  disabled = false,
  /** Primera fila para limpiar valor; `null` u omisión con `hideClear`: sin fila vacía */
  clearLabel = '—',
  hideClear = false,
  onAddNew,
  addNewLabel = '+ Agregar nuevo',
  minPanelWidth = 200,
  className,
  /** z-index del panel portaleado (`fixed`, en document.body); debe estar por encima de modales (suelen llevar z-200–300). */
  dropdownZClass = 'z-[6000]',
  /** Muestra la caja «Buscar…» en el panel; desactívalo en listas cortas (p. ej. presets de filtro). */
  showSearch = true,
}) {
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 240 })

  const selected = useMemo(
    () => options.find((o) => String(o.value) === String(value) && !o.disabled),
    [options, value],
  )

  const placePanel = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const w = Math.max(r.width, minPanelWidth)
    setCoords({ top: r.bottom + 4, left: r.left, width: w })
  }, [minPanelWidth])

  const closePanel = useCallback(() => {
    setOpen(false)
    setFilter('')
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    placePanel()
  }, [open, placePanel, options.length, filter])

  useEffect(() => {
    if (!open) return
    const reposition = () => placePanel()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, placePanel])

  useEffect(() => {
    if (!open) return
    function onMd(e) {
      const t = triggerRef.current
      const p = panelRef.current
      if (t?.contains(e.target) || p?.contains(e.target)) return
      closePanel()
    }
    document.addEventListener('mousedown', onMd)
    return () => document.removeEventListener('mousedown', onMd)
  }, [open, closePanel])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => {
      if (o.disabled) return false
      const haystack = o.searchText != null ? String(o.searchText) : String(o.label ?? '')
      return haystack.toLowerCase().includes(q)
    })
  }, [options, filter])

  function pick(v) {
    onChange(v)
    closePanel()
  }

  function handleAdd() {
    closePanel()
    onAddNew?.()
  }

  const showClear = !hideClear && clearLabel != null && clearLabel !== false
  const displayLine = selected ? selected.label : placeholder || clearLabel || ''

  const panel =
    open &&
    createPortal(
      <div
        ref={panelRef}
        role="listbox"
        aria-label={placeholder || String(clearLabel) || 'Lista'}
        className={`${SEARCHABLE_SELECT_PANEL_CLASSES} fixed ${dropdownZClass}`}
        style={{ top: coords.top, left: coords.left, width: coords.width }}
      >
        {showSearch && (
          <div className="p-2 border-b border-gray-200 shrink-0">
            <input
              autoFocus
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              className="w-full h-8 px-2 rounded border border-gray-300 text-sm text-gray-900 bg-white outline-none focus:outline-none focus:ring-0"
              placeholder="Buscar…"
            />
          </div>
        )}
        {onAddNew && (
          <button
            type="button"
            role="option"
            className="text-left px-3 py-2 text-sm font-medium text-blue-600 hover:bg-gray-100 border-b border-gray-100 shrink-0"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleAdd}
          >
            {addNewLabel}
          </button>
        )}
        <div className="overflow-y-auto min-h-0">
          {showClear && (
            <button
              type="button"
              role="option"
              className="w-full text-left px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 border-b border-gray-100"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick('')}
            >
              {clearLabel}
            </button>
          )}
          {!filtered.some((o) => !o.disabled) && filter.trim() ? (
            <div className="px-3 py-2 text-sm text-gray-500">Sin coincidencias</div>
          ) : (
            filtered.map((o, idx) => {
              const keyBase = `${String(o.value)}-${idx}`
              if (o.disabled) {
                return (
                  <div
                    key={keyBase}
                    role="presentation"
                    className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400 bg-gray-50 border-b border-gray-100 cursor-default select-none"
                  >
                    {o.label}
                  </div>
                )
              }
              return (
                <button
                  key={keyBase}
                  type="button"
                  role="option"
                  aria-selected={String(o.value) === String(value)}
                  className={`w-full text-left px-3 py-2 text-sm text-gray-900 hover:bg-gray-100 ${String(o.value) === String(value) ? 'bg-gray-50 font-medium' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o.value)}
                >
                  {o.label}
                </button>
              )
            })
          )}
        </div>
      </div>,
      document.body,
    )

  return (
    <div className={className ?? 'w-full'}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={triggerClasses(disabled)}
        onClick={() => {
          if (disabled) return
          setOpen((v) => {
            const next = !v
            if (next) setFilter('')
            return next
          })
        }}
      >
        <span
          className={`truncate min-w-0 ${selected ? '' : 'text-gray-500'}`}
          title={typeof displayLine === 'string' ? displayLine : ''}
        >
          {displayLine}
        </span>
        <ChevronDown size={18} className="text-gray-500 shrink-0" aria-hidden />
      </button>
      {panel}
    </div>
  )
}
