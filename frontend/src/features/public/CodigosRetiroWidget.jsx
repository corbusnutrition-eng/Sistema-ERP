import {
  buildCodigosRetiroWidgetUrl,
  CODIGOS_RETIRO_ES_PRUEBA,
} from './codigosRetiroPayment'

/** Altura del iframe: espacio para subida + formulario de verificación OCR (2 pasos). */
export const CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX = 650

/**
 * Widget embebido del socio externo (OCR de comprobantes de retiro físico).
 * La respuesta llega vía ``window.postMessage`` (escuchada en el padre).
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
      className={`portal-codigos-retiro-wrap ${className}`.trim()}
      style={{
        width: '100%',
        minHeight: CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX,
        overflow: 'visible',
        borderRadius: 16,
        border: '1px solid rgba(34, 197, 94, 0.35)',
        background: 'rgba(0,0,0,0.25)',
        ...style,
      }}
    >
      <p
        className="mb-0 px-4 pt-4 text-[12px] font-medium uppercase tracking-[0.06em] text-green-300"
        style={{ margin: 0, padding: '16px 16px 8px' }}
      >
        Códigos de retiro
      </p>
      <p
        style={{ margin: '0 0 12px', padding: '0 16px', fontSize: 13, color: 'rgba(226,232,240,0.9)' }}
      >
        Sube tu comprobante y confirma los datos detectados en el formulario de verificación.
      </p>
      <iframe
        src={iframeSrc}
        title="Códigos de Retiro"
        style={{
          width: '100%',
          height: CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX,
          minHeight: CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX,
          border: 'none',
          display: 'block',
          overflow: 'hidden',
        }}
        scrolling="no"
        allow="camera; clipboard-write"
      />
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
