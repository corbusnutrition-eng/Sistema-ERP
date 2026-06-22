import { useEffect } from 'react'
import { loadExchangeRateStringForCurrency } from '../lib/accountCurrencyCascade'
import { normalizeCurrencyCode } from '../lib/currencyCode'

/**
 * Rellena el tipo de cambio (unidades locales por 1 USD) cuando cambia la moneda de cobro/pago.
 *
 * @param {string} currency - moneda activa del formulario
 * @param {(rate: string, currencyCode: string) => void} onRateLoaded
 * @param {{ enabled?: boolean, skip?: { current?: boolean } }} [options]
 */
export default function useExchangeRateForCurrency(currency, onRateLoaded, options = {}) {
  const { enabled = true, skip } = options

  useEffect(() => {
    if (!enabled || skip?.current) return undefined
    const cur = normalizeCurrencyCode(currency || 'USD', 'USD')
    if (cur === 'USD') {
      onRateLoaded('1', cur)
      return undefined
    }
    let cancelled = false
    loadExchangeRateStringForCurrency(cur).then((rateStr) => {
      if (!cancelled) onRateLoaded(rateStr, cur)
    })
    return () => {
      cancelled = true
    }
  }, [currency, enabled, onRateLoaded, skip])
}
