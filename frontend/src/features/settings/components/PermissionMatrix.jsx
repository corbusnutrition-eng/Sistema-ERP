import { useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight } from 'lucide-react'
import { moduleAccessSummary } from '../../../lib/permissionMatrix'

function MatrixCheckCell({ checked, readOnly, onChange, label }) {
  if (readOnly) {
    return (
      <td className="px-3 py-2.5 text-center">
        {checked ? (
          <Check size={16} className="inline text-gray-800" strokeWidth={2.5} aria-label={`${label} — permitido`} />
        ) : (
          <span className="inline-block w-4" aria-hidden />
        )}
      </td>
    )
  }

  return (
    <td className="px-3 py-2.5 text-center">
      <input
        type="checkbox"
        checked={Boolean(checked)}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 cursor-pointer"
        aria-label={label}
      />
    </td>
  )
}

function ModuleAccordion({
  module,
  actions,
  grantedSet,
  readOnly,
  onToggle,
  defaultOpen = false,
}) {
  const [open, setOpen] = useState(defaultOpen)
  const summary = useMemo(() => moduleAccessSummary(module, grantedSet), [module, grantedSet])

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-3 px-4 py-4 text-left hover:bg-gray-50/80 transition-colors"
      >
        {open ? (
          <ChevronDown size={18} className="text-gray-500 shrink-0 mt-0.5" />
        ) : (
          <ChevronRight size={18} className="text-gray-500 shrink-0 mt-0.5" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-semibold text-gray-900">{module.label}</span>
            <span
              className={`text-sm ${
                summary.level === 'none'
                  ? 'text-gray-500'
                  : summary.level === 'full'
                    ? 'text-emerald-700'
                    : 'text-amber-700'
              }`}
            >
              {summary.label}
            </span>
          </div>
          {!open && (
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">
              {summary.withAccess.length > 0 && (
                <span>Con acceso: {summary.withAccess.join(', ')}</span>
              )}
              {summary.withAccess.length > 0 && summary.withoutAccess.length > 0 && ' · '}
              {summary.withoutAccess.length > 0 && (
                <span>Sin acceso: {summary.withoutAccess.join(', ')}</span>
              )}
            </p>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-100 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/60">
                <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  &nbsp;
                </th>
                {actions.map((action) => (
                  <th
                    key={action.id}
                    className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide text-gray-500 whitespace-nowrap"
                  >
                    {action.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(module.rows ?? []).map((row) => (
                <tr key={row.id} className="hover:bg-gray-50/40">
                  <td className="px-4 py-2.5 text-gray-800 font-medium whitespace-nowrap">{row.label}</td>
                  {actions.map((action) => {
                    const permKey = row.cells?.[action.id]
                    if (!permKey) {
                      return <td key={action.id} className="px-3 py-2.5" />
                    }
                    const cellLabel = `${row.label} — ${action.label}`
                    return (
                      <MatrixCheckCell
                        key={action.id}
                        checked={grantedSet.has(permKey)}
                        readOnly={readOnly}
                        onChange={(enabled) => onToggle(permKey, enabled)}
                        label={cellLabel}
                      />
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function PermissionMatrix({
  modules = [],
  actions = [],
  granted = [],
  readOnly = false,
  onChange,
  loading = false,
}) {
  const grantedSet = useMemo(() => new Set(granted), [granted])

  function handleToggle(permissionKey, enabled) {
    if (readOnly || !onChange) return
    const next = new Set(grantedSet)
    if (enabled) next.add(permissionKey)
    else next.delete(permissionKey)
    onChange([...next])
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500">
        Cargando matriz de permisos…
      </div>
    )
  }

  if (!modules.length) {
    return (
      <div className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-6 text-sm text-amber-800">
        No se pudo cargar la matriz de permisos.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {modules.map((mod, idx) => (
        <ModuleAccordion
          key={mod.id}
          module={mod}
          actions={actions}
          grantedSet={grantedSet}
          readOnly={readOnly}
          onToggle={handleToggle}
          defaultOpen={idx === 0}
        />
      ))}
    </div>
  )
}
