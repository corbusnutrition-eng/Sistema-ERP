/**
 * Pestañas de filtro por estado (pills + badges), compartidas entre Ventas y recargas BaaS.
 *
 * @typedef {{ id: string, label: string, badgeClass?: string }} StatusFilterTab
 */

/**
 * @param {{
 *   tabs: StatusFilterTab[],
 *   activeId: string,
 *   onChange: (id: string) => void,
 *   counts?: Record<string, number>,
 *   className?: string,
 *   wrap?: boolean,
 * }} props
 */
export default function StatusFilterTabs({
  tabs,
  activeId,
  onChange,
  counts = {},
  className = '',
  wrap = false,
}) {
  const list = Array.isArray(tabs) ? tabs : []

  return (
    <div
      className={`flex items-center gap-1 bg-gray-100 p-1 rounded-xl w-fit ${
        wrap ? 'flex-wrap' : ''
      } ${className}`.trim()}
      role="tablist"
      aria-label="Filtrar por estado"
    >
      {list.map((tab) => {
        const id = String(tab.id ?? '')
        const active = activeId === id
        const count = Number(counts[id] ?? 0)
        const showBadge = Number.isFinite(count) && count > 0
        const badgeClass = tab.badgeClass ?? 'bg-slate-500'

        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(id)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${
              active ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
            {showBadge ?
              <span
                className={`ml-1.5 px-1.5 py-0.5 text-[10px] font-bold text-white rounded-full ${badgeClass}`}
              >
                {count}
              </span>
            : null}
          </button>
        )
      })}
    </div>
  )
}
