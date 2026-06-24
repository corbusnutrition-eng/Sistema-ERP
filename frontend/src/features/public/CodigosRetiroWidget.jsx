import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildCodigosRetiroWidgetUrl,
  CODIGOS_RETIRO_ES_PRUEBA,
  CODIGOS_RETIRO_ORIGIN,
  normalizeRetiroPostMessageData,
} from './codigosRetiroPayment'

/** Altura inicial del iframe: formulario completo (OCR + verificación + botón enviar). */
export const CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX = 720

const CODIGOS_RETIRO_HEIGHT_MESSAGE_TYPES = new Set([
  'WIDGET_HEIGHT',
  'IFRAME_HEIGHT',
  'RESIZE',
  'resize',
])

function extractIframeHeightFromMessage(data) {
  const raw = normalizeRetiroPostMessageData(data)
  if (!raw || typeof raw !== 'object') return null

  const tipo = String(raw.tipo ?? raw.type ?? raw.event ?? '').trim()
  if (tipo && !CODIGOS_RETIRO_HEIGHT_MESSAGE_TYPES.has(tipo)) {
    return null
  }

  const heightRaw =
    raw.height ?? raw.altura ?? raw.iframeHeight ?? raw.scrollHeight ?? raw.h ?? raw.frameHeight
  const parsed = Number(heightRaw)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.ceil(parsed)
}

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
  const iframeRef = useRef(null)
  const [iframeHeight, setIframeHeight] = useState(CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX)

  const applyIframeHeight = useCallback((nextHeight) => {
    const h = Math.max(CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX, Math.ceil(Number(nextHeight) || 0))
    setIframeHeight(h)
  }, [])

  useEffect(() => {
    const allowedOrigin = CODIGOS_RETIRO_ORIGIN.replace(/\/$/, '')

    const onMessage = (event) => {
      const origin = String(event?.origin ?? '')
        .trim()
        .replace(/\/$/, '')
      if (origin !== allowedOrigin) return

      const next = extractIframeHeightFromMessage(event.data)
      if (next != null) applyIframeHeight(next)
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [applyIframeHeight])

  return (
    <div
      className={`portal-receipt-upload-glow-wrap portal-codigos-retiro-glow portal-public-section mb-3 h-fit w-full min-w-0 rounded-2xl border border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.6)] md:mb-4 ${className}`.trim()}
      style={style}
    >
      <section className="portal-receipt-upload-card portal-codigos-retiro-card h-fit w-full min-w-0 overflow-visible">
        <div className="portal-receipt-upload-circuit-overlay" aria-hidden />
        <div className="portal-order-summary-inner h-fit w-full px-3 pb-4 pt-4 md:px-5 md:pb-6 md:pt-5">
          <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.06em] text-green-300">
            Códigos de retiro
          </p>
          <p className="mb-4 text-[13px] leading-relaxed text-slate-200/90">
            Sube tu comprobante y confirma los datos detectados en el formulario de verificación.
          </p>
          <div className="portal-codigos-retiro-iframe-shell h-fit w-full overflow-visible">
            <iframe
              ref={iframeRef}
              src={iframeSrc}
              title="Códigos de Retiro"
              className="portal-codigos-retiro-iframe block h-auto w-full min-h-0 max-w-full border-0 bg-transparent p-0 outline-none"
              style={{
                height: iframeHeight,
                minHeight: CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX,
              }}
              scrolling="no"
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
