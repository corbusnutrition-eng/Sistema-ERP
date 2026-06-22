import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'

const API_BASE = `${(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')}/api/v1`

// ── íconos SVG inline (sin dependencias extra) ─────────────────────────────

function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
      strokeLinecap="round" strokeLinejoin="round" style={{ width: 48, height: 48 }}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

function IconTV() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" style={{ width: 22, height: 22 }}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

function IconShield() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

function IconUser() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  )
}

function IconUpload() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

// ── estilos ─────────────────────────────────────────────────────────────────

const styles = {
  page: {
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  card: {
    background: 'rgba(255,255,255,0.05)',
    backdropFilter: 'blur(20px)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '24px',
    padding: '32px 24px',
    width: '100%',
    maxWidth: '420px',
    boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
    color: '#fff',
  },
  logo: {
    textAlign: 'center',
    marginBottom: '28px',
  },
  logoText: {
    fontSize: '13px',
    fontWeight: 600,
    letterSpacing: '3px',
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.4)',
  },
  greeting: {
    fontSize: '26px',
    fontWeight: 700,
    marginBottom: '4px',
    lineHeight: 1.2,
  },
  greetingSpan: {
    background: 'linear-gradient(90deg, #a78bfa, #60a5fa)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  subtitle: {
    fontSize: '14px',
    color: 'rgba(255,255,255,0.5)',
    marginBottom: '28px',
  },
  subscriptionCard: {
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '16px',
    padding: '20px',
    marginBottom: '24px',
  },
  subscriptionTitle: {
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '2px',
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.4)',
    marginBottom: '16px',
  },
  infoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    marginBottom: '12px',
  },
  infoIcon: {
    width: 36,
    height: 36,
    borderRadius: '10px',
    background: 'rgba(167,139,250,0.15)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#a78bfa',
    flexShrink: 0,
  },
  infoLabel: {
    fontSize: '12px',
    color: 'rgba(255,255,255,0.4)',
    marginBottom: '2px',
  },
  infoValue: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#fff',
  },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    fontSize: '12px',
    fontWeight: 600,
    padding: '3px 10px',
    borderRadius: '999px',
    background: 'rgba(52,211,153,0.15)',
    color: '#34d399',
    border: '1px solid rgba(52,211,153,0.3)',
  },
  badgeDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: '#34d399',
    animation: 'pulse 2s infinite',
  },
  providerPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    fontSize: '12px',
    fontWeight: 600,
    padding: '3px 10px',
    borderRadius: '999px',
    background: 'rgba(96,165,250,0.15)',
    color: '#60a5fa',
    border: '1px solid rgba(96,165,250,0.3)',
    marginRight: '6px',
  },
  divider: {
    height: '1px',
    background: 'rgba(255,255,255,0.08)',
    margin: '16px 0',
  },
  amountRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  amountLabel: {
    fontSize: '14px',
    color: 'rgba(255,255,255,0.5)',
  },
  amountValue: {
    fontSize: '22px',
    fontWeight: 800,
    background: 'linear-gradient(90deg, #a78bfa, #60a5fa)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  payButton: {
    width: '100%',
    padding: '18px',
    borderRadius: '16px',
    border: 'none',
    background: 'linear-gradient(135deg, #7c3aed, #2563eb)',
    color: '#fff',
    fontSize: '17px',
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: '0.3px',
    boxShadow: '0 8px 32px rgba(124,58,237,0.4)',
    transition: 'all 0.2s ease',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    marginBottom: '14px',
  },
  payButtonLoading: {
    background: 'linear-gradient(135deg, #4c1d95, #1e40af)',
    cursor: 'not-allowed',
    opacity: 0.7,
  },
  secureNote: {
    textAlign: 'center',
    fontSize: '12px',
    color: 'rgba(255,255,255,0.35)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '5px',
  },
  // ── estados ──
  centerBox: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '300px',
    gap: '16px',
  },
  spinner: {
    width: 44,
    height: 44,
    borderRadius: '50%',
    border: '3px solid rgba(255,255,255,0.1)',
    borderTopColor: '#a78bfa',
    animation: 'spin 0.8s linear infinite',
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: '8px',
  },
  errorTitle: {
    fontSize: '20px',
    fontWeight: 700,
    color: '#f87171',
    textAlign: 'center',
  },
  errorMsg: {
    fontSize: '14px',
    color: 'rgba(255,255,255,0.5)',
    textAlign: 'center',
    maxWidth: '280px',
    lineHeight: 1.5,
  },
  // ── pantalla de éxito ──
  successCircle: {
    width: 90,
    height: 90,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, rgba(52,211,153,0.2), rgba(16,185,129,0.3))',
    border: '2px solid rgba(52,211,153,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#34d399',
    marginBottom: '16px',
  },
  successTitle: {
    fontSize: '24px',
    fontWeight: 800,
    textAlign: 'center',
    marginBottom: '8px',
    background: 'linear-gradient(90deg, #34d399, #60a5fa)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  successMsg: {
    fontSize: '15px',
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
    lineHeight: 1.6,
    maxWidth: '300px',
  },
  successDetail: {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '14px',
    padding: '16px 20px',
    marginTop: '20px',
    width: '100%',
  },
  successDetailRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '13px',
    marginBottom: '6px',
  },
  successDetailLabel: {
    color: 'rgba(255,255,255,0.4)',
  },
  successDetailValue: {
    fontWeight: 600,
    color: '#fff',
  },
  // ── sección reporte manual ──
  manualSection: {
    marginTop: '28px',
    borderTop: '1px solid rgba(255,255,255,0.08)',
    paddingTop: '24px',
  },
  manualTitle: {
    fontSize: '13px',
    fontWeight: 700,
    color: 'rgba(255,255,255,0.6)',
    textTransform: 'uppercase',
    letterSpacing: '1.5px',
    marginBottom: '14px',
  },
  fileLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '12px 16px',
    background: 'rgba(255,255,255,0.06)',
    border: '1px dashed rgba(255,255,255,0.2)',
    borderRadius: '12px',
    cursor: 'pointer',
    color: 'rgba(255,255,255,0.6)',
    fontSize: '14px',
    marginBottom: '12px',
    transition: 'all 0.2s',
  },
  fileName: {
    fontSize: '12px',
    color: '#a78bfa',
    marginBottom: '12px',
    wordBreak: 'break-all',
  },
  reportButton: {
    width: '100%',
    padding: '14px',
    borderRadius: '12px',
    border: 'none',
    background: 'linear-gradient(135deg, #059669, #047857)',
    color: '#fff',
    fontSize: '15px',
    fontWeight: 600,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    transition: 'all 0.2s',
  },
  reportButtonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  reportSuccess: {
    marginTop: '12px',
    padding: '12px 16px',
    background: 'rgba(52,211,153,0.1)',
    border: '1px solid rgba(52,211,153,0.3)',
    borderRadius: '12px',
    color: '#34d399',
    fontSize: '13px',
    textAlign: 'center',
    lineHeight: 1.5,
  },
  reportError: {
    marginTop: '12px',
    padding: '12px 16px',
    background: 'rgba(248,113,113,0.1)',
    border: '1px solid rgba(248,113,113,0.3)',
    borderRadius: '12px',
    color: '#f87171',
    fontSize: '13px',
    textAlign: 'center',
  },
}

// ── componente principal ─────────────────────────────────────────────────────

export default function PaymentPage() {
  const { paymentId } = useParams()

  const [client, setClient] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [paying, setPaying] = useState(false)
  const [success, setSuccess] = useState(null)

  // Manual report state
  const [reportFile, setReportFile] = useState(null)
  const [reporting, setReporting] = useState(false)
  const [reportSuccess, setReportSuccess] = useState(false)
  const [reportError, setReportError] = useState(null)

  useEffect(() => {
    if (!paymentId) {
      setError('El link de pago no es válido.')
      setLoading(false)
      return
    }

    fetch(`${API_BASE}/clients/public/${paymentId}`)
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.detail || 'No se encontró el cliente.')
        }
        return res.json()
      })
      .then((data) => {
        setClient(data)
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message)
        setLoading(false)
      })
  }, [paymentId])

  async function handlePay() {
    if (paying) return
    setPaying(true)
    try {
      const res = await fetch(`${API_BASE}/sales/webhook/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_link_id: paymentId,
          amount: '10.00',
          currency: 'USD',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Error al procesar el pago.')
      setSuccess(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setPaying(false)
    }
  }

  async function handleReport() {
    if (!reportFile || reporting) return
    setReporting(true)
    setReportError(null)
    try {
      // 1. Upload image
      const formData = new FormData()
      formData.append('file', reportFile)
      const uploadRes = await fetch(`${API_BASE}/uploads/receipt`, {
        method: 'POST',
        body: formData,
      })
      const uploadData = await uploadRes.json()
      if (!uploadRes.ok) throw new Error(uploadData.detail || 'Error al subir la imagen.')

      // 2. Report payment with receipt_url
      const reportRes = await fetch(`${API_BASE}/sales/public/${paymentId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt_url: uploadData.receipt_url }),
      })
      const reportData = await reportRes.json()
      if (!reportRes.ok) throw new Error(reportData.detail || 'Error al reportar el pago.')

      setReportSuccess(true)
      setReportFile(null)
    } catch (err) {
      setReportError(err.message)
    } finally {
      setReporting(false)
    }
  }

  // ── JSX ───────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .pay-card { animation: fadeUp 0.4s ease; }
        .pay-btn:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 12px 40px rgba(124,58,237,0.55) !important;
        }
        .pay-btn:active:not(:disabled) { transform: translateY(0); }
      `}</style>

      <div style={styles.page}>
        <div style={styles.card} className="pay-card">

          {/* Logo / branding */}
          <div style={styles.logo}>
            <div style={styles.logoText}>⚡ StreamPay</div>
          </div>

          {/* ── Estado: cargando ── */}
          {loading && (
            <div style={styles.centerBox}>
              <div style={styles.spinner} />
              <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 14 }}>
                Cargando tu información…
              </span>
            </div>
          )}

          {/* ── Estado: error ── */}
          {!loading && error && !success && (
            <div style={styles.centerBox}>
              <div style={styles.errorIcon}>⚠️</div>
              <p style={styles.errorTitle}>Algo salió mal</p>
              <p style={styles.errorMsg}>{error}</p>
            </div>
          )}

          {/* ── Estado: éxito ── */}
          {success && (
            <div style={{ ...styles.centerBox, paddingTop: 8 }}>
              <div style={styles.successCircle}>
                <IconCheck />
              </div>
              <p style={styles.successTitle}>¡Pago Exitoso!</p>
              <p style={styles.successMsg}>
                Tu cuenta ha sido renovada. ¡Disfruta de tu servicio!
              </p>
              <div style={styles.successDetail}>
                <div style={styles.successDetailRow}>
                  <span style={styles.successDetailLabel}>Cliente</span>
                  <span style={styles.successDetailValue}>{client?.name}</span>
                </div>
                <div style={styles.successDetailRow}>
                  <span style={styles.successDetailLabel}>Proveedor</span>
                  <span style={styles.successDetailValue}>{success.provider ?? '—'}</span>
                </div>
                <div style={styles.successDetailRow}>
                  <span style={styles.successDetailLabel}>Referencia</span>
                  <span style={styles.successDetailValue}>#{success.sale_id}</span>
                </div>
                <div style={{ ...styles.successDetailRow, marginBottom: 0 }}>
                  <span style={styles.successDetailLabel}>Monto</span>
                  <span style={{ ...styles.successDetailValue, color: '#34d399' }}>$10.00 USD</span>
                </div>
              </div>
            </div>
          )}

          {/* ── Estado: datos del cliente ── */}
          {!loading && !error && !success && client && (
            <>
              {/* Saludo */}
              <h1 style={styles.greeting}>
                Hola,{' '}
                <span style={styles.greetingSpan}>
                  {client.name.split(' ')[0]}
                </span>{' '}
                👋
              </h1>
              <p style={styles.subtitle}>{client.email}</p>

              {/* Tarjeta de suscripción */}
              <div style={styles.subscriptionCard}>
                <p style={styles.subscriptionTitle}>Resumen de suscripción</p>

                {/* Pantallas activas */}
                <div style={styles.infoRow}>
                  <div style={styles.infoIcon}>
                    <IconTV />
                  </div>
                  <div>
                    <p style={styles.infoLabel}>Pantallas activas</p>
                    <p style={styles.infoValue}>
                      {client.active_screens > 0
                        ? `${client.active_screens} pantalla${client.active_screens !== 1 ? 's' : ''}`
                        : 'Sin pantallas asignadas'}
                    </p>
                  </div>
                </div>

                {/* Estado */}
                <div style={styles.infoRow}>
                  <div style={{ ...styles.infoIcon, background: 'rgba(52,211,153,0.1)', color: '#34d399' }}>
                    <IconUser />
                  </div>
                  <div>
                    <p style={styles.infoLabel}>Estado de cuenta</p>
                    <div>
                      {client.active_screens > 0 ? (
                        <span style={styles.badge}>
                          <span style={styles.badgeDot} />
                          Activo
                        </span>
                      ) : (
                        <span style={{ ...styles.badge, background: 'rgba(251,191,36,0.1)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}>
                          <span style={{ ...styles.badgeDot, background: '#fbbf24' }} />
                          Sin servicio
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Proveedores */}
                {client.providers?.length > 0 && (
                  <div style={styles.infoRow}>
                    <div style={{ ...styles.infoIcon, background: 'rgba(96,165,250,0.1)', color: '#60a5fa' }}>
                      <IconTV />
                    </div>
                    <div>
                      <p style={styles.infoLabel}>Plataformas</p>
                      <div style={{ marginTop: 4 }}>
                        {client.providers.map((p) => (
                          <span key={p} style={styles.providerPill}>{p}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                <div style={styles.divider} />

                <div style={styles.amountRow}>
                  <span style={styles.amountLabel}>Renovación mensual</span>
                  <span style={styles.amountValue}>$10.00 USD</span>
                </div>
              </div>

              {/* Botón de pago */}
              <button
                className="pay-btn"
                style={{
                  ...styles.payButton,
                  ...(paying ? styles.payButtonLoading : {}),
                }}
                onClick={handlePay}
                disabled={paying}
              >
                {paying ? (
                  <>
                    <div style={{ ...styles.spinner, width: 20, height: 20, borderWidth: 2 }} />
                    Procesando…
                  </>
                ) : (
                  <>
                    💳 Simular Pago ($10.00)
                  </>
                )}
              </button>

              {/* Nota de seguridad */}
              <div style={styles.secureNote}>
                <IconShield />
                Pago seguro y cifrado
              </div>

              {/* ── Sección: Reporte de pago manual ── */}
              <div style={styles.manualSection}>
                <p style={styles.manualTitle}>Reportar Pago Manual</p>

                {reportSuccess ? (
                  <div style={styles.reportSuccess}>
                    ✅ ¡Comprobante enviado! El administrador revisará tu pago y activará tu servicio en breve.
                  </div>
                ) : (
                  <>
                    <label style={styles.fileLabel} htmlFor="receipt-file">
                      <IconUpload />
                      {reportFile ? 'Cambiar imagen' : 'Seleccionar comprobante (foto / captura)'}
                    </label>
                    <input
                      id="receipt-file"
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        setReportFile(e.target.files[0] || null)
                        setReportError(null)
                      }}
                    />
                    {reportFile && (
                      <p style={styles.fileName}>📎 {reportFile.name}</p>
                    )}
                    <button
                      style={{
                        ...styles.reportButton,
                        ...(!reportFile || reporting ? styles.reportButtonDisabled : {}),
                      }}
                      onClick={handleReport}
                      disabled={!reportFile || reporting}
                    >
                      {reporting ? (
                        <>
                          <div style={{ ...styles.spinner, width: 16, height: 16, borderWidth: 2 }} />
                          Enviando…
                        </>
                      ) : (
                        <>
                          <IconUpload />
                          Enviar Comprobante
                        </>
                      )}
                    </button>
                    {reportError && (
                      <div style={styles.reportError}>{reportError}</div>
                    )}
                  </>
                )}
              </div>
            </>
          )}

        </div>
      </div>
    </>
  )
}
