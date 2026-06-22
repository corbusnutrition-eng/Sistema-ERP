import api from '../api/axios'
import { salesCurrencyDefaultRate } from '../features/sales/salesCurrencies'

/**
 * Última tasa usada en ventas/pagos/recargas para la moneda (unidades locales por 1 USD).
 *
 * @returns {Promise<{ rate: number, fromHistory: boolean }>}
 */
export async function fetchLastExchangeRate(currency) {
  const cur = String(currency || 'USD')
    .trim()
    .toUpperCase()
    .slice(0, 10)
  if (!cur || cur === 'USD' || cur === 'USDT' || cur === 'USDC') {
    return { rate: 1, fromHistory: true }
  }
  try {
    const { data } = await api.get('/api/v1/currency/last-rate', { params: { currency: cur } })
    const xr = Number(data?.exchange_rate)
    if (Number.isFinite(xr) && xr > 0) {
      return { rate: xr, fromHistory: Boolean(data?.from_history) }
    }
  } catch {
    /* fallback catálogo */
  }
  return { rate: salesCurrencyDefaultRate(cur), fromHistory: false }
}
