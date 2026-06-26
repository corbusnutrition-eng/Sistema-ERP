/** Skeleton/spinner localizado — solo dentro del contenedor de la tabla. */
export default function SalesTableSkeleton({ colSpan, isRefreshing }) {
  return (
    <>
      <tr>
        <td colSpan={colSpan} className="px-3 py-8 text-center text-gray-400 text-sm">
          <div className="flex items-center justify-center gap-2">
            <span
              className="w-4 h-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin"
              aria-hidden
            />
            {isRefreshing ? 'Actualizando ventas…' : 'Cargando ventas…'}
          </div>
        </td>
      </tr>
      {[...Array(4)].map((_, i) => (
        <tr key={`sk-${i}`} aria-hidden>
          <td colSpan={colSpan} className="px-3 py-3">
            <div className="h-10 bg-gray-100 rounded-lg animate-pulse" />
          </td>
        </tr>
      ))}
    </>
  )
}
