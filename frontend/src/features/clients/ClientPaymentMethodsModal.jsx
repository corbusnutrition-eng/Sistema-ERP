import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, CreditCard, Loader2, X } from 'lucide-react'
import api from '../../api/axios'
import { normalizeCurrencyCode } from '../../lib/currencyCode'

function draftToAccountIds(draft) {
  const ids = new Set()
  for (const idSet of Object.values(draft || {})) {
    if (!(idSet instanceof Set)) continue
    for (const id of idSet) {
      const n = Number(id)
      if (Number.isFinite(n) && n > 0) ids.add(n)
    }
  }
  return Array.from(ids).sort((a, b) => a - b)
}

function accountIdsToDraft(accountIds, available) {
  const allowed = new Set(
    (Array.isArray(accountIds) ? accountIds : [])
      .map((id) => Number(id))
      .filter((id) => Number.isFinite(id) && id > 0),
  )
  const draft = {}
  for (const pm of available || []) {
    const methodId = Number(pm?.id)
    if (!Number.isFinite(methodId) || methodId < 1) continue
    const matched = (Array.isArray(pm?.accounts) ? pm.accounts : [])
      .map((a) => Number(a?.id))
      .filter((id) => Number.isFinite(id) && id > 0 && allowed.has(id))
    if (matched.length) draft[String(methodId)] = new Set(matched)
  }
  return draft
}

export default function ClientPaymentMethodsModal({ open, client, onClose, onSaved, onToast }) {
  const [available, setAvailable] = useState([])
  const [selectedByMethod, setSelectedByMethod] = useState({})
  const [expandedMethods, setExpandedMethods] = useState({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const clientId = client?.id != null ? Number(client.id) : null
  const clientCurrency = useMemo(
    () => normalizeCurrencyCode(client?.currency ?? 'USD', 'USD'),
    [client?.currency],
  )
  const clientLabel = useMemo(() => {
    const name = String(client?.name ?? '').trim()
    if (name) return name
    const email = String(client?.email ?? '').trim()
    if (email) return email
    return clientId ? `Cliente #${clientId}` : 'Cliente'
  }, [client?.name, client?.email, clientId])

  const selectedAccountCount = useMemo(
    () =>
      Object.values(selectedByMethod).reduce(
        (sum, idSet) => sum + (idSet instanceof Set ? idSet.size : 0),
        0,
      ),
    [selectedByMethod],
  )

  const loadData = useCallback(async () => {
    if (!clientId || clientId < 1) return
    setLoading(true)
    setError('')
    try {
      const [methodsRes, accountsRes] = await Promise.all([
        api.get(`/api/v1/admin/clients/${clientId}/payment-methods`),
        api.get(`/api/v1/admin/clients/${clientId}/payment-accounts`),
      ])
      const list = Array.isArray(methodsRes.data?.available_payment_methods)
        ? methodsRes.data.available_payment_methods
        : []
      const assignedIds = Array.isArray(accountsRes.data?.account_ids)
        ? accountsRes.data.account_ids
        : Array.isArray(methodsRes.data?.assigned_account_ids)
          ? methodsRes.data.assigned_account_ids
          : []
      const draft = accountIdsToDraft(assignedIds, list)
      const expanded = {}
      for (const key of Object.keys(draft)) expanded[key] = true
      setAvailable(list)
      setSelectedByMethod(draft)
      setExpandedMethods(expanded)
    } catch (err) {
      setAvailable([])
      setSelectedByMethod({})
      setExpandedMethods({})
      const d = err?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'No se pudieron cargar los métodos de pago.')
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    if (!open || !clientId) return
    void loadData()
  }, [open, clientId, loadData])

  function toggleMethodExpanded(methodId) {
    const key = String(methodId)
    setExpandedMethods((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function toggleAccount(methodId, accountId) {
    const mKey = String(methodId)
    const aId = Number(accountId)
    if (!Number.isFinite(aId) || aId < 1) return
    setSelectedByMethod((prev) => {
      const next = { ...prev }
      const current = new Set(next[mKey] || [])
      if (current.has(aId)) current.delete(aId)
      else current.add(aId)
      if (current.size === 0) delete next[mKey]
      else next[mKey] = current
      return next
    })
    setExpandedMethods((prev) => ({ ...prev, [mKey]: true }))
  }

  function toggleAllAccountsForMethod(methodId, accounts, checked) {
    const mKey = String(methodId)
    setSelectedByMethod((prev) => {
      const next = { ...prev }
      if (!checked) {
        delete next[mKey]
        return next
      }
      const ids = (accounts || [])
        .map((a) => Number(a?.id))
        .filter((id) => Number.isFinite(id) && id > 0)
      next[mKey] = new Set(ids)
      return next
    })
    if (checked) setExpandedMethods((prev) => ({ ...prev, [mKey]: true }))
  }

  async function handleSave() {
    if (!clientId) return
    const account_ids = draftToAccountIds(selectedByMethod)
    setSaving(true)
    setError('')
    try {
      const { data } = await api.put(`/api/v1/admin/clients/${clientId}/payment-accounts`, {
        account_ids,
      })
      onToast?.(data?.message || 'Cuentas de pago guardadas.')
      onSaved?.()
      onClose?.()
    } catch (err) {
      const d = err?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'No se pudieron guardar las cuentas de pago.')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/45"
      role="dialog"
      aria-modal="true"
      aria-labelledby="client-payment-methods-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose?.()
      }}
    >
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-white shadow-2xl ring-1 ring-gray-200 overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-sky-50 to-emerald-50">
          <div className="min-w-0">
            <h2 id="client-payment-methods-title" className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <CreditCard size={20} className="text-sky-600 shrink-0" aria-hidden />
              Métodos y cuentas de pago
            </h2>
            <p className="mt-0.5 text-sm text-gray-600 truncate">
              {clientLabel}
              {clientId ? <span className="text-gray-400"> · #{clientId}</span> : null}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Moneda del cliente:{' '}
              <span className="font-semibold text-gray-700">{clientCurrency}</span>
              {!loading && available.length > 0 ? (
                <span className="text-gray-400">
                  {' '}
                  · {available.length} método(s) · {selectedAccountCount} cuenta(s) seleccionada(s)
                </span>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            onClick={() => !saving && onClose?.()}
            className="shrink-0 p-2 rounded-lg text-gray-500 hover:bg-white/80 hover:text-gray-800"
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 text-red-800 text-sm px-3 py-2">
              {error}
            </div>
          ) : null}

          {loading ? (
            <p className="text-sm text-gray-500 flex items-center gap-2 py-8 justify-center">
              <Loader2 size={18} className="animate-spin" />
              Cargando métodos y cuentas…
            </p>
          ) : available.length === 0 ? (
            <p className="text-sm text-gray-500 py-8 text-center">
              No hay métodos de pago globales con cuentas de depósito en {clientCurrency}.
            </p>
          ) : (
            <ul className="space-y-3">
              {available.map((pm) => {
                const pid = Number(pm.id)
                const mKey = String(pid)
                const accounts = Array.isArray(pm.accounts) ? pm.accounts : []
                const selectedSet = selectedByMethod[mKey] || new Set()
                const expanded = Boolean(expandedMethods[mKey])
                const allSelected =
                  accounts.length > 0 && accounts.every((a) => selectedSet.has(Number(a.id)))
                const someSelected = accounts.some((a) => selectedSet.has(Number(a.id)))
                return (
                  <li
                    key={`pm-${pid}`}
                    className="rounded-xl border border-gray-200 overflow-hidden bg-white"
                  >
                    <div className="flex items-start gap-2 px-3 py-3 bg-slate-50/80">
                      <button
                        type="button"
                        onClick={() => toggleMethodExpanded(pid)}
                        className="mt-0.5 p-1 rounded-md text-gray-500 hover:bg-white hover:text-gray-800"
                        aria-expanded={expanded}
                        aria-label={expanded ? 'Contraer cuentas' : 'Expandir cuentas'}
                      >
                        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-gray-900">{pm.name}</p>
                          {someSelected ? (
                            <span className="text-[11px] font-medium text-sky-700 bg-sky-100 px-2 py-0.5 rounded-full">
                              {selectedSet.size} cuenta(s)
                            </span>
                          ) : null}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {accounts.length} cuenta(s) disponible(s) en {pm.currency || clientCurrency}
                        </p>
                      </div>
                      <label className="inline-flex items-center gap-2 text-xs text-gray-600 shrink-0 cursor-pointer">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-gray-300 text-sky-600 focus:ring-sky-500"
                          checked={allSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someSelected && !allSelected
                          }}
                          onChange={(e) => toggleAllAccountsForMethod(pid, accounts, e.target.checked)}
                          disabled={saving || accounts.length === 0}
                        />
                        Todas
                      </label>
                    </div>

                    {expanded ? (
                      <ul className="divide-y divide-gray-100 border-t border-gray-100">
                        {accounts.map((acc) => {
                          const aid = Number(acc.id)
                          const checked = selectedSet.has(aid)
                          return (
                            <li key={`acc-${pid}-${aid}`}>
                              <label className="flex items-start gap-3 px-4 py-2.5 pl-10 cursor-pointer hover:bg-sky-50/50 has-[:checked]:bg-sky-50/70">
                                <input
                                  type="checkbox"
                                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-sky-600 focus:ring-sky-500"
                                  checked={checked}
                                  onChange={() => toggleAccount(pid, aid)}
                                  disabled={saving}
                                />
                                <span className="min-w-0">
                                  <span className="block text-sm font-medium text-gray-800">{acc.name}</span>
                                  <span className="block text-xs text-gray-500 mt-0.5">
                                    {acc.account_number ? `Nº ${acc.account_number} · ` : ''}
                                    {acc.currency || clientCurrency}
                                  </span>
                                </span>
                              </label>
                            </li>
                          )
                        })}
                      </ul>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}

          <p className="mt-4 text-xs text-gray-500">
            Selecciona las cuentas específicas (hijas) que verá el cliente en su portal. El método padre
            solo aparecerá si tiene al menos una cuenta marcada. Si no seleccionas ninguna, el portal usará
            la configuración global por defecto.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-gray-100 bg-gray-50/80">
          <button
            type="button"
            onClick={() => !saving && onClose?.()}
            className="px-4 py-2 text-sm font-medium text-gray-700 rounded-lg hover:bg-gray-100"
            disabled={saving}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || loading}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-sky-600 rounded-lg hover:bg-sky-700 disabled:opacity-60"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : null}
            Guardar
          </button>
        </div>
      </div>
    </div>
  )
}
