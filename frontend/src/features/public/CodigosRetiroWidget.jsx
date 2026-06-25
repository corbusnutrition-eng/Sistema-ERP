import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  buildCodigosRetiroWidgetUrl,
  CODIGOS_RETIRO_ES_PRUEBA,
  isRetiroCompletadoMessage,
  isRetiroErrorMessage,
  normalizeRetiroPostMessageData,
  parseRetiroErrorMessage,
  resolveCodigosRetiroOrigin,
  RETIRO_REJECTED_DEFAULT_MESSAGE,
} from './codigosRetiroPayment'

/** Altura inicial del iframe: formulario completo (OCR + verificación + botón enviar). */
export const CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX = 720

export const CODIGOS_RETIRO_PROCESSING_TIMEOUT_MS = 15000

const CODIGOS_RETIRO_PENDING_MESSAGE =
  'Tu comprobante fue enviado y está siendo procesado. El saldo se reflejará en breve.'

const CODIGOS_RETIRO_HEIGHT_MESSAGE_TYPES = new Set([
  'WIDGET_HEIGHT',
  'IFRAME_HEIGHT',
  'RESIZE',
  'resize',
])

const CODIGOS_RETIRO_WAIT_MESSAGE_TYPES = new Set([
  'RETIRO_EN_PROCESO',
  'ENVIANDO',
  'PROCESSING',
  'SUBMIT',
  'SUBMITTED',
  'WAITING',
  'UPLOADING',
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

function extractRetiroMessageType(data) {
  const raw = normalizeRetiroPostMessageData(data)
  if (!raw || typeof raw !== 'object') return ''
  return String(raw.tipo ?? raw.type ?? raw.event ?? '').trim()
}

/** Aviso cuando el socio rechaza el comprobante (duplicado / inválido). */
export function RetiroRejectedPanel({ message = RETIRO_REJECTED_DEFAULT_MESSAGE }) {
  return (
    <div
      className="rounded-2xl border border-rose-400/45 bg-rose-950/40 px-5 py-8 text-center"
      role="alert"
      aria-live="assertive"
    >
      <p className="m-0 text-3xl" aria-hidden>
        ✕
      </p>
      <p className="mt-3 mb-0 text-[15px] font-semibold leading-relaxed text-rose-50">{message}</p>
    </div>
  )
}

/** Aviso amigable cuando el iframe/webhook tarda más de lo esperado. */
export function RetiroPendingProcessingPanel({ message = CODIGOS_RETIRO_PENDING_MESSAGE }) {
  return (
    <div
      className="rounded-2xl border border-emerald-400/45 bg-emerald-950/40 px-5 py-8 text-center"
      role="status"
      aria-live="polite"
    >
      <p className="m-0 text-3xl" aria-hidden>
        ⏳
      </p>
      <p className="mt-3 mb-0 text-[15px] font-semibold leading-relaxed text-emerald-50">{message}</p>
    </div>
  )
}

/**
 * Widget embebido del socio externo (OCR de comprobantes de retiro físico).
 * Ventas y recargas BaaS comparten la misma tubería; ``entity`` solo cambia el prefijo FAC/REC.
 */
export default function CodigosRetiroWidget({
  clientName = 'Cliente',
  referenciaExterna = null,
  entity = 'sale',
  esPrueba = CODIGOS_RETIRO_ES_PRUEBA,
  className = '',
  style = {},
  processingTimeoutMs = CODIGOS_RETIRO_PROCESSING_TIMEOUT_MS,
  onRetiroError = null,
}) {
  const label = String(clientName ?? '').trim() || 'Cliente'
  const widgetEntity = entity === 'recharge' ? 'recharge' : 'sale'

  const iframeSrc = useMemo(() => {
    try {
      return buildCodigosRetiroWidgetUrl(label, {
        referenciaExterna,
        entity: widgetEntity,
        esPrueba,
      })
    } catch (err) {
      console.error('[CodigosRetiroWidget] No se pudo construir la URL del iframe:', err)
      return buildCodigosRetiroWidgetUrl(label, { esPrueba })
    }
  }, [esPrueba, label, referenciaExterna, widgetEntity])

  const iframeRef = useRef(null)
  const iframeLoadCountRef = useRef(0)
  const userInteractedRef = useRef(false)
  const completedRef = useRef(false)
  const rejectedRef = useRef(false)
  const processingTimeoutRef = useRef(null)
  const initialLoadTimeoutRef = useRef(null)

  const [iframeHeight, setIframeHeight] = useState(CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX)
  const [iframeLoaded, setIframeLoaded] = useState(false)
  const [isAwaitingResult, setIsAwaitingResult] = useState(false)
  const [showPendingNotice, setShowPendingNotice] = useState(false)
  const [showRejectedNotice, setShowRejectedNotice] = useState(false)
  const [rejectedMessage, setRejectedMessage] = useState(RETIRO_REJECTED_DEFAULT_MESSAGE)

  useEffect(() => {
    setIframeLoaded(false)
    setIsAwaitingResult(false)
    completedRef.current = false
    rejectedRef.current = false
    iframeLoadCountRef.current = 0
  }, [iframeSrc])

  const clearProcessingTimeout = useCallback(() => {
    if (processingTimeoutRef.current != null) {
      window.clearTimeout(processingTimeoutRef.current)
      processingTimeoutRef.current = null
    }
  }, [])

  const markRetiroCompleted = useCallback(() => {
    completedRef.current = true
    setIsAwaitingResult(false)
    clearProcessingTimeout()
    if (initialLoadTimeoutRef.current != null) {
      window.clearTimeout(initialLoadTimeoutRef.current)
      initialLoadTimeoutRef.current = null
    }
  }, [clearProcessingTimeout])

  const markRetiroRejected = useCallback(
    (message) => {
      if (completedRef.current || rejectedRef.current) return
      rejectedRef.current = true
      const msg = String(message || '').trim() || RETIRO_REJECTED_DEFAULT_MESSAGE
      setRejectedMessage(msg)
      setShowRejectedNotice(true)
      setIsAwaitingResult(false)
      setShowPendingNotice(false)
      clearProcessingTimeout()
      if (initialLoadTimeoutRef.current != null) {
        window.clearTimeout(initialLoadTimeoutRef.current)
        initialLoadTimeoutRef.current = null
      }
      onRetiroError?.(msg)
    },
    [clearProcessingTimeout, onRetiroError],
  )

  const revealPendingNotice = useCallback(() => {
    if (completedRef.current || rejectedRef.current) return
    setShowPendingNotice(true)
    setIsAwaitingResult(false)
    clearProcessingTimeout()
  }, [clearProcessingTimeout])

  const startProcessingTimeout = useCallback(() => {
    if (completedRef.current || rejectedRef.current || showPendingNotice || showRejectedNotice) return
    setIsAwaitingResult(true)
    clearProcessingTimeout()
    processingTimeoutRef.current = window.setTimeout(() => {
      revealPendingNotice()
    }, Math.max(1000, Number(processingTimeoutMs) || CODIGOS_RETIRO_PROCESSING_TIMEOUT_MS))
  }, [clearProcessingTimeout, processingTimeoutMs, revealPendingNotice, showPendingNotice, showRejectedNotice])

  const applyIframeHeight = useCallback((nextHeight) => {
    const h = Math.max(CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX, Math.ceil(Number(nextHeight) || 0))
    setIframeHeight(h)
  }, [])

  const handleIframeLoad = useCallback(() => {
    setIframeLoaded(true)
    iframeLoadCountRef.current += 1
    if (initialLoadTimeoutRef.current != null) {
      window.clearTimeout(initialLoadTimeoutRef.current)
      initialLoadTimeoutRef.current = null
    }
  }, [])

  const handleIframeShellPointerDown = useCallback(() => {
    userInteractedRef.current = true
  }, [])

  useEffect(() => {
    const allowedOrigin = resolveCodigosRetiroOrigin().replace(/\/$/, '')

    const onMessage = (event) => {
      const origin = String(event?.origin ?? '')
        .trim()
        .replace(/\/$/, '')
      if (origin !== allowedOrigin) return

      if (isRetiroErrorMessage(event)) {
        markRetiroRejected(parseRetiroErrorMessage(event))
        return
      }

      if (isRetiroCompletadoMessage(event)) {
        markRetiroCompleted()
        return
      }

      const tipo = extractRetiroMessageType(event.data)
      if (tipo && CODIGOS_RETIRO_WAIT_MESSAGE_TYPES.has(tipo)) {
        startProcessingTimeout()
        return
      }

      const next = extractIframeHeightFromMessage(event.data)
      if (next != null) applyIframeHeight(next)
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [applyIframeHeight, markRetiroCompleted, markRetiroRejected, startProcessingTimeout])

  useEffect(() => {
    if (iframeLoaded) return undefined
    initialLoadTimeoutRef.current = window.setTimeout(() => {
      if (!iframeLoaded && !completedRef.current && !rejectedRef.current) {
        revealPendingNotice()
      }
    }, Math.max(1000, Number(processingTimeoutMs) || CODIGOS_RETIRO_PROCESSING_TIMEOUT_MS))
    return () => {
      if (initialLoadTimeoutRef.current != null) {
        window.clearTimeout(initialLoadTimeoutRef.current)
        initialLoadTimeoutRef.current = null
      }
    }
  }, [iframeLoaded, processingTimeoutMs, revealPendingNotice])

  useEffect(
    () => () => {
      clearProcessingTimeout()
      if (initialLoadTimeoutRef.current != null) {
        window.clearTimeout(initialLoadTimeoutRef.current)
      }
    },
    [clearProcessingTimeout],
  )

  const shellClassName =
    `portal-receipt-upload-glow-wrap portal-codigos-retiro-glow portal-public-section mb-3 h-fit w-full min-w-0 rounded-2xl border border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.6)] md:mb-4 ${className}`.trim()

  if (showRejectedNotice) {
    return (
      <div className={shellClassName} style={style}>
        <section className="portal-receipt-upload-card portal-codigos-retiro-card h-fit w-full min-w-0 overflow-visible">
          <div className="portal-receipt-upload-circuit-overlay" aria-hidden />
          <div className="portal-order-summary-inner h-fit w-full px-3 pb-4 pt-4 md:px-5 md:pb-6 md:pt-5">
            <RetiroRejectedPanel message={rejectedMessage} />
          </div>
        </section>
      </div>
    )
  }

  if (showPendingNotice) {
    return (
      <div className={shellClassName} style={style}>
        <section className="portal-receipt-upload-card portal-codigos-retiro-card h-fit w-full min-w-0 overflow-visible">
          <div className="portal-receipt-upload-circuit-overlay" aria-hidden />
          <div className="portal-order-summary-inner h-fit w-full px-3 pb-4 pt-4 md:px-5 md:pb-6 md:pt-5">
            <RetiroPendingProcessingPanel />
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className={shellClassName} style={style}>
      <section className="portal-receipt-upload-card portal-codigos-retiro-card h-fit w-full min-w-0 overflow-visible">
        <div className="portal-receipt-upload-circuit-overlay" aria-hidden />
        <div className="portal-order-summary-inner h-fit w-full px-3 pb-4 pt-4 md:px-5 md:pb-6 md:pt-5">
          <p className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.06em] text-green-300">
            Códigos de retiro
          </p>
          <p className="mb-4 text-[13px] leading-relaxed text-slate-200/90">
            Sube tu comprobante y confirma los datos detectados en el formulario de verificación.
          </p>
          <div
            className="portal-codigos-retiro-iframe-shell relative min-h-[720px] w-full overflow-visible"
            onPointerDown={handleIframeShellPointerDown}
          >
            <iframe
              key={iframeSrc}
              ref={iframeRef}
              src={iframeSrc}
              title="Códigos de Retiro"
              className="portal-codigos-retiro-iframe block w-full min-h-[720px] border-0 bg-slate-950 p-0 outline-none"
              style={{
                height: iframeHeight,
                minHeight: CODIGOS_RETIRO_IFRAME_MIN_HEIGHT_PX,
              }}
              scrolling="no"
              allow="camera; clipboard-write"
              allowTransparency="true"
              onLoad={handleIframeLoad}
            />
            {!iframeLoaded ? (
              <div
                className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl border border-emerald-500/25 bg-slate-950/95 px-4 py-10 text-center"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-8 w-8 animate-spin text-emerald-400" aria-hidden />
                <p className="m-0 text-sm font-medium text-emerald-100/90">Cargando formulario de retiro…</p>
              </div>
            ) : null}
            {iframeLoaded && isAwaitingResult ? (
              <div
                className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl bg-slate-950/88 px-4 py-8 text-center backdrop-blur-[2px]"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-7 w-7 animate-spin text-emerald-400" aria-hidden />
                <p className="m-0 max-w-xs text-sm font-medium leading-relaxed text-emerald-100/95">
                  Procesando tu comprobante…
                </p>
              </div>
            ) : null}
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
