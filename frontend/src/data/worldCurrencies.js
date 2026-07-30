/** Catálogo exclusivo de monedas de Latinoamérica para agregar divisas. */
export const WORLD_CURRENCIES = [
  { code: 'ARS', country: 'Argentina', name: 'Peso argentino', symbol: '$' },
  { code: 'BOB', country: 'Bolivia', name: 'Boliviano', symbol: 'Bs.' },
  { code: 'BRL', country: 'Brasil', name: 'Real', symbol: 'R$' },
  { code: 'CLP', country: 'Chile', name: 'Peso chileno', symbol: '$' },
  { code: 'COP', country: 'Colombia', name: 'Peso colombiano', symbol: '$' },
  { code: 'CRC', country: 'Costa Rica', name: 'Colón', symbol: '₡' },
  { code: 'CUP', country: 'Cuba', name: 'Peso cubano', symbol: '$' },
  { code: 'DOP', country: 'República Dominicana', name: 'Peso dominicano', symbol: 'RD$' },
  { code: 'GTQ', country: 'Guatemala', name: 'Quetzal', symbol: 'Q' },
  { code: 'HNL', country: 'Honduras', name: 'Lempira', symbol: 'L' },
  { code: 'MXN', country: 'México', name: 'Peso mexicano', symbol: '$' },
  { code: 'NIO', country: 'Nicaragua', name: 'Córdoba', symbol: 'C$' },
  { code: 'PAB', country: 'Panamá', name: 'Balboa', symbol: 'B/.' },
  { code: 'PEN', country: 'Perú', name: 'Sol', symbol: 'S/' },
  { code: 'PYG', country: 'Paraguay', name: 'Guaraní', symbol: '₲' },
  { code: 'UYU', country: 'Uruguay', name: 'Peso uruguayo', symbol: '$U' },
  { code: 'VES', country: 'Venezuela', name: 'Bolívar', symbol: 'Bs.' },
]

export function buildCurrencySelectOptions(currencies) {
  return currencies.map((c) => ({
    value: c.code,
    label: `${c.symbol} · ${c.code} · ${c.country}`,
    searchText: `${c.code} ${c.country} ${c.name} ${c.symbol}`.toLowerCase(),
  }))
}
