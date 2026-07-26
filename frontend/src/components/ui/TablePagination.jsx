export const ITEMS_PER_PAGE = 10

export default function TablePagination({
  currentPage,
  totalItems,
  itemsPerPage = ITEMS_PER_PAGE,
  onPageChange,
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage))
  const page = Math.min(Math.max(1, currentPage), totalPages)
  const rangeStart = totalItems === 0 ? 0 : (page - 1) * itemsPerPage + 1
  const rangeEnd = Math.min(page * itemsPerPage, totalItems)

  if (totalItems === 0) return null

  return (
    <div className="px-6 py-3 border-t border-gray-100 bg-gray-50/50 flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs text-gray-400 tabular-nums">
        Mostrando {rangeStart}–{rangeEnd} de {totalItems} registros
      </span>
      {totalPages > 1 && onPageChange ? (
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
            className="h-8 px-3 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-md shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Anterior
          </button>
          <span className="text-xs text-gray-500 tabular-nums min-w-[4.5rem] text-center">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            className="h-8 px-3 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-md shadow-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Siguiente
          </button>
        </div>
      ) : null}
    </div>
  )
}
