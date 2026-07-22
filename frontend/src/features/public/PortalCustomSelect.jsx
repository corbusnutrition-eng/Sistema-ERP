import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

/**
 * Select desplegable custom para el portal público (evita el picker nativo de iOS).
 */
export default function PortalCustomSelect({
  id,
  value = '',
  onChange,
  options = [],
  placeholder = 'Seleccionar…',
  disabled = false,
  required = false,
  className = '',
  buttonClassName = '',
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  const autoId = useId()
  const controlId = id || autoId
  const listboxId = `${controlId}-listbox`

  const selected = options.find((o) => String(o.value) === String(value)) ?? null

  useEffect(() => {
    if (!open) return undefined
    function onDocPointer(ev) {
      if (rootRef.current && !rootRef.current.contains(ev.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocPointer)
    document.addEventListener('touchstart', onDocPointer)
    return () => {
      document.removeEventListener('mousedown', onDocPointer)
      document.removeEventListener('touchstart', onDocPointer)
    }
  }, [open])

  const pick = useCallback(
    (next) => {
      onChange?.(String(next))
      setOpen(false)
    },
    [onChange],
  )

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        id={controlId}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => {
          if (!disabled) setOpen((o) => !o)
        }}
        className={`flex w-full min-h-[44px] items-center justify-between gap-2 rounded-xl border bg-white/[0.06] px-3 py-2.5 text-left text-sm outline-none transition touch-manipulation disabled:cursor-not-allowed disabled:opacity-50 ${
          open
            ? 'border-blue-500 text-slate-50 ring-2 ring-blue-500/30'
            : 'border-white/15 text-slate-50 hover:border-blue-500/45 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30'
        } ${buttonClassName}`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? 'font-medium text-slate-50' : 'text-slate-400'}`}>
          {selected?.label || placeholder}
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {required && !String(value || '').trim() ? (
        <input
          tabIndex={-1}
          required
          value=""
          readOnly
          aria-hidden
          className="pointer-events-none absolute h-0 w-0 opacity-0"
          onChange={() => {}}
        />
      ) : null}

      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-labelledby={controlId}
          className="absolute z-[200] mt-1.5 max-h-56 w-full overflow-y-auto rounded-xl border border-slate-600/80 bg-slate-900 py-1 shadow-lg shadow-black/50"
        >
          {options.length === 0 ? (
            <li className="px-3 py-2.5 text-sm text-slate-500">Sin opciones disponibles</li>
          ) : (
            options.map((opt) => {
              const isSel = String(opt.value) === String(value)
              return (
                <li key={String(opt.value)} role="option" aria-selected={isSel}>
                  <button
                    type="button"
                    onClick={() => pick(opt.value)}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition touch-manipulation ${
                      isSel
                        ? 'bg-indigo-500/20 font-medium text-indigo-50'
                        : 'text-slate-100 hover:bg-slate-800 active:bg-slate-700'
                    }`}
                  >
                    <span className="min-w-0 flex-1 break-words leading-snug">{opt.label}</span>
                    {isSel ? <Check size={14} className="shrink-0 text-indigo-300" aria-hidden /> : null}
                  </button>
                </li>
              )
            })
          )}
        </ul>
      ) : null}
    </div>
  )
}
