/**
 * Alias frecuentes en comprobantes / OCR → ISO 4217 del ERP.
 * Claves en mayúsculas, sin espacios laterales (normalizar antes de lookup).
 */
export const CURRENCY_ALIASES = {
  BS: 'BOB',
  'BS.': 'BOB',
  BSB: 'BOB',
  BOLIVIANO: 'BOB',
  BOLIVIANOS: 'BOB',
  'S/': 'PEN',
  'S/.': 'PEN',
  SOLES: 'PEN',
  SOL: 'PEN',
  'R$': 'BRL',
  REAL: 'BRL',
  REALES: 'BRL',
  $: 'USD',
  US$: 'USD',
  'U$S': 'USD',
  USD$: 'USD',
  DÓLAR: 'USD',
  DOLAR: 'USD',
  DÓLARES: 'USD',
  DOLARES: 'USD',
  '€': 'EUR',
  EURO: 'EUR',
  '£': 'GBP',
  USD: 'USD',
  BOB: 'BOB',
  PEN: 'PEN',
  BRL: 'BRL',
  COP: 'COP',
  MXN: 'MXN',
  ARS: 'ARS',
  CLP: 'CLP',
}

const ALIAS_KEYS_LONGEST_FIRST = Object.keys(CURRENCY_ALIASES).sort((a, b) => b.length - a.length)

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function resolveCurrencyAlias(raw) {
  if (raw == null) return ''
  const trimmed = String(raw).trim()
  if (!trimmed) return ''
  const compact = trimmed.toUpperCase().replace(/\s+/g, '')
  if (CURRENCY_ALIASES[compact]) return CURRENCY_ALIASES[compact]
  const upper = trimmed.toUpperCase()
  if (CURRENCY_ALIASES[upper]) return CURRENCY_ALIASES[upper]
  for (const key of ALIAS_KEYS_LONGEST_FIRST) {
    if (compact === key.replace(/\s+/g, '')) return CURRENCY_ALIASES[key]
  }
  return compact.slice(0, 10)
}

/**
 * Normaliza moneda OCR / cuenta a ISO (con alias). Misma convención que backend.
 * @param {unknown} value
 * @param {string} [defaultCode='USD']
 * @returns {string}
 */
export function normalizeCurrencyWithAliases(value, defaultCode = 'USD') {
  if (value == null || String(value).trim() === '') {
    return String(defaultCode || 'USD')
      .trim()
      .toUpperCase()
      .slice(0, 10)
  }
  const resolved = resolveCurrencyAlias(value)
  if (!resolved) {
    return String(defaultCode || 'USD')
      .trim()
      .toUpperCase()
      .slice(0, 10)
  }
  return resolved.slice(0, 10)
}

/** Etiqueta segura para formularios de depósito: siempre código ISO, nunca Intl/DisplayNames. */
export function portalCurrencyIsoLabel(currency, fallback = 'USD') {
  return normalizeCurrencyWithAliases(currency, fallback)
}
