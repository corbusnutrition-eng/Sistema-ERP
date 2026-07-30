import { useCallback, useEffect, useState } from 'react'
import {
  fetchExchangeRatesCatalog,
  getActiveRateForCode,
} from '../lib/exchangeRatesActive'

/**
 * Carga GET /api/v1/exchange-rates y expone helper de tasa activa.
 * Cada vez que `enabled` pasa a true (p. ej. al abrir el modal), refetch sin caché.
 */
export default function useExchangeRatesCatalog(enabled = true) {
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
    fetchExchangeRatesCatalog({ bypassCache: true })
      .then((items) => {
        if (!cancelled) setRates(Array.isArray(items) ? items : [])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  const getActiveRate = useCallback(
    (currencyCode) => getActiveRateForCode(rates, currencyCode),
    [rates],
  )

  return { rates, loading, getActiveRate }
}
