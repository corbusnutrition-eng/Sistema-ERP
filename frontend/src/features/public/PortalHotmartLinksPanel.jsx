import {
  formatPaymentLinkAmount,
  isCustomPaymentLinkBlock,
  paymentLinkBlockHasPortalContent,
} from '../../utils/hotmartLinks'

function formatMoney(amount, currency) {
  return formatPaymentLinkAmount(amount, currency)
}

/**
 * Tarjetas/botones de links y bloques personalizados en el portal público del cliente.
 */
export default function PortalHotmartLinksPanel({ links = [], currency = 'USD', className = '' }) {
  const rows = (Array.isArray(links) ? links : []).filter(paymentLinkBlockHasPortalContent)
  if (!rows.length) return null

  return (
    <div className={`portal-order-summary-glow-wrap w-full min-w-0 ${className}`.trim()} style={{ marginBottom: 14 }}>
      <section className="portal-order-summary-card portal-order-summary-card--overflow-visible w-full min-w-0 rounded-[18px] p-4">
        <p className="m-0 mb-3 text-[13px] leading-snug text-cyan-50/90">
          Opciones de pago configuradas por tu proveedor. Elige la que corresponda a tu abono.
        </p>
        <div className="flex flex-col gap-3">
          {rows.map((item, index) => {
            if (isCustomPaymentLinkBlock(item)) {
              return <CustomPaymentCard key={`custom-${index}`} item={item} currency={currency} index={index} />
            }
            return <StandardPaymentButton key={`std-${index}`} item={item} currency={currency} />
          })}
        </div>
      </section>
    </div>
  )
}

function StandardPaymentButton({ item, currency }) {
  const url = String(item.url).trim()
  const label = `Pagar ${formatMoney(item.amount, currency)}`
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-center rounded-xl px-4 py-3 text-sm font-bold text-white no-underline shadow-[0_4px_14px_rgba(234,88,12,0.35)]"
      style={{ background: 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)' }}
    >
      {label}
    </a>
  )
}

function CustomPaymentCard({ item, currency, index }) {
  const text = String(item?.text ?? '').trim()
  const imageUrl = String(item?.image_url ?? '').trim()
  const url = String(item?.url ?? '').trim()
  const hasPay = url && Number(item?.amount) > 0

  return (
    <article className="overflow-hidden rounded-xl border border-cyan-400/35 bg-slate-950/35 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
      <p className="m-0 mb-3 text-[10px] font-bold uppercase tracking-[0.14em] text-cyan-200/80">
        Bloque personalizado {index + 1}
      </p>
      {imageUrl ? (
        <div className="mb-3 flex justify-center">
          <img
            src={imageUrl}
            alt=""
            className="max-h-40 w-auto max-w-full rounded-lg border border-white/10 object-contain"
          />
        </div>
      ) : null}
      {text ? (
        <p className="m-0 mb-3 whitespace-pre-wrap text-center text-sm leading-relaxed text-slate-100/90">{text}</p>
      ) : null}
      {hasPay ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center rounded-xl px-4 py-3 text-sm font-bold text-white no-underline shadow-[0_4px_14px_rgba(234,88,12,0.35)]"
          style={{ background: 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)' }}
        >
          Pagar {formatMoney(item.amount, currency)}
        </a>
      ) : item?.amount != null && Number(item.amount) > 0 ? (
        <p className="m-0 text-center text-sm font-semibold tabular-nums text-amber-200">
          Valor: {formatMoney(item.amount, currency)}
        </p>
      ) : null}
    </article>
  )
}
