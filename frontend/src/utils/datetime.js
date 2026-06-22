/**
 * Fechas y horas del sistema: siempre America/Guayaquil (Ecuador, UTC-5).
 */

export const ECUADOR_TZ = 'America/Guayaquil'

const LOCALE = 'es-EC'

function parseApiDate(iso) {
  if (iso == null || iso === '') return null
  const s = String(iso).trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T12:00:00-05:00`)
  }
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

function formatParts(iso, options) {
  const d = parseApiDate(iso)
  if (!d) return null
  return new Intl.DateTimeFormat(LOCALE, { timeZone: ECUADOR_TZ, ...options }).format(d)
}

/** DD/MM/YYYY */
export function formatDateEcuador(iso) {
  const d = parseApiDate(iso)
  if (!d) return '—'
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: ECUADOR_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d)
}

/** DD/MM/YYYY, HH:MM (24 h) */
export function formatDateTimeEcuador(iso) {
  const d = parseApiDate(iso)
  if (!d) return '—'
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: ECUADOR_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

/** Fecha corta para tablas: «17 may 2026, 14:30» */
export function formatSaleTableDate(iso) {
  const d = parseApiDate(iso)
  if (!d) return '—'
  const dayNum = new Intl.DateTimeFormat(LOCALE, {
    timeZone: ECUADOR_TZ,
    day: 'numeric',
  }).format(d)
  const monthRaw = new Intl.DateTimeFormat('en-GB', {
    timeZone: ECUADOR_TZ,
    month: 'short',
  })
    .format(d)
    .replace(/\.$/, '')
    .trim()
    .toLowerCase()
  const yyyy = new Intl.DateTimeFormat(LOCALE, {
    timeZone: ECUADOR_TZ,
    year: 'numeric',
  }).format(d)
  const time = new Intl.DateTimeFormat(LOCALE, {
    timeZone: ECUADOR_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
  return `${dayNum} ${monthRaw} ${yyyy}, ${time}`
}

/** Libro mayor: fecha en una línea, hora en otra */
export function formatSaleLedgerDateParts(iso) {
  if (!iso) return { dateLine: '—', timeLine: '' }
  const d = parseApiDate(iso)
  if (!d) return { dateLine: '—', timeLine: '' }
  const dateLine = new Intl.DateTimeFormat(LOCALE, {
    timeZone: ECUADOR_TZ,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d)
  const timeLine = new Intl.DateTimeFormat(LOCALE, {
    timeZone: ECUADOR_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
  return { dateLine, timeLine }
}

/** Solo fecha corta (día mes año) */
export function formatShortDateEcuador(iso) {
  return (
    formatParts(iso, { day: '2-digit', month: 'short', year: 'numeric' }) ?? '—'
  )
}

/** Fecha relativa + fallback absoluto (listados de clientes) */
export function formatRelativeTimeEcuador(dateStr) {
  const d = parseApiDate(dateStr)
  if (!d) return '—'
  const diffMs = Date.now() - d.getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'Ahora'
  if (mins < 60) return `Hace ${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `Hace ${hours} h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `Hace ${days} d`
  return formatShortDateEcuador(dateStr)
}

/** YYYY-MM-DD (hoy en Ecuador) */
export function todayIsoDateEcuador() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ECUADOR_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const y = parts.find((p) => p.type === 'year')?.value
  const m = parts.find((p) => p.type === 'month')?.value
  const day = parts.find((p) => p.type === 'day')?.value
  return `${y}-${m}-${day}`
}

/** Valor para <input type="datetime-local"> en horario Ecuador */
export function toDatetimeLocalEcuador(iso) {
  const d = parseApiDate(iso)
  if (!d) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ECUADOR_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (type) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

/** Inicio del día calendario en Ecuador (ms UTC) */
export function ecuadorDayStartMs(isoDateStr) {
  return new Date(`${isoDateStr}T00:00:00-05:00`).getTime()
}

/** Fin del día calendario en Ecuador (ms UTC) */
export function ecuadorDayEndMs(isoDateStr) {
  return new Date(`${isoDateStr}T23:59:59.999-05:00`).getTime()
}

export { parseApiDate }
