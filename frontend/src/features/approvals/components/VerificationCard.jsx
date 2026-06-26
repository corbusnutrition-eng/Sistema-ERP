import { CheckCircle2, Eye, XCircle } from 'lucide-react'
import { formatSaleTableDate } from '../../sales/saleTableHelpers'

function receiptIsPdf(url) {
  if (!url) return false
  return String(url).toLowerCase().split('?')[0].endsWith('.pdf')
}

/**
 * Tarjeta ancha de conciliación bancaria para un ingreso pendiente.
 */
export default function VerificationCard({
  row,
  receiptHref,
  badge,
  formatMoney,
  canVerify,
  busyAction,
  onVerify,
  onReject,
}) {
  const payer =
    row.iptv_username?.trim() ||
    row.client_name?.trim() ||
    '—'
  const ref = row.reference || '—'
  const dateLabel = row.date ? formatSaleTableDate(row.date) : '—'

  return (
    <article className="rounded-2xl border border-gray-100 bg-white shadow-sm ring-1 ring-gray-100/80 overflow-hidden">
      <div className="flex flex-col lg:flex-row">
        <div className="flex-1 min-w-0 p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${badge.cls}`}
                >
                  {badge.label}
                </span>
                <span className="text-xs text-gray-500 truncate">{row.origin_label}</span>
              </div>
              <p className="mt-2 text-2xl font-bold tabular-nums text-gray-900 tracking-tight">
                {formatMoney(row.amount, row.currency)}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Referencia</p>
              <p className="font-mono text-sm font-semibold text-blue-700 tabular-nums">{ref}</p>
            </div>
          </div>

          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Fecha</dt>
              <dd className="mt-0.5 font-medium text-gray-800">{dateLabel}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Usuario que pagó</dt>
              <dd className="mt-0.5 font-mono text-gray-900 truncate" title={payer}>
                {payer}
              </dd>
              {row.client_name && row.iptv_username && row.client_name !== row.iptv_username ? (
                <dd className="text-xs text-gray-500 truncate mt-0.5">{row.client_name}</dd>
              ) : null}
            </div>
          </dl>

          {row.description ? (
            <p className="text-xs text-gray-500 line-clamp-2 border-t border-gray-50 pt-3">{row.description}</p>
          ) : null}
        </div>

        <div className="lg:w-72 xl:w-80 border-t lg:border-t-0 lg:border-l border-gray-100 bg-slate-50/60 p-5 flex flex-col gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-2">Comprobante</p>
            {receiptHref ? (
              <div className="space-y-2">
                {!receiptIsPdf(receiptHref) ? (
                  <a
                    href={receiptHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-xl overflow-hidden ring-1 ring-gray-200 bg-white hover:ring-blue-200 transition-shadow"
                  >
                    <img
                      src={receiptHref}
                      alt="Comprobante de pago"
                      className="w-full h-36 object-cover object-top"
                      loading="lazy"
                    />
                  </a>
                ) : null}
                <a
                  href={receiptHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex w-full items-center justify-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-xl
                             bg-white text-slate-700 ring-1 ring-gray-200 hover:bg-gray-50"
                >
                  <Eye size={16} aria-hidden />
                  Ver comprobante
                </a>
              </div>
            ) : (
              <p className="text-sm text-gray-400 italic">Sin comprobante adjunto</p>
            )}
          </div>

          {canVerify ? (
            <div className="mt-auto space-y-2">
              <button
                type="button"
                disabled={busyAction != null}
                onClick={() => onVerify?.(row)}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold rounded-xl
                           bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm disabled:opacity-50"
              >
                {busyAction === 'verify' ? (
                  <span className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                ) : (
                  <CheckCircle2 size={18} aria-hidden />
                )}
                Confirmar ingreso
              </button>
              <button
                type="button"
                disabled={busyAction != null}
                onClick={() => onReject?.(row)}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-xl
                           bg-white text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50 disabled:opacity-50"
              >
                {busyAction === 'reject' ? (
                  <span className="w-4 h-4 rounded-full border-2 border-rose-400 border-t-transparent animate-spin" />
                ) : (
                  <XCircle size={18} aria-hidden />
                )}
                No efectivo
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-400 text-center mt-auto">Solo lectura</p>
          )}
        </div>
      </div>
    </article>
  )
}
