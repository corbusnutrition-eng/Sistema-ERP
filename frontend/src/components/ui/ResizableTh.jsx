/**
 * Header de columna redimensionable (arrastre en el borde derecho).
 */
export default function ResizableTh({
  columnKey,
  width,
  onResizeStart,
  children,
  align = 'left',
  className = '',
  resizable = true,
}) {
  const textAlign =
    align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'

  const widthStyle =
    width != null
      ? {
          width: typeof width === 'number' ? `${width}px` : width,
          // Evita que table-fixed aplaste el encabezado a 1 letra en móvil
          minWidth: typeof width === 'number' ? `${Math.min(Number(width) || 72, 72)}px` : '4.5rem',
        }
      : undefined

  return (
    <th
      className={`relative px-3 py-2 ${textAlign} text-[11px] font-semibold text-gray-500 uppercase tracking-wide ${className}`}
      style={widthStyle}
    >
      <span className="block whitespace-nowrap pr-2 leading-tight">{children}</span>
      {resizable && columnKey && onResizeStart ? (
        <span
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionar columna"
          className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-blue-400 active:bg-blue-600 z-10 transition-colors"
          onMouseDown={(event) => onResizeStart(columnKey, event)}
        />
      ) : null}
    </th>
  )
}
