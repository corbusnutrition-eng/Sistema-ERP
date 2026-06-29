import { useCallback, useRef, useState } from 'react'

const MIN_COLUMN_WIDTH = 48

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
        const delta = moveEvent.clientX - state.startX
        const nextWidth = Math.max(minWidth, state.startWidth + delta)
        setColumnWidths((prev) => ({
          ...prev,
          [state.columnKey]: nextWidth,
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
export const TABLE_CELL = 'px-2 py-2 align-middle'
export const TABLE_CELL_NOWRAP = `${TABLE_CELL} whitespace-nowrap`
export const TABLE_CELL_TRUNC = `${TABLE_CELL} min-w-0 max-w-0 truncate`

/**
 * Anchos iniciales (% del ancho total) — tabla principal de Ventas (12 columnas).
 * Suma 100%.
 */
export const SALES_TABLE_COLUMN_WIDTHS = {
  fecha: '10%',
  cliente: '14%',
  usuario: '11%',
  numero: '5%',
  nota: '5%',
  metodoPago: '12%',
  moneda: '5%',
  etiquetas: '10%',
  importe: '9%',
  estado: '9%',
  comprobante: '4%',
  acciones: '7%',
}

/** Ventas — pestaña rechazadas (+ columna motivo). Suma 100%. */
export const SALES_TABLE_REJECTED_COLUMN_WIDTHS = {
  fecha: '9%',
  cliente: '12%',
  usuario: '10%',
  numero: '5%',
  nota: '4%',
  metodoPago: '11%',
  moneda: '5%',
  etiquetas: '8%',
  importe: '8%',
  estado: '8%',
  comprobante: '4%',
  motivo: '8%',
  acciones: '8%',
}

/** Anchos iniciales (%) — solicitudes de recarga BaaS. Suma 100%. */
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
