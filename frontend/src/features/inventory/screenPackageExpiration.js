/** Utilidades compartidas: vencimiento efectivo del paquete (sin meses promocionales). */

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function diffCalendarDays(fromDay, toDay) {
  const a = startOfLocalDay(fromDay).getTime()
  const b = startOfLocalDay(toDay).getTime()
  return Math.round((b - a) / 86400000)
}

export function parseCreatedDate(raw) {
  if (raw == null || raw === '') return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Suma meses calendario sin librerías (evita mediodía por DST). */
function addCalendarMonthsFrom(date, monthsToAdd) {
  const y = date.getFullYear()
  const m = date.getMonth()
  const day = date.getDate()
  const nm = m + monthsToAdd
  const lastDayTarget = new Date(y, nm + 1, 0).getDate()
  const clampedDay = Math.min(day, lastDayTarget)
  return new Date(y, nm, clampedDay, 12, 0, 0, 0)
}

/**
 * Meses de servicio base según nombre de paquete (sin meses promocionales).
 * Orden: 12 → 6 → 3 → 1 para no confundir «12 meses» con «1 mes».
 */
export function parseBaseMonthsFromPackage(packageName) {
  const s = String(packageName || '').toLowerCase()
  if (/\b12\s*mes(es)?\b/.test(s)) return 12
  if (/\b6\s*mes(es)?\b/.test(s)) return 6
  if (/\b3\s*mes(es)?\b/.test(s)) return 3
  if (/\b1\s*mes\b/.test(s)) return 1
  return null
}

/**
 * Estadísticas de vencimiento efectivo (solo tiempo base del paquete, sin promos).
 */
export function calculateExpirationStats(createdAt, packageName, referenceDate = new Date()) {
  const baseMonths = parseBaseMonthsFromPackage(packageName)
  const created = parseCreatedDate(createdAt)
  if (baseMonths == null || created == null) return null

  const fechaExpiracionEfectiva = addCalendarMonthsFrom(created, baseMonths)
  const today = referenceDate

  const diasPasados = diffCalendarDays(created, today)
  const diasRestantes = diffCalendarDays(today, fechaExpiracionEfectiva)

  return {
    baseMonths,
    diasPasados,
    fechaExpiracionEfectiva,
    diasRestantes,
  }
}
