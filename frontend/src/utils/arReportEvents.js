/** Notifica a Cuentas por cobrar que debe recargar el reporte (p. ej. tras aprobar recarga BaaS). */
export const AR_REPORT_STALE_EVENT = 'erp:ar-report-stale'

export function notifyAccountsReceivableStale() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AR_REPORT_STALE_EVENT))
  }
}
