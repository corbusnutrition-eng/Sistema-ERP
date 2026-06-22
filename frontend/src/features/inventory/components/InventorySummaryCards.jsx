import { useEffect, useMemo, useState } from 'react'
import { Loader2, Pencil, Trash2 } from 'lucide-react'
import api from '../../../api/axios'
import { useInventoryData } from '../../../context/InventoryDataContext'
import { useModal } from '../../../context/ModalContext'
import {
  PRODUCT_TYPE_CREDITO_NORMAL,
  PRODUCT_TYPE_CREDITO_PANTALLA,
} from '../inventoryProductTypes'

export const ALL_PACKAGES = [
  '1 mes',
  '3 meses',
  '6 meses + 1 mes gratis',
  '12 meses + 2 meses gratis',
]

export function distinctPackageNamesForProviderAllStatuses(screensList, provider) {
  const want = String(provider || '').trim().toLowerCase()
  const set = new Set()
  for (const row of screensList || []) {
    if (!row) continue
    if (String(row.provider || '').trim().toLowerCase() !== want) continue
    const pkg = String(row.package || '').trim()
    if (pkg) set.add(pkg)
  }
  return set
}

export function countFreeScreensByPackage(screensList, provider) {
  const want = String(provider || '').trim().toLowerCase()
  const map = new Map()
  for (const row of screensList || []) {
    if (!row || row.status !== 'free') continue
    if (String(row.provider || '').trim().toLowerCase() !== want) continue
    const pkg = String(row.package || '').trim()
    if (!pkg) continue
    map.set(pkg, (map.get(pkg) || 0) + 1)
  }
  return map
}

export function packageCatalogOrderedForSale(screensList, provider) {
  const p = String(provider || '').trim()
  if (!p) return []
  const historical = distinctPackageNamesForProviderAllStatuses(screensList, p)
  return [...historical].sort((a, b) => a.localeCompare(b, 'es'))
}

function slugProductType(p) {
  return String(p.product_type ?? '')
    .trim()
    .toLowerCase()
}

function serviceTypeLower(p) {
  return String(p.service_type ?? '')
    .trim()
    .toLowerCase()
}

function matchesCreditoNormalType(p) {
  const slug = slugProductType(p)
  if (slug === PRODUCT_TYPE_CREDITO_PANTALLA) return false
  if (slug === PRODUCT_TYPE_CREDITO_NORMAL) return true
  return serviceTypeLower(p) !== 'paquete pantalla'
}

function matchesCreditoPantallaType(p) {
  const slug = slugProductType(p)
  if (slug === PRODUCT_TYPE_CREDITO_NORMAL) return false
  if (slug === PRODUCT_TYPE_CREDITO_PANTALLA) return true
  return serviceTypeLower(p) === 'paquete pantalla'
}

const CARD_OUTER =
  'relative flex-none w-[280px] h-[200px] p-5 bg-white rounded-xl border border-slate-200 flex flex-col justify-between overflow-hidden'

const ROW_SCROLL = 'flex flex-row gap-4 overflow-x-auto pb-4 w-full'

function stockBlockingDelete(raw, creditsByProductId, screens) {
  if (matchesCreditoNormalType(raw)) {
    const pid = Number(raw.id)
    if (!Number.isFinite(pid)) return Infinity
    return Math.max(0, Number(creditsByProductId[pid] ?? 0))
  }
  if (matchesCreditoPantallaType(raw)) {
    const pid = Number(raw.id)
    if (!Number.isFinite(pid)) return Infinity
    let n = 0
    for (const row of screens || []) {
      if (Number(row?.product_id) !== pid) continue
      const st = String(row.status || '')
      if (st === 'free' || st === 'reserved' || st === 'held' || st === 'assigned') n++
    }
    return n
  }
  return Infinity
}

function formatDeleteDetail(err) {
  const d = err?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d)) {
    return d
      .map((item) => item.msg || item.message || '')
      .filter(Boolean)
      .join('; ')
  }
  return err?.message || 'No se pudo eliminar.'
}

function mediaAbsoluteUrl(path) {
  if (path == null || path === '') return null
  const s = String(path).trim()
  if (!s) return null
  const base = String(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '')
  const rel = s.startsWith('/') ? s : `/${s}`
  return `${base}${rel}`
}

function ProductCardTitle({ titulo, accentColor, logoUrl }) {
  const src = logoUrl ? mediaAbsoluteUrl(logoUrl) : null
  const initial = (String(titulo).trim().charAt(0) || '?').toUpperCase()
  return (
    <div className="flex items-center min-h-0 shrink min-w-0">
      <div className="h-10 w-10 rounded-full mr-3 shrink-0 overflow-hidden bg-gray-100 border border-gray-200 flex items-center justify-center">
        {src ? (
          <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <span className="text-sm font-bold text-gray-400 select-none">{initial}</span>
        )}
      </div>
      <span
        className="font-bold text-base leading-snug line-clamp-2 text-left min-w-0 flex-1"
        style={{ color: accentColor || '#6366f1' }}
      >
        {titulo}
      </span>
    </div>
  )
}

function PantallaCardBody({ producto, screens, loading }) {
  const provider = producto.iptv_provider || ''
  const pid = Number(producto?.id)
  const scopedScreens = useMemo(() => {
    if (!Array.isArray(screens) || !Number.isFinite(pid)) return []
    return screens.filter((row) => Number(row?.product_id) === pid)
  }, [screens, pid])

  const rowsByPackage = useMemo(
    () => countFreeScreensByPackage(scopedScreens, provider),
    [scopedScreens, provider],
  )
  const pkgOrder = useMemo(
    () => packageCatalogOrderedForSale(scopedScreens, provider),
    [scopedScreens, provider],
  )

  if (loading) {
    return (
      <div className="space-y-1">
        {ALL_PACKAGES.map((pkg) => (
          <div key={pkg} className="h-3 bg-gray-100 rounded animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <ul className="space-y-0.5 min-w-0">
      {pkgOrder.map((pkg) => {
        const count = rowsByPackage.get(pkg) ?? 0
        return (
          <li key={pkg} className="flex items-center justify-between gap-1 text-sm leading-tight">
            <span className="text-gray-600 truncate min-w-0">{pkg}</span>
            <span
              className={
                count > 0
                  ? 'text-sm font-bold text-slate-700 tabular-nums shrink-0'
                  : 'text-sm font-semibold text-gray-400 tabular-nums shrink-0'
              }
            >
              {count}
            </span>
          </li>
        )
      })}
      {!pkgOrder.length && <li className="text-sm text-gray-400 leading-tight">Sin pantallas libres.</li>}
    </ul>
  )
}

/**
 * Resumen inventario: productos activos desde GET /products + saldos por producto (crédito normal).
 */
export default function InventorySummaryCards({
  refreshKey = 0,
  summarySelection = null,
  interactive = false,
  onPickNormalCredits,
  onPickScreens,
}) {
  const { screens, loading: ctxLoading, refreshInventoryData } = useInventoryData()
  const { openProductServiceModal } = useModal()
  const [products, setProducts] = useState([])
  const [creditsByProductId, setCreditsByProductId] = useState({})
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [deletingId, setDeletingId] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoadingProducts(true)
    api
      .get('/api/v1/products/', { params: { limit: 500, skip: 0 } })
      .then(({ data }) => {
        if (!cancelled) setProducts(Array.isArray(data) ? data : [])
      })
      .catch(() => {
        if (!cancelled) setProducts([])
      })
      .finally(() => {
        if (!cancelled) setLoadingProducts(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  useEffect(() => {
    let cancelled = false
    api
      .get('/api/v1/inventory/catalog-full-credits')
      .then(({ data }) => {
        if (!cancelled) {
          const m = {}
          for (const row of Array.isArray(data) ? data : []) {
            const pid = row?.product_id
            if (pid == null || pid === '') continue
            const idNum = Number(pid)
            if (!Number.isFinite(idNum)) continue
            m[idNum] = Number(row.available_credits ?? 0)
          }
          setCreditsByProductId(m)
        }
      })
      .catch(() => {
        if (!cancelled) setCreditsByProductId({})
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  const productosNormales = useMemo(
    () => products.filter((p) => p.is_active && matchesCreditoNormalType(p)),
    [products],
  )
  const productosPantalla = useMemo(
    () => products.filter((p) => p.is_active && matchesCreditoPantallaType(p)),
    [products],
  )

  const loading = ctxLoading || loadingProducts
  const canPickNormal = Boolean(interactive && typeof onPickNormalCredits === 'function')
  const canPickScreens = Boolean(interactive && typeof onPickScreens === 'function')

  function isNormalSelected(raw) {
    return (
      summarySelection?.tab === 'full' &&
      String(summarySelection?.productId ?? '') === String(raw.id)
    )
  }

  function isScreensSelected(raw) {
    return (
      summarySelection?.tab === 'screens' &&
      String(summarySelection?.productId ?? '') === String(raw.id)
    )
  }

  async function handleDeleteProduct(raw, e) {
    e.preventDefault()
    e.stopPropagation()
    const alive = stockBlockingDelete(raw, creditsByProductId, screens)
    if (alive > 0) return
    const titulo = String(raw.name ?? '').trim() || `Producto #${raw.id}`
    if (!window.confirm(`¿Estás seguro de eliminar «${titulo}»? Esta acción no se puede deshacer.`)) return
    const pid = Number(raw.id)
    setDeletingId(pid)
    try {
      await api.delete(`/api/v1/products/${pid}`)
      window.dispatchEvent(new CustomEvent('products:changed'))
      await refreshInventoryData()
    } catch (err) {
      window.alert(formatDeleteDetail(err))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0 w-full">
      <div className="space-y-2 min-w-0 w-full">
        <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500">Créditos normales</h2>
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 w-full min-w-0">
          {loading ? (
            <p className="text-sm text-gray-400">Cargando…</p>
          ) : (
            <div className={ROW_SCROLL}>
              {productosNormales.length > 0 ? (
                productosNormales.map((raw) => {
                  const titulo = String(raw.name ?? '').trim() || `Producto #${raw.id}`
                  const pidNum = Number(raw.id)
                  const saldoFromProduct = Number(raw.available_credits)
                  const saldoFromCatalog = Number.isFinite(pidNum)
                    ? creditsByProductId[pidNum]
                    : undefined
                  const saldoSrc = Number.isFinite(saldoFromProduct)
                    ? saldoFromProduct
                    : saldoFromCatalog
                  const saldo = saldoSrc != null && Number.isFinite(Number(saldoSrc)) ? Number(saldoSrc) : 0
                  const physicalTotal = Number(raw.inventory_physical_total)
                  const showLoadedHint =
                    Number.isFinite(physicalTotal) && physicalTotal > saldo + 1e-9
                  const sel = isNormalSelected(raw)
                  const blockedDel = stockBlockingDelete(raw, creditsByProductId, screens) > 0
                  const pidDel = Number(raw.id)
                  return (
                    <div
                      key={raw.id}
                      role={canPickNormal ? 'button' : undefined}
                      tabIndex={canPickNormal ? 0 : undefined}
                      onClick={() => {
                        if (!canPickNormal) return
                        const pv = String(raw.iptv_provider || '').trim()
                        if (pv) onPickNormalCredits?.({ provider: pv, productId: raw.id })
                      }}
                      onKeyDown={(e) => {
                        if (!canPickNormal) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          const pv = String(raw.iptv_provider || '').trim()
                          if (pv) onPickNormalCredits?.({ provider: pv, productId: raw.id })
                        }
                      }}
                      className={`${CARD_OUTER} ${canPickNormal ? 'cursor-pointer transition-all hover:ring-2 hover:ring-inset hover:ring-blue-400' : ''} ${sel ? 'ring-2 ring-inset ring-blue-500' : ''}`}
                    >
                      <div className="absolute top-2 right-2 z-10 flex items-center gap-0.5">
                        <button
                          type="button"
                          className="rounded-md p-1.5 text-gray-400 hover:text-slate-700 hover:bg-white/90 border border-transparent hover:border-gray-200 shadow-sm transition-colors disabled:opacity-40"
                          title="Editar producto"
                          aria-label="Editar producto"
                          disabled={deletingId === pidDel}
                          onClick={(e) => {
                            e.stopPropagation()
                            openProductServiceModal(raw)
                          }}
                        >
                          <Pencil size={14} strokeWidth={2} />
                        </button>
                        <button
                          type="button"
                          className={`rounded-md p-1.5 border shadow-sm transition-colors disabled:opacity-50 ${
                            blockedDel
                              ? 'text-gray-300 cursor-not-allowed border-transparent bg-white/40'
                              : 'text-gray-400 hover:text-red-600 hover:bg-white/90 hover:border-gray-200'
                          }`}
                          title={
                            blockedDel
                              ? 'Hay inventario activo; vacía el stock antes de eliminar.'
                              : 'Eliminar producto'
                          }
                          aria-label="Eliminar producto"
                          disabled={blockedDel || deletingId === pidDel}
                          onClick={(e) => handleDeleteProduct(raw, e)}
                        >
                          {deletingId === pidDel ? (
                            <Loader2 size={14} className="animate-spin text-gray-500" />
                          ) : (
                            <Trash2 size={14} strokeWidth={2} />
                          )}
                        </button>
                      </div>
                      <div className="min-h-0 shrink min-w-0">
                        <ProductCardTitle titulo={titulo} accentColor={raw.color || '#6366f1'} logoUrl={raw.logo_url} />
                      </div>
                      <div className="flex items-baseline gap-2 min-h-0">
                        <span className="text-4xl font-bold tabular-nums truncate text-slate-800">
                          {Number.isFinite(saldo) ? saldo : 0}
                        </span>
                        <span className="text-sm text-gray-500 whitespace-nowrap shrink-0">disponibles</span>
                      </div>
                      {showLoadedHint ? (
                        <p className="mt-1 text-[11px] leading-snug text-gray-500">
                          Cargados en recargas:{' '}
                          <span className="tabular-nums font-medium text-gray-600">{physicalTotal}</span>
                          {Number.isFinite(Number(raw.inventory_reserved_qty)) &&
                          Number(raw.inventory_reserved_qty) > 0 ? (
                            <>
                              {' · '}
                              Reservados:{' '}
                              <span className="tabular-nums font-medium text-amber-700">
                                {Number(raw.inventory_reserved_qty)}
                              </span>
                            </>
                          ) : null}
                        </p>
                      ) : null}
                    </div>
                  )
                })
              ) : (
                <p className="text-gray-500 text-sm p-4 border border-dashed rounded-xl w-full text-center">
                  No hay productos de crédito normal activos.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2 min-w-0 w-full">
        <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500">Crédito por pantalla</h2>
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 w-full min-w-0">
          {loading ? (
            <p className="text-sm text-gray-400">Cargando…</p>
          ) : (
            <div className={ROW_SCROLL}>
              {productosPantalla.length > 0 ? (
                productosPantalla.map((raw) => {
                  const titulo = String(raw.name ?? '').trim() || `Producto #${raw.id}`
                  const sel = isScreensSelected(raw)
                  const blockedDel = stockBlockingDelete(raw, creditsByProductId, screens) > 0
                  const pidDel = Number(raw.id)
                  return (
                    <div
                      key={raw.id}
                      role={canPickScreens ? 'button' : undefined}
                      tabIndex={canPickScreens ? 0 : undefined}
                      onClick={() => {
                        if (!canPickScreens) return
                        const pv = String(raw.iptv_provider || '').trim()
                        if (pv) onPickScreens?.({ provider: pv, productId: raw.id })
                      }}
                      onKeyDown={(e) => {
                        if (!canPickScreens) return
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          const pv = String(raw.iptv_provider || '').trim()
                          if (pv) onPickScreens?.({ provider: pv, productId: raw.id })
                        }
                      }}
                      className={`${CARD_OUTER} ${canPickScreens ? 'cursor-pointer transition-all hover:ring-2 hover:ring-inset hover:ring-blue-400' : ''} ${sel ? 'ring-2 ring-inset ring-slate-500' : ''}`}
                    >
                      <div className="absolute top-2 right-2 z-10 flex items-center gap-0.5">
                        <button
                          type="button"
                          className="rounded-md p-1.5 text-gray-400 hover:text-slate-700 hover:bg-white/90 border border-transparent hover:border-gray-200 shadow-sm transition-colors disabled:opacity-40"
                          title="Editar producto"
                          aria-label="Editar producto"
                          disabled={deletingId === pidDel}
                          onClick={(e) => {
                            e.stopPropagation()
                            openProductServiceModal(raw)
                          }}
                        >
                          <Pencil size={14} strokeWidth={2} />
                        </button>
                        <button
                          type="button"
                          className={`rounded-md p-1.5 border shadow-sm transition-colors disabled:opacity-50 ${
                            blockedDel
                              ? 'text-gray-300 cursor-not-allowed border-transparent bg-white/40'
                              : 'text-gray-400 hover:text-red-600 hover:bg-white/90 hover:border-gray-200'
                          }`}
                          title={
                            blockedDel
                              ? 'Hay inventario activo; vacía la bodega antes de eliminar.'
                              : 'Eliminar producto'
                          }
                          aria-label="Eliminar producto"
                          disabled={blockedDel || deletingId === pidDel}
                          onClick={(e) => handleDeleteProduct(raw, e)}
                        >
                          {deletingId === pidDel ? (
                            <Loader2 size={14} className="animate-spin text-gray-500" />
                          ) : (
                            <Trash2 size={14} strokeWidth={2} />
                          )}
                        </button>
                      </div>
                      <div className="min-h-0 shrink min-w-0">
                        <ProductCardTitle titulo={titulo} accentColor={raw.color || '#6366f1'} logoUrl={raw.logo_url} />
                      </div>
                      <div className="flex flex-col flex-1 min-h-0 gap-1">
                        <p className="text-[10px] text-gray-400 uppercase font-semibold shrink-0">
                          Pantallas por paquete
                        </p>
                        <div className="flex-1 min-h-0 overflow-y-auto pr-1 custom-scrollbar">
                          <PantallaCardBody producto={raw} screens={screens} loading={ctxLoading} />
                        </div>
                      </div>
                    </div>
                  )
                })
              ) : (
                <p className="text-gray-500 text-sm p-4 border border-dashed rounded-xl w-full text-center">
                  No hay productos de crédito por pantalla activos.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
