import StatusFilterTabs from '../../../components/ui/StatusFilterTabs'

/** Pestañas de estado — siempre montadas; el fetch de datos es independiente. */
export default function SalesTabs({ tabs, activeId, onChange, counts }) {
  return (
    <div className="min-h-[2.75rem]" aria-label="Pestañas de estado de ventas">
      <StatusFilterTabs tabs={tabs} activeId={activeId} onChange={onChange} counts={counts} />
    </div>
  )
}
