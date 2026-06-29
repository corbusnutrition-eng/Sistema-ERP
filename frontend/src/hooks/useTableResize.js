import { useCallback, useRef, useState } from 'react'

const MIN_COLUMN_WIDTH = 60

/**
 * Hook para redimensionar columnas de tablas arrastrando el borde del header.
 * @param {Record<string, number | string>} initialWidths - anchos iniciales (px o %)
 * @param {{ minWidth?: number }} [options]
 */
export function useTableResize(initialWidths, options = {}) {
  const minWidth = options.minWidth ?? MIN_COLUMN_WIDTH
  const [columnWidths, setColumnWidths] = useState(initialWidths)
  const resizingRef = useRef(null)

  const startResize = useCallback(
    (columnKey, event) => {
      event.preventDefault()
      event.stopPropagation()

      const th = event.currentTarget.closest('th')
      if (!th) return

      resizingRef.current = {
        columnKey,
        startX: event.clientX,
        startWidth: th.offsetWidth,
      }

      const onMouseMove = (moveEvent) => {
        const state = resizingRef.current
        if (!state) return
        const currentX = moveEvent.clientX
        const newWidth = Math.max(minWidth, state.startWidth + (currentX - state.startX))
        setColumnWidths((prev) => ({
          ...prev,
          [state.columnKey]: newWidth,
        }))
      }

      const onMouseUp = () => {
        resizingRef.current = null
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [minWidth],
  )

  return { columnWidths, startResize, setColumnWidths }
}

/** Clases base para celdas de tablas redimensionables */
export const TABLE_CELL = 'px-3 py-2 align-middle min-w-0 overflow-hidden'
export const TABLE_CELL_NOWRAP = `${TABLE_CELL} whitespace-nowrap truncate`
export const TABLE_CELL_TRUNC = `${TABLE_CELL} truncate`

/**
 * Anchos iniciales (px) — tabla principal de Ventas (12 columnas).
 */
export const SALES_TABLE_COLUMN_WIDTHS = {
  fecha: 140,
  cliente: 180,
  usuario: 160,
  numero: 80,
  nota: 100,
  metodoPago: 180,
  moneda: 80,
  etiquetas: 140,
  importe: 130,
  estado: 130,
  comprobante: 100,
  acciones: 100,
}

/** Ventas — pestaña rechazadas (+ columna motivo). */
export const SALES_TABLE_REJECTED_COLUMN_WIDTHS = {
  ...SALES_TABLE_COLUMN_WIDTHS,
  nota: 90,
  etiquetas: 120,
  comprobante: 90,
  acciones: 90,
  motivo: 200,
}

/** Anchos iniciales (%) — solicitudes de recarga BaaS. */
export const BAAS_RECHARGE_TABLE_COLUMN_WIDTHS = {
  fecha: '10%',
  cliente: '14%',
  usuario: '11%',
  numeroRef: '5%',
  nota: '5%',
  metodoPago: '12%',
  moneda: '5%',
  etiquetas: '10%',
  importe: '9%',
  estado: '9%',
  comprobante: '4%',
  acciones: '7%',
}
