/** Alineado con backend `MAX_CURRENCY_CODE_LEN` (ISO 4217 + códigos extendidos ej. USDT). */

export const MAX_CURRENCY_CODE_LEN = 5

export function normalizeCurrencyCode(value, defaultCode = 'USD') {
  if (value == null || value === '') {
    return String(defaultCode || 'USD')
      .trim()
      .toUpperCase()
      .slice(0, MAX_CURRENCY_CODE_LEN)
  }
  const s = String(value).trim().toUpperCase()
  if (!s) {
    return String(defaultCode || 'USD')
      .trim()
      .toUpperCase()
      .slice(0, MAX_CURRENCY_CODE_LEN)
  }
  return s.slice(0, MAX_CURRENCY_CODE_LEN)
}
