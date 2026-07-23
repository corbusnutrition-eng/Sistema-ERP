import { useEffect, useMemo, useState } from 'react'
import api from '../../../api/axios'
import { useInventoryData } from '../../../context/InventoryDataContext'
import { buildInventorySalesProductOptions } from '../buildInventorySalesProductOptions'

/**
 * Catálogo de producto/servicio idéntico al de Nueva venta (inventario + secciones QB).
 */
export default function useInventorySalesProductOptions({
  saleId = null,
  includeScreenPicks = false,
  includeDraftRecharge = false,
  draftRecharge = null,
  draftProvider = '',
  extraFallbackOptions = [],
} = {}) {
  const { combinedProvidersList, snapshotFor, loadFinished } = useInventoryData()
  const [inventorySalesOpts, setInventorySalesOpts] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = {}
    if (saleId != null) params.sale_id = saleId
    api
      .get('/api/v1/inventory/sales-options', { params })
      .then(({ data }) => {
        if (cancelled) return
        setInventorySalesOpts(data && typeof data === 'object' ? data : {})
      })
      .catch(() => {
        if (!cancelled) setInventorySalesOpts({})
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [saleId])

  const options = useMemo(
    () =>
      buildInventorySalesProductOptions({
        inventorySalesOpts,
        inventorySalesOptsLoading: loading,
        combinedProvidersList,
        snapshotFor,
        catalogReady: loadFinished,
        includeDraftRecharge,
        draftRecharge,
        draftProvider,
        includeScreenPicks,
        extraFallbackOptions,
      }),
    [
      inventorySalesOpts,
      loading,
      combinedProvidersList,
      snapshotFor,
      loadFinished,
      includeDraftRecharge,
      draftRecharge,
      draftProvider,
      includeScreenPicks,
      extraFallbackOptions,
    ],
  )

  return {
    options,
    inventorySalesOpts,
    loading,
  }
}
