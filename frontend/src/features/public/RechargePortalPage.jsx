import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Wallet, Upload, CheckCircle2, AlertCircle } from 'lucide-react'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

async function readErrorDetail(res) {
  try {
    const j = await res.json()
    const d = j?.detail
    if (typeof d === 'string') return d
    if (Array.isArray(d)) return d.map((x) => x?.msg || x).join('; ')
    return `Error ${res.status}`
  } catch {
    return `Error ${res.status}`
  }
}

export default function RechargePortalPage() {
  const { linkHash } = useParams()
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [file, setFile] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [doneMsg, setDoneMsg] = useState('')
  const [uploadError, setUploadError] = useState('')

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!linkHash) return
      setLoading(true)
      setError('')
      setUploadError('')
      try {
        const res = await fetch(
          `${API_BASE}/api/v1/distributors/recharge-public/${encodeURIComponent(linkHash)}`,
        )
        if (!res.ok) throw new Error(await readErrorDetail(res))
        const data = await res.json()
        if (!cancelled) setDetail(data)
      } catch (e) {
        if (!cancelled) setError(e?.message || 'No se pudo cargar el enlace.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [linkHash])

  async function handleSubmit(e) {
    e.preventDefault()
    setDoneMsg('')
    setUploadError('')
    if (!file || !linkHash) return
    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(
        `${API_BASE}/api/v1/distributors/recharge-public/${encodeURIComponent(linkHash)}/submit-receipt`,
        { method: 'POST', body: fd },
      )
      if (!res.ok) throw new Error(await readErrorDetail(res))
      const updated = await res.json()
      setDoneMsg('Comprobante enviado correctamente. Puedes enviar abonos adicionales mientras quede saldo pendiente.')
      setFile(null)
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              status: updated.status || prev.status,
              balance_pending:
                updated.balance_pending != null ? Number(updated.balance_pending) : prev.balance_pending,
              can_submit_receipt:
                updated.can_submit_receipt != null ?
                  Boolean(updated.can_submit_receipt)
                : Number(updated.balance_pending ?? prev.balance_pending ?? 0) > 1e-6,
              status_message:
                updated.status_message ||
                'Comprobante recibido. Puedes enviar abonos adicionales si aún hay saldo pendiente.',
            }
          : prev,
      )
    } catch (e) {
      setDoneMsg('')
      setUploadError(e?.message || 'No se pudo subir el archivo.')
    } finally {
      setSubmitting(false)
    }
  }

  function formatBillingAmount(amount, currency) {
    const n = Number(amount)
    if (!Number.isFinite(n)) return '—'
    const cur =
      String(currency ?? 'USD')
        .trim()
        .toUpperCase()
        .slice(0, 10) || 'USD'
    try {
      if (cur.length === 3) {
        return new Intl.NumberFormat('es-CO', {
          style: 'currency',
          currency: cur,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(n)
      }
    } catch {
      /* noop */
    }
    return `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`
  }

  function absolutizeMedia(u) {
    if (!u || typeof u !== 'string') return ''
    const t = u.trim()
    if (!t) return ''
    if (t.startsWith('http://') || t.startsWith('https://')) return t
    return t.startsWith('/') ? `${API_BASE}${t}` : `${API_BASE}/${t}`
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-4 py-12">
      <div className="max-w-lg mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-emerald-600 shadow-lg mb-4">
            <Wallet size={26} className="text-white" />
          </div>
          <h1 className="text-xl font-bold text-white tracking-tight">Recarga de saldo BaaS</h1>
          <p className="text-slate-400 text-sm mt-1">Completa el pago y adjunta tu comprobante</p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl p-6 space-y-5">
          {loading && <p className="text-sm text-gray-500 text-center py-8">Cargando…</p>}

          {!loading && error && (
            <div className="flex gap-2 items-start text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3 text-sm">
              <AlertCircle size={18} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {!loading && detail && !error && (
            <>
              <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Importe a pagar</p>
                <p className="text-2xl font-bold text-emerald-700 tabular-nums">
                  {formatBillingAmount(detail.amount_requested, detail.recharge_currency)}
                </p>
                {(() => {
                  const cur =
                    detail.recharge_currency && String(detail.recharge_currency).trim().length ?
                      String(detail.recharge_currency).trim().toUpperCase().slice(0, 10)
                    : 'USD'
                  const xr = Number(detail.recharge_exchange_rate)
                  if (!(Number.isFinite(xr) && xr > 0) || cur === 'USD') return null
                  return (
                    <p className="text-xs text-slate-600 mt-1">
                      Referencia tipo ventas: 1 USD = {xr.toLocaleString('es-LA')} {cur}
                    </p>
                  )
                })()}
                {detail.admin_precheck_receipt_url ?
                  <p className="text-xs mt-3">
                    <a
                      href={absolutizeMedia(detail.admin_precheck_receipt_url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-emerald-700 underline font-semibold"
                    >
                      Ver referencia de comprobante
                    </a>
                  </p>
                : null}
                <p className="text-xs text-slate-500 mt-2">{detail.status_message}</p>
                {Number(detail.balance_pending) > 1e-6 ? (
                  <p className="text-sm font-semibold text-amber-800 mt-2">
                    Saldo restante a pagar:{' '}
                    {formatBillingAmount(detail.balance_pending, detail.recharge_currency)}
                  </p>
                ) : null}
              </div>

              <div className="space-y-4">
                <h2 className="text-sm font-semibold text-gray-900">Datos para tu pago</h2>
                {(detail.method_groups || []).length === 0 ? (
                  <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                    No hay cuentas configuradas para este enlace. Contacta al administrador.
                  </p>
                ) : (
                  detail.method_groups.map((g) => (
                    <div key={g.payment_method_id} className="border border-gray-100 rounded-xl overflow-hidden">
                      <div className="bg-gray-50 px-3 py-2 text-xs font-bold text-gray-600 uppercase tracking-wide">
                        {g.payment_method_name}
                      </div>
                      <ul className="divide-y divide-gray-100">
                        {(g.accounts || []).map((a) => (
                          <li key={a.id} className="px-3 py-2.5 text-sm text-gray-800">
                            {a.label}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </div>

              {uploadError && (
                <div className="flex gap-2 items-start text-red-700 bg-red-50 border border-red-100 rounded-xl px-4 py-3 text-sm">
                  <AlertCircle size={18} className="shrink-0 mt-0.5" />
                  <span>{uploadError}</span>
                </div>
              )}

              {detail.can_submit_receipt ? (
                <form onSubmit={handleSubmit} className="space-y-3 pt-2 border-t border-gray-100">
                  <label className="block text-sm font-medium text-gray-700">Subir comprobante</label>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
                    className="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-emerald-600 file:text-white"
                    onChange={(ev) => setFile(ev.target.files?.[0] ?? null)}
                  />
                  <button
                    type="submit"
                    disabled={submitting || !file}
                    className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold text-sm py-2.5 rounded-xl transition-colors"
                  >
                    <Upload size={16} />
                    {submitting ? 'Enviando…' : 'Enviar comprobante'}
                  </button>
                </form>
              ) : null}

              {doneMsg && (
                <div className="flex gap-2 items-start text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3 text-sm">
                  <CheckCircle2 size={18} className="shrink-0 mt-0.5" />
                  <span>{doneMsg}</span>
                </div>
              )}
            </>
          )}
        </div>

        <p className="text-center text-slate-500 text-xs mt-8">IPTV ERP · Recarga distribuidores</p>
      </div>
    </div>
  )
}
