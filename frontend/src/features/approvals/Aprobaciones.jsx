import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ExternalLink, Landmark, RefreshCw } from 'lucide-react'
import api from '../../api/axios'
import { useAuth } from '../../context/AuthContext'
import { PERMS } from '../../lib/permissions'
import { formatSaleTableDate } from '../sales/saleTableHelpers'

const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')

function receiptHref(url) {
  if (!url || typeof url !== 'string') return null
  const t = url.trim()
  if (!t) return null
  if (t.startsWith('http://') || t.startsWith('https://')) return t
  return `${API_BASE}${t.startsWith('/') ? t : `/${t}`}`
}

function formatMoney(n, currency = 'USD') {
  const x = Number(n)
  if (!Number.isFinite(x)) return '—'
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: String(currency || 'USD').toUpperCase(),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(x)
  } catch {
    return `${currency} ${x.toFixed(2)}`
  }
}

function originBadge(type) {
  const t = String(type || '').toLowerCase()
  if (t === 'venta') return { label: 'Venta', cls: 'bg-blue-50 text-blue-800 ring-blue-100' }
  if (t === 'recarga') return { label: 'Recarga', cls: 'bg-emerald-50 text-emerald-800 ring-emerald-100' }
  return { label: 'Pago', cls: 'bg-slate-50 text-slate-700 ring-slate-200' }
}

export default function Aprobaciones() {
  const { hasPermission } = useAuth()
  const canVerify = hasPermission(PERMS.APPROVALS_VERIFY)

  const [accounts, setAccounts] = useState([])
  const [selectedAccountId, setSelectedAccountId] = useState(null)
  const [pending, setPending] = useState([])
  const [loadingAccounts, setLoadingAccounts] = useState(true)
  const [loadingPending, setLoadingPending] = useState(false)
  const [verifyingId, setVerifyingId] = useState(null)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(''), 4000)
  }, [])

  const fetchAccounts = useCallback(async () => {
    setLoadingAccounts(true)
    setError('')
    try {
      const { data } = await api.get('/api/v1/approvals/accounts')
      const rows = Array.isArray(data) ? data : []
      setAccounts(rows)
      setSelectedAccountId((prev) => {
        if (prev != null && rows.some((a) => a.id === prev)) return prev
        return rows[0]?.id ?? null
      })
    } catch (err) {
      setAccounts([])
      setSelectedAccountId(null)
      const d = err?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'No se pudieron cargar las cuentas bancarias.')
    } finally {
      setLoadingAccounts(false)
    }
  }, [])

  const fetchPending = useCallback(async (accountId, silent = false) => {
    if (accountId == null) {
      setPending([])
      return
    }
    if (!silent) setLoadingPending(true)
    try {
      const { data } = await api.get(`/api/v1/approvals/pending/${accountId}`)
      setPending(Array.isArray(data) ? data : [])
    } catch (err) {
      setPending([])
      if (!silent) {
        const d = err?.response?.data?.detail
        showToast(typeof d === 'string' ? d : 'No se pudieron cargar los ingresos pendientes.')
      }
    } finally {
      if (!silent) setLoadingPending(false)
    }
  }, [showToast])

  useEffect(() => {
    void fetchAccounts()
  }, [fetchAccounts])

  useEffect(() => {
    if (selectedAccountId == null) return
    void fetchPending(selectedAccountId)
  }, [selectedAccountId, fetchPending])

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId],
  )

  async function handleVerify(row) {
    if (!canVerify || !row?.transaction_id) return
    if (!window.confirm(`¿Confirmar ingreso de ${formatMoney(row.amount, row.currency)} en el banco?`)) {
      return
    }
    setVerifyingId(row.transaction_id)
    try {
      await api.post(`/api/v1/approvals/${row.transaction_id}/verify`)
      setPending((prev) => prev.filter((x) => x.transaction_id !== row.transaction_id))
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === selectedAccountId ?
            { ...a, pending_count: Math.max(0, (a.pending_count ?? 0) - 1) }
          : a,
        ),
      )
      showToast('Ingreso confirmado en banco.')
    } catch (err) {
      const d = err?.response?.data?.detail
      showToast(typeof d === 'string' ? d : 'No se pudo verificar el ingreso.')
    } finally {
      setVerifyingId(null)
    }
  }

  function handleRefresh() {
    void fetchAccounts()
    if (selectedAccountId != null) void fetchPending(selectedAccountId)
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {toast && (
        <div className="fixed top-5 right-5 z-50 flex items-center gap-2 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg">
          <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
          {toast}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <CheckCircle2 size={22} className="text-emerald-600" />
            <h1 className="text-2xl font-bold text-gray-900">Aprobaciones</h1>
          </div>
          <p className="text-sm text-gray-500 mt-0.5">
            Confirma que los cobros aprobados ingresaron realmente a tus cuentas bancarias.
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
        >
          <RefreshCw size={14} />
          Actualizar
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      <section aria-label="Cuentas bancarias">
        <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Efectivo y equivalentes
        </h2>
        {loadingAccounts ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-24 rounded-2xl bg-gray-100 animate-pulse" />
            ))}
          </div>
        ) : accounts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-10 text-center text-sm text-gray-500">
            No hay cuentas de Efectivo y equivalentes activas en el plan de cuentas.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {accounts.map((acc) => {
              const active = acc.id === selectedAccountId
              const pendingCount = Number(acc.pending_count ?? 0) || 0
              return (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => setSelectedAccountId(acc.id)}
                  className={`text-left rounded-2xl px-5 py-4 ring-1 transition-all ${
                    active ?
                      'bg-emerald-50 ring-emerald-300 shadow-sm'
                    : 'bg-white ring-gray-100 hover:ring-gray-200 hover:bg-gray-50/80'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Landmark size={18} className={active ? 'text-emerald-700' : 'text-gray-400'} />
                      <span className="font-semibold text-gray-900 truncate">{acc.name}</span>
                    </div>
                    {pendingCount > 0 && (
                      <span className="shrink-0 inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-full bg-amber-500 text-white text-xs font-bold">
                        {pendingCount}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    {acc.currency}
                    {acc.code ? ` · ${acc.code}` : ''}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {pendingCount === 0 ? 'Sin pendientes' : `${pendingCount} pendiente${pendingCount !== 1 ? 's' : ''}`}
                  </p>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <div className="bg-white rounded-2xl shadow-sm ring-1 ring-gray-100 overflow-hidden min-h-[20rem]">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-800">
              {selectedAccount ? selectedAccount.name : 'Ingresos pendientes'}
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {loadingPending ? 'Cargando…' : `${pending.length} ingreso${pending.length !== 1 ? 's' : ''} por verificar`}
            </p>
          </div>
        </div>

        {selectedAccountId == null ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
            Selecciona una cuenta bancaria arriba.
          </div>
        ) : loadingPending ? (
          <div className="p-6 space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-100 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : pending.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <CheckCircle2 size={36} className="mb-3 text-emerald-200" />
            <p className="text-sm font-medium text-gray-500">Todo verificado en esta cuenta</p>
            <p className="text-xs mt-1">No hay ingresos pendientes de confirmación bancaria.</p>
          </div>
        ) : (
          <div className="w-full overflow-x-auto">
            <table className="w-full table-auto text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">FECHA</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">REFERENCIA</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">ORIGEN</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">CLIENTE</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">MONTO</th>
                  <th className="text-center px-4 py-3 font-semibold text-gray-600">COMPROBANTE</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600 min-w-[160px]">ACCIÓN</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {pending.map((row) => {
                  const badge = originBadge(row.origin_type)
                  const href = receiptHref(row.receipt_url)
                  return (
                    <tr key={row.transaction_id} className="hover:bg-gray-50/60">
                      <td className="px-4 py-3 whitespace-nowrap text-gray-600">
                        {row.date ? formatSaleTableDate(row.date) : '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap font-medium text-gray-800 tabular-nums">
                        {row.reference || '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${badge.cls}`}
                        >
                          {badge.label}
                        </span>
                        <span className="block text-xs text-gray-500 mt-0.5">{row.origin_label}</span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-gray-700 max-w-[12rem] truncate">
                        {row.client_name || '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right font-semibold tabular-nums text-gray-900">
                        {formatMoney(row.amount, row.currency)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-800"
                          >
                            Ver
                            <ExternalLink size={12} />
                          </a>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {canVerify ? (
                          <button
                            type="button"
                            disabled={verifyingId === row.transaction_id}
                            onClick={() => handleVerify(row)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm disabled:opacity-50"
                          >
                            {verifyingId === row.transaction_id ? (
                              <span className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
                            ) : (
                              <CheckCircle2 size={14} />
                            )}
                            Confirmar Ingreso
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400">Solo lectura</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
