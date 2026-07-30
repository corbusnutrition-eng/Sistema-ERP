import { useCallback, useEffect, useState } from 'react'
import {
  fetchExchangeRatesCatalog,
  fetchPortalExchangeRatesCatalog,
  getActiveRateForCode,
} from '../lib/exchangeRatesActive'

/**
 * Carga tasas activas del ERP.
 * - Panel admin: GET /api/v1/exchange-rates (requiere JWT).
 * - Portal cliente: GET /api/v1/portal/{token}/exchange-rates.
 * Cada vez que `enabled` pasa a true, refetch sin caché del panel admin.
 */
export default function useExchangeRatesCatalog(enabled = true, options = null) {
  const portalToken = options?.portalToken ?? null
  const portalApi = options?.portalApi ?? null
  const [rates, setRates] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setRates([])
      setLoading(false)
      return undefined
    }
    let cancelled = false
    setLoading(true)
    const load =
      portalToken && portalApi
        ? fetchPortalExchangeRatesCatalog(portalToken, portalApi)
        : fetchExchangeRatesCatalog({ bypassCache: true })
    load
      .then((items) => {
        if (!cancelled) setRates(Array.isArray(items) ? items : [])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, portalToken, portalApi])

  const getActiveRate = useCallback(
    (currencyCode) => getActiveRateForCode(rates, currencyCode),
    [rates],
  )

  return { rates, loading, getActiveRate }
}
