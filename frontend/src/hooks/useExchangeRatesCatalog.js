import { useCallback, useEffect, useState } from 'react'
import {
  fetchExchangeRatesCatalog,
  getActiveRateForCode,
} from '../lib/exchangeRatesActive'

/**
 * Carga GET /api/v1/exchange-rates y expone helper de tasa activa.
 */
export default function useExchangeRatesCatalog(enabled = true) {
  const [rates, setRates] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setRates([])
      return undefined
    }
    let cancelled = false
    setLoading(true)
    fetchExchangeRatesCatalog()
      .then((items) => {
        if (!cancelled) setRates(items)
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
