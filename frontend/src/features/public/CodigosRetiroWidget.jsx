import {
  buildCodigosRetiroWidgetUrl,
  CODIGOS_RETIRO_ES_PRUEBA,
} from './codigosRetiroPayment'

/** Altura visible del iframe en paso de subida (formulario OCR puede hacer scroll dentro). */
export const CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX = 300

/**
 * Widget embebido del socio externo (OCR de comprobantes de retiro físico).
 * La respuesta llega vía ``window.postMessage`` (escuchada en el padre).
 *
 * El contenedor replica el shell visual del uploader «Comprobante» del portal
 * (glow verde, vidrio oscuro, borde punteado) para integrarse al checkout.
 */
export default function CodigosRetiroWidget({
  clientName = 'Cliente',
  referenciaExterna = null,
  esPrueba = CODIGOS_RETIRO_ES_PRUEBA,
  className = '',
  style = {},
}) {
  const label = String(clientName ?? '').trim() || 'Cliente'
  const iframeSrc = buildCodigosRetiroWidgetUrl(label, { referenciaExterna, esPrueba })

  return (
    <div
      className={`portal-receipt-upload-glow-wrap portal-codigos-retiro-glow mb-4 h-fit w-full rounded-2xl border border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.6)] ${className}`.trim()}
      style={style}
    >
      <section className="portal-receipt-upload-card portal-codigos-retiro-card h-fit w-full">
        <div className="portal-receipt-upload-circuit-overlay" aria-hidden />
        <div className="portal-order-summary-inner h-fit w-full px-5 pb-6 pt-5">
          <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.06em] text-green-300">
            Códigos de retiro
          </p>
          <p className="mb-4 text-[13px] leading-relaxed text-slate-200/90">
            Sube tu comprobante y confirma los datos detectados en el formulario de verificación.
          </p>
          <div className="portal-codigos-retiro-iframe-shell h-fit w-full">
            <iframe
              src={iframeSrc}
              title="Códigos de Retiro"
              className="portal-codigos-retiro-iframe"
              style={{ height: CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX }}
              scrolling="auto"
              allow="camera; clipboard-write"
              allowTransparency="true"
            />
          </div>
        </div>
      </section>
    </div>
  )
}

/** Pantalla de éxito tras ``RETIRO_COMPLETADO`` y registro en backend. */
export function RetiroSuccessPanel({ message, title = 'Pago en revisión', monto, currency = 'USD' }) {
  const montoLabel =
    Number.isFinite(monto) && monto > 0
      ? new Intl.NumberFormat('es-CO', {
          style: 'currency',
          currency: String(currency || 'USD').slice(0, 10),
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        }).format(monto)
      : null

  return (
    <div
      className="rounded-2xl border border-emerald-400/45 bg-emerald-950/40 px-5 py-6 text-center"
      role="status"
      aria-live="polite"
    >
      <p className="m-0 text-3xl" aria-hidden>
        ✅
      </p>
      <p className="mt-3 mb-1 text-[16px] font-bold text-emerald-50">{title}</p>
      <p className="m-0 text-[14px] leading-relaxed text-emerald-100/95">{message}</p>
      {montoLabel ? (
        <p className="mt-3 mb-0 text-[13px] text-emerald-200/90">
          Importe registrado: <strong className="tabular-nums">{montoLabel}</strong>
        </p>
      ) : null}
    </div>
  )
}
