import { useState, useEffect, useMemo } from 'react'
import { CheckCircle2, X } from 'lucide-react'
import api from '../../../api/axios'
import {
  ACCOUNT_STRUCTURE,
  buildTipoCuentaValue,
  getBackendAccountTypeForTipoCuenta,
  getDefaultTipoCuentaValue,
  getDetallesForTipoCuenta,
  getFirstDetalleForTipoCuenta,
  inferTipoCuentaFromApi,
  isEfectivoYEquivalentesTipoCuenta,
  normalizeDetailType,
  sortPaymentMethodNames,
} from '../accountStructure'
import SearchableSelect from '../../../components/ui/SearchableSelect'
import { normalizeCurrencyCode } from '../../../lib/currencyCode'
import { formatDateEcuador, todayIsoDateEcuador } from '../../../utils/datetime'

const inputCls =
  'w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500'

function todayISO() {
  return todayIsoDateEcuador()
}

function toDateInputValue(v) {
  if (v == null || v === '') return todayISO()
  return String(v).slice(0, 10)
}

const MONEDA_OPCIONES = [
  { code: 'USD', label: 'USD — Dólar estadounidense' },
  { code: 'USDT', label: 'USDT — Tether (cripto estable)' },
  { code: 'BOB', label: 'BOB — Boliviano' },
  { code: 'COP', label: 'COP — Peso colombiano' },
  { code: 'MXN', label: 'MXN — Peso mexicano' },
  { code: 'ARS', label: 'ARS — Peso argentino' },
  { code: 'CLP', label: 'CLP — Peso chileno' },
  { code: 'PEN', label: 'PEN — Sol peruano' },
  { code: 'UYU', label: 'UYU — Peso uruguayo' },
  { code: 'PYG', label: 'PYG — Guaraní paraguayo' },
  { code: 'VES', label: 'VES — Bolívar venezolano' },
  { code: 'GTQ', label: 'GTQ — Quetzal guatemalteco' },
  { code: 'CRC', label: 'CRC — Colón costarricense' },
  { code: 'PAB', label: 'PAB — Balboa panameño' },
  { code: 'NIO', label: 'NIO — Córdoba nicaragüense' },
  { code: 'HNL', label: 'HNL — Lempira hondureño' },
  { code: 'DOP', label: 'DOP — Peso dominicano' },
  { code: 'EUR', label: 'EUR — Euro' },
]

function ToastSuccess({ message, onDismiss }) {
  return (
    <div className="fixed bottom-6 right-6 z-[80] flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ring-1 bg-green-50 text-green-800 ring-green-200">
      <CheckCircle2 size={16} className="text-green-600 shrink-0" />
      <span>{message}</span>
      <button type="button" onClick={onDismiss} className="ml-2 opacity-60 hover:opacity-100" aria-label="Cerrar">
        <X size={14} />
      </button>
    </div>
  )
}

function buildInitialFormState(tipoValue, paymentMethodsList = []) {
  const pmNames = sortPaymentMethodNames(paymentMethodsList)
  return {
    name: '',
    account_number: '',
    detail_type: getFirstDetalleForTipoCuenta(tipoValue, pmNames),
    description: '',
    is_subaccount: false,
    parent_id: '',
    opening_balance: '',
    opening_balance_date: todayISO(),
    currency: 'USD',
  }
}

export default function NuevaCuentaModal({
  onClose,
  onCreated,
  editAccount = null,
  initialParentId = null,
}) {
  const defaultTipo = useMemo(() => getDefaultTipoCuentaValue(), [])

  const [selectedTipoCuenta, setSelectedTipoCuenta] = useState(defaultTipo)
  const [accounts, setAccounts] = useState([])
  const [paymentMethods, setPaymentMethods] = useState([])
  const [paymentMethodsLoading, setPaymentMethodsLoading] = useState(true)
  const [loadingParents, setLoadingParents] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [successToast, setSuccessToast] = useState(null)
  const [form, setForm] = useState(() => buildInitialFormState(defaultTipo, []))

  const usingPaymentMethodsAsDetail = isEfectivoYEquivalentesTipoCuenta(selectedTipoCuenta)
  const paymentMethodNames = useMemo(() => sortPaymentMethodNames(paymentMethods), [paymentMethods])

  const detallesDisponibles = useMemo(() => {
    if (usingPaymentMethodsAsDetail) return paymentMethodNames
    return getDetallesForTipoCuenta(selectedTipoCuenta)
  }, [selectedTipoCuenta, usingPaymentMethodsAsDetail, paymentMethodNames])

  const detailFormBlocked =
    saving ||
    detallesDisponibles.length === 0 ||
    (usingPaymentMethodsAsDetail && paymentMethodsLoading)

  const tipoCuentaSelectOptions = useMemo(() => {
    const out = []
    for (const [categoriaMatriz, grupos] of Object.entries(ACCOUNT_STRUCTURE)) {
      for (const row of grupos) {
        const v = buildTipoCuentaValue(categoriaMatriz, row.tipo)
        out.push({ value: v, label: `${categoriaMatriz} — ${row.tipo}` })
      }
    }
    return out
  }, [])

  const detailTypeSelectOptions = useMemo(
    () => detallesDisponibles.map((d) => ({ value: d, label: d })),
    [detallesDisponibles],
  )

  const monedaSelectOptions = useMemo(
    () => MONEDA_OPCIONES.map((m) => ({ value: m.code, label: m.label })),
    [],
  )

  const parentChoices = useMemo(() => {
    let list = accounts.filter((a) => !editAccount || Number(a.id) !== Number(editAccount.id))
    if (form.is_subaccount && form.currency) {
      const cur = normalizeCurrencyCode(form.currency)
      list = list.filter((a) => normalizeCurrencyCode(a.currency ?? 'USD') === cur)
    }
    return list
  }, [accounts, editAccount, form.is_subaccount, form.currency])

  const parentAccountSelectOptions = useMemo(() => {
    if (loadingParents) {
      return [{ value: '_loading', label: 'Cargando…', disabled: true }]
    }
    if (parentChoices.length === 0) {
      return [
        {
          value: '_empty',
          label: form.currency
            ? `Sin cuentas padre en ${form.currency}`
            : 'Sin cuentas disponibles',
          disabled: true,
        },
      ]
    }
    return parentChoices.map((a) => ({
      value: String(a.id),
      label: `${a.name}${a.account_number ? ` (${a.account_number})` : ''} · ${a.currency}`,
    }))
  }, [loadingParents, parentChoices, form.currency])

  const currencyLocked = form.is_subaccount && Boolean(form.parent_id)
  const mostrarSaldoApertura = usingPaymentMethodsAsDetail

  const fechaAyudaFormatted = useMemo(() => {
    const raw = form.opening_balance_date
    if (!raw) return 'la fecha seleccionada'
    return formatDateEcuador(`${raw}T12:00:00-05:00`)
  }, [form.opening_balance_date])

  async function refreshParentAccounts({ showLoading = true } = {}) {
    if (showLoading) setLoadingParents(true)
    try {
      const { data } = await api.get('/api/v1/accounts/')
      setAccounts(Array.isArray(data) ? data : [])
    } catch {
      setAccounts([])
    } finally {
      if (showLoading) setLoadingParents(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoadingParents(true)
      try {
        const { data } = await api.get('/api/v1/accounts/')
        if (!cancelled) setAccounts(Array.isArray(data) ? data : [])
      } catch {
        if (!cancelled) setAccounts([])
      } finally {
        if (!cancelled) setLoadingParents(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setPaymentMethodsLoading(true)
      try {
        const { data } = await api.get('/api/v1/payment-methods/', { params: { include_inactive: false } })
        if (!cancelled) setPaymentMethods(Array.isArray(data) ? data : [])
      } catch {
        if (!cancelled) setPaymentMethods([])
      } finally {
        if (!cancelled) setPaymentMethodsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (initialParentId == null || editAccount) return
    const par = accounts.find((a) => String(a.id) === String(initialParentId))
    if (!par) return
    setForm((p) =>
      p.is_subaccount && String(p.parent_id) === String(initialParentId)
        ? {
            ...p,
            currency: normalizeCurrencyCode(par.currency),
          }
        : p,
    )
  }, [accounts, initialParentId, editAccount])

  useEffect(() => {
    if (editAccount) {
      const tipo = inferTipoCuentaFromApi(
        editAccount.account_type,
        editAccount.detail_type,
        editAccount.linked_payment_method,
      )
      setSelectedTipoCuenta(tipo)
      const efectivoUi = isEfectivoYEquivalentesTipoCuenta(tipo)
      const opcionesDetalle = efectivoUi ? paymentMethodNames : getDetallesForTipoCuenta(tipo)
      const dtRaw = String(editAccount.linked_payment_method || editAccount.detail_type || '').trim()
      let safeDetail = opcionesDetalle[0] || getFirstDetalleForTipoCuenta(tipo, paymentMethodNames)
      if (dtRaw && opcionesDetalle.includes(dtRaw)) {
        safeDetail = dtRaw
      }
      const ob = editAccount.opening_balance
      setForm({
        name: editAccount.name ?? '',
        account_number: editAccount.account_number ?? '',
        detail_type: safeDetail,
        description: editAccount.description ?? '',
        is_subaccount: Boolean(editAccount.parent_id),
        parent_id: editAccount.parent_id ? String(editAccount.parent_id) : '',
        opening_balance: ob != null && ob !== '' ? String(ob) : '',
        opening_balance_date: toDateInputValue(editAccount.opening_balance_date),
        currency: normalizeCurrencyCode(editAccount.currency),
      })
      setError('')
      return
    }
    if (initialParentId != null) {
      setSelectedTipoCuenta(defaultTipo)
      setForm({
        ...buildInitialFormState(defaultTipo, paymentMethods),
        is_subaccount: true,
        parent_id: String(initialParentId),
      })
      setError('')
    }
  }, [editAccount, initialParentId, defaultTipo, paymentMethods, paymentMethodNames])

  useEffect(() => {
    if (editAccount) return
    if (!usingPaymentMethodsAsDetail) return
    if (paymentMethodNames.length === 0) return
    setForm((p) => {
      const cur = String(p.detail_type || '').trim()
      if (paymentMethodNames.includes(cur)) return p
      return { ...p, detail_type: paymentMethodNames[0] }
    })
  }, [paymentMethodNames, usingPaymentMethodsAsDetail, editAccount])

  function resetFormToNew() {
    setError('')
    setSelectedTipoCuenta(defaultTipo)
    setForm(buildInitialFormState(defaultTipo, paymentMethods))
  }

  function showSavedToast() {
    setSuccessToast('Cuenta guardada correctamente.')
    window.setTimeout(() => setSuccessToast(null), 4000)
  }

  function handleTipoCuentaChange(e) {
    const value = e.target.value
    setError('')
    setSelectedTipoCuenta(value)
    const primero = getFirstDetalleForTipoCuenta(value, paymentMethodNames)
    setForm((p) => {
      const next = { ...p, detail_type: primero }
      if (!isEfectivoYEquivalentesTipoCuenta(value)) {
        next.opening_balance = ''
        next.opening_balance_date = todayISO()
      }
      return next
    })
  }

  function handleChange(e) {
    const { name, value, type, checked } = e.target
    setError('')
    if (name === 'is_subaccount') {
      setForm((p) => ({ ...p, is_subaccount: checked, parent_id: checked ? p.parent_id : '' }))
      return
    }
    if (name === 'parent_id') {
      const pid = value
      setForm((p) => {
        if (!pid) return { ...p, parent_id: '' }
        const par = accounts.find((a) => String(a.id) === String(pid))
        const cur = par ? normalizeCurrencyCode(par.currency) : p.currency
        return { ...p, parent_id: pid, currency: cur || 'USD' }
      })
      return
    }
    if (name === 'currency') {
      setForm((p) => {
        const next = { ...p, currency: value }
        if (p.is_subaccount && p.parent_id) {
          const par = accounts.find((a) => String(a.id) === String(p.parent_id))
          if (
            par &&
            normalizeCurrencyCode(par.currency ?? 'USD') !== normalizeCurrencyCode(value || '')
          ) {
            next.parent_id = ''
          }
        }
        return next
      })
      return
    }
    if (name === 'detail_type') {
      setForm((p) => ({ ...p, detail_type: value }))
      return
    }
    setForm((p) => ({ ...p, [name]: value }))
  }

  async function saveAccount(keepOpen) {
    setError('')
    if (!form.name.trim()) {
      setError('Indica el nombre de la cuenta.')
      return
    }
    if (form.is_subaccount && !form.parent_id) {
      setError('Selecciona la cuenta padre.')
      return
    }

    const pmName = String(form.detail_type ?? '').trim()
    const efectivo = usingPaymentMethodsAsDetail

    if (efectivo && !pmName) {
      setError(
        paymentMethodsLoading
          ? 'Espera a que carguen los métodos de pago.'
          : paymentMethodNames.length === 0
            ? 'No hay métodos de pago activos. Créalos en Listas → Métodos de pago.'
            : 'Selecciona el método de pago vinculado a esta cuenta.',
      )
      return
    }

    if (!efectivo && !pmName) {
      setError('Selecciona el tipo de detalle.')
      return
    }

    const account_type = getBackendAccountTypeForTipoCuenta(selectedTipoCuenta)
    const detail_type = efectivo ? pmName : normalizeDetailType(pmName) || null

    const rawSaldo = String(form.opening_balance ?? '')
      .trim()
      .replace(/\s/g, '')
      .replace(',', '.')
    let opening_balance = null
    if (rawSaldo !== '') {
      const num = Number.parseFloat(rawSaldo)
      opening_balance = Number.isFinite(num) ? num : null
    }

    const curr = normalizeCurrencyCode(form.currency || 'USD', 'USD')

    const body = {
      name: form.name.trim(),
      account_number: form.account_number.trim() || null,
      account_type,
      detail_type,
      linked_payment_method: efectivo ? pmName : null,
      description: form.description.trim() || null,
      is_subaccount: form.is_subaccount,
      parent_id: form.is_subaccount ? Number(form.parent_id) : null,
      currency: curr,
      opening_balance: null,
      opening_balance_date: null,
    }

    if (efectivo) {
      body.opening_balance = opening_balance
      body.opening_balance_date = form.opening_balance_date || null
    }

    setSaving(true)
    try {
      const res = editAccount
        ? await api.patch(`/api/v1/accounts/${editAccount.id}`, body)
        : await api.post('/api/v1/accounts/', body)
      const ok = res.status >= 200 && res.status < 300
      if (!ok) {
        setError(editAccount ? 'No se pudo guardar la cuenta.' : 'No se pudo crear la cuenta.')
        return
      }
      onCreated()
      await refreshParentAccounts({ showLoading: false })
      if (editAccount) {
        onClose()
      } else if (keepOpen) {
        resetFormToNew()
        showSavedToast()
      } else {
        onClose()
      }
    } catch (err) {
      const d = err?.response?.data?.detail
      setError(
        typeof d === 'string'
          ? d
          : editAccount
            ? 'No se pudo guardar la cuenta.'
            : 'No se pudo crear la cuenta.',
      )
    } finally {
      setSaving(false)
    }
  }

  function handleSubmit(e) {
    e.preventDefault()
    saveAccount(false)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white rounded-2xl shadow-2xl border border-gray-100">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{editAccount ? 'Editar cuenta' : 'Nueva cuenta'}</h2>
            <p className="text-xs text-gray-500 mt-0.5">Tipos en cascada · Efectivo usa métodos de pago del catálogo</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-lg text-gray-400 hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nombre de la cuenta *</label>
            <input name="name" value={form.name} onChange={handleChange} className={inputCls} required placeholder="Ej. Caja PayPal USD" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Número de cuenta</label>
            <input name="account_number" value={form.account_number} onChange={handleChange} className={inputCls} placeholder="Opcional" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tipo de cuenta *</label>
              <SearchableSelect
                value={selectedTipoCuenta}
                onChange={(v) => handleTipoCuentaChange({ target: { value: v } })}
                options={tipoCuentaSelectOptions}
                hideClear
                disabled={saving}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {usingPaymentMethodsAsDetail ? 'Método de pago (detalle) *' : 'Tipo de detalle *'}
              </label>
              <SearchableSelect
                value={form.detail_type}
                onChange={(v) => handleChange({ target: { name: 'detail_type', value: v } })}
                options={detailTypeSelectOptions}
                hideClear
                placeholder={usingPaymentMethodsAsDetail ? 'Selecciona método de pago…' : undefined}
                disabled={detailFormBlocked}
              />
              {usingPaymentMethodsAsDetail && paymentMethodsLoading ? (
                <p className="text-[11px] text-gray-500 mt-1">Cargando métodos de pago…</p>
              ) : null}
              {usingPaymentMethodsAsDetail && !paymentMethodsLoading && paymentMethodNames.length === 0 ? (
                <p className="text-[11px] text-amber-700 mt-1">
                  No hay métodos de pago activos. Créalos en Listas → Métodos de pago.
                </p>
              ) : null}
              {usingPaymentMethodsAsDetail ? (
                <p className="text-[11px] text-gray-500 mt-1">
                  El detalle se toma del catálogo de métodos de pago y queda vinculado a esta cuenta.
                </p>
              ) : null}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Moneda de la cuenta</label>
            <div className={currencyLocked ? 'opacity-90' : ''}>
              <SearchableSelect
                value={form.currency}
                onChange={(v) => handleChange({ target: { name: 'currency', value: v } })}
                options={monedaSelectOptions}
                hideClear
                disabled={currencyLocked || saving}
              />
            </div>
            {currencyLocked && (
              <p className="text-xs text-gray-500 mt-1">La moneda coincide con la cuenta padre.</p>
            )}
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              name="is_subaccount"
              checked={form.is_subaccount}
              onChange={handleChange}
              className="mt-1 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-700">
              Convertir en una subcuenta
              {form.is_subaccount && (
                <span className="block text-xs text-gray-500 mt-1">Quedará bajo la cuenta padre seleccionada.</span>
              )}
            </span>
          </label>

          {mostrarSaldoApertura && (
            <div className="space-y-4 rounded-xl border border-slate-100 bg-slate-50/70 p-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Saldo de apertura</label>
                  <input
                    type="number"
                    name="opening_balance"
                    value={form.opening_balance}
                    onChange={handleChange}
                    className={inputCls}
                    min={0}
                    step="0.01"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">A partir del</label>
                  <input
                    type="date"
                    name="opening_balance_date"
                    value={form.opening_balance_date}
                    onChange={handleChange}
                    className={inputCls}
                  />
                </div>
              </div>
              <p className="text-xs text-gray-500 leading-relaxed">
                Iniciaremos el seguimiento a partir del {fechaAyudaFormatted} en adelante.
              </p>
            </div>
          )}

          {form.is_subaccount && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cuenta padre *</label>
              <SearchableSelect
                value={form.parent_id}
                onChange={(v) => handleChange({ target: { name: 'parent_id', value: v } })}
                options={parentAccountSelectOptions}
                placeholder="Selecciona cuenta padre…"
                clearLabel="Selecciona cuenta padre…"
                disabled={saving || loadingParents}
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Descripción</label>
            <textarea
              name="description"
              value={form.description}
              onChange={handleChange}
              rows={3}
              className={inputCls}
              placeholder="Notas internas sobre el uso de esta cuenta"
            />
          </div>

          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex flex-wrap justify-end gap-2 pt-2 border-t border-gray-100 mt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              Cancelar
            </button>
            {!editAccount && (
              <button
                type="button"
                onClick={() => saveAccount(true)}
                disabled={detailFormBlocked}
                className="px-4 py-2 text-sm font-semibold text-gray-800 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200 disabled:opacity-50"
              >
                {saving ? 'Guardando…' : 'Guardar y crear nueva'}
              </button>
            )}
            <button
              type="submit"
              disabled={detailFormBlocked}
              className="px-5 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 shadow-sm"
            >
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
      {successToast && <ToastSuccess message={successToast} onDismiss={() => setSuccessToast(null)} />}
    </div>
  )
}
