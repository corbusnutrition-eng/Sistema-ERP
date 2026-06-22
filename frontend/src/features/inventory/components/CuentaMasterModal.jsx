import { useState, useMemo, useRef, useEffect } from 'react'
import {
  X, Tv2, Coins, Loader2, Info, DollarSign, RefreshCw,
  Monitor, Plus, Trash2, ChevronDown, Check,
} from 'lucide-react'
import api from '../../../api/axios'
import SearchableSelect from '../../../components/ui/SearchableSelect'
import {
  PRODUCT_TYPE_CREDITO_NORMAL,
  PRODUCT_TYPE_CREDITO_PANTALLA,
} from '../inventoryProductTypes'



function catalogKind(p) {
  const pt = String(p?.product_type ?? '').trim()
  if (pt === PRODUCT_TYPE_CREDITO_NORMAL || pt === PRODUCT_TYPE_CREDITO_PANTALLA) return pt
  const st = String(p?.service_type ?? '').trim().toLowerCase()
  return st === 'paquete pantalla' ? PRODUCT_TYPE_CREDITO_PANTALLA : PRODUCT_TYPE_CREDITO_NORMAL
}



// ── Helpers ───────────────────────────────────────────────────────────────────

const todayISO = () => new Date().toISOString().split('T')[0]

function genRecVendorBillNumber() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `REC-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}



function lineScreensPerPkg(line) {
  const n = Number(line?.screens_per_package)
  return Number.isFinite(n) && n >= 1 ? Math.min(20, Math.round(n)) : 0
}

let _lineId = 0
const nextId = () => ++_lineId

/** Alineado con backend ``quantity`` (1–200). */
const MAX_SCREEN_QTY = 200

function parseLineQty(raw) {
  const q = parseInt(String(raw ?? '').trim(), 10)
  if (!Number.isFinite(q) || q < 1) return 1
  return Math.min(q, MAX_SCREEN_QTY)
}

function resizeLineCredentials(prev, qtyHint) {
  const n = parseLineQty(qtyHint)
  const arr = Array.isArray(prev) ? [...prev] : []
  while (arr.length < n) arr.push({ username: '', password: '' })
  if (arr.length > n) arr.length = n
  return arr
}

function newLine(overrides = {}) {
  const { credentials: oCred, quantity: oQty, ...rest } = overrides
  const q0 = oQty != null ? parseLineQty(oQty) : 1
  const base = {
    id: nextId(),
    entryMode: 'catalog',
    catalogLineId: null,
    package: '',
    quantity: q0,
    cost_per_package: '',
    screens_per_package: '',
    credentials: resizeLineCredentials(oCred, q0),
    ...rest,
  }
  const qf = parseLineQty(base.quantity)
  return {
    ...base,
    quantity: qf,
    credentials: resizeLineCredentials(base.credentials, qf),
  }
}

function catalogFirstLineTemplate(catalogLines) {
  const sorted = [...(catalogLines || [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
  )
  const row = sorted[0]
  if (!row) return newLine({ entryMode: 'custom' })
  return newLine({
    entryMode: 'catalog',
    catalogLineId: row.id,
    package: row.package_label,
    screens_per_package: row.screens_per_package,
    cost_per_package:
      row.reference_cost_usd != null && row.reference_cost_usd !== ''
        ? String(row.reference_cost_usd)
        : '',
  })
}

const inputCls = `w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800
  placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-100
  focus:border-blue-500 transition bg-white`

const labelCls  = 'block text-xs font-semibold text-gray-600 mb-1.5'

/** Mensaje legible desde FastAPI (`detail` string, lista 422 u objeto). */
function formatAxiosApiDetail(err) {
  const d = err?.response?.data?.detail
  if (d == null) {
    if (!err?.response) return err?.message || 'No hubo respuesta del servidor. Comprueba la conexión.'
    return `Error HTTP ${err.response.status}`
  }
  if (typeof d === 'string') return d
  if (Array.isArray(d)) {
    return d
      .map((item) => {
        if (typeof item === 'string') return item
        const loc = Array.isArray(item.loc) ? item.loc.filter(Boolean).join(' › ') : ''
        const msg = item.msg || item.message || JSON.stringify(item)
        return loc ? `${loc}: ${msg}` : msg
      })
      .join('\n')
  }
  if (typeof d === 'object' && typeof d.msg === 'string') return d.msg
  try {
    return JSON.stringify(d)
  } catch {
    return String(d)
  }
}

/** Pantallas/paq. válidas (1–20) cuando hay nombre de paquete. */
function validateScreenPackagesAndCounts(screenLines) {
  for (const l of screenLines) {
    const pkg = String(l.package ?? '').trim()
    if (!pkg) continue
    const sp = lineScreensPerPkg(l)
    if (sp < 1) {
      return `Define pantallas por paquete (1–20) en la línea «${pkg.slice(0, 48)}».`
    }
  }
  return null
}

/** Cuerpo POST `/inventory/screens/` (recarga pantallas / ``ScreenStockBulkCreate``). */
function buildScreensPayload(screenLines, iptvProvider) {
  const provider = String(iptvProvider || '').trim()
  const lines = []
  for (const l of screenLines) {
    const pkg = String(l.package ?? '').trim()
    if (!pkg) continue
    const quantity = parseLineQty(l.quantity)
    const costRaw = parseFloat(String(l.cost_per_package).replace(',', '.'))
    const cost_per_package =
      !Number.isNaN(costRaw) && costRaw >= 0 ? Math.round(costRaw * 10000) / 10000 : null
    const sc = lineScreensPerPkg(l)
    if (sc < 1) continue
    const fromCatalog =
      l.entryMode === 'catalog' &&
      l.catalogLineId != null &&
      l.catalogLineId !== ''
    const catalogIdNum = fromCatalog ? Number(l.catalogLineId) : NaN
    const package_catalog_id =
      fromCatalog && Number.isFinite(catalogIdNum) && catalogIdNum >= 1
        ? catalogIdNum
        : null
    const credentials = resizeLineCredentials(l.credentials || [], quantity).map((c) => ({
      username: String(c?.username ?? '').trim() || null,
      password: String(c?.password ?? '').trim() || null,
    }))
    lines.push({
      package: pkg,
      quantity,
      cost_per_package,
      screens_count: sc,
      package_catalog_id,
      credentials,
    })
  }
  return { provider, lines }
}

// ── Catálogo de paquetes por producto (GET /products incluye catalog_packages) ─

function CatalogPackageDropdown({ value, catalogLines, disabled, onSelectRow, onSelectNewManual }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  const sorted = useMemo(
    () => [...(catalogLines || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [catalogLines],
  )

  useEffect(() => {
    if (!open) return
    function h(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  return (
    <div className="relative min-w-0" ref={wrapRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className={`truncate text-left ${value ? 'text-gray-800' : 'text-gray-300'}`}>
          {value || 'Paquete…'}
        </span>
        <ChevronDown
          size={14}
          className={`text-gray-400 transition-transform shrink-0 ml-1 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-[80] w-full min-w-[13rem] max-w-[20rem] bg-white rounded-xl shadow-xl ring-1 ring-gray-200 overflow-hidden">
          <div className="max-h-48 overflow-y-auto py-1">
            {sorted.map((row) => {
              const label = row.package_label
              const sel = label === value
              return (
                <div
                  key={row.id}
                  role="option"
                  className={`flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50 transition-colors ${sel ? 'bg-violet-50' : ''}`}
                  onClick={() => {
                    onSelectRow(row)
                    setOpen(false)
                  }}
                >
                  <div
                    className={`w-4 h-4 rounded flex items-center justify-center shrink-0 ring-1 ${
                      sel ? 'bg-violet-600 ring-violet-600 text-white' : 'ring-gray-200'
                    }`}
                  >
                    {sel && <Check size={10} strokeWidth={3} />}
                  </div>
                  <span className="flex-1 text-sm text-gray-700 truncate" title={label}>
                    {label}
                  </span>
                </div>
              )
            })}
            {!sorted.length && (
              <p className="px-3 py-2 text-xs text-gray-400">Este producto aún no tiene paquetes en catálogo.</p>
            )}
          </div>
          <div className="border-t border-gray-100 p-2">
            <button
              type="button"
              onClick={() => {
                onSelectNewManual()
                setOpen(false)
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-50 rounded-lg transition-colors"
            >
              <Plus size={12} /> Nuevo paquete (manual)
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main Modal ────────────────────────────────────────────────────────────────

const FULL_INIT = {
  credits_spent: '',
  cost_per_credit: '',
  recharge_date: todayISO(),
  vendor_id: '',
  inventory_asset_account_id: '',
  vendor_bill_number: '',
  vendor_bill_date: todayISO(),
  vendor_bill_due_date: '',
  vendor_bill_terms: '',
}

/** Acepta 'screens' | 'full' | 'Crédito por pantalla' / textos legacy, etc. */
export function normalizeInventoryModalTab(tab) {
  const s = String(tab ?? 'full').trim().toLowerCase()
  if (s === 'screens') return 'screens'
  if (s.includes('bodega') || s.includes('pantalla')) return 'screens'
  return 'full'
}

function resolveDefaultProvider(p) {
  return String(p ?? '').trim()
}

export default function CuentaMasterModal({
  onClose,
  onSuccess,
  defaultTab = 'full',
  defaultProvider = '',
  overlayZIndexClass = 'z-50',
  /** Si está definido (p. ej. desde Nueva venta), no persiste en API: devuelve borrador y cierra. */
  onSaveDraft,
}) {
  const initialTab      = normalizeInventoryModalTab(defaultTab)
  const initialProvider = resolveDefaultProvider(defaultProvider)

  const [serviceType, setServiceType] = useState(initialTab)

  // ── Full-service state ──
  const [fullForm, setFullForm] = useState(() => ({
    ...FULL_INIT,
    recharge_date: todayISO(),
    vendor_bill_number: genRecVendorBillNumber(),
    vendor_bill_date: todayISO(),
  }))

  const [products, setProducts] = useState([])
  const [fullProductId, setFullProductId] = useState('')
  const [screenProductId, setScreenProductId] = useState('')

  const [vendorComboOpts, setVendorComboOpts] = useState([])
  const [invAssetComboOpts, setInvAssetComboOpts] = useState([])

  // ── Screens (cart) state ──
  const [screenLines, setScreenLines] = useState(() => [newLine()])
  const [expirationDate, setExpirationDate] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')
  const isScreens = serviceType === 'screens'
  const isFull    = serviceType === 'full'

  const fullProductOptions = useMemo(
    () =>
      products
        .filter((p) => p.is_active && catalogKind(p) === PRODUCT_TYPE_CREDITO_NORMAL)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'))
        .map((p) => ({
          value: String(p.id),
          label: `${p.name} (${p.iptv_provider})`,
        })),
    [products],
  )

  const screenProductOptions = useMemo(
    () =>
      products
        .filter((p) => p.is_active && catalogKind(p) === PRODUCT_TYPE_CREDITO_PANTALLA)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'es'))
        .map((p) => ({
          value: String(p.id),
          label: `${p.name} (${p.iptv_provider})`,
        })),
    [products],
  )

  const selectedFullProduct = useMemo(
    () => products.find((p) => String(p.id) === String(fullProductId)),
    [products, fullProductId],
  )

  const selectedScreenProduct = useMemo(
    () => products.find((p) => String(p.id) === String(screenProductId)),
    [products, screenProductId],
  )

  const screensProvider = (selectedScreenProduct?.iptv_provider || '').trim()

  /** Solo reinicia el carrito al cambiar de producto por pantalla, no cuando se refresca `products`. */
  const screenLinesInitProductIdRef = useRef(null)
  /** Al elegir otro «crédito normal», prefijar costo sugerido del catálogo (editable). */
  const fullCatalogPrefillProductIdRef = useRef(null)

  const screenCatalogPackages = useMemo(
    () =>
      Array.isArray(selectedScreenProduct?.catalog_packages)
        ? selectedScreenProduct.catalog_packages
        : [],
    [selectedScreenProduct],
  )

  useEffect(() => {
    if (!screenProductId) return
    const p = products.find((x) => String(x.id) === String(screenProductId))
    if (!p) return
    const key = String(screenProductId)
    if (screenLinesInitProductIdRef.current === key) return
    screenLinesInitProductIdRef.current = key
    const cat = Array.isArray(p.catalog_packages) ? p.catalog_packages : []
    setScreenLines([catalogFirstLineTemplate(cat)])
  }, [screenProductId, products])

  useEffect(() => {
    if (!isFull || onSaveDraft || !fullProductId) return
    const key = String(fullProductId)
    if (fullCatalogPrefillProductIdRef.current === key) return
    fullCatalogPrefillProductIdRef.current = key
    const p = products.find((x) => String(x.id) === key)
    const raw = p?.purchase_cost_usd
    const pre =
      raw != null && raw !== '' && Number.isFinite(Number(raw)) ? String(Number(raw)) : ''
    setFullForm((prev) => ({
      ...prev,
      cost_per_credit: pre,
    }))
  }, [fullProductId, products, isFull, onSaveDraft])

  useEffect(() => {
    let cancelled = false
    api
      .get('/api/v1/products/', { params: { skip: 0, limit: 500 } })
      .then((r) => {
        if (!cancelled) setProducts(Array.isArray(r.data) ? r.data : [])
      })
      .catch(() => {
        if (!cancelled) setProducts([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!products.length) return
    const want = initialProvider.toLowerCase()
    function pick(kind) {
      const pool = products.filter((p) => p.is_active && catalogKind(p) === kind)
      const byPv = want
        ? pool.find((p) => (p.iptv_provider || '').trim().toLowerCase() === want)
        : null
      return byPv || pool[0]
    }
    setFullProductId((prev) => {
      if (
        prev &&
        products.some(
          (p) =>
            String(p.id) === prev &&
            p.is_active &&
            catalogKind(p) === PRODUCT_TYPE_CREDITO_NORMAL,
        )
      ) {
        return prev
      }
      const p = pick(PRODUCT_TYPE_CREDITO_NORMAL)
      return p ? String(p.id) : ''
    })
    setScreenProductId((prev) => {
      if (
        prev &&
        products.some(
          (p) =>
            String(p.id) === prev &&
            p.is_active &&
            catalogKind(p) === PRODUCT_TYPE_CREDITO_PANTALLA,
        )
      ) {
        return prev
      }
      const p = pick(PRODUCT_TYPE_CREDITO_PANTALLA)
      return p ? String(p.id) : ''
    })
  }, [products, initialProvider])

  useEffect(() => {
    let cancelled = false
    api.get('/api/v1/vendors/')
      .then((r) => {
        if (!cancelled) setVendorComboOpts((r.data || []).map((v) => ({ value: String(v.id), label: v.name })))
      })
      .catch(() => {})
    api.get('/api/v1/accounts/')
      .then((r) => {
        if (!cancelled) {
          const rows = r.data || []
          setInvAssetComboOpts(
            rows
              .filter((a) => a.account_type === 'asset' && String(a.detail_type || '').toLowerCase() === 'inventario')
              .map((a) => ({ value: String(a.id), label: `${a.name} (${a.currency})` })),
          )
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isFull || typeof onSaveDraft === 'function') return
    setFullForm((p) => ({
      ...p,
      vendor_bill_number: genRecVendorBillNumber(),
      vendor_bill_date: todayISO(),
    }))
  }, [serviceType, isFull, onSaveDraft])

  // ── Full-service totals ──
  const fullTotalToPay = useMemo(() => {
    const c = parseFloat(fullForm.credits_spent)
    const p = parseFloat(fullForm.cost_per_credit)
    if (!isNaN(c) && !isNaN(p) && c > 0 && p > 0) return (c * p).toFixed(2)
    return null
  }, [fullForm.credits_spent, fullForm.cost_per_credit])

  // ── Screen cart totals (all lines combined) ──
  const screenTotals = useMemo(() => {
    let totalScreens = 0
    let totalCost    = 0
    let hasCost      = false
    for (const line of screenLines) {
      const qty = parseLineQty(line.quantity)
      const screensPerPkg = lineScreensPerPkg(line)
      totalScreens += screensPerPkg * qty
      const c = parseFloat(String(line.cost_per_package).replace(',', '.'))
      if (!Number.isNaN(c) && c >= 0) {
        totalCost += c * qty
        hasCost = true
      }
    }
    return { totalScreens, totalCost: hasCost ? totalCost.toFixed(2) : null }
  }, [screenLines])

  // ── Cart mutation helpers ──
  function updateLine(id, field, val) {
    setScreenLines((prev) =>
      prev.map((l) => {
        if (l.id !== id) return l
        if (field === 'quantity') {
          const n = parseLineQty(val)
          return {
            ...l,
            quantity: n,
            credentials: resizeLineCredentials(l.credentials, n),
          }
        }
        return { ...l, [field]: val }
      }),
    )
  }

  function updateLineCredential(lineId, index, credField, value) {
    setScreenLines((prev) =>
      prev.map((l) => {
        if (l.id !== lineId) return l
        const n = parseLineQty(l.quantity)
        const creds = resizeLineCredentials(l.credentials || [], n)
        const cur = creds[index] || { username: '', password: '' }
        creds[index] = { ...cur, [credField]: value }
        return { ...l, credentials: creds }
      }),
    )
  }

  function patchLine(id, patch) {
    setScreenLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }
  function addLine() {
    setScreenLines((prev) => [...prev, catalogFirstLineTemplate(screenCatalogPackages)])
  }
  function removeLine(id) {
    setScreenLines(prev => prev.length > 1 ? prev.filter(l => l.id !== id) : prev)
  }

  // ── Submit ──
  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (typeof onSaveDraft === 'function') {
        if (!isScreens) {
          setError('Desde nueva venta solo puedes preparar pantallas en bodega (borrador).')
          return
        }
        const cntErrDraft = validateScreenPackagesAndCounts(screenLines)
        if (cntErrDraft) {
          setError(cntErrDraft)
          return
        }
        const salePackage = String(screenLines[0]?.package || '').trim()
        if (!salePackage) {
          setError('Selecciona un paquete en la primera línea.')
          return
        }
        const { provider: draftProv, lines: draftLines } = buildScreensPayload(
          screenLines,
          screensProvider,
        )
        if (!draftLines.length) {
          setError('Añade al menos una línea con paquete válido.')
          return
        }
        if (!selectedScreenProduct?.id) {
          setError('Selecciona un producto de tipo «crédito por pantalla».')
          return
        }
        const rechargeDraft = {
          provider: draftProv,
          product_id: Number(selectedScreenProduct.id),
          expiration_date: expirationDate?.trim() || null,
          lines: draftLines,
          salePackage,
        }
        onSaveDraft(rechargeDraft)
        onClose()
        return
      }

      if (isFull) {
        const vid = String(fullForm.vendor_id || '').trim()
        const iacc = String(fullForm.inventory_asset_account_id || '').trim()
        if (vid && !iacc) {
          setError('Selecciona la cuenta de activos de inventario para registrar la factura del proveedor.')
          setLoading(false)
          return
        }
        if (!selectedFullProduct?.id) {
          setError('Selecciona un producto/servicio de tipo «crédito normal».')
          setLoading(false)
          return
        }
        const provStr = String(selectedFullProduct.iptv_provider || '').trim()
        if (!provStr) {
          setError('El producto no tiene proveedor IPTV configurado.')
          setLoading(false)
          return
        }
        const body = {
          provider: provStr,
          product_id: Number(selectedFullProduct.id),
          service_type: 'full',
          credits_spent: fullForm.credits_spent !== '' ? parseFloat(fullForm.credits_spent) : null,
          cost_per_credit: fullForm.cost_per_credit !== '' ? parseFloat(fullForm.cost_per_credit) : null,
          total_cost: fullTotalToPay !== null ? parseFloat(fullTotalToPay) : null,
          recharge_date: fullForm.recharge_date || null,
        }
        if (vid) {
          body.vendor_id = parseInt(vid, 10)
          body.inventory_asset_account_id = parseInt(iacc, 10)
          const bn = String(fullForm.vendor_bill_number || '').trim()
          if (bn) body.vendor_bill_number = bn
          body.vendor_bill_date = fullForm.vendor_bill_date || fullForm.recharge_date || null
          const due = String(fullForm.vendor_bill_due_date || '').trim()
          if (due) body.vendor_bill_due_date = due
          const terms = String(fullForm.vendor_bill_terms || '').trim()
          if (terms) body.vendor_bill_terms = terms
        }
        await api.post('/api/v1/inventory/accounts/', body)
        window.dispatchEvent(new CustomEvent('products:changed'))
      } else {
        const cntErr = validateScreenPackagesAndCounts(screenLines)
        if (cntErr) {
          setError(cntErr)
          return
        }
        if (!selectedScreenProduct?.id) {
          setError('Selecciona un producto de tipo «crédito por pantalla».')
          return
        }
        const { provider, lines } = buildScreensPayload(screenLines, screensProvider)
        if (!lines.length) {
          setError('Indica al menos una línea con paquete válido.')
          return
        }
        await api.post('/api/v1/inventory/screens/', {
          provider,
          product_id: Number(selectedScreenProduct.id),
          expiration_date: expirationDate?.trim() || null,
          lines,
        })
        window.dispatchEvent(new CustomEvent('products:changed'))
        try {
          const r = await api.get('/api/v1/products/', { params: { skip: 0, limit: 500 } })
          if (Array.isArray(r.data)) setProducts(r.data)
        } catch {
          /* el catálogo en memoria puede quedar un turno atrás hasta reabrir */
        }
      }
      onSuccess(serviceType)
    } catch (err) {
      setError(formatAxiosApiDetail(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={`fixed inset-0 ${overlayZIndexClass} flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm`}>
      <div className="absolute inset-0" onClick={onClose} />

      <div className={`relative w-full ${isScreens ? 'max-w-4xl' : isFull ? 'max-w-xl' : 'max-w-lg'} bg-white rounded-2xl shadow-2xl z-10 flex flex-col max-h-[92vh] transition-all duration-200`}>

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center ring-1 ${
              isScreens ? 'bg-violet-50 ring-violet-100' : 'bg-blue-50 ring-blue-100'
            }`}>
              {isScreens
                ? <Monitor size={16} className="text-violet-600" />
                : <RefreshCw size={16} className="text-blue-600" />}
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                {onSaveDraft ? 'Pantallas (borrador de venta)' : 'Recarga de créditos'}
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {onSaveDraft
                  ? 'Se crearán en bodega al registrar la venta'
                  : (isScreens ? 'Pantallas individuales a bodega' : 'Servicio completo')}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* ── Service-type tabs ── */}
        <div className="flex border-b border-gray-100 shrink-0">
          {(onSaveDraft
            ? [['screens', 'Crédito por pantalla', Monitor]]
            : [['full', 'Crédito normal', Tv2], ['screens', 'Crédito por pantalla', Monitor]]
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              onClick={() => { setServiceType(id); setError('') }}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-xs font-semibold border-b-2 transition-colors ${
                serviceType === id
                  ? id === 'screens'
                    ? 'border-violet-600 text-violet-600 bg-violet-50/40'
                    : 'border-blue-600 text-blue-600 bg-blue-50/40'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Icon size={13} />{label}
            </button>
          ))}
        </div>

        {/* ── Form ── */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

          {/* ════════════════ FULL (Crédito normal) ════════════════ */}
          {isFull && (
            <>
              <div>
                <label className={labelCls}>Producto/servicio</label>
                <SearchableSelect
                  value={fullProductId}
                  onChange={(v) => setFullProductId(String(v))}
                  options={fullProductOptions}
                  hideClear
                  placeholder={fullProductOptions.length ? 'Buscar producto…' : 'Sin productos activos'}
                  disabled={!fullProductOptions.length}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>
                    <span className="inline-flex items-center gap-1.5"><Coins size={11} />Créditos Totales</span>
                  </label>
                  <input
                    type="number" min="0" step="1" placeholder="ej. 100"
                    value={fullForm.credits_spent}
                    onChange={e => setFullForm(p => ({ ...p, credits_spent: e.target.value }))}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>
                    <span className="inline-flex items-center gap-1.5"><DollarSign size={11} />Costo por crédito (USD)</span>
                  </label>
                  <input
                    type="number" min="0" step="0.01" placeholder="ej. 0.50"
                    value={fullForm.cost_per_credit}
                    onChange={e => setFullForm(p => ({ ...p, cost_per_credit: e.target.value }))}
                    className={inputCls}
                  />
                </div>
              </div>

              <div>
                <label className={labelCls}>Total a pagar (USD)</label>
                <div className={`w-full px-3 py-2.5 rounded-xl text-sm ring-1 flex items-center gap-2 ${
                  fullTotalToPay ? 'bg-emerald-50 ring-emerald-200 text-emerald-800 font-semibold' : 'bg-gray-50 ring-gray-200 text-gray-400'
                }`}>
                  <DollarSign size={13} className={fullTotalToPay ? 'text-emerald-600' : 'text-gray-300'} />
                  {fullTotalToPay ? `$${fullTotalToPay} USD` : 'Se calculará automáticamente'}
                </div>
              </div>

              <div>
                <label className={labelCls}>Fecha de recarga</label>
                <input
                  type="date"
                  value={fullForm.recharge_date}
                  onChange={e => setFullForm(p => ({ ...p, recharge_date: e.target.value }))}
                  className={inputCls}
                />
              </div>

              {!onSaveDraft && (
                <div className="rounded-xl ring-1 ring-slate-200 bg-slate-50/90 p-4 space-y-3">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Factura de proveedor (opcional)</p>
                  <p className="text-xs text-slate-600 leading-snug">
                    Si eliges un proveedor de la lista, se creará una factura por el total a pagar y el asiento Débito inventario · Crédito cuentas por pagar.
                  </p>
                  <div>
                    <label className={labelCls}>Proveedor</label>
                    <SearchableSelect
                      value={fullForm.vendor_id}
                      onChange={(v) => setFullForm((p) => ({ ...p, vendor_id: v }))}
                      options={[{ value: '', label: '(Sin factura automática)' }, ...vendorComboOpts]}
                      placeholder="Buscar proveedor…"
                    />
                  </div>
                  <div>
                    <label className={labelCls}>Cuenta activos de inventario</label>
                    <SearchableSelect
                      value={fullForm.inventory_asset_account_id}
                      onChange={(v) => setFullForm((p) => ({ ...p, inventory_asset_account_id: v }))}
                      options={[{ value: '', label: '(Seleccionar si hay proveedor)' }, ...invAssetComboOpts]}
                      placeholder="Tipo inventario en plan de cuentas"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>N.º factura proveedor</label>
                      <input
                        type="text"
                        className={inputCls}
                        value={fullForm.vendor_bill_number}
                        onChange={(e) => setFullForm((p) => ({ ...p, vendor_bill_number: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Términos</label>
                      <input
                        type="text"
                        className={inputCls}
                        placeholder="ej. Net 30"
                        value={fullForm.vendor_bill_terms}
                        onChange={(e) => setFullForm((p) => ({ ...p, vendor_bill_terms: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>Fecha de factura</label>
                      <input
                        type="date"
                        className={inputCls}
                        value={fullForm.vendor_bill_date}
                        onChange={(e) => setFullForm((p) => ({ ...p, vendor_bill_date: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Fecha de vencimiento</label>
                      <input
                        type="date"
                        className={inputCls}
                        value={fullForm.vendor_bill_due_date}
                        onChange={(e) => setFullForm((p) => ({ ...p, vendor_bill_due_date: e.target.value }))}
                      />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ════════════════ SCREENS (Carrito) ════════════════ */}
          {isScreens && (
            <>
              {/* Info banner */}
              <div className="flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl text-xs ring-1 bg-violet-50 ring-violet-100 text-violet-700">
                <Info size={13} className="mt-0.5 shrink-0" />
                <span>
                  Se crearán <strong>{screenTotals.totalScreens} pantallas individuales</strong> en bodega
                  desde <strong>{screenLines.length} {screenLines.length === 1 ? 'línea' : 'líneas'} de compra</strong>.
                  Cada pantalla quedará disponible para asignarse a un cliente distinto.
                  Puedes cargar usuario y contraseña IPTV <strong>por cada unidad de Cant.</strong> (opcional).
                </span>
              </div>

              {/* Provider (single, applies to all lines) */}
              <div>
                <label className={labelCls}>Producto/servicio</label>
                <SearchableSelect
                  value={screenProductId}
                  onChange={(v) => setScreenProductId(String(v))}
                  options={screenProductOptions}
                  hideClear
                  placeholder={screenProductOptions.length ? 'Buscar producto…' : 'Sin productos activos'}
                  disabled={!screenProductOptions.length}
                />
              </div>

              {/* Cart table */}
              <div>
                {/* Column headers */}
                <div
                  className="grid gap-2 mb-1.5 px-0.5"
                  style={{ gridTemplateColumns: 'minmax(0,1fr) 62px 100px 52px 36px' }}
                >
                  <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Paquete</span>
                  <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider text-center">Cant.</span>
                  <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Costo/paq.</span>
                  <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider text-center">
                    Pant./paq.
                  </span>
                  <span />
                </div>

                {/* Lines */}
                <div className="space-y-3">
                  {screenLines.map((line) => {
                    const fromCatalog = line.entryMode === 'catalog'
                    const screensPerPkg = lineScreensPerPkg(line)
                    const qty = parseLineQty(line.quantity)
                    const lineScreens = screensPerPkg * qty

                    return (
                      <div
                        key={line.id}
                        className="rounded-xl ring-1 ring-gray-100 bg-gray-50/50 p-3 space-y-2.5"
                      >
                        <div
                          className="grid gap-2 items-center"
                          style={{ gridTemplateColumns: 'minmax(0,1fr) 62px 100px 52px 36px' }}
                        >
                          <div className="min-w-0">
                            {line.entryMode === 'custom' ? (
                              <input
                                type="text"
                                value={line.package}
                                placeholder="Nombre del paquete"
                                onChange={(e) => updateLine(line.id, 'package', e.target.value)}
                                className={inputCls}
                              />
                            ) : (
                              <CatalogPackageDropdown
                                value={line.package}
                                catalogLines={screenCatalogPackages}
                                disabled={!screenProductId}
                                onSelectRow={(row) => {
                                  patchLine(line.id, {
                                    catalogLineId: row.id,
                                    entryMode: 'catalog',
                                    package: row.package_label,
                                    screens_per_package: row.screens_per_package,
                                    cost_per_package:
                                      row.reference_cost_usd != null && row.reference_cost_usd !== ''
                                        ? String(row.reference_cost_usd)
                                        : '',
                                  })
                                }}
                                onSelectNewManual={() =>
                                  patchLine(line.id, {
                                    entryMode: 'custom',
                                    catalogLineId: null,
                                    package: '',
                                    screens_per_package: '',
                                    cost_per_package: '',
                                  })}
                              />
                            )}
                          </div>

                          <input
                            type="number" min="1" max="200" step="1"
                            value={line.quantity}
                            onChange={(e) => updateLine(line.id, 'quantity', e.target.value)}
                            className="w-full px-2 py-2.5 border border-gray-200 rounded-xl text-sm text-center text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition bg-white"
                          />

                          <div className="relative">
                            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs pointer-events-none">$</span>
                            <input
                              type="number" min="0" step="0.01" placeholder="0.00"
                              value={line.cost_per_package}
                              onChange={(e) =>
                                updateLine(line.id, 'cost_per_package', e.target.value)
                              }
                              className="w-full pl-5 pr-2 py-2.5 border border-gray-200 rounded-xl text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition bg-white"
                            />
                          </div>

                          {fromCatalog ? (
                            <div
                              className="flex items-center justify-center h-[42px] rounded-xl bg-violet-50 ring-1 ring-violet-100 text-violet-700 text-sm font-bold"
                              title={`${screensPerPkg} pantallas por paquete × ${qty} = ${lineScreens}`}
                            >
                              {lineScreens || '—'}
                            </div>
                          ) : (
                            <div
                              className="flex flex-col items-stretch justify-center gap-0.5 min-h-[42px]"
                              title="Pantallas por paquete (cada lote físico); total de la línea abajo"
                            >
                              <input
                                type="number"
                                min="1"
                                max="20"
                                step="1"
                                placeholder="–"
                                value={line.screens_per_package}
                                onChange={(e) => updateLine(line.id, 'screens_per_package', e.target.value)}
                                className="w-full px-1 py-1.5 border border-gray-200 rounded-lg text-sm text-center text-gray-800 focus:outline-none focus:ring-2 focus:ring-violet-100 focus:border-violet-400 transition bg-white"
                              />
                              <span className="text-[10px] text-center text-violet-600 font-semibold tabular-nums leading-tight">
                                → {lineScreens || 0} tot.
                              </span>
                            </div>
                          )}

                          <button
                            type="button"
                            onClick={() => removeLine(line.id)}
                            disabled={screenLines.length === 1}
                            className="flex items-center justify-center w-9 h-[42px] rounded-xl text-gray-300 hover:text-red-400 hover:bg-red-50 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>

                        <div className="mt-2 pl-3 border-l-2 border-violet-200/90 rounded-md bg-white py-2.5 px-2 space-y-2 ring-1 ring-violet-50">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-violet-800/85">
                            Credenciales IPTV (una fila por cada unidad de Cant.)
                          </p>
                          {qty > 0
                            ? Array.from({ length: qty }, (_, idx) => {
                                const slot = line.credentials?.[idx] || { username: '', password: '' }
                                return (
                                  <div
                                    key={`${line.id}-cred-${idx}`}
                                    className="rounded-lg border border-gray-100 bg-slate-50/70 p-2.5 space-y-2"
                                  >
                                    <p className="text-[11px] font-semibold text-gray-700">
                                      Paquete {idx + 1} de {qty}
                                    </p>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                      <div>
                                        <label className={labelCls} htmlFor={`scr-u-${line.id}-${idx}`}>
                                          Usuario IPTV
                                        </label>
                                        <input
                                          id={`scr-u-${line.id}-${idx}`}
                                          type="text"
                                          autoComplete="off"
                                          maxLength={120}
                                          placeholder="Opcional"
                                          value={slot.username ?? ''}
                                          onChange={(e) =>
                                            updateLineCredential(line.id, idx, 'username', e.target.value)
                                          }
                                          className={inputCls}
                                        />
                                      </div>
                                      <div>
                                        <label className={labelCls} htmlFor={`scr-p-${line.id}-${idx}`}>
                                          Contraseña IPTV
                                        </label>
                                        <input
                                          id={`scr-p-${line.id}-${idx}`}
                                          type="password"
                                          autoComplete="new-password"
                                          maxLength={255}
                                          placeholder="Opcional"
                                          value={slot.password ?? ''}
                                          onChange={(e) =>
                                            updateLineCredential(line.id, idx, 'password', e.target.value)
                                          }
                                          className={inputCls}
                                        />
                                      </div>
                                    </div>
                                  </div>
                                )
                              })
                            : null}
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Add-line button */}
                <button
                  type="button"
                  onClick={addLine}
                  className="mt-3 w-full flex items-center justify-center gap-2 py-2 text-xs font-medium text-violet-600 hover:text-violet-700 hover:bg-violet-50 rounded-xl border border-dashed border-violet-200 hover:border-violet-300 transition-colors"
                >
                  <Plus size={13} /> Añadir otro paquete
                </button>
              </div>

              {/* Expiration date (applies to all screens) */}
              <div>
                <label className={labelCls}>
                  Fecha de vencimiento{' '}
                  <span className="font-normal text-gray-400 text-[10px]">(aplica a todas las pantallas)</span>
                </label>
                <input
                  type="date"
                  value={expirationDate}
                  onChange={e => setExpirationDate(e.target.value)}
                  className={inputCls}
                />
              </div>

              {/* Totals summary card */}
              <div className="rounded-xl ring-1 ring-emerald-200 bg-emerald-50 px-4 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <Monitor size={14} className="text-violet-500 shrink-0" />
                  <span className="text-sm text-gray-600">Total de pantallas:</span>
                  <span className="text-sm font-bold text-violet-700">{screenTotals.totalScreens}</span>
                </div>
                <div className="w-px h-6 bg-emerald-200" />
                <div className="flex items-center gap-2">
                  <DollarSign size={14} className="text-emerald-500 shrink-0" />
                  <span className="text-sm text-gray-600">Total a pagar:</span>
                  {screenTotals.totalCost
                    ? <span className="text-sm font-bold text-emerald-700">${screenTotals.totalCost} USD</span>
                    : <span className="text-xs text-gray-400">—</span>
                  }
                </div>
              </div>
            </>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-100 text-red-600 text-sm rounded-xl px-4 py-3">
              <X size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button" onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 rounded-xl transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit" disabled={loading}
              className={`px-5 py-2 text-sm font-semibold text-white rounded-xl disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center gap-2 shadow-sm ${
                isScreens
                  ? 'bg-violet-600 hover:bg-violet-700 shadow-violet-200'
                  : 'bg-blue-600 hover:bg-blue-700 shadow-blue-200'
              }`}
            >
              {loading
                ? <><Loader2 size={14} className="animate-spin" />Guardando…</>
                : onSaveDraft && isScreens
                  ? 'Añadir al borrador de venta'
                  : isScreens
                    ? `Crear ${screenTotals.totalScreens} pantalla${screenTotals.totalScreens !== 1 ? 's' : ''}`
                    : 'Registrar Recarga'
              }
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
