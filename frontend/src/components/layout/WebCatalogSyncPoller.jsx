import { useEffect, useRef } from 'react'
import api from '../../api/axios'

const INTERVAL_MS = 30_000

function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null')
  } catch {
    return null
  }
}

/**
 * Robot global (solo admin): sincroniza recargas billetera + comprobantes de ventas IPTV/créditos
 * desde catalogo-vip (Render). Dispara pulso visual y evento para refrescar Ventas / Distribuidores.
 */
export default function WebCatalogSyncPoller() {
  const titleFlashTimeoutRef = useRef(null)

  useEffect(() => {
    const user = getStoredUser()
    if (!user || user.role !== 'admin') return undefined

    const pulseBody = () => {
      document.body.classList.add('erp-web-sync-pulse')
      window.setTimeout(() => {
        document.body.classList.remove('erp-web-sync-pulse')
      }, 2800)
    }

    const flashTitle = (n) => {
      if (!n || n < 1) return
      if (titleFlashTimeoutRef.current) window.clearTimeout(titleFlashTimeoutRef.current)
      const prev = document.title
      document.title = `(${n}) Comprobante listo · ERP`
      titleFlashTimeoutRef.current = window.setTimeout(() => {
        document.title = prev
        titleFlashTimeoutRef.current = null
      }, 2400)
    }

    const run = async () => {
      try {
        const [resSales, resRec] = await Promise.all([
          api.get('/api/v1/sales/sync-web-credits').catch(() => null),
          api.get('/api/v1/distributors/sync-recharges').catch(() => null),
        ])

        const salesData = resSales?.data
        const recData = resRec?.data
        const salesN = Array.isArray(salesData?.updated_ids) ? salesData.updated_ids.length : 0
        const recN = Array.isArray(recData?.updated_ids) ? recData.updated_ids.length : 0

        if (salesN > 0) {
          pulseBody()
          flashTitle(salesN)
        }
        if (salesN > 0 || recN > 0) {
          window.dispatchEvent(
            new CustomEvent('erp-web-catalog-sync', {
              detail: {
                sales: { count: salesN, ids: salesData?.updated_ids ?? [] },
                recharges: { count: recN, ids: recData?.updated_ids ?? [] },
              },
            }),
          )
        }
      } catch (err) {
        console.warn('[WebCatalogSyncPoller]', err)
      }
    }

    void run()
    const id = window.setInterval(run, INTERVAL_MS)
    return () => {
      window.clearInterval(id)
      if (titleFlashTimeoutRef.current) window.clearTimeout(titleFlashTimeoutRef.current)
    }
  }, [])

  return null
}
