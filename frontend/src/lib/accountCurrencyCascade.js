import { normalizeCurrencyCode } from './currencyCode'
import { fetchLastExchangeRate } from './exchangeRateApi'

/**
 * Busca una cuenta del plan de cuentas / depósito por id.
 *
 * @param {Array<{ id?: number|string, currency?: string }>} accounts
 * @param {number|string|null|undefined} accountId
 * @returns {object|null}
 */
export function findAccountInList(accounts, accountId) {
  if (accountId == null || accountId === '') return null
  const id = Number(accountId)
  if (!Number.isFinite(id)) return null
  const list = Array.isArray(accounts) ? accounts : []
  return list.find((a) => Number(a?.id) === id) ?? null
}

/**
 * Moneda ISO de la cuenta (`account.currency`); nunca infiere por nombre.
 */
export function currencyCodeFromAccount(account, fallback = 'USD') {
  return normalizeCurrencyCode(String(account?.currency ?? '').trim() || fallback, fallback)
}

/**
 * Moneda de una cuenta por id en el listado cargado del API.
 */
export function currencyCodeFromAccountId(accounts, accountId, fallback = 'USD') {
  return currencyCodeFromAccount(findAccountInList(accounts, accountId), fallback)
}

/**
 * Última cuenta de depósito marcada (checkboxes), omitiendo agrupadoras.
 *
 * @param {Array} accounts
 * @param {Array<number|string>} selectedIds
 * @param {(id: number|string) => boolean} [isGroupingParent]
 * @returns {string|null} código ISO o null si no hay selección válida
 */
export function currencyFromLastSelectedDepositIds(
  accounts,
  selectedIds,
  isGroupingParent = () => false,
) {
  const ids = Array.isArray(selectedIds) ? selectedIds : []
  if (!ids.length) return null
  const list = Array.isArray(accounts) ? accounts : []
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const id = ids[i]
    const acc = list.find((x) => Number(x?.id) === Number(id))
    if (acc && !isGroupingParent(acc.id)) {
      return currencyCodeFromAccount(acc)
    }
  }
  return null
}

/**
 * Tipo de cambio a USD para autollenar formularios (última tasa histórica o catálogo).
 *
 * @returns {Promise<string>}
 */
export async function loadExchangeRateStringForCurrency(currencyCode) {
  const code = normalizeCurrencyCode(currencyCode || 'USD', 'USD')
  if (code === 'USD') return '1'
  const { rate } = await fetchLastExchangeRate(code)
  return String(rate)
}

/**
 * Handler reutilizable: al elegir cuenta, devuelve la moneda para setear estado.
 */
export function billingCurrencyForAccountSelection(accounts, accountId) {
  if (!accountId) return null
  return currencyCodeFromAccountId(accounts, accountId)
}
