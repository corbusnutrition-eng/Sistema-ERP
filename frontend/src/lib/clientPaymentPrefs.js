import api from '../api/axios'

function normalizePositiveIntIds(raw) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(raw) ? raw : []) {
    const n = Number(item)
    if (!Number.isFinite(n) || n < 1 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/**
 * Preferencias de pago del cliente en CRM (métodos + cuentas granulares).
 * @returns {Promise<{ paymentMethodIds: number[], depositAccountIds: number[] }>}
 */
export async function fetchClientPaymentPrefs(clientId) {
  const cid = Number(clientId)
  if (!Number.isFinite(cid) || cid < 1) {
    return { paymentMethodIds: [], depositAccountIds: [] }
  }

  const [methodsRes, accountsRes] = await Promise.all([
    api.get(`/api/v1/admin/clients/${cid}/payment-methods`),
    api.get(`/api/v1/admin/clients/${cid}/payment-accounts`),
  ])

  const depositAccountIds = normalizePositiveIntIds(
    accountsRes.data?.account_ids ??
      methodsRes.data?.assigned_account_ids ??
      [],
  )

  let paymentMethodIds = normalizePositiveIntIds(methodsRes.data?.assigned_payment_method_ids)

  if (!paymentMethodIds.length && depositAccountIds.length) {
    const available = Array.isArray(methodsRes.data?.available_payment_methods)
      ? methodsRes.data.available_payment_methods
      : []
    const allowed = new Set(depositAccountIds)
    const derived = new Set()
    for (const pm of available) {
      const methodId = Number(pm?.id)
      if (!Number.isFinite(methodId) || methodId < 1) continue
      const accounts = Array.isArray(pm?.accounts) ? pm.accounts : []
      if (accounts.some((a) => allowed.has(Number(a?.id)))) {
        derived.add(methodId)
      }
    }
    paymentMethodIds = Array.from(derived).sort((a, b) => a - b)
  }

  return { paymentMethodIds, depositAccountIds }
}
