import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import {
  buildCodigosRetiroWidgetLink,
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

export const RETIRO_ERP_SUCCESS_TITLE = '¡Pago enviado y registrado con éxito!'
export const RETIRO_ERP_SUCCESS_MESSAGE =
  'Tu comprobante fue procesado por el sistema de Códigos de Retiro y tu saldo ha sido acreditado en el ERP.'

export const RETIRO_ERP_ERROR_TITLE = 'Ocurrió un problema al procesar tu pago.'
export const RETIRO_ERP_ERROR_MESSAGE =
  'No pudimos registrar tu comprobante en este momento. Por favor, vuelve a intentar cargarlo o contacta a tu distribuidor.'

const CODIGOS_RETIRO_PENDING_MESSAGE =
  'Tu comprobante fue enviado y está siendo procesado. El saldo se reflejará en breve.'

const CODIGOS_RETIRO_ERP_PROCESSING_MESSAGE = 'Registrando tu comprobante en el ERP…'

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

function formatRetiroMontoLabel(monto, currency = 'USD') {
  if (!Number.isFinite(monto) || monto <= 0) return null
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: String(currency || 'USD').slice(0, 10),
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(monto)
}

/** Pantalla de éxito tras confirmación del socio + registro en ERP. */
export function RetiroErpSuccessPanel({
  title = RETIRO_ERP_SUCCESS_TITLE,
  message = RETIRO_ERP_SUCCESS_MESSAGE,
  monto,
  currency = 'USD',
}) {
  const montoLabel = formatRetiroMontoLabel(monto, currency)

  return (
    <div
      className="rounded-2xl border border-emerald-400/45 bg-emerald-950/40 px-5 py-8 text-center"
      role="status"
      aria-live="polite"
    >
      <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-400" strokeWidth={1.75} aria-hidden />
      <p className="mt-4 mb-1 text-[17px] font-bold leading-snug text-emerald-50">{title}</p>
      <p className="m-0 text-[14px] leading-relaxed text-emerald-100/95">{message}</p>
      {montoLabel ? (
        <p className="mt-3 mb-0 text-[13px] text-emerald-200/90">
          Importe registrado: <strong className="tabular-nums">{montoLabel}</strong>
        </p>
      ) : null}
    </div>
  )
}

/** Pantalla de error con opción de reintentar. */
export function RetiroErpErrorPanel({
  title = RETIRO_ERP_ERROR_TITLE,
  message = RETIRO_ERP_ERROR_MESSAGE,
  onRetry = null,
}) {
  return (
    <div
      className="rounded-2xl border border-orange-400/45 bg-orange-950/35 px-5 py-8 text-center"
      role="alert"
      aria-live="assertive"
    >
      <AlertTriangle className="mx-auto h-12 w-12 text-orange-400" strokeWidth={1.75} aria-hidden />
      <p className="mt-4 mb-1 text-[17px] font-bold leading-snug text-orange-50">{title}</p>
      <p className="m-0 text-[14px] leading-relaxed text-orange-100/95">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 inline-flex items-center justify-center rounded-xl border border-orange-400/55 bg-orange-950/60 px-5 py-2.5 text-[14px] font-semibold text-orange-50 transition-colors hover:border-orange-300/70 hover:bg-orange-900/50"
        >
          Volver a intentar
        </button>
      ) : null}
    </div>
  )
}

/** Pantalla de procesamiento mientras el ERP registra el comprobante. */
export function RetiroErpProcessingPanel({ message = CODIGOS_RETIRO_ERP_PROCESSING_MESSAGE }) {
  return (
    <div
      className="rounded-2xl border border-sky-400/40 bg-sky-950/35 px-5 py-10 text-center"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="mx-auto h-10 w-10 animate-spin text-sky-400" aria-hidden />
      <p className="mt-4 mb-0 text-[15px] font-semibold leading-relaxed text-sky-50">{message}</p>
    </div>
  )
}

/** Aviso cuando el socio rechaza el comprobante (duplicado / inválido). */
export function RetiroRejectedPanel({ message = RETIRO_REJECTED_DEFAULT_MESSAGE, onRetry = null }) {
  return (
    <RetiroErpErrorPanel
      title="Comprobante rechazado"
      message={String(message || '').trim() || RETIRO_REJECTED_DEFAULT_MESSAGE}
      onRetry={onRetry}
    />
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
  erpIsProcessing = false,
  erpIsSuccess = false,
  erpHasError = false,
  erpErrorMessage = null,
  erpSuccessMonto = undefined,
  erpSuccessCurrency = 'USD',
  onErpRetry = null,
  remountKey = 0,
  onSuccess = null,
}) {
  const label = String(clientName ?? '').trim() || 'Cliente'
  const widgetEntity = entity === 'recharge' ? 'recharge' : 'sale'

  const widgetLink = useMemo(
    () =>
      buildCodigosRetiroWidgetLink(label, {
        referenciaExterna,
        entity: widgetEntity,
        esPrueba,
      }),
    [esPrueba, label, referenciaExterna, widgetEntity],
  )

  const iframeSrc = widgetLink.ok ? widgetLink.href : null

  useEffect(() => {
    if (!widgetLink.ok) {
      console.error('[CodigosRetiroWidget] Error al construir enlace de pago', {
        entity: widgetEntity,
        referenciaExterna,
        clientName,
        missing: widgetLink.missing,
        referenciaFormatted: widgetLink.referenciaFormatted,
      })
    }
  }, [clientName, referenciaExterna, widgetEntity, widgetLink])

  useEffect(() => {
    if (iframeSrc) {
      console.log('[CodigosRetiroWidget] URL del iframe:', iframeSrc, {
        entity: widgetEntity,
        referenciaExterna,
        referenciaFormatted: widgetLink.referenciaFormatted,
      })
    }
  }, [iframeSrc, referenciaExterna, widgetEntity, widgetLink.referenciaFormatted])

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
  const [internalRemountKey, setInternalRemountKey] = useState(0)

  const resetWidgetInternalState = useCallback(() => {
    completedRef.current = false
    rejectedRef.current = false
    iframeLoadCountRef.current = 0
    setIframeLoaded(false)
    setIsAwaitingResult(false)
    setShowPendingNotice(false)
    setShowRejectedNotice(false)
    setRejectedMessage(RETIRO_REJECTED_DEFAULT_MESSAGE)
    setInternalRemountKey((k) => k + 1)
  }, [])

  const handleRetry = useCallback(() => {
    resetWidgetInternalState()
    onErpRetry?.()
  }, [onErpRetry, resetWidgetInternalState])

  useEffect(() => {
    setIframeLoaded(false)
    setIsAwaitingResult(false)
    completedRef.current = false
    rejectedRef.current = false
    iframeLoadCountRef.current = 0
    setShowPendingNotice(false)
    setShowRejectedNotice(false)
  }, [iframeSrc, remountKey, internalRemountKey])

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

  const prevErpSuccessRef = useRef(false)
  useEffect(() => {
    if (erpIsSuccess && !prevErpSuccessRef.current) {
      onSuccess?.()
    }
    prevErpSuccessRef.current = erpIsSuccess
  }, [erpIsSuccess, onSuccess])

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
    if (completedRef.current || rejectedRef.current || erpIsProcessing || erpIsSuccess || erpHasError) return
    setShowPendingNotice(true)
    setIsAwaitingResult(false)
    clearProcessingTimeout()
  }, [clearProcessingTimeout, erpHasError, erpIsProcessing, erpIsSuccess])

  const startProcessingTimeout = useCallback(() => {
    if (
      completedRef.current ||
      rejectedRef.current ||
      showPendingNotice ||
      showRejectedNotice ||
      erpIsProcessing ||
      erpIsSuccess ||
      erpHasError
    ) {
      return
    }
    setIsAwaitingResult(true)
    clearProcessingTimeout()
    processingTimeoutRef.current = window.setTimeout(() => {
      revealPendingNotice()
    }, Math.max(1000, Number(processingTimeoutMs) || CODIGOS_RETIRO_PROCESSING_TIMEOUT_MS))
  }, [
    clearProcessingTimeout,
    erpHasError,
    erpIsProcessing,
    erpIsSuccess,
    processingTimeoutMs,
    revealPendingNotice,
    showPendingNotice,
    showRejectedNotice,
  ])

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
    if (iframeLoaded || erpIsProcessing || erpIsSuccess || erpHasError) return undefined
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
  }, [erpHasError, erpIsProcessing, erpIsSuccess, iframeLoaded, processingTimeoutMs, revealPendingNotice])

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

  const iframeMountKey = `${iframeSrc ?? 'none'}-${remountKey}-${internalRemountKey}`

  const renderFeedbackBody = (content) => (
    <div className={shellClassName} style={style}>
      <section className="portal-receipt-upload-card portal-codigos-retiro-card h-fit w-full min-w-0 overflow-visible">
        <div className="portal-receipt-upload-circuit-overlay" aria-hidden />
        <div className="portal-order-summary-inner h-fit w-full px-3 pb-4 pt-4 md:px-5 md:pb-6 md:pt-5">{content}</div>
      </section>
    </div>
  )

  if (!widgetLink.ok || !iframeSrc) {
    return renderFeedbackBody(
      <div
        className="rounded-2xl border border-amber-500/45 bg-amber-950/35 px-5 py-6 text-center"
        role="alert"
      >
        <p className="m-0 text-[15px] font-semibold text-amber-50">Error al construir enlace de pago</p>
        <p className="mt-2 mb-0 text-[13px] leading-relaxed text-amber-100/90">
          No pudimos enlazar esta {widgetEntity === 'recharge' ? 'recarga BaaS' : 'venta'} con el proveedor de pagos.
          Recarga la página o contacta soporte.
        </p>
      </div>,
    )
  }

  if (erpIsSuccess) {
    return renderFeedbackBody(
      <RetiroErpSuccessPanel monto={erpSuccessMonto} currency={erpSuccessCurrency} />,
    )
  }

  if (erpHasError) {
    return renderFeedbackBody(
      <RetiroErpErrorPanel
        message={String(erpErrorMessage || '').trim() || RETIRO_ERP_ERROR_MESSAGE}
        onRetry={handleRetry}
      />,
    )
  }

  if (erpIsProcessing) {
    return renderFeedbackBody(<RetiroErpProcessingPanel />)
  }

  if (showRejectedNotice && !erpHasError) {
    return renderFeedbackBody(
      <RetiroRejectedPanel message={rejectedMessage} onRetry={handleRetry} />,
    )
  }

  if (showPendingNotice) {
    return renderFeedbackBody(<RetiroPendingProcessingPanel />)
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
          {iframeSrc ? (
            <a
              href={iframeSrc}
              target="_blank"
              rel="noopener noreferrer"
              className="mb-3 inline-block text-[11px] text-slate-400/90 underline-offset-2 transition-colors hover:text-emerald-300/90 hover:underline"
            >
              Probar Enlace Directo
            </a>
          ) : null}
          <div
            className="portal-codigos-retiro-iframe-shell relative min-h-[720px] w-full overflow-visible"
            onPointerDown={handleIframeShellPointerDown}
          >
            <iframe
              key={iframeMountKey}
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

/** @deprecated Usar ``RetiroErpSuccessPanel`` para flujos con activación ERP. */
export function RetiroSuccessPanel({
  message = RETIRO_ERP_SUCCESS_MESSAGE,
  title = RETIRO_ERP_SUCCESS_TITLE,
  monto,
  currency = 'USD',
}) {
  return <RetiroErpSuccessPanel title={title} message={message} monto={monto} currency={currency} />
}
