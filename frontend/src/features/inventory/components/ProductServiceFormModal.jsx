import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2, X } from 'lucide-react'
import api from '../../../api/axios'
import SearchableSelect from '../../../components/ui/SearchableSelect'
import ImageDropZone from '../../../components/ui/ImageDropZone'
import {
  PRODUCT_TYPE_CREDITO_NORMAL,
  PRODUCT_TYPE_CREDITO_PANTALLA,
  PRODUCT_TYPE_LABEL_NORMAL,
  PRODUCT_TYPE_LABEL_PANTALLA,
} from '../inventoryProductTypes'

const QB_GREEN = '#2ca01c'

const PRODUCT_TYPE_OPTS = [
  { value: PRODUCT_TYPE_CREDITO_NORMAL, label: PRODUCT_TYPE_LABEL_NORMAL },
  { value: PRODUCT_TYPE_CREDITO_PANTALLA, label: PRODUCT_TYPE_LABEL_PANTALLA },
]

function formatAxiosDetail(err) {
  const d = err?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d)) {
    return d
      .map((item) => {
        const loc = Array.isArray(item.loc) ? item.loc.filter(Boolean).join(' › ') : ''
        const msg = item.msg || item.message || ''
        return loc ? `${loc}: ${msg}` : msg
      })
      .join('; ')
  }
  return err?.message || 'No se pudo guardar.'
}

function mediaAbsoluteUrl(path) {
  if (path == null || path === '') return null
  const s = String(path).trim()
  if (!s) return null
  const base = String(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')
  const rel = s.startsWith('/') ? s : `/${s}`
  return `${base}${rel}`
}

let _prodPkgRowId = 0
const nextPkgRowId = () => ++_prodPkgRowId

/** Entero positivo tal cual el usuario (sin combinar con cant. inicial ni otros campos). */
function parseScreensPerPackage(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return NaN
  if (!/^\d+$/.test(s)) return NaN
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : NaN
}

const MAX_CREDENTIAL_ROWS_PER_PACKAGE = 200

/** Índices de cant. inicial válidos para pintar/subir credenciales (alinea con bootstrap backend). */
function parseOpeningPkgCredRowCount(rawOpening) {
  const q = parseInt(String(rawOpening ?? '').trim(), 10)
  if (!Number.isFinite(q) || q <= 0) return 0
  return Math.min(q, MAX_CREDENTIAL_ROWS_PER_PACKAGE)
}

function resizePackageInitialCredentials(prev, targetLen) {
  const n = Math.max(0, Math.min(Number(targetLen) || 0, MAX_CREDENTIAL_ROWS_PER_PACKAGE))
  const arr = Array.isArray(prev) ? [...prev] : []
  while (arr.length < n) arr.push({ username: '', password: '' })
  if (arr.length > n) arr.length = n
  return arr
}

function newEmptyPackageRow() {
  return {
    id: nextPkgRowId(),
    catalogLineId: null,
    packageLabel: '',
    screens: '',
    costUsd: '',
    salePriceUsd: '',
    openingQtyPkg: '',
    initialCredentials: [],
  }
}

export default function ProductServiceFormModal({ open, onClose, onSaved, productToEdit = null }) {
  const editIdRaw = productToEdit?.id != null ? Number(productToEdit.id) : null
  const editId = Number.isFinite(editIdRaw) && editIdRaw > 0 ? editIdRaw : null
  const isEditMode = Boolean(editId)

  const [productType, setProductType] = useState(PRODUCT_TYPE_CREDITO_NORMAL)
  const [name, setName] = useState('')
  const [sku, setSku] = useState('')

  const [invQty, setInvQty] = useState('')
  const [invAsOf, setInvAsOf] = useState('')
  const [reorderPt, setReorderPt] = useState('')
  const [invAssetAccId, setInvAssetAccId] = useState('')

  const [saleDesc, setSaleDesc] = useState('')
  const [salePrice, setSalePrice] = useState('')
  const [incomeAccId, setIncomeAccId] = useState('')

  const [purchaseDesc, setPurchaseDesc] = useState('')
  const [purchaseCost, setPurchaseCost] = useState('')
  const [purchaseExpAccId, setPurchaseExpAccId] = useState('')
  const [vendorPrefId, setVendorPrefId] = useState('')
  const [productColor, setProductColor] = useState('#6366f1')
  const [logoFile, setLogoFile] = useState(null)
  /** URL relativa del logo ya persistido (modo edición). */
  const [savedLogoUrl, setSavedLogoUrl] = useState(null)
  const [iptvProvider, setIptvProvider] = useState('General')

  const [packageRows, setPackageRows] = useState(() => [newEmptyPackageRow()])
  /** Reinicia hijos para evitar estado fantasma en filas dinámicas. */
  const [pkgMountKey, setPkgMountKey] = useState(0)
  const [packagesInventoryOpeningDate, setPackagesInventoryOpeningDate] = useState('')

  const [accounts, setAccounts] = useState([])
  const [vendors, setVendors] = useState([])

  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)

  const resetForm = useCallback(() => {
    setProductType(PRODUCT_TYPE_CREDITO_NORMAL)
    setName('')
    setSku('')
    setInvQty('')
    setInvAsOf('')
    setReorderPt('')
    setInvAssetAccId('')
    setSaleDesc('')
    setSalePrice('')
    setIncomeAccId('')
    setPurchaseDesc('')
    setPurchaseCost('')
    setPurchaseExpAccId('')
    setVendorPrefId('')
    setProductColor('#6366f1')
    setLogoFile(null)
    setSavedLogoUrl(null)
    setIptvProvider('General')
    setPkgMountKey((k) => k + 1)
    setPackagesInventoryOpeningDate('')
    setPackageRows([])
    setPackageRows([newEmptyPackageRow()])
    setAccounts([])
    setVendors([])
    setErr(null)
  }, [])

  const applyProductFromApi = useCallback((p) => {
    setErr(null)
    setLogoFile(null)
    const pt =
      String(p.product_type || '').trim() === PRODUCT_TYPE_CREDITO_PANTALLA
        ? PRODUCT_TYPE_CREDITO_PANTALLA
        : PRODUCT_TYPE_CREDITO_NORMAL
    setProductType(pt)
    setName(String(p.name ?? ''))
    setSku(p.sku != null ? String(p.sku) : '')
    setIptvProvider(String(p.iptv_provider ?? 'General').trim() || 'General')
    setProductColor(p.color || '#6366f1')
    setSavedLogoUrl(p.logo_url && String(p.logo_url).trim() ? String(p.logo_url).trim() : null)

    setInvQty(p.inventory_opening_qty != null ? String(p.inventory_opening_qty) : '')
    setInvAsOf(p.inventory_as_of_date ? String(p.inventory_as_of_date).slice(0, 10) : '')
    setReorderPt(p.reorder_point != null ? String(p.reorder_point) : '')
    setInvAssetAccId(p.inventory_asset_account_id != null ? String(p.inventory_asset_account_id) : '')
    setSaleDesc(p.description != null ? String(p.description) : '')
    setSalePrice(p.price != null ? String(p.price) : '')
    setIncomeAccId(p.income_account_id != null ? String(p.income_account_id) : '')
    setPurchaseDesc(p.purchase_description != null ? String(p.purchase_description) : '')
    setPurchaseCost(p.purchase_cost_usd != null ? String(p.purchase_cost_usd) : '')
    setPurchaseExpAccId(p.purchase_expense_account_id != null ? String(p.purchase_expense_account_id) : '')
    setVendorPrefId(p.preferred_vendor_id != null ? String(p.preferred_vendor_id) : '')

    setPkgMountKey((k) => k + 1)
    setPackagesInventoryOpeningDate('')
    if (pt === PRODUCT_TYPE_CREDITO_PANTALLA) {
      const lines = Array.isArray(p.catalog_packages) ? p.catalog_packages : []
      setPackageRows(
        lines.length
          ? lines.map((ln) => ({
              id: nextPkgRowId(),
              catalogLineId: ln.id != null ? Number(ln.id) : null,
              packageLabel: String(ln.package_label ?? ''),
              screens: ln.screens_per_package != null ? String(ln.screens_per_package) : '',
              costUsd: ln.reference_cost_usd != null ? String(ln.reference_cost_usd) : '',
              salePriceUsd: ln.listing_price_usd != null ? String(ln.listing_price_usd) : '',
              openingQtyPkg:
                ln.opening_inventory_qty != null && Number(ln.opening_inventory_qty) > 0
                  ? String(Math.round(Number(ln.opening_inventory_qty)))
                  : '',
              initialCredentials:
                ln.opening_inventory_qty != null && Number(ln.opening_inventory_qty) > 0
                  ? resizePackageInitialCredentials(
                      [],
                      Math.min(Math.round(Number(ln.opening_inventory_qty)), MAX_CREDENTIAL_ROWS_PER_PACKAGE),
                    )
                  : [],
            }))
          : [newEmptyPackageRow()],
      )
    } else {
      setPackageRows([newEmptyPackageRow()])
    }
  }, [])

  /** Evita valores «pegados» cuando el backdrop cierra sin desmontar. */
  useEffect(() => {
    if (!open) resetForm()
  }, [open, resetForm])

  useEffect(() => {
    if (!open) return
    Promise.all([
      api.get('/api/v1/accounts/').catch(() => ({ data: [] })),
      api.get('/api/v1/vendors/').catch(() => ({ data: [] })),
    ]).then(([a, v]) => {
      setAccounts(Array.isArray(a.data) ? a.data : [])
      setVendors(Array.isArray(v.data) ? v.data : [])
    })

    if (isEditMode && editId != null) {
      api
        .get(`/api/v1/products/${editId}`)
        .then(({ data }) => applyProductFromApi(data))
        .catch(() => {
          setErr('No se pudo cargar el producto.')
          resetForm()
        })
    } else {
      resetForm()
      setPackageRows([newEmptyPackageRow()])
    }
  }, [open, editId, isEditMode, applyProductFromApi, resetForm])

  useEffect(() => {
    if (!open || isEditMode) return
    if (productType === PRODUCT_TYPE_CREDITO_PANTALLA) {
      setPackageRows([newEmptyPackageRow()])
      setPackagesInventoryOpeningDate('')
      setPkgMountKey((k) => k + 1)
      return
    }
    setPackageRows([newEmptyPackageRow()])
    setPackagesInventoryOpeningDate('')
  }, [productType, open, isEditMode])

  const invAssetOpts = useMemo(() => {
    return accounts
      .filter((acc) => acc.account_type === 'asset' && (acc.detail_type || '').toLowerCase() === 'inventario')
      .map((a) => ({ value: String(a.id), label: `${a.name} (${a.currency})` }))
  }, [accounts])

  const incomeOpts = useMemo(() => {
    return accounts
      .filter((acc) => acc.account_type === 'income')
      .map((a) => ({ value: String(a.id), label: `${a.name} (${a.currency})` }))
  }, [accounts])

  const expenseOpts = useMemo(() => {
    return accounts
      .filter((acc) => acc.account_type === 'expense' || acc.account_type === 'cost_of_sales')
      .map((a) => ({ value: String(a.id), label: `${a.name} (${a.currency})` }))
  }, [accounts])

  const vendorOpts = useMemo(() => {
    return [{ value: '', label: '(Sin proveedor preferido)' }, ...vendors.map((v) => ({ value: String(v.id), label: v.name }))]
  }, [vendors])

  const updatePkgRow = useCallback(
    (id, field, val) => {
      setPackageRows((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r
          const next = { ...r, [field]: val }
          if (field === 'openingQtyPkg' && productType === PRODUCT_TYPE_CREDITO_PANTALLA) {
            const n = parseOpeningPkgCredRowCount(val)
            next.initialCredentials = resizePackageInitialCredentials(r.initialCredentials, n)
          }
          return next
        }),
      )
    },
    [productType],
  )

  const updatePkgCredential = useCallback((rowId, index, credField, value) => {
    setPackageRows((prev) =>
      prev.map((r) => {
        if (r.id !== rowId) return r
        const creds = Array.isArray(r.initialCredentials) ? [...r.initialCredentials] : []
        while (creds.length <= index) creds.push({ username: '', password: '' })
        const cur = creds[index] || { username: '', password: '' }
        creds[index] = { ...cur, [credField]: value }
        return { ...r, initialCredentials: creds }
      }),
    )
  }, [])

  const addPkgRow = useCallback(() => {
    setPackageRows((prev) => [...prev, newEmptyPackageRow()])
  }, [])

  const removePkgRow = useCallback((id) => {
    setPackageRows((prev) => (prev.length > 1 ? prev.filter((r) => r.id !== id) : prev))
  }, [])

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault()
      setErr(null)
      if (!productType) {
        setErr('Selecciona el tipo de producto o servicio.')
        return
      }
      const nm = name.trim()
      if (!nm) {
        setErr('El nombre es obligatorio.')
        return
      }
      const isPantalla = productType === PRODUCT_TYPE_CREDITO_PANTALLA

      let price
      let packagesPayload
      let packagesInventoryOpeningDatePayload = null

      if (isPantalla) {
        const filled = packageRows
          .map((r) => ({
            label: r.packageLabel.trim(),
            screens: String(r.screens ?? '').trim(),
            cost: String(r.costUsd ?? '').trim(),
            sale: String(r.salePriceUsd ?? '').trim(),
            opening: String(r.openingQtyPkg ?? '').trim(),
            catalogLineId: r.catalogLineId,
            initialCredentials: r.initialCredentials,
          }))
          .filter((r) => r.label || r.screens || r.cost || r.sale || r.opening)

        if (!filled.length) {
          setErr('Añade al menos un paquete con nombre, pantallas y precio de venta.')
          return
        }

        const built = []
        for (const r of filled) {
          if (!r.label) {
            setErr('En «Configuración de paquetes», cada fila con datos debe tener nombre de paquete.')
            return
          }
          const sp = parseScreensPerPackage(r.screens)
          if (!Number.isFinite(sp) || sp < 1) {
            setErr('Indica «Pantallas» como entero ≥ 1 en cada paquete que completes.')
            return
          }
          const saleNum = parseFloat(r.sale.replace(',', '.'))
          if (Number.isNaN(saleNum) || saleNum <= 0) {
            setErr('Indica «Precio de venta (USD)» mayor que cero en cada paquete.')
            return
          }
          let costUsd = null
          if (r.cost !== '') {
            const c = parseFloat(r.cost.replace(',', '.'))
            if (Number.isNaN(c) || c < 0) {
              setErr('El costo (USD) de cada paquete debe ser ≥ 0.')
              return
            }
            costUsd = c
          }
          let inventoryInitialQty = null
          if (r.opening !== '') {
            const oq = parseInt(r.opening, 10)
            if (Number.isNaN(oq) || oq < 1) {
              setErr('«Cant. inicial» debe ser un entero ≥ 1 o déjalo vacío.')
              return
            }
            inventoryInitialQty = oq
          }
          const rowObj = {
            package_label: r.label,
            cost_usd: costUsd,
            screens_per_package: sp,
            listing_price_usd: saleNum,
          }
          if (inventoryInitialQty != null) rowObj.inventory_initial_qty = inventoryInitialQty
          if (inventoryInitialQty != null && inventoryInitialQty > 0 && isPantalla) {
            rowObj.initial_credentials = resizePackageInitialCredentials(
              r.initialCredentials,
              inventoryInitialQty,
            ).map((c) => ({
              username: String(c?.username ?? '').trim() || null,
              password: String(c?.password ?? '').trim() || null,
            }))
          }
          if (r.catalogLineId != null && Number.isFinite(Number(r.catalogLineId))) {
            rowObj.id = Number(r.catalogLineId)
          }
          built.push(rowObj)
        }

        const needsOpeningDate = built.some((b) => (b.inventory_initial_qty ?? 0) > 0)
        if (needsOpeningDate && !packagesInventoryOpeningDate.trim()) {
          setErr('Indica la fecha de inventario inicial para los paquetes con cantidad inicial > 0.')
          return
        }
        packagesPayload = built
        packagesInventoryOpeningDatePayload = needsOpeningDate ? packagesInventoryOpeningDate.trim() : null
        price = built[0].listing_price_usd
      } else {
        price = parseFloat(String(salePrice).replace(',', '.'))
        if (Number.isNaN(price) || price <= 0) {
          setErr('Indica un precio de venta mayor que cero (USD).')
          return
        }
      }

      const body = {
        product_type: productType,
        name: nm,
        sku: sku.trim() || null,
        iptv_provider: iptvProvider.trim() || 'General',
        target_audience: 'Cliente',
        currency: 'USD',
        price,
        description: saleDesc.trim() || null,
        is_active: true,
        transaction_class_id: null,
        inventory_opening_qty:
          !isPantalla && invQty !== '' ? parseFloat(String(invQty).replace(',', '.')) : null,
        inventory_as_of_date: !isPantalla && invAsOf.trim() ? invAsOf.trim() : null,
        reorder_point: reorderPt !== '' ? parseFloat(String(reorderPt).replace(',', '.')) : null,
        inventory_asset_account_id: invAssetAccId ? parseInt(invAssetAccId, 10) : null,
        income_account_id: incomeAccId ? parseInt(incomeAccId, 10) : null,
        purchase_description: purchaseDesc.trim() || null,
        purchase_cost_usd:
          !isPantalla && purchaseCost !== '' ? parseFloat(String(purchaseCost).replace(',', '.')) : null,
        purchase_expense_account_id: purchaseExpAccId ? parseInt(purchaseExpAccId, 10) : null,
        preferred_vendor_id: vendorPrefId ? parseInt(vendorPrefId, 10) : null,
        color: productColor || '#6366f1',
      }

      if (packagesPayload != null && packagesPayload.length) {
        body.packages = packagesPayload
      }
      if (packagesInventoryOpeningDatePayload) {
        body.packages_inventory_opening_date = packagesInventoryOpeningDatePayload
      }

      setSaving(true)
      try {
        let resolvedLogo = savedLogoUrl
        if (logoFile) {
          const fd = new FormData()
          fd.append('file', logoFile)
          const up = await api.post('/api/v1/products/upload-logo', fd)
          resolvedLogo = up.data?.logo_url ?? resolvedLogo
        }
        body.logo_url = resolvedLogo ?? null

        if (isEditMode && editId != null) {
          await api.put(`/api/v1/products/${editId}`, body)
        } else {
          await api.post('/api/v1/products/', body)
        }
        resetForm()
        onSaved?.()
        onClose()
      } catch (ex) {
        const ep = isEditMode ? 'PUT' : 'POST'
        console.error(`[ProductServiceFormModal] ${ep} /api/v1/products/`, ex?.response?.data ?? ex?.message, ex)
        setErr(formatAxiosDetail(ex))
      } finally {
        setSaving(false)
      }
    },
    [
      productType,
      name,
      sku,
      iptvProvider,
      salePrice,
      saleDesc,
      invQty,
      invAsOf,
      reorderPt,
      invAssetAccId,
      incomeAccId,
      purchaseDesc,
      purchaseCost,
      purchaseExpAccId,
      vendorPrefId,
      productColor,
      packageRows,
      packagesInventoryOpeningDate,
      logoFile,
      savedLogoUrl,
      editId,
      isEditMode,
      resetForm,
      onClose,
      onSaved,
    ],
  )

  if (!open) return null

  const isPantalla = productType === PRODUCT_TYPE_CREDITO_PANTALLA

  const secTitle = (t) => <h3 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-3">{t}</h3>
  const inputCls =
    'w-full h-10 px-3 text-sm bg-white border border-gray-300 rounded-md text-gray-900 outline-none focus:ring-2 focus:ring-emerald-100 focus:border-emerald-500'
  const labelCls = 'block text-[11px] font-semibold text-gray-600 mb-1'

  return (
    <div className="fixed inset-0 z-[85] flex justify-end">
      <button type="button" className="absolute inset-0 bg-gray-900/50 backdrop-blur-[2px]" aria-label="Cerrar" onClick={() => !saving && onClose()} />
      <div className="relative h-full w-full max-w-4xl bg-white shadow-2xl flex flex-col border-l border-gray-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0 bg-gray-50/80">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {isEditMode ? 'Editar producto/servicio' : 'Información del producto/servicio'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {isEditMode ? 'Editar producto — los cambios sustituyen el registro actual.' : 'Inventario IPTV — inventario, ventas y compras'}
            </p>
          </div>
          <button type="button" onClick={() => !saving && onClose()} className="p-2 rounded-lg text-gray-400 hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        <form autoComplete="off" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          <section className="rounded-lg ring-1 ring-gray-100 bg-white p-4">
            {secTitle('Principal')}
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Tipo de producto o servicio</label>
                <SearchableSelect
                  value={productType}
                  onChange={setProductType}
                  options={PRODUCT_TYPE_OPTS}
                  hideClear
                  disabled={isEditMode || saving}
                  placeholder="Seleccionar tipo…"
                />
              </div>
              <div>
                <label className={labelCls}>Nombre</label>
                <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div>
                <label className={labelCls}>Proveedor IPTV</label>
                <input
                  className={inputCls}
                  value={iptvProvider}
                  onChange={(e) => setIptvProvider(e.target.value)}
                  placeholder="General, Flujo, Stella…"
                  maxLength={64}
                />
              </div>
              <div>
                <label className={labelCls}>Logotipo</label>
                <ImageDropZone
                  file={logoFile}
                  onFileChange={setLogoFile}
                  disabled={saving}
                  remotePreviewUrl={!logoFile && savedLogoUrl ? mediaAbsoluteUrl(savedLogoUrl) : null}
                  onClearRemote={() => setSavedLogoUrl(null)}
                />
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
                <div>
                  <label className={labelCls}>Color (tarjetas inventario)</label>
                  <input
                    className={inputCls}
                    type="text"
                    value={productColor}
                    onChange={(e) => setProductColor(e.target.value)}
                    placeholder="#6366f1"
                    maxLength={16}
                  />
                </div>
                <input
                  type="color"
                  className="h-10 w-14 rounded-md border border-gray-300 cursor-pointer shrink-0"
                  value={productColor?.startsWith('#') ? productColor : '#6366f1'}
                  onChange={(e) => setProductColor(e.target.value)}
                  title="Color"
                />
              </div>
              <div>
                <label className={labelCls}>SKU</label>
                <input className={inputCls} value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Opcional" />
              </div>
            </div>
          </section>

          {isPantalla ? (
            <section key={`pkg-section-${pkgMountKey}`} className="rounded-lg ring-1 ring-violet-100 bg-violet-50/40 p-4">
              {secTitle('Configuración de paquetes')}
              <p className="text-[11px] text-violet-900/85 mb-3 leading-relaxed">
                Define cada línea de venta por paquete: pantallas incluidas, costo y precio de venta. Si indicas cantidad inicial &gt; 0,
                se crearán pantallas en bodega y podrás precargar credenciales IPTV por cada unidad (hasta {MAX_CREDENTIAL_ROWS_PER_PACKAGE}{' '}
                filas desde el formulario por paquete; unidades extra quedan sin credencial inicial). Usa la fecha única para todas las
                líneas con inventario inicial.
              </p>
              <div className="mb-4">
                <label className={labelCls}>Fecha de inventario inicial</label>
                <input
                  className={inputCls}
                  type="date"
                  value={packagesInventoryOpeningDate}
                  onChange={(e) => setPackagesInventoryOpeningDate(e.target.value)}
                />
                <p className="text-[10px] text-violet-800/80 mt-1">Obligatoria si algún paquete tiene cantidad inicial &gt; 0.</p>
              </div>
              <div className="overflow-x-auto pb-1">
                <div className="min-w-[680px] space-y-2">
                  <div
                    className="grid gap-2 px-0.5 items-end text-[10px] font-semibold text-gray-400 uppercase tracking-wider"
                    style={{ gridTemplateColumns: 'minmax(96px,1.4fr) 52px 76px 76px 76px 36px' }}
                  >
                    <span>Nombre</span>
                    <span className="text-center">Pant.</span>
                    <span className="text-center">Costo</span>
                    <span className="text-center">P. venta</span>
                    <span className="text-center leading-tight">
                      Cant.
                      <br />
                      inicial
                    </span>
                    <span />
                  </div>
                  {packageRows.map((row) => {
                    const credSlotCount = parseOpeningPkgCredRowCount(row.openingQtyPkg)
                    return (
                      <div key={row.id} className="space-y-2">
                        <div
                          className="grid gap-2 items-center rounded-lg ring-1 ring-gray-100 bg-white p-2"
                          style={{
                            gridTemplateColumns: 'minmax(96px,1.4fr) 52px 76px 76px 76px 36px',
                          }}
                        >
                          <input
                            className={inputCls}
                            placeholder="ej. 1 mes"
                            name={`pkg-label-${row.id}`}
                            autoComplete="off"
                            value={row.packageLabel}
                            onChange={(e) => updatePkgRow(row.id, 'packageLabel', e.target.value)}
                          />
                          <input
                            className={`${inputCls} text-center px-1`}
                            type="number"
                            min={1}
                            step={1}
                            placeholder="1"
                            title="Pantallas por paquete"
                            name={`pkg-screens-${row.id}`}
                            autoComplete="off"
                            inputMode="numeric"
                            value={row.screens}
                            onChange={(e) => updatePkgRow(row.id, 'screens', e.target.value)}
                          />
                          <div className="relative">
                            <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-gray-400 text-[10px] pointer-events-none">
                              $
                            </span>
                            <input
                              className={`${inputCls} pl-5 px-1`}
                              type="number"
                              min={0}
                              step="0.01"
                              placeholder="0"
                              title="Costo USD"
                              name={`pkg-cost-${row.id}`}
                              autoComplete="off"
                              value={row.costUsd}
                              onChange={(e) => updatePkgRow(row.id, 'costUsd', e.target.value)}
                            />
                          </div>
                          <div className="relative">
                            <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-gray-400 text-[10px] pointer-events-none">
                              $
                            </span>
                            <input
                              className={`${inputCls} pl-5 px-1`}
                              type="number"
                              min={0}
                              step="0.01"
                              placeholder="0"
                              title="Precio venta USD"
                              name={`pkg-sale-${row.id}`}
                              autoComplete="off"
                              value={row.salePriceUsd}
                              onChange={(e) => updatePkgRow(row.id, 'salePriceUsd', e.target.value)}
                            />
                          </div>
                          <input
                            className={`${inputCls} text-center px-1`}
                            type="number"
                            min={0}
                            step={1}
                            placeholder="—"
                            title="Cantidad inicial de paquetes en bodega"
                            name={`pkg-open-${row.id}`}
                            autoComplete="off"
                            inputMode="numeric"
                            value={row.openingQtyPkg}
                            onChange={(e) => updatePkgRow(row.id, 'openingQtyPkg', e.target.value)}
                          />
                          <button
                            type="button"
                            onClick={() => removePkgRow(row.id)}
                            disabled={packageRows.length === 1}
                            className="flex items-center justify-center w-9 h-10 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                            aria-label="Quitar fila"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                        {credSlotCount > 0 ? (
                          <div className="ml-2 pl-3 border-l-2 border-violet-200/90 rounded-md bg-white/90 py-3 px-3 space-y-2 ring-1 ring-violet-100/60">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-800/85">
                              Credenciales IPTV (stock inicial — misma orden que «Cant. inicial»)
                            </p>
                            {Array.from({ length: credSlotCount }, (_, idx) => {
                              const slot = row.initialCredentials?.[idx] || { username: '', password: '' }
                              return (
                                <div
                                  key={`${row.id}-cred-${idx}`}
                                  className="rounded-lg border border-gray-100/90 bg-slate-50/50 p-2.5 space-y-2"
                                >
                                  <p className="text-[11px] font-semibold text-gray-700">
                                    Credenciales para pantalla {idx + 1}
                                  </p>
                                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    <div>
                                      <label className={labelCls} htmlFor={`pkg-iptv-u-${row.id}-${idx}`}>
                                        Usuario IPTV
                                      </label>
                                      <input
                                        id={`pkg-iptv-u-${row.id}-${idx}`}
                                        className={inputCls}
                                        autoComplete="off"
                                        name={`pkg-iptv-u-${row.id}-${idx}`}
                                        maxLength={120}
                                        value={slot.username ?? ''}
                                        onChange={(e) =>
                                          updatePkgCredential(row.id, idx, 'username', e.target.value)
                                        }
                                      />
                                    </div>
                                    <div>
                                      <label className={labelCls} htmlFor={`pkg-iptv-p-${row.id}-${idx}`}>
                                        Contraseña IPTV
                                      </label>
                                      <input
                                        id={`pkg-iptv-p-${row.id}-${idx}`}
                                        className={inputCls}
                                        autoComplete="new-password"
                                        name={`pkg-iptv-p-${row.id}-${idx}`}
                                        type="password"
                                        maxLength={255}
                                        value={slot.password ?? ''}
                                        onChange={(e) =>
                                          updatePkgCredential(row.id, idx, 'password', e.target.value)
                                        }
                                      />
                                    </div>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </div>
              <button
                type="button"
                onClick={addPkgRow}
                className="mt-3 w-full flex items-center justify-center gap-2 py-2 text-xs font-medium text-violet-600 hover:text-violet-700 hover:bg-violet-50 rounded-lg border border-dashed border-violet-200 hover:border-violet-300 transition-colors"
              >
                <Plus size={13} /> Añadir paquete
              </button>
            </section>
          ) : null}

          <section className="rounded-lg ring-1 ring-gray-100 bg-slate-50/80 p-4">
            {secTitle('Inventario')}
            <div className="grid grid-cols-2 gap-3">
              {!isPantalla ? (
                <>
                  <div>
                    <label className={labelCls}>Cantidad inicial</label>
                    <input className={inputCls} type="number" min={0} step="0.0001" value={invQty} onChange={(e) => setInvQty(e.target.value)} />
                  </div>
                  <div>
                    <label className={labelCls}>As of date</label>
                    <input className={inputCls} type="date" value={invAsOf} onChange={(e) => setInvAsOf(e.target.value)} />
                  </div>
                  <div>
                    <label className={labelCls}>Punto de reorden</label>
                    <input className={inputCls} type="number" min={0} step="1" value={reorderPt} onChange={(e) => setReorderPt(e.target.value)} />
                  </div>
                </>
              ) : null}
              <div className="col-span-2">
                <label className={labelCls}>Cuenta activos de inventario</label>
                <SearchableSelect
                  value={invAssetAccId}
                  onChange={setInvAssetAccId}
                  options={[{ value: '', label: '(Ninguna)' }, ...invAssetOpts]}
                  placeholder="Filtrado: activo · Inventario"
                />
              </div>
            </div>
          </section>

          <section className="rounded-lg ring-1 ring-gray-100 bg-white p-4">
            {secTitle('Ventas')}
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Descripción en ventas</label>
                <textarea className={`${inputCls} min-h-[72px] py-2 resize-none`} value={saleDesc} onChange={(e) => setSaleDesc(e.target.value)} />
              </div>
              {!isPantalla ? (
                <div>
                  <label className={labelCls}>Precio / tasa de venta (USD)</label>
                  <input className={inputCls} type="number" min={0} step="0.01" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} />
                </div>
              ) : null}
              <div>
                <label className={labelCls}>Cuenta de ingresos</label>
                <SearchableSelect
                  value={incomeAccId}
                  onChange={setIncomeAccId}
                  options={[{ value: '', label: '(Ninguna)' }, ...incomeOpts]}
                  placeholder="Filtrado: ingresos"
                />
              </div>
            </div>
          </section>

          <section className="rounded-lg ring-1 ring-gray-100 bg-slate-50/80 p-4">
            {secTitle('Compras')}
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Descripción de compras</label>
                <textarea className={`${inputCls} min-h-[64px] py-2 resize-none`} value={purchaseDesc} onChange={(e) => setPurchaseDesc(e.target.value)} />
              </div>
              {!isPantalla ? (
                <div>
                  <label className={labelCls}>Coste (USD)</label>
                  <input className={inputCls} type="number" min={0} step="0.01" value={purchaseCost} onChange={(e) => setPurchaseCost(e.target.value)} />
                </div>
              ) : null}
              <div>
                <label className={labelCls}>Cuenta de gastos / costos</label>
                <SearchableSelect
                  value={purchaseExpAccId}
                  onChange={setPurchaseExpAccId}
                  options={[{ value: '', label: '(Ninguna)' }, ...expenseOpts]}
                  placeholder="Gastos o costo de ventas"
                />
              </div>
              <div>
                <label className={labelCls}>Proveedor preferido</label>
                <SearchableSelect value={vendorPrefId} onChange={setVendorPrefId} options={vendorOpts} placeholder="Proveedores…" />
              </div>
            </div>
          </section>

          {err ? <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">{err}</p> : null}

          <div className="flex justify-end gap-2 pb-6">
            <button type="button" onClick={() => !saving && onClose()} className="px-4 py-2 text-sm rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50">
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{ backgroundColor: QB_GREEN }}
              className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold rounded-md text-white disabled:opacity-50"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {isEditMode ? 'Guardar cambios' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
