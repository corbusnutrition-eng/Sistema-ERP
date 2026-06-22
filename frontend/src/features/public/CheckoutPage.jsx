import axios from 'axios'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

function publicApi() {
  return axios.create({
    baseURL: (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/?$/, ''),
  })
}

function formatMoney(amount, currency) {
  const n = typeof amount === 'number' ? amount : parseFloat(String(amount ?? 0))
  if (Number.isNaN(n)) return '—'
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: String(currency ?? 'USD')
        .trim()
        .toUpperCase()
        .slice(0, 10) || 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${currency || 'USD'} ${n.toFixed(2)}`
  }
}

function IconUploadCloud() {
  return (
    <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M7 18a4.6 4.6 0 0 1 0 -9 5 5 0 0 1 9.584 2" />
      <path d="M7 13a4 4 0 0 0 .585 7.957" />
      <path d="M12 12v9" />
      <path d="M9 16l3 -3 3 3" />
    </svg>
  )
}

export default function CheckoutPage() {
  const { token } = useParams()
  const [searchParams] = useSearchParams()
  const sent = searchParams.get('sent') === '1'

  const api = useMemo(() => publicApi(), [])

  const [detail, setDetail] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [loading, setLoading] = useState(true)

  const [methodId, setMethodId] = useState('')
  const [depositAccountId, setDepositAccountId] = useState('')
  const [file, setFile] = useState(null)
  const [dragOver, setDragOver] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [thanks, setThanks] = useState(sent ? 'Tu comprobante ya fue enviado. Gracias.' : '')

  const pickFileList = useCallback((list) => {
    const f = list?.[0]
    if (!f) return
    const ok =
      /^image\/(jpeg|png|gif|webp)$/i.test(f.type || '') ||
      /^application\/pdf$/i.test(f.type || '')
    if (!ok) {
      setSubmitError('El archivo debe ser imagen (JPG, PNG, GIF, WEBP) o PDF.')
      return
    }
    setSubmitError(null)
    setFile(f)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function run() {
      if (!token) {
        setLoadError('Enlace incompleto.')
        setLoading(false)
        return
      }
      if (sent) {
        setLoading(false)
        return
      }
      setLoading(true)
      setLoadError(null)
      try {
        const { data } = await api.get(`/api/v1/checkout/${encodeURIComponent(token)}`)
        if (!cancelled) {
          setDetail(data)
          const methods = Array.isArray(data.payment_methods) ? data.payment_methods : []
          setDepositAccountId('')
          if (methods.length) {
            setMethodId(String(methods[0].id))
          } else {
            setMethodId('')
          }
        }
      } catch (e) {
        if (!cancelled) {
          const msg =
            e?.response?.data?.detail ||
            'No encontramos este pedido o el enlace ya no está disponible para pagos.'
          setLoadError(typeof msg === 'string' ? msg : 'No disponible.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [api, token, sent])

  const saleCurrency = detail?.currency || 'USD'

  const linesSubtotalApprox = useMemo(() => {
    const lines = Array.isArray(detail?.lines) ? detail.lines : []
    let sum = 0
    let counted = false
    for (const ln of lines) {
      let piece = NaN
      if (ln.amount != null && !Number.isNaN(Number(ln.amount))) {
        piece = Number(ln.amount)
      } else if (
        ln.qty != null &&
        ln.rate != null &&
        !Number.isNaN(Number(ln.qty)) &&
        !Number.isNaN(Number(ln.rate))
      ) {
        piece = Number(ln.qty) * Number(ln.rate)
      }
      if (Number.isFinite(piece)) {
        sum += piece
        counted = true
      }
    }
    return counted ? sum : null
  }, [detail?.lines])

  /** Total a mostrar si el backend aún envía balance en cero pero hay líneas / local_amount / USD×tasa */
  const amountDueDisplayed = useMemo(() => {
    if (!detail) return 0
    const parseAmt = (v) => {
      if (v == null || v === '') return NaN
      const n = parseFloat(String(v).replace(',', '.'))
      return Number.isFinite(n) ? n : NaN
    }
    const bd = parseAmt(detail.balance_due)
    if (bd > 1e-9) return bd
    const la = parseAmt(detail.local_amount)
    if (la > 1e-9) return la
    if (linesSubtotalApprox != null && linesSubtotalApprox > 1e-9) return linesSubtotalApprox
    const usd = parseAmt(detail.amount_usd)
    const xr = Number(detail.exchange_rate)
    if (Number.isFinite(usd) && usd > 1e-9 && Number.isFinite(xr) && xr > 0) return usd * xr
    return Number.isFinite(bd) ? bd : 0
  }, [detail, linesSubtotalApprox])

  const owesLabel = useMemo(() => {
    if (!detail) return 'Saldo pendiente'
    const bd = parseFloat(String(detail.balance_due ?? '').replace(',', '.'))
    return Number.isFinite(bd) && bd > 1e-9 ? 'Saldo pendiente' : 'Total del pedido'
  }, [detail])

  const depositsForSelectedMethod = useMemo(() => {
    if (!detail) return []
    const pmName = Array.isArray(detail.payment_methods)
      ? detail.payment_methods.find((m) => String(m.id) === String(methodId))?.name
      : null
    const low = String(pmName ?? '')
      .trim()
      .toLowerCase()
    const deps = Array.isArray(detail.deposit_accounts) ? detail.deposit_accounts : []
    return deps.filter((d) => String(d.linked_payment_method || '').trim().toLowerCase() === low)
  }, [detail, methodId])

  const needsDepositPick = Boolean(
    detail && Array.isArray(detail.allowed_deposit_accounts) && detail.allowed_deposit_accounts.length > 0,
  )

  useEffect(() => {
    if (!detail || sent || !needsDepositPick) return
    setDepositAccountId((prev) => {
      const list = depositsForSelectedMethod
      if (!list.length) return ''
      if (prev && list.some((d) => String(d.id) === String(prev))) return prev
      return String(list[0].id)
    })
  }, [detail, depositsForSelectedMethod, needsDepositPick, sent])

  async function submitPay(e) {
    e.preventDefault()
    setSubmitError(null)
    if (!token) return
    if (!methodId) {
      setSubmitError('Elige un método de pago.')
      return
    }
    if (!file) {
      setSubmitError('Adjunta el comprobante (foto o PDF).')
      return
    }
    const needsDeposit = Boolean(
      detail?.allowed_deposit_accounts?.length > 0,
    )
    if (needsDeposit) {
      if (!depositAccountId) {
        setSubmitError(
          depositsForSelectedMethod.length
            ? 'Elige la cuenta donde realizaste el depósito.'
            : 'Este método no tiene cuentas de depósito habilitadas para este pedido; elija otro o contacte al vendedor.',
        )
        return
      }
    }

    const fd = new FormData()
    fd.append('payment_method_id', methodId)
    if (needsDeposit && depositAccountId) fd.append('deposit_account_id', depositAccountId)
    fd.append('payment_receipt', file)
    setSubmitting(true)
    try {
        const { data } = await api.post(`/api/v1/checkout/${encodeURIComponent(token)}/pay`, fd)
      const msg =
        typeof data?.message === 'string' ? data.message : 'Comprobante recibido. Gracias.'
      setThanks(msg)
      setDetail(null)
      setFile(null)
      window.history.replaceState(null, '', `${window.location.pathname}?sent=1`)
    } catch (e) {
      const raw = e?.response?.data?.detail
      setSubmitError(typeof raw === 'string' ? raw : 'No pudimos registrar el pago. Intenta de nuevo.')
    } finally {
      setSubmitting(false)
    }
  }

  const pageChrome = (
    <>
      <p
        style={{
          textAlign: 'center',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.28em',
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.45)',
          marginBottom: 8,
        }}
      >
        Pago seguro
      </p>
      <h1
        style={{
          margin: '0 0 6px',
          fontSize: 26,
          fontWeight: 800,
          letterSpacing: -0.5,
          lineHeight: 1.15,
          textAlign: 'center',
        }}
      >
        Portal de pagos de{' '}
        <span style={{ color: '#7dd3fc', fontWeight: 800 }}>Global Streaming</span>
      </h1>
      <p style={{ margin: '0 0 22px', textAlign: 'center', opacity: 0.62, fontSize: 14, lineHeight: 1.5 }}>
        Revisa tu pedido, el método de cobro y sube tu comprobante desde el móvil.
      </p>
    </>
  )

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'linear-gradient(145deg, #0f0c29 0%, #1a1440 42%, #16324a 100%)',
        padding: '20px 16px 48px',
        fontFamily: "'DM Sans', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        color: '#f8fafc',
      }}
    >
      <div style={{ maxWidth: 460, margin: '0 auto' }}>
        <div style={{ paddingTop: 12 }} />

        {pageChrome}

        {loading ? (
          <div
            style={{
              padding: '40px 20px',
              textAlign: 'center',
              borderRadius: 20,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                margin: '0 auto 14px',
                borderRadius: '50%',
                border: '3px solid rgba(255,255,255,0.25)',
                borderTopColor: '#a78bfa',
                animation: 'spin 0.8s linear infinite',
              }}
            />
            <p style={{ margin: 0, opacity: 0.72 }}>Cargando tu pedido…</p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        ) : null}

        {!loading && thanks ? (
          <div
            style={{
              padding: '28px 22px',
              borderRadius: 22,
              background: 'linear-gradient(180deg, rgba(34,197,94,0.18), rgba(15,23,42,0.72))',
              border: '1px solid rgba(52,211,153,0.35)',
              textAlign: 'center',
              boxShadow: '0 28px 64px rgba(0,0,0,0.45)',
            }}
          >
            <div style={{ fontSize: 44, marginBottom: 12 }} aria-hidden>
              ✓
            </div>
            <p style={{ margin: '0 0 8px', fontSize: 19, fontWeight: 750 }}>Listo</p>
            <p style={{ margin: 0, fontSize: 15, opacity: 0.88, lineHeight: 1.55 }}>{thanks}</p>
          </div>
        ) : null}

        {!loading && !thanks && loadError ? (
          <div
            style={{
              padding: '24px',
              borderRadius: 22,
              background: 'rgba(248,113,113,0.12)',
              border: '1px solid rgba(248,113,113,0.35)',
              textAlign: 'center',
              fontSize: 15,
              lineHeight: 1.5,
            }}
          >
            {loadError}
          </div>
        ) : null}

        {!loading && !thanks && detail ? (
          <form onSubmit={submitPay}>
            <section
              style={{
                padding: '20px',
                marginBottom: 16,
                borderRadius: 22,
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.12)',
                boxShadow: '0 26px 50px rgba(0,0,0,0.38)',
              }}
            >
              <p style={{ margin: '0 0 4px', fontSize: 12, opacity: 0.5, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Resumen del pedido
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, marginBottom: 14 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 780, letterSpacing: -0.3 }}>
                    {formatMoney(amountDueDisplayed, saleCurrency)}
                  </p>
                  <p style={{ margin: 0, fontSize: 13, opacity: 0.62 }}>
                    <span>{saleCurrency}</span>
                    {' · '}
                    {owesLabel}
                  </p>
                </div>
                <div
                  style={{
                    padding: '6px 10px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: 0.4,
                    textTransform: 'uppercase',
                    background: 'rgba(251,191,36,0.18)',
                    color: '#fcd34d',
                  }}
                >
                  Pendiente
                </div>
              </div>
              {(detail.lines || []).length > 0 ? (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12 }}>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {(detail.lines || []).map((ln, i) => {
                      const qty = ln.qty != null && !Number.isNaN(Number(ln.qty)) ? Number(ln.qty) : null
                      const rate = ln.rate != null && !Number.isNaN(Number(ln.rate)) ? Number(ln.rate) : null
                      const amt =
                        ln.amount != null && !Number.isNaN(Number(ln.amount))
                          ? Number(ln.amount)
                          : qty != null && rate != null
                            ? qty * rate
                            : null
                      return (
                        <li
                          key={i}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '1fr auto',
                            gap: '10px 12px',
                            padding: '10px 0',
                            borderBottom:
                              i < (detail.lines || []).length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                            fontSize: 14,
                            alignItems: 'start',
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <p style={{ margin: 0, fontWeight: 650, opacity: 0.95, lineHeight: 1.35 }}>
                              {(ln.description && String(ln.description).trim()) || 'Concepto'}
                            </p>
                            {(qty != null || rate != null) && (
                              <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.52, lineHeight: 1.4 }}>
                                {qty != null ? (
                                  <span>Cantidad: {qty === Math.floor(qty) ? qty.toLocaleString('es-ES') : qty.toLocaleString('es-ES', { maximumFractionDigits: 4 })}</span>
                                ) : null}
                                {qty != null && rate != null ? ' · ' : null}
                                {rate != null ? (
                                  <span>Precio unit.: {formatMoney(rate, saleCurrency)}</span>
                                ) : null}
                              </p>
                            )}
                          </div>
                          <div style={{ textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                            {amt != null ? formatMoney(amt, saleCurrency) : rate != null && qty != null ? formatMoney(rate * qty, saleCurrency) : '—'}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 12,
                      paddingTop: 12,
                      marginTop: 4,
                      fontSize: 14,
                      fontWeight: 750,
                      opacity: 0.95,
                      borderTop: '1px solid rgba(255,255,255,0.1)',
                    }}
                  >
                    <span>Total a pagar</span>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatMoney(amountDueDisplayed, saleCurrency)}</span>
                  </div>
                </div>
              ) : null}
              <p style={{ margin: '14px 0 0', fontSize: 12, opacity: 0.45 }}>
                Referencia #{String(detail.sale_id || '').padStart(4, '0')}
              </p>
            </section>

            <section
              style={{
                padding: '18px',
                marginBottom: 14,
                borderRadius: 22,
                background: 'rgba(15,23,42,0.55)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              <label htmlFor="pm" style={{ display: 'block', fontSize: 12, opacity: 0.5, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
                Método de pago
              </label>
              <select
                id="pm"
                value={methodId}
                required
                onChange={(ev) => setMethodId(ev.target.value)}
                style={{
                  width: '100%',
                  padding: '14px 16px',
                  borderRadius: 14,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(255,255,255,0.06)',
                  color: '#f8fafc',
                  fontSize: 15,
                  fontWeight: 600,
                }}
              >
                {(detail.payment_methods || []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {(detail.payment_methods || []).length === 0 ? (
                <p style={{ margin: '12px 0 0', fontSize: 13, color: '#fbbf24', opacity: 0.92 }}>
                  No hay métodos de pago habilitados para este pedido desde el ERP. Solicita que el proveedor seleccione
                  métodos permitidos antes de usar este enlace.
                </p>
              ) : null}
            </section>

            {(detail?.allowed_deposit_accounts || []).length > 0 ? (
              <section
                style={{
                  padding: '18px',
                  marginBottom: 14,
                  borderRadius: 22,
                  background: 'rgba(15,23,42,0.45)',
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              >
                <p style={{ margin: '0 0 4px', fontSize: 12, opacity: 0.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  Cuenta donde depositar
                </p>
                <p style={{ margin: '0 0 12px', fontSize: 12, opacity: 0.55, lineHeight: 1.45 }}>
                  Solo se muestran cuentas que el proveedor marcó como permitidas y que coinciden con tu método de
                  pago.
                </p>
                {depositsForSelectedMethod.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 14, color: '#fbbf24', lineHeight: 1.45 }}>
                    No hay una cuenta configurada para el método seleccionado. Elige otro método o contacta a Global
                    Streaming.
                  </p>
                ) : depositsForSelectedMethod.length === 1 ? (
                  depositsForSelectedMethod.map((d) => (
                    <div
                      key={d.id}
                      style={{
                        padding: '14px',
                        borderRadius: 14,
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        fontSize: 14,
                        lineHeight: 1.55,
                      }}
                    >
                      <p style={{ margin: 0, fontWeight: 700 }}>{d.bank_name}</p>
                      {d.account_holder_hint ? (
                        <p style={{ margin: '8px 0 0', opacity: 0.78 }}>{d.account_holder_hint}</p>
                      ) : null}
                      {d.account_number ? (
                        <p style={{ margin: '8px 0 0', fontVariantNumeric: 'tabular-nums', opacity: 0.92 }}>
                          Nº cuenta / referencia: <strong>{d.account_number}</strong>
                        </p>
                      ) : null}
                      <p style={{ margin: '8px 0 0', fontSize: 12, opacity: 0.55 }}>Moneda: {d.currency}</p>
                    </div>
                  ))
                ) : (
                  <>
                    <label htmlFor="depacc" style={{ display: 'block', fontSize: 12, opacity: 0.55, marginBottom: 8 }}>
                      Elige la cuenta donde transferiste:
                    </label>
                    <select
                      id="depacc"
                      value={depositAccountId}
                      required={needsDepositPick}
                      onChange={(ev) => setDepositAccountId(ev.target.value)}
                      style={{
                        width: '100%',
                        padding: '14px 16px',
                        borderRadius: 14,
                        border: '1px solid rgba(255,255,255,0.12)',
                        background: 'rgba(255,255,255,0.06)',
                        color: '#f8fafc',
                        fontSize: 15,
                        fontWeight: 600,
                      }}
                    >
                      {depositsForSelectedMethod.map((d) => (
                        <option key={d.id} value={String(d.id)}>
                          {d.bank_name}
                          {d.account_number ? ` · ${d.account_number}` : ''}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </section>
            ) : null}

            <section
              style={{
                padding: '18px',
                marginBottom: 16,
                borderRadius: 22,
                background: 'rgba(255,255,255,0.05)',
                border: dragOver ? '1px dashed #a78bfa' : '1px solid rgba(255,255,255,0.1)',
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                pickFileList(e.dataTransfer.files)
              }}
            >
              <p style={{ margin: '0 0 6px', fontSize: 12, opacity: 0.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Comprobante
              </p>
              <p style={{ margin: '0 0 14px', fontSize: 13, opacity: 0.65 }}>Captura tu transferencia, Nequi o billetera. También puedes adjuntar PDF.</p>

              <input
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
                id="rcv"
                className="sr-only"
                style={{ display: 'none' }}
                onChange={(e) => pickFileList(e.target.files)}
              />
              <label
                htmlFor="rcv"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  padding: '22px',
                  cursor: 'pointer',
                  borderRadius: 18,
                  background: 'rgba(0,0,0,0.18)',
                  color: dragOver ? '#e9d5ff' : '#94a3b8',
                  textAlign: 'center',
                  border: '1px dashed rgba(255,255,255,0.15)',
                  transition: 'border-color .2s,color .2s',
                }}
              >
                <IconUploadCloud />
                <span style={{ fontSize: 14, fontWeight: 620, color: '#e2e8f0' }}>
                  Arrastra la foto aquí{' '}
                  <span style={{ opacity: 0.55 }}>o toca para elegir</span>
                </span>
              </label>
              {file ? (
                <p style={{ margin: '12px 0 0', fontSize: 13, fontWeight: 600, opacity: 0.88 }}>
                  Archivo listo: {file.name}
                </p>
              ) : null}
            </section>

            {submitError ? (
              <p style={{ margin: '0 0 12px', fontSize: 14, color: '#fecaca', textAlign: 'center', lineHeight: 1.4 }}>{submitError}</p>
            ) : null}

            <button
              type="submit"
              disabled={
                submitting ||
                (detail.payment_methods || []).length === 0 ||
                (Boolean(detail?.allowed_deposit_accounts?.length) &&
                  methodId &&
                  depositsForSelectedMethod.length === 0)
              }
              style={{
                width: '100%',
                padding: '16px',
                border: 'none',
                borderRadius: 16,
                fontSize: 16,
                fontWeight: 780,
                color: '#0f172a',
                cursor:
                  submitting ||
                  (detail.payment_methods || []).length === 0 ||
                  (Boolean(detail?.allowed_deposit_accounts?.length) &&
                    methodId &&
                    depositsForSelectedMethod.length === 0)
                    ? 'not-allowed'
                    : 'pointer',
                opacity:
                  submitting ||
                  (detail.payment_methods || []).length === 0 ||
                  (Boolean(detail?.allowed_deposit_accounts?.length) &&
                    methodId &&
                    depositsForSelectedMethod.length === 0)
                    ? 0.55
                    : 1,
                background: 'linear-gradient(90deg,#c4b5fd,#67e8f9,#a5b4fc)',
                boxShadow: '0 18px 40px rgba(99,102,241,0.35)',
              }}
            >
              {submitting ? 'Enviando…' : 'Enviar pago'}
            </button>
          </form>
        ) : null}

        <p style={{ marginTop: 28, textAlign: 'center', fontSize: 12, opacity: 0.35 }}>Si tienes dudas, escríbenos por el mismo canal donde recibiste el enlace.</p>
      </div>
    </div>
  )
}
