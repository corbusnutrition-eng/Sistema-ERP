function formatMoney(amount, currency) {
  const n = typeof amount === 'number' ? amount : parseFloat(String(amount ?? 0))
  if (!Number.isNaN(n)) {
    try {
      return new Intl.NumberFormat('es-CO', {
        style: 'currency',
        currency:
          String(currency ?? 'USD')
            .trim()
            .toUpperCase()
            .slice(0, 10) || 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n)
    } catch {
      return `${currency || 'USD'} ${n.toFixed(2)}`
    }
  }
  return '—'
}

/**
 * Tarjetas/botones de links Hotmart en el portal público del cliente.
 */
export default function PortalHotmartLinksPanel({ links = [], currency = 'USD', className = '' }) {
  const rows = (Array.isArray(links) ? links : []).filter(
    (item) => String(item?.url ?? '').trim() && Number(item?.amount) > 0,
  )
  if (!rows.length) return null

  return (
    <section
      className={className}
      style={{
        padding: '16px',
        marginBottom: 14,
        borderRadius: 18,
        background: 'rgba(249,115,22,0.12)',
        border: '1px solid rgba(249,115,22,0.35)',
      }}
    >
      <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.5, color: '#ffedd5', opacity: 0.95 }}>
        Haz clic en el link correspondiente a tu abono para pagar de forma segura en Hotmart.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((item, index) => {
          const url = String(item.url).trim()
          const label = `Pagar ${formatMoney(item.amount, currency)}`
          return (
            <a
              key={`${url}-${index}`}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '12px 16px',
                borderRadius: 14,
                background: 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)',
                color: '#fff',
                fontWeight: 700,
                fontSize: 14,
                textDecoration: 'none',
                boxShadow: '0 4px 14px rgba(234,88,12,0.35)',
              }}
            >
              {label}
            </a>
          )
        })}
      </div>
    </section>
  )
}
