import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Check } from 'lucide-react'

export default function SaleTagsMultiSelect({ groups, value, onChange, disabled }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    function onDocMouseDown(e) {
      if (!open) return
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  const selectedSet = useMemo(() => new Set(Array.isArray(value) ? value : []), [value])

  function toggle(id) {
    const n = new Set(selectedSet)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    onChange(Array.from(n).sort((a, b) => a - b))
  }

  const summary = useMemo(() => {
    const ids = Array.isArray(value) ? value : []
    if (!ids.length) return 'Seleccionar etiquetas…'
    const names = []
    for (const g of groups || []) {
      for (const t of g.tags || []) {
        if (selectedSet.has(t.id)) names.push(t.name)
      }
    }
    if (names.length <= 2) return names.join(', ') || `${ids.length} etiquetas`
    return `${names.slice(0, 2).join(', ')} +${names.length - 2}`
  }, [groups, value, selectedSet])

  const hasGroups = Array.isArray(groups) && groups.some((g) => (g.tags || []).length > 0)

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl border border-gray-200 bg-white text-left text-sm ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-gray-300 text-gray-800'
        }`}
      >
        <span className="truncate text-gray-700">{summary}</span>
        <ChevronDown size={16} className={`text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-[70] mt-1 max-h-52 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg py-2">
          {!hasGroups ? (
            <p className="px-3 py-4 text-xs text-gray-500 text-center">
              No hay etiquetas. Usa «Administrar etiquetas» para crear grupos.
            </p>
          ) : (
            (groups || []).map((g) => {
              const tags = Array.isArray(g.tags) ? g.tags : []
              if (!tags.length) return null
              const sorted = [...tags].sort((a, b) =>
                String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'es', { sensitivity: 'base' }),
              )
              return (
                <div key={g.id} role="group" aria-label={g.name}>
                  <div className="sticky top-0 bg-gray-50/95 backdrop-blur px-3 py-1.5 text-[11px] font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-2 border-b border-gray-100">
                    <span className="w-2 h-2 rounded-full shrink-0 ring-1 ring-white shadow-sm" style={{ backgroundColor: g.color || '#64748B' }} />
                    <span className="truncate">{g.name}</span>
                  </div>
                  {sorted.map((t) => {
                    const sel = selectedSet.has(t.id)
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => toggle(t.id)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-gray-50 text-gray-800"
                      >
                        <span
                          className={`w-4 h-4 rounded border shrink-0 flex items-center justify-center ${
                            sel ? 'bg-blue-600 border-blue-600' : 'border-gray-300 bg-white'
                          }`}
                        >
                          {sel ? <Check size={11} className="text-white stroke-[3]" /> : null}
                        </span>
                        <span className="truncate">{t.name}</span>
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
