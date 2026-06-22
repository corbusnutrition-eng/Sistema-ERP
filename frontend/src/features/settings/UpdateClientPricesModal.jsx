import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import api from '../../api/axios'
import { normalizeCurrencyCode } from '../../lib/currencyCode'

function parsePriceInput(raw) {
  const s = String(raw ?? '').trim().replace(',', '.')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

function formatUsdCost(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return '—'
  return `$${x.toFixed(2)}`
}

function packageCatalogId(row) {
  return Number(row?.package_catalog_id ?? row?.package_id ?? row?.id)
}

function findAssignedPrice(clientPrices, catalogPkgId) {
  const target = Number(catalogPkgId)
  if (!Number.isFinite(target)) return null
  return (
    clientPrices.find((p) => {
      const pid = Number(p?.package_id ?? p?.package_catalog_id)
      return Number.isFinite(pid) && pid === target
    }) ?? null
  )
}

export default function UpdateClientPricesModal({ open, client, onClose, onSaved, onToast }) {
  const [catalog, setCatalog] = useState([])
  const [clientPrices, setClientPrices] = useState([])
  const [priceDraft, setPriceDraft] = useState({})
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

  const loadData = useCallback(async () => {
    if (!clientId || clientId < 1) return
    setLoading(true)
    setError('')
    try {
      const [catalogRes, pricesRes] = await Promise.all([
        api.get('/api/v1/distributors/screen-catalog-products'),
        api.get(`/api/v1/admin/clients/${clientId}/assigned-package-prices`),
      ])
      const catalogList = Array.isArray(catalogRes.data) ? catalogRes.data : []
      const pricesList = Array.isArray(pricesRes.data) ? pricesRes.data : []
      setCatalog(catalogList)
      setClientPrices(pricesList)

      const draft = {}
      for (const pkg of catalogList) {
        const pkgId = packageCatalogId(pkg)
        const precioExistente = findAssignedPrice(pricesList, pkgId)
        const saleLocal = precioExistente?.sale_price_local
        if (Number.isFinite(pkgId) && saleLocal != null && Number(saleLocal) > 0) {
          draft[String(pkgId)] = String(saleLocal)
        }
      }
      setPriceDraft(draft)
    } catch (err) {
      setCatalog([])
      setClientPrices([])
      setPriceDraft({})
      const d = err?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'No se pudo cargar el catálogo y los precios del cliente.')
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    if (!open || !clientId) return
    void loadData()
  }, [open, clientId, loadData])

  function updatePrice(packageCatalogIdValue, value) {
    setPriceDraft((prev) => ({
      ...prev,
      [String(packageCatalogIdValue)]: value,
    }))
  }

  async function handleSave() {
    if (!clientId) return
    const payload = []
    for (const pkg of catalog) {
      const pkgId = packageCatalogId(pkg)
      if (!Number.isFinite(pkgId)) continue
      const raw = priceDraft[String(pkgId)]
      const local = parsePriceInput(raw)
      if (local == null) continue
      payload.push({ package_id: pkgId, sale_price_local: local })
    }
    if (!payload.length) {
      setError('Ingresa al menos un precio de venta válido.')
      return
    }

    setSaving(true)
    setError('')
    try {
      const { data } = await api.put(`/api/v1/admin/clients/${clientId}/package-prices`, {
        prices: payload,
      })
      onToast?.(data?.message || 'Precios guardados.')
      onSaved?.()
      onClose?.()
    } catch (err) {
      const d = err?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'No se pudieron guardar los precios.')
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
      aria-labelledby="update-client-prices-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose?.()
      }}
    >
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl bg-white shadow-2xl ring-1 ring-gray-200 overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-100 bg-gradient-to-r from-violet-50 to-fuchsia-50">
          <div className="min-w-0">
            <h2 id="update-client-prices-title" className="text-lg font-bold text-gray-900">
              🏷️ Precios de venta
            </h2>
            <p className="mt-0.5 text-sm text-gray-600 truncate">
              {clientLabel}
              {clientId ? <span className="text-gray-400"> · #{clientId}</span> : null}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Moneda del cliente: <span className="font-semibold text-gray-700">{clientCurrency}</span>
              {!loading && catalog.length > 0 ? (
                <span className="text-gray-400">
                  {' '}
                  · {catalog.length} paquete(s) en catálogo · {clientPrices.length} con precio asignado
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
              Cargando catálogo global y precios del cliente…
            </p>
          ) : catalog.length === 0 ? (
            <p className="text-sm text-gray-500 py-8 text-center">
              No hay paquetes activos de crédito por pantalla en el inventario.
            </p>
          ) : (
            <div className="rounded-xl border border-gray-200 overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-600">
                    <th className="px-3 py-2.5 font-semibold">Paquete</th>
                    <th className="px-3 py-2.5 font-semibold w-20">Stock</th>
                    <th className="px-3 py-2.5 font-semibold w-28">Costo base</th>
                    <th className="px-3 py-2.5 font-semibold w-40">
                      Precio venta ({clientCurrency})
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.map((paqueteCatalogo) => {
                    const pkgId = packageCatalogId(paqueteCatalogo)
                    const precioExistente = findAssignedPrice(clientPrices, pkgId)
                    const assignedSale = precioExistente?.sale_price_local
                    const hasExisting =
                      assignedSale != null && Number(assignedSale) > 0
                    const raw =
                      priceDraft[String(pkgId)] ??
                      (hasExisting ? String(assignedSale) : '')
                    return (
                      <tr key={`pkg-price-${pkgId}`} className="border-t border-gray-100 align-middle">
                        <td className="px-3 py-2.5">
                          <p className="font-medium text-gray-800">
                            {String(
                              paqueteCatalogo?.display_name ??
                                paqueteCatalogo?.package_label ??
                                '—',
                            )}
                          </p>
                          {paqueteCatalogo?.product_name ? (
                            <p className="text-[11px] text-gray-500">
                              {String(paqueteCatalogo.product_name)}
                            </p>
                          ) : null}
                          {!hasExisting && !raw ? (
                            <p className="mt-1 text-[11px] text-amber-700">
                              Nuevo — sin precio asignado
                            </p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums text-gray-700">
                          {Number(paqueteCatalogo?.free_stock ?? 0)}
                        </td>
                        <td className="px-3 py-2.5 tabular-nums text-gray-600">
                          {formatUsdCost(paqueteCatalogo?.reference_cost_usd)}
                        </td>
                        <td className="px-3 py-2.5">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={raw}
                            disabled={saving}
                            onChange={(e) => updatePrice(pkgId, e.target.value)}
                            placeholder="—"
                            className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm tabular-nums text-gray-800 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400"
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-4 border-t border-gray-100 bg-gray-50/60">
          <button
            type="button"
            disabled={saving}
            onClick={() => onClose?.()}
            className="px-4 py-2 text-sm rounded-xl border border-gray-200 text-gray-700 hover:bg-white disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={saving || loading || !catalog.length}
            onClick={() => void handleSave()}
            className="px-4 py-2 text-sm rounded-xl font-semibold text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50 inline-flex items-center gap-2"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : null}
            {saving ? 'Guardando…' : 'Guardar precios'}
          </button>
        </div>
      </div>
    </div>
  )
}
