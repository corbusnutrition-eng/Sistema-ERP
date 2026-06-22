/**
 * Monedas de cobro para ventas (LATAM + EUR).
 * defaultRate = unidades de moneda local por 1 USD (según etiqueta "1 USD = X moneda").
 * Valores orientativos para autollenar la tasa; el usuario puede corregirlos.
 */
export const SALES_CURRENCIES = [
  { code: 'USD', label: 'USD — Dólar estadounidense (Por defecto)', flag: '🇺🇸', defaultRate: 1 },
  { code: 'USDT', label: 'USDT — Tether (cripto estable)', flag: '₮', defaultRate: 1 },
  { code: 'ARS', label: 'ARS — Peso argentino', flag: '🇦🇷', defaultRate: 1200 },
  { code: 'BOB', label: 'BOB — Boliviano', flag: '🇧🇴', defaultRate: 6.9 },
  { code: 'BRL', label: 'BRL — Real brasileño', flag: '🇧🇷', defaultRate: 5.0 },
  { code: 'CLP', label: 'CLP — Peso chileno', flag: '🇨🇱', defaultRate: 950 },
  { code: 'COP', label: 'COP — Peso colombiano', flag: '🇨🇴', defaultRate: 4200 },
  { code: 'CRC', label: 'CRC — Colón costarricense', flag: '🇨🇷', defaultRate: 520 },
  { code: 'CUP', label: 'CUP — Peso cubano', flag: '🇨🇺', defaultRate: 24 },
  { code: 'DOP', label: 'DOP — Peso dominicano', flag: '🇩🇴', defaultRate: 59 },
  { code: 'EUR', label: 'EUR — Euro', flag: '🇪🇺', defaultRate: 0.92 },
  { code: 'GTQ', label: 'GTQ — Quetzal guatemalteco', flag: '🇬🇹', defaultRate: 7.8 },
  { code: 'HNL', label: 'HNL — Lempira hondureño', flag: '🇭🇳', defaultRate: 26 },
  { code: 'MXN', label: 'MXN — Peso mexicano', flag: '🇲🇽', defaultRate: 17 },
  { code: 'NIO', label: 'NIO — Córdoba nicaragüense', flag: '🇳🇮', defaultRate: 37 },
  { code: 'PAB', label: 'PAB — Balboa panameño', flag: '🇵🇦', defaultRate: 1 },
  { code: 'PEN', label: 'PEN — Sol peruano', flag: '🇵🇪', defaultRate: 3.75 },
  { code: 'PYG', label: 'PYG — Guaraní paraguayo', flag: '🇵🇾', defaultRate: 7500 },
  { code: 'UYU', label: 'UYU — Peso uruguayo', flag: '🇺🇾', defaultRate: 40 },
  { code: 'VES', label: 'VES — Bolívar venezolano', flag: '🇻🇪', defaultRate: 36 },
]

export function salesCurrencyDefaultRate(code) {
  const c = SALES_CURRENCIES.find((x) => x.code === code)
  if (!c) return 1
  return code === 'USD' ? 1 : c.defaultRate
}

export function salesCurrencyExchangeRateString(code) {
  return code === 'USD' ? '1' : String(salesCurrencyDefaultRate(code))
}
