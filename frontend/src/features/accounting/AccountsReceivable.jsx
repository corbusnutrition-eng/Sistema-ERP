import { useCallback, useEffect, useMemo, useState, Fragment } from 'react'
import { Link } from 'react-router-dom'
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Receipt,
  RefreshCw,
} from 'lucide-react'
import api from '../../api/axios'
import { AR_REPORT_STALE_EVENT } from '../../utils/arReportEvents'
import { formatShortDateEcuador } from '../../utils/datetime'

function formatMoney(n, currency = 'USD') {
  const x = Number(n)
  const safe = Number.isFinite(x) ? x : 0
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safe)
  } catch {
    return `${safe.toFixed(2)} ${currency}`
  }
}

function saleDetailHref(saleId) {
  return `/ventas?sale=${encodeURIComponent(String(saleId))}`
}

function walletRechargeDetailHref(rechargeId) {
  return `/equipo/distribuidores?open_recharge=${encodeURIComponent(String(rechargeId))}`
}

function obligationKey(clientId, inv) {
  const kind = String(inv?.obligation_kind ?? 'sale')
  if (kind === 'wallet_recharge' && inv?.wallet_recharge_id != null) {
    return `${clientId}-wr-${inv.wallet_recharge_id}`
  }
  return `${clientId}-sale-${inv?.sale_id ?? '0'}`
}

function obligationDocLabel(inv) {
  const kind = String(inv?.obligation_kind ?? 'sale')
  const ref = String(inv?.reference ?? '').trim()
  if (kind === 'wallet_recharge') {
    if (ref) return ref.startsWith('REC-') ? ref : `REC-${ref.replace(/^#+/, '')}`
    const rid = inv?.wallet_recharge_id
    return rid != null ? `REC-${String(rid).padStart(5, '0')}` : 'REC—'
  }
  const saleRef = ref || String(inv?.sale_id ?? '')
  return `FAC-${saleRef.replace(/^#+/, '')}`
}

function rowKey(clientId, currency) {
  return `${clientId}-${currency || 'USD'}`
}

function CurrencyTotals({ totals, currencyFilter }) {
  const rows = Array.isArray(totals) ? totals : []
  if (currencyFilter && rows.length === 1) {
    return (
      <p className="text-sm font-bold text-gray-900 tabular-nums">
        {formatMoney(rows[0].total_amount_due, rows[0].currency)}
      </p>
    )
  }
  if (rows.length === 0) {
    return <p className="text-sm text-gray-400">—</p>
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      {rows.map((t) => (
        <span key={t.currency} className="text-sm font-semibold tabular-nums text-gray-900">
          {formatMoney(t.total_amount_due, t.currency)}
        </span>
      ))}
    </div>
  )
}

function CreditTotals({ totals, currencyFilter }) {
  const rows = Array.isArray(totals) ? totals : []
  if (currencyFilter && rows.length === 1) {
    return (
      <span className="text-sm font-bold text-emerald-800 tabular-nums">
        Total: {formatMoney(rows[0].total_credit_balance, rows[0].currency)}
      </span>
    )
  }
  if (rows.length === 0) {
    return <span className="text-sm text-gray-400">—</span>
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      {rows.map((t) => (
        <span key={`credit-${t.currency}`} className="text-sm font-bold text-emerald-800 tabular-nums">
          {formatMoney(t.total_credit_balance, t.currency)}
        </span>
      ))}
    </div>
  )
}

function formatReceiptLabel(payment) {
  const num = (payment.payment_number || '').trim()
  if (num) return num.startsWith('REC-') ? num : `REC-${num}`
  return `REC-${payment.payment_id}`
}

export default function AccountsReceivable({ backHref = '/contabilidad/plan-de-cuentas', backLabel = 'Volver a contabilidad' }) {
  const [currency, setCurrency] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [report, setReport] = useState(null)
  const [expandedClients, setExpandedClients] = useState(() => new Set())
  const [expandedInvoices, setExpandedInvoices] = useState(() => new Set())

  const loadReport = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = {}
      if (currency.trim()) params.currency = currency.trim().toUpperCase()
      const { data } = await api.get('/api/v1/reports/accounts-receivable', { params })
      setReport(data)
      setExpandedClients(new Set())
      setExpandedInvoices(new Set())
    } catch (err) {
      const detail = err?.response?.data?.detail
      setError(typeof detail === 'string' ? detail : 'No se pudo cargar cuentas por cobrar.')
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [currency])

  useEffect(() => {
    loadReport()
  }, [loadReport])

  useEffect(() => {
    const onStale = () => {
      loadReport()
    }
    window.addEventListener(AR_REPORT_STALE_EVENT, onStale)
    return () => window.removeEventListener(AR_REPORT_STALE_EVENT, onStale)
  }, [loadReport])

  const debtorRows = useMemo(() => report?.debtors ?? [], [report])
  const credits = useMemo(() => report?.credit_balances ?? [], [report])
  const currencyTotals = useMemo(() => report?.totals_by_currency ?? [], [report])

  function toggleRow(clientId, rowCurrency) {
    setExpandedClients((prev) => {
      const next = new Set(prev)
      const key = rowKey(clientId, rowCurrency)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleInvoice(clientId, inv) {
    const key = obligationKey(clientId, inv)
    setExpandedInvoices((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="max-w-6xl mx-auto pb-12 px-4">
      <Link
        to={backHref}
        className="text-green-700 hover:text-green-800 font-medium inline-flex items-center gap-1 mb-6 text-sm"
      >
        {'< '}
        {backLabel}
      </Link>

      <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
        <BookOpen size={14} className="text-blue-500" />
        <span>Contabilidad · Cuentas por cobrar</span>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Cuentas por cobrar</h1>
      <p className="text-sm text-gray-500 mt-1 max-w-3xl">
        Cartera agrupada por cliente y moneda (facturas IPTV y recargas BaaS). El saldo pendiente usa el
        CxC vivo tras abonos aprobados, no el importe total de la obligación.
      </p>

      <div className="mt-6 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600 font-medium">Moneda (opcional)</span>
          <input
            type="text"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            placeholder="USD, BOB, PEN…"
            className="w-36 px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
          />
        </label>
        <button
          type="button"
          onClick={loadReport}
          disabled={loading}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-green-700 text-white text-sm font-semibold hover:bg-green-800 disabled:opacity-60"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Actualizar
        </button>
      </div>

      {error && (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {loading && !report ? (
        <div className="mt-10 flex justify-center text-gray-500">
          <Loader2 size={28} className="animate-spin" />
        </div>
      ) : report ? (
        <div className="mt-8 space-y-10">
          <section className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-slate-50 to-white flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Clientes con deuda pendiente</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {debtorRows.length} balance{debtorRows.length === 1 ? '' : 's'} · cliente + moneda
                </p>
              </div>
              <div className="text-right">
                <p className="text-[11px] uppercase tracking-wide text-gray-500 font-medium">Total cartera</p>
                <CurrencyTotals totals={currencyTotals} currencyFilter={report.currency_filter} />
              </div>
            </div>

            {debtorRows.length === 0 ? (
              <p className="px-5 py-12 text-center text-sm text-gray-500">No hay deudores con saldo pendiente.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50/90 text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-gray-100">
                      <th className="w-11 px-3 py-3" aria-label="Expandir" />
                      <th className="px-3 py-3 font-semibold">Cliente / Usuario</th>
                      <th className="px-3 py-3 font-semibold text-center">Moneda</th>
                      <th className="px-3 py-3 font-semibold text-center">Facturas</th>
                      <th className="px-5 py-3 font-semibold text-right">Deuda total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {debtorRows.map((row) => {
                      const balanceKey = rowKey(row.client_id, row.currency)
                      const rowOpen = expandedClients.has(balanceKey)
                      const rowCurrency = row.currency || 'USD'
                      const invoices = [...(row.open_invoices || [])].sort(
                        (a, b) => new Date(b.date || 0) - new Date(a.date || 0),
                      )
                      return (
                        <Fragment key={balanceKey}>
                          <tr
                            className={`border-t border-gray-100 cursor-pointer transition-colors ${
                              rowOpen ? 'bg-blue-50/40' : 'hover:bg-slate-50/80'
                            }`}
                            onClick={() => toggleRow(row.client_id, rowCurrency)}
                            aria-expanded={rowOpen}
                          >
                            <td className="px-3 py-4 text-gray-400 align-top">
                              {rowOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                            </td>
                            <td className="px-3 py-4 align-top">
                              <div className="min-w-0">
                                <span className="font-semibold text-gray-900">{row.client_name}</span>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-gray-500">
                                  {row.client_username ? <span>@{row.client_username}</span> : null}
                                  <Link
                                    to={`/clientes/${row.client_id}`}
                                    onClick={(e) => e.stopPropagation()}
                                    className="inline-flex items-center gap-0.5 text-blue-600 hover:text-blue-800 hover:underline"
                                  >
                                    Ver perfil
                                    <ExternalLink size={12} className="opacity-70" />
                                  </Link>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-4 text-center align-top">
                              <span className="inline-flex rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-bold text-indigo-800">
                                {rowCurrency}
                              </span>
                            </td>
                            <td className="px-3 py-4 text-center align-top">
                              <span className="inline-flex min-w-[2rem] justify-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-700 tabular-nums">
                                {invoices.length}
                              </span>
                            </td>
                            <td className="px-5 py-4 text-right align-top">
                              <span className="text-lg font-bold tabular-nums text-gray-900">
                                {formatMoney(row.amount_due, rowCurrency)}
                              </span>
                            </td>
                          </tr>

                          {rowOpen ? (
                            <tr className="bg-slate-50/60 border-t border-gray-100">
                              <td colSpan={5} className="px-4 sm:px-6 py-4">
                                {invoices.length === 0 ? (
                                  <p className="text-sm text-gray-500 italic py-2">Sin detalle de facturas.</p>
                                ) : (
                                  <div className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
                                    <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50/80">
                                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">
                                        Obligaciones CxC — {row.client_name} ({rowCurrency})
                                      </p>
                                    </div>
                                    <table className="w-full text-xs sm:text-sm">
                                      <thead>
                                        <tr className="text-left text-gray-500 border-b border-gray-100">
                                          <th className="w-10 px-3 py-2.5" aria-label="Expandir factura" />
                                          <th className="px-3 py-2.5 font-semibold">N.º ref.</th>
                                          <th className="px-3 py-2.5 font-semibold">Fecha</th>
                                          <th className="px-3 py-2.5 font-semibold text-right">Monto total</th>
                                          <th className="px-3 py-2.5 font-semibold text-right">Saldo pendiente</th>
                                          <th className="px-3 py-2.5 font-semibold text-center">Detalle</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {invoices.map((inv) => {
                                          const cur = inv.currency || rowCurrency
                                          const invKey = obligationKey(row.client_id, inv)
                                          const invOpen = expandedInvoices.has(invKey)
                                          const payments = Array.isArray(inv.payments) ? inv.payments : []
                                          const isRecharge = String(inv?.obligation_kind ?? '') === 'wallet_recharge'
                                          const docLabel = obligationDocLabel(inv)
                                          return (
                                            <Fragment key={invKey}>
                                              <tr
                                                className={`border-t border-gray-50 cursor-pointer transition-colors ${
                                                  invOpen
                                                    ? isRecharge
                                                      ? 'bg-fuchsia-50/35'
                                                      : 'bg-amber-50/40'
                                                    : 'hover:bg-blue-50/30'
                                                }`}
                                                onClick={() => toggleInvoice(row.client_id, inv)}
                                                aria-expanded={invOpen}
                                              >
                                                <td className="px-3 py-2.5 text-gray-400">
                                                  {invOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                                </td>
                                                <td className="px-3 py-2.5 font-semibold text-gray-800 tabular-nums">
                                                  <span className={isRecharge ? 'text-fuchsia-900' : ''}>{docLabel}</span>
                                                  {isRecharge ? (
                                                    <span className="ml-1.5 text-[10px] font-bold uppercase text-fuchsia-700">
                                                      BaaS
                                                    </span>
                                                  ) : null}
                                                </td>
                                                <td className="px-3 py-2.5 text-gray-600">{formatShortDateEcuador(inv.date)}</td>
                                                <td className="px-3 py-2.5 text-right tabular-nums text-gray-700">
                                                  {formatMoney(inv.total_amount, cur)}
                                                </td>
                                                <td className="px-3 py-2.5 text-right tabular-nums font-bold text-red-700">
                                                  {formatMoney(inv.open_balance, cur)}
                                                </td>
                                                <td className="px-3 py-2.5 text-center">
                                                  {isRecharge && inv.wallet_recharge_id != null ? (
                                                    <Link
                                                      to={walletRechargeDetailHref(inv.wallet_recharge_id)}
                                                      onClick={(e) => e.stopPropagation()}
                                                      className="inline-flex items-center gap-1 rounded-md border border-fuchsia-200 bg-fuchsia-50 px-2 py-1 text-[11px] font-semibold text-fuchsia-800 hover:bg-fuchsia-100 hover:text-fuchsia-950"
                                                      title="Abrir solicitud BaaS"
                                                    >
                                                      Ver recarga
                                                      <ExternalLink size={12} className="opacity-70" />
                                                    </Link>
                                                  ) : (
                                                    <Link
                                                      to={saleDetailHref(inv.sale_id)}
                                                      onClick={(e) => e.stopPropagation()}
                                                      className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 hover:text-blue-900"
                                                      title="Abrir venta en el módulo de facturación"
                                                    >
                                                      Ver venta
                                                      <ExternalLink size={12} className="opacity-70" />
                                                    </Link>
                                                  )}
                                                </td>
                                              </tr>

                                              {invOpen ? (
                                                <tr className="bg-slate-50/80">
                                                  <td colSpan={6} className="px-4 py-3">
                                                    {payments.length === 0 ? (
                                                      <p className="text-xs text-gray-500 italic flex items-center gap-1.5 pl-6">
                                                        <Receipt size={14} className="opacity-50" />
                                                        Sin cobros registrados aplicados a esta factura.
                                                      </p>
                                                    ) : (
                                                      <div className="ml-6 rounded-lg border border-gray-200 bg-white overflow-hidden">
                                                        <div className="px-3 py-2 border-b border-gray-100 bg-gray-50/90">
                                                          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-600">
                                                            Cobros aplicados
                                                          </p>
                                                        </div>
                                                        <table className="w-full text-xs">
                                                          <thead>
                                                            <tr className="text-left text-gray-500 border-b border-gray-100">
                                                              <th className="px-3 py-2 font-semibold">N.º recibo</th>
                                                              <th className="px-3 py-2 font-semibold">Fecha</th>
                                                              <th className="px-3 py-2 font-semibold text-right">Monto aplicado</th>
                                                            </tr>
                                                          </thead>
                                                          <tbody className="divide-y divide-gray-50">
                                                            {payments.map((p) => (
                                                              <tr key={`${p.payment_id}-${p.date}`} className="hover:bg-emerald-50/40">
                                                                <td className="px-3 py-2 font-medium text-gray-800 tabular-nums">
                                                                  {formatReceiptLabel(p)}
                                                                </td>
                                                                <td className="px-3 py-2 text-gray-600">{formatShortDateEcuador(p.date)}</td>
                                                                <td className="px-3 py-2 text-right tabular-nums font-semibold text-emerald-700">
                                                                  {formatMoney(p.amount_applied, cur)}
                                                                </td>
                                                              </tr>
                                                            ))}
                                                          </tbody>
                                                        </table>
                                                      </div>
                                                    )}
                                                  </td>
                                                </tr>
                                              ) : null}
                                            </Fragment>
                                          )
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Saldos a favor</h2>
                <p className="text-xs text-gray-500 mt-0.5">Crédito acumulado por pagos excedentes (por moneda)</p>
              </div>
              <CreditTotals totals={currencyTotals} currencyFilter={report.currency_filter} />
            </div>
            {credits.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-gray-500">Ningún cliente con saldo a favor.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
                      <th className="px-5 py-3 font-semibold">Cliente</th>
                      <th className="px-5 py-3 font-semibold text-center">Moneda</th>
                      <th className="px-5 py-3 font-semibold text-right">Saldo a favor</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {credits.map((row) => (
                      <tr key={`credit-${row.client_id}-${row.currency}`} className="hover:bg-slate-50/70">
                        <td className="px-5 py-3">
                          <div>
                            <Link
                              to={`/clientes/${row.client_id}`}
                              className="font-medium text-blue-700 hover:text-blue-900 hover:underline"
                            >
                              {row.client_name || `Cliente #${row.client_id}`}
                            </Link>
                            {row.client_username ? (
                              <p className="text-xs text-gray-500 mt-0.5">@{row.client_username}</p>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-center">
                          <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
                            {row.currency || 'USD'}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-right font-semibold tabular-nums text-emerald-700">
                          {formatMoney(row.credit_balance, row.currency || 'USD')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}
