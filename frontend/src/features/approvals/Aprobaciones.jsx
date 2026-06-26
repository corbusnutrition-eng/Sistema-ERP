import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Landmark, RefreshCw } from 'lucide-react'
import api from '../../api/axios'
import { useAuth } from '../../context/AuthContext'
import { PERMS } from '../../lib/permissions'
import VerificationCard from './components/VerificationCard'

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

function sameAccountId(a, b) {
  if (a == null || b == null) return false
  return Number(a) === Number(b)
}

export default function Aprobaciones() {
  const { hasPermission } = useAuth()
  const canVerify = hasPermission(PERMS.APPROVALS_VERIFY)

  const [accounts, setAccounts] = useState([])
  const [selectedAccountId, setSelectedAccountId] = useState(null)
  const [pending, setPending] = useState([])
  const [loadingAccounts, setLoadingAccounts] = useState(true)
  const [loadingPending, setLoadingPending] = useState(false)
  const [actionState, setActionState] = useState(null)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')

  const pendingFetchSeq = useRef(0)

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
        if (prev != null && rows.some((a) => sameAccountId(a.id, prev))) return Number(prev)
        return rows[0]?.id != null ? Number(rows[0].id) : null
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

  const fetchPending = useCallback(async (accountId) => {
    if (accountId == null) {
      setPending([])
      setLoadingPending(false)
      return
    }
    const seq = ++pendingFetchSeq.current
    setLoadingPending(true)
    setPending([])
    try {
      const { data } = await api.get(`/api/v1/approvals/pending/${Number(accountId)}`)
      if (seq !== pendingFetchSeq.current) return
      setPending(Array.isArray(data) ? data : [])
    } catch (err) {
      if (seq !== pendingFetchSeq.current) return
      setPending([])
      const d = err?.response?.data?.detail
      showToast(typeof d === 'string' ? d : 'No se pudieron cargar los ingresos pendientes.')
    } finally {
      if (seq === pendingFetchSeq.current) setLoadingPending(false)
    }
  }, [showToast])

  useEffect(() => {
    void fetchAccounts()
  }, [fetchAccounts])

  useEffect(() => {
    if (selectedAccountId == null) {
      setPending([])
      return
    }
    void fetchPending(selectedAccountId)
  }, [selectedAccountId, fetchPending])

  const selectedAccount = useMemo(
    () => accounts.find((a) => sameAccountId(a.id, selectedAccountId)) ?? null,
    [accounts, selectedAccountId],
  )

  function bumpAccountPendingCount(delta) {
    setAccounts((prev) =>
      prev.map((a) =>
        sameAccountId(a.id, selectedAccountId) ?
          { ...a, pending_count: Math.max(0, (Number(a.pending_count) || 0) + delta) }
        : a,
      ),
    )
  }

  function removePendingRow(transactionId) {
    setPending((prev) => prev.filter((x) => x.transaction_id !== transactionId))
    bumpAccountPendingCount(-1)
  }

  async function handleVerify(row) {
    if (!canVerify || !row?.transaction_id) return
    if (!window.confirm(`¿Confirmar ingreso de ${formatMoney(row.amount, row.currency)} en el banco?`)) {
      return
    }
    setActionState({ id: row.transaction_id, action: 'verify' })
    try {
      await api.post(`/api/v1/approvals/${row.transaction_id}/verify`)
      removePendingRow(row.transaction_id)
      showToast('Ingreso confirmado en banco.')
    } catch (err) {
      const d = err?.response?.data?.detail
      showToast(typeof d === 'string' ? d : 'No se pudo verificar el ingreso.')
    } finally {
      setActionState(null)
    }
  }

  async function handleReject(row) {
    if (!canVerify || !row?.transaction_id) return
    if (
      !window.confirm(
        `¿Marcar como NO EFECTIVO el ingreso de ${formatMoney(row.amount, row.currency)}?\n\nSe revertirá el asiento contable y el pago quedará rechazado.`,
      )
    ) {
      return
    }
    setActionState({ id: row.transaction_id, action: 'reject' })
    try {
      await api.post(`/api/v1/approvals/${row.transaction_id}/reject`)
      removePendingRow(row.transaction_id)
      showToast('Ingreso rechazado. El asiento contable fue revertido.')
    } catch (err) {
      const d = err?.response?.data?.detail
      showToast(typeof d === 'string' ? d : 'No se pudo rechazar el ingreso.')
    } finally {
      setActionState(null)
    }
  }

  function handleSelectAccount(accountId) {
    setSelectedAccountId(Number(accountId))
  }

  function handleRefresh() {
    void fetchAccounts()
    if (selectedAccountId != null) void fetchPending(selectedAccountId)
  }

  const pendingCountLabel =
    loadingPending ?
      'Cargando…'
    : `${pending.length} ingreso${pending.length !== 1 ? 's' : ''} por verificar`

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
              const active = sameAccountId(acc.id, selectedAccountId)
              const pendingCount = Number(acc.pending_count ?? 0) || 0
              return (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => handleSelectAccount(acc.id)}
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
            <p className="text-xs text-gray-400 mt-0.5">{pendingCountLabel}</p>
          </div>
        </div>

        {selectedAccountId == null ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
            Selecciona una cuenta bancaria arriba.
          </div>
        ) : loadingPending ? (
          <div className="p-6 space-y-4">
            {[...Array(2)].map((_, i) => (
              <div key={i} className="h-44 bg-gray-100 rounded-2xl animate-pulse" />
            ))}
          </div>
        ) : pending.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <CheckCircle2 size={36} className="mb-3 text-emerald-200" />
            <p className="text-sm font-medium text-gray-500">Todo verificado en esta cuenta</p>
            <p className="text-xs mt-1">No hay ingresos pendientes de confirmación bancaria.</p>
          </div>
        ) : (
          <div className="p-4 sm:p-6 space-y-4">
            {pending.map((row) => {
              const badge = originBadge(row.origin_type)
              const href = receiptHref(row.receipt_url)
              const busy =
                actionState?.id === row.transaction_id ? actionState.action : null
              return (
                <VerificationCard
                  key={row.transaction_id}
                  row={row}
                  receiptHref={href}
                  badge={badge}
                  formatMoney={formatMoney}
                  canVerify={canVerify}
                  busyAction={busy}
                  onVerify={handleVerify}
                  onReject={handleReject}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
