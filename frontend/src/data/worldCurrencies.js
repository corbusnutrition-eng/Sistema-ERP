/** Catálogo de monedas para el selector de agregar divisas (LATAM, USA, Europa). */
export const WORLD_CURRENCIES = [
  { code: 'USD', country: 'Estados Unidos', name: 'Dólar estadounidense', symbol: '$' },
  { code: 'CAD', country: 'Canadá', name: 'Dólar canadiense', symbol: 'CA$' },
  { code: 'MXN', country: 'México', name: 'Peso mexicano', symbol: '$' },
  { code: 'BOB', country: 'Bolivia', name: 'Boliviano', symbol: 'Bs.' },
  { code: 'ARS', country: 'Argentina', name: 'Peso argentino', symbol: '$' },
  { code: 'BRL', country: 'Brasil', name: 'Real', symbol: 'R$' },
  { code: 'CLP', country: 'Chile', name: 'Peso chileno', symbol: '$' },
  { code: 'COP', country: 'Colombia', name: 'Peso colombiano', symbol: '$' },
  { code: 'PEN', country: 'Perú', name: 'Sol', symbol: 'S/' },
  { code: 'UYU', country: 'Uruguay', name: 'Peso uruguayo', symbol: '$U' },
  { code: 'PYG', country: 'Paraguay', name: 'Guaraní', symbol: '₲' },
  { code: 'VES', country: 'Venezuela', name: 'Bolívar', symbol: 'Bs.' },
  { code: 'GTQ', country: 'Guatemala', name: 'Quetzal', symbol: 'Q' },
  { code: 'HNL', country: 'Honduras', name: 'Lempira', symbol: 'L' },
  { code: 'NIO', country: 'Nicaragua', name: 'Córdoba', symbol: 'C$' },
  { code: 'CRC', country: 'Costa Rica', name: 'Colón', symbol: '₡' },
  { code: 'DOP', country: 'República Dominicana', name: 'Peso dominicano', symbol: 'RD$' },
  { code: 'PAB', country: 'Panamá', name: 'Balboa', symbol: 'B/.' },
  { code: 'EUR', country: 'Zona Euro', name: 'Euro', symbol: '€' },
  { code: 'GBP', country: 'Reino Unido', name: 'Libra esterlina', symbol: '£' },
  { code: 'CHF', country: 'Suiza', name: 'Franco suizo', symbol: 'CHF' },
  { code: 'NOK', country: 'Noruega', name: 'Corona noruega', symbol: 'kr' },
  { code: 'SEK', country: 'Suecia', name: 'Corona sueca', symbol: 'kr' },
  { code: 'DKK', country: 'Dinamarca', name: 'Corona danesa', symbol: 'kr' },
  { code: 'PLN', country: 'Polonia', name: 'Złoty', symbol: 'zł' },
  { code: 'CZK', country: 'República Checa', name: 'Corona checa', symbol: 'Kč' },
  { code: 'HUF', country: 'Hungría', name: 'Forinto', symbol: 'Ft' },
  { code: 'RON', country: 'Rumanía', name: 'Leu', symbol: 'lei' },
  { code: 'BGN', country: 'Bulgaria', name: 'Lev', symbol: 'лв' },
  { code: 'HRK', country: 'Croacia', name: 'Kuna', symbol: 'kn' },
  { code: 'ISK', country: 'Islandia', name: 'Corona islandesa', symbol: 'kr' },
  { code: 'TRY', country: 'Turquía', name: 'Lira turca', symbol: '₺' },
  { code: 'RUB', country: 'Rusia', name: 'Rublo', symbol: '₽' },
  { code: 'UAH', country: 'Ucrania', name: 'Grivna', symbol: '₴' },
]

export function buildCurrencySelectOptions(currencies, activeCodes = new Set()) {
  const blocked = new Set(['USD', 'USDT', 'USDC'])
  return currencies
    .filter((c) => !blocked.has(c.code) && !activeCodes.has(c.code))
    .map((c) => ({
      value: c.code,
      label: `${c.symbol} · ${c.code} · ${c.country}`,
      searchText: `${c.code} ${c.country} ${c.name} ${c.symbol}`.toLowerCase(),
    }))
}
