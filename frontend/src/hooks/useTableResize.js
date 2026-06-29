import { useCallback, useRef, useState } from 'react'

const MIN_COLUMN_WIDTH = 48

/**
 * Hook para redimensionar columnas de tablas arrastrando el borde del header.
 * @param {Record<string, number>} initialWidths - anchos iniciales en px por clave de columna
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

/** Anchos por defecto — tabla principal de Ventas */
export const SALES_TABLE_COLUMN_WIDTHS = {
  fecha: 120,
  cliente: 168,
  usuario: 120,
  numero: 64,
  nota: 140,
  metodoPago: 132,
  moneda: 80,
  etiquetas: 168,
  importe: 112,
  estado: 128,
  comprobante: 56,
  motivo: 200,
  acciones: 240,
}

/** Anchos por defecto — solicitudes de recarga BaaS */
export const BAAS_RECHARGE_TABLE_COLUMN_WIDTHS = {
  fecha: 120,
  cliente: 168,
  usuario: 120,
  numeroRef: 72,
  nota: 140,
  metodoPago: 132,
  moneda: 80,
  etiquetas: 168,
  importe: 112,
  estado: 128,
  comprobante: 56,
  acciones: 220,
}
