import api from '../api/axios'
import { normalizeCurrencyCode } from './currencyCode'
import { fetchLastExchangeRate } from './exchangeRateApi'

/** @typedef {{ currency_code: string, binance_rate?: number|null, manual_rate?: number|null, use_manual_override?: boolean, active_rate?: number|null }} ExchangeRateRow */

let catalogCache = /** @type {ExchangeRateRow[]|null} */ (null)
let catalogPromise = /** @type {Promise<ExchangeRateRow[]>|null} */ (null)

/**
 * Tasa activa de una fila del panel (manual si override, si no mercado/active_rate).
 * @param {ExchangeRateRow|null|undefined} row
 * @returns {number|null}
 */
export function getActiveRateFromRow(row) {
  if (!row) return null
  const code = normalizeCurrencyCode(row.currency_code || 'USD', 'USD')
  if (code === 'USD') return 1
  if (
    row.use_manual_override &&
    row.manual_rate != null &&
    Number(row.manual_rate) > 0
  ) {
    return Number(row.manual_rate)
  }
  if (row.active_rate != null && Number(row.active_rate) > 0) {
    return Number(row.active_rate)
  }
  if (row.binance_rate != null && Number(row.binance_rate) > 0) {
    return Number(row.binance_rate)
  }
  return null
}

/**
 * @param {ExchangeRateRow[]} rows
 * @param {string} currencyCode
 * @returns {number|null}
 */
export function getActiveRateForCode(rows, currencyCode) {
  const code = normalizeCurrencyCode(currencyCode || 'USD', 'USD')
  if (code === 'USD') return 1
  const list = Array.isArray(rows) ? rows : []
  const row = list.find((r) => normalizeCurrencyCode(r?.currency_code, '') === code)
  return getActiveRateFromRow(row)
}

/**
 * @returns {Promise<ExchangeRateRow[]>}
 */
export async function fetchExchangeRatesCatalog() {
  if (catalogCache) return catalogCache
  if (!catalogPromise) {
    catalogPromise = api
      .get('/api/v1/exchange-rates')
      .then(({ data }) => {
        catalogCache = Array.isArray(data?.items) ? data.items : []
        return catalogCache
      })
      .catch(() => {
        catalogCache = []
        return catalogCache
      })
      .finally(() => {
        catalogPromise = null
      })
  }
  return catalogPromise
}

export function invalidateExchangeRatesCatalog() {
  catalogCache = null
}

/**
 * Tasa activa como string para inputs de formulario (unidades locales por 1 USD).
 * @param {string} currencyCode
 * @param {ExchangeRateRow[]} [catalog]
 * @returns {Promise<string>}
 */
export async function loadActiveRateStringForCurrency(currencyCode, catalog) {
  const code = normalizeCurrencyCode(currencyCode || 'USD', 'USD')
  if (code === 'USD') return '1'
  const rows = catalog ?? (await fetchExchangeRatesCatalog())
  const active = getActiveRateForCode(rows, code)
  if (active != null && active > 0) return String(active)
  const { rate } = await fetchLastExchangeRate(code)
  return String(rate)
}

/**
 * Convierte precio base USD a tarifa en moneda de cobro.
 * @param {object|null|undefined} meta
 * @param {string} saleCurrency
 * @param {number} exchangeRate
 * @returns {number|null}
 */
export function computeLineRateFromProduct(meta, saleCurrency, exchangeRate) {
  if (!meta) return null
  const rawBase = meta.reference_price ?? meta.reference_cost_usd
  const base = Number(String(rawBase ?? '').replace(',', '.'))
  if (!Number.isFinite(base) || base < 0) return null

  const refCur = normalizeCurrencyCode(meta.reference_currency || 'USD', 'USD')
  const saleCur = normalizeCurrencyCode(saleCurrency || 'USD', 'USD')
  if (saleCur === 'USD') return Math.round(base * 100) / 100

  const xr = Number(exchangeRate)
  if (!Number.isFinite(xr) || xr <= 0) return null

  if (refCur === 'USD' || saleCur !== refCur) {
    return Math.round(base * xr * 100) / 100
  }
  if (saleCur === refCur) return Math.round(base * 100) / 100
  return null
}
