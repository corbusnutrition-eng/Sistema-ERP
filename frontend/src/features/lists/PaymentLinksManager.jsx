import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Link2, Loader2, Trash2 } from 'lucide-react'
import api from '../../api/axios'
import SearchableSelect from '../../components/ui/SearchableSelect'
import PaymentLinksTemplateEditor from './PaymentLinksTemplateEditor'
import {
  buildHotmartLinksPayload,
  emptyHotmartLinkRow,
  hydrateHotmartLinkRows,
} from '../../utils/hotmartLinks'

const MODULE_OPTIONS = [
  { value: 'VENTAS', label: 'Ventas' },
  { value: 'BAAS', label: 'Billeteras BaaS' },
]

export default function PaymentLinksManager() {
  const [paymentMethods, setPaymentMethods] = useState([])
  const [products, setProducts] = useState([])
  const [loadingCatalogs, setLoadingCatalogs] = useState(true)

  const [paymentMethodId, setPaymentMethodId] = useState('')
  const [moduleType, setModuleType] = useState('VENTAS')
  const [productId, setProductId] = useState('')

  const [templateId, setTemplateId] = useState(null)
  const [linkRows, setLinkRows] = useState([emptyHotmartLinkRow()])
  const [loadingTemplate, setLoadingTemplate] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  const pmOptions = useMemo(
    () =>
      (Array.isArray(paymentMethods) ? paymentMethods : []).map((m) => ({
        value: String(m.id),
        label: m.name,
      })),
    [paymentMethods],
  )

  const productOptions = useMemo(
    () =>
      (Array.isArray(products) ? products : [])
        .filter((p) => p?.is_active !== false)
        .map((p) => ({
          value: String(p.id),
          label: String(p.name || `Producto #${p.id}`),
        })),
    [products],
  )

  const selectionReady =
    Boolean(paymentMethodId) &&
    (moduleType === 'BAAS' || (moduleType === 'VENTAS' && Boolean(productId)))

  useEffect(() => {
    let cancelled = false
    async function loadCatalogs() {
      setLoadingCatalogs(true)
      try {
        const [pmRes, prodRes] = await Promise.all([
          api.get('/api/v1/payment-methods/', { params: { include_inactive: true } }),
          api.get('/api/v1/products/'),
        ])
        if (cancelled) return
        setPaymentMethods(Array.isArray(pmRes.data) ? pmRes.data : [])
        setProducts(Array.isArray(prodRes.data) ? prodRes.data : [])
      } catch {
        if (!cancelled) setErrorMsg('No se pudieron cargar métodos de pago o productos.')
      } finally {
        if (!cancelled) setLoadingCatalogs(false)
      }
    }
    void loadCatalogs()
    return () => {
      cancelled = true
    }
  }, [])

  const fetchTemplate = useCallback(async () => {
    if (!selectionReady) {
      setTemplateId(null)
      setLinkRows([emptyHotmartLinkRow()])
      return
    }
    setLoadingTemplate(true)
    setErrorMsg('')
    setStatusMsg('')
    try {
      const params = {
        payment_method_id: Number(paymentMethodId),
        module_type: moduleType,
      }
      if (moduleType === 'VENTAS') params.product_id = Number(productId)
      const { data } = await api.get('/api/v1/payment-link-templates/', { params })
      const row = Array.isArray(data) && data.length ? data[0] : null
      if (row) {
        setTemplateId(row.id)
        setLinkRows(hydrateHotmartLinkRows(row.links, { all: true }))
        setStatusMsg('Plantilla existente cargada. Puedes editarla y guardar.')
      } else {
        setTemplateId(null)
        setLinkRows([emptyHotmartLinkRow()])
        setStatusMsg('No hay plantilla para esta combinación. Crea una nueva y guarda.')
      }
    } catch {
      setTemplateId(null)
      setLinkRows([emptyHotmartLinkRow()])
      setErrorMsg('No se pudo consultar la plantilla.')
    } finally {
      setLoadingTemplate(false)
    }
  }, [selectionReady, paymentMethodId, moduleType, productId])

  useEffect(() => {
    void fetchTemplate()
  }, [fetchTemplate])

  async function handleSave() {
    if (!selectionReady) {
      setErrorMsg('Selecciona método de pago y, para Ventas, un producto.')
      return
    }
    let linksPayload
    try {
      linksPayload = buildHotmartLinksPayload(linkRows, { all: true })
    } catch (err) {
      setErrorMsg(err?.message || 'Revisa los links ingresados.')
      return
    }
    if (!linksPayload?.length) {
      setErrorMsg('Agrega al menos un link con URL y valor.')
      return
    }

    const body = {
      payment_method_id: Number(paymentMethodId),
      module_type: moduleType,
      links: linksPayload,
      ...(moduleType === 'VENTAS' ? { product_id: Number(productId) } : { product_id: null }),
    }

    setSaving(true)
    setErrorMsg('')
    setStatusMsg('')
    try {
      if (templateId) {
        await api.put(`/api/v1/payment-link-templates/${templateId}`, body)
        setStatusMsg('Plantilla actualizada correctamente.')
      } else {
        const { data } = await api.post('/api/v1/payment-link-templates/', body)
        setTemplateId(data?.id ?? null)
        setStatusMsg('Plantilla creada correctamente.')
      }
      await fetchTemplate()
    } catch (err) {
      const detail = err?.response?.data?.detail
      setErrorMsg(typeof detail === 'string' ? detail : 'No se pudo guardar la plantilla.')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!templateId) return
    if (!window.confirm('¿Eliminar esta plantilla de links de pago?')) return
    setDeleting(true)
    setErrorMsg('')
    try {
      await api.delete(`/api/v1/payment-link-templates/${templateId}`)
      setTemplateId(null)
      setLinkRows([emptyHotmartLinkRow()])
      setStatusMsg('Plantilla eliminada.')
    } catch {
      setErrorMsg('No se pudo eliminar la plantilla.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12 px-4">
      <Link
        to="/listas"
        className="inline-flex items-center gap-1 text-sm font-medium text-green-700 hover:text-green-800"
      >
        <ArrowLeft size={16} aria-hidden />
        Volver a Listas
      </Link>

      <div>
        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
          <Link2 size={14} className="text-blue-500" />
          <span>QuickBooks · Listas</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Links de pago</h1>
        <p className="text-sm text-gray-500 mt-1">
          Plantillas por método de pago y producto. Se auto-completan en ventas y recargas BaaS.
        </p>
      </div>

      {loadingCatalogs ? (
        <p className="text-sm text-gray-500 flex items-center gap-2">
          <Loader2 size={16} className="animate-spin" aria-hidden />
          Cargando catálogos…
        </p>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Método de pago</label>
              <SearchableSelect
                value={paymentMethodId}
                onChange={(v) => setPaymentMethodId(v != null ? String(v) : '')}
                options={pmOptions}
                placeholder="Seleccionar…"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Módulo</label>
              <SearchableSelect
                value={moduleType}
                onChange={(v) => {
                  const next = v != null ? String(v) : 'VENTAS'
                  setModuleType(next)
                  if (next === 'BAAS') setProductId('')
                }}
                options={MODULE_OPTIONS}
                hideClear
              />
            </div>
          </div>

          {moduleType === 'VENTAS' ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Producto / servicio</label>
              <SearchableSelect
                value={productId}
                onChange={(v) => setProductId(v != null ? String(v) : '')}
                options={productOptions}
                placeholder="Seleccionar producto del inventario…"
              />
            </div>
          ) : null}

          {selectionReady ? (
            <>
              {loadingTemplate ? (
                <p className="text-sm text-gray-500 flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" aria-hidden />
                  Consultando plantilla…
                </p>
              ) : (
                <PaymentLinksTemplateEditor rows={linkRows} onChange={setLinkRows} disabled={saving || deleting} />
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={saving || deleting || loadingTemplate}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
                >
                  {saving ? <Loader2 size={16} className="animate-spin" aria-hidden /> : null}
                  Guardar cambios
                </button>
                {templateId ? (
                  <button
                    type="button"
                    onClick={() => void handleDelete()}
                    disabled={saving || deleting || loadingTemplate}
                    className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
                  >
                    {deleting ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Trash2 size={16} aria-hidden />}
                    Eliminar plantilla
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="text-sm text-gray-500">Elige método de pago y módulo para configurar los links.</p>
          )}

          {statusMsg ? <p className="text-sm text-emerald-700">{statusMsg}</p> : null}
          {errorMsg ? <p className="text-sm text-red-600">{errorMsg}</p> : null}
        </div>
      )}
    </div>
  )
}
