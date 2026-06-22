import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import api from '../api/axios'

const InventoryDataContext = createContext(null)

/** Fallback cuando no hay registros / falla parte de la API (misma tabla que verías en Inventario vacío). */
const MOCK_BY_PROVIDER = {
  Flujo: {
    total_credits: 21000,
    screens: [
      { package: '1 mes', count: 3 },
      { package: '6 meses + 1 mes gratis', count: 2 },
    ],
  },
  Stella: {
    total_credits: 18500,
    screens: [
      { package: '1 mes', count: 2 },
      { package: '12 meses + 2 meses gratis', count: 1 },
    ],
  },
}

function groupScreensByPackage(provider, screensList) {
  const p = (provider || '').trim()
  const tally = new Map()
  const list = Array.isArray(screensList) ? screensList : []
  for (const row of list) {
    if (!row || row.status !== 'free') continue
    if ((row.provider || '').trim() !== p) continue
    const pkg = String(row.package || '').trim()
    if (!pkg) continue
    tally.set(pkg, (tally.get(pkg) || 0) + 1)
  }
  return [...tally.entries()]
    .map(([pkg, count]) => ({ package: pkg, count }))
    .sort((a, b) => a.package.localeCompare(b.package, 'es'))
}

function sumFullCreditsForProvider(accountsRows, provider) {
  const p = (provider || '').trim()
  let sum = 0
  const list = Array.isArray(accountsRows) ? accountsRows : []
  for (const a of list) {
    const st = String(a.service_type ?? '').trim().toLowerCase()
    const pv = String(a.provider_name ?? '').trim()
    if (st !== 'full' || pv !== p) continue
    sum += Number(a.credits_spent) || 0
  }
  return sum
}

export function InventoryDataProvider({ children }) {
  const [accounts, setAccounts] = useState([])
  const [screens, setScreens] = useState([])
  const [inventoryProviders, setInventoryProviders] = useState([])
  const [availabilityByProvider, setAvailabilityByProvider] = useState({})

  const [accountsFailed, setAccountsFailed] = useState(false)
  const [screensFailed, setScreensFailed] = useState(false)
  const [providersFailed, setProvidersFailed] = useState(false)

  const [loading, setLoading] = useState(true)
  const [loadFinished, setLoadFinished] = useState(false)

  const refreshInventoryData = useCallback(async () => {
    setLoading(true)
    setAccountsFailed(false)
    setScreensFailed(false)
    setProvidersFailed(false)

    const accTask = api
      .get('/api/v1/inventory/accounts/')
      .then((r) => (Array.isArray(r.data) ? r.data : []))
      .catch((err) => {
        console.warn('[inventory] GET accounts failed', err?.response?.status, err?.response?.data)
        setAccountsFailed(true)
        return []
      })

    const scrTask = api
      .get('/api/v1/inventory/screens/')
      .then((r) => (Array.isArray(r.data) ? r.data : []))
      .catch((err) => {
        console.warn('[inventory] GET screens failed', err?.response?.status, err?.response?.data)
        setScreensFailed(true)
        return []
      })

    const provTask = api
      .get('/api/v1/inventory/providers/')
      .then((r) => (Array.isArray(r.data) ? r.data.filter(Boolean) : []))
      .catch((err) => {
        console.warn('[inventory] GET providers failed', err?.response?.status, err?.response?.data)
        setProvidersFailed(true)
        return []
      })

    try {
      const [accRows, scrRows, provRows] = await Promise.all([accTask, scrTask, provTask])
      setAccounts(accRows)
      setScreens(scrRows)
      setInventoryProviders(provRows)

      const provSet = new Set(['Flujo', 'Stella'])
      for (const r of provRows) {
        const x = String(r || '').trim()
        if (x) provSet.add(x)
      }
      for (const a of accRows) {
        const pn = String(a.provider_name ?? '').trim()
        if (pn) provSet.add(pn)
      }
      for (const s of scrRows) {
        const pn = String(s.provider ?? '').trim()
        if (pn) provSet.add(pn)
      }

      const availPairs = await Promise.all(
        [...provSet].map(async (pv) => {
          try {
            const { data } = await api.get('/api/v1/inventory/available', { params: { provider: pv } })
            return [pv, data]
          } catch (err) {
            console.warn('[inventory] GET available failed', pv, err?.response?.status, err?.response?.data)
            return [pv, null]
          }
        }),
      )
      const nextAvail = {}
      for (const [pv, data] of availPairs) {
        if (
          data &&
          data.total_credits != null &&
          !Number.isNaN(Number(data.total_credits))
        ) {
          nextAvail[pv] = {
            ...data,
            total_credits: Number(data.total_credits),
          }
        }
      }
      setAvailabilityByProvider(nextAvail)
    } finally {
      setLoading(false)
      setLoadFinished(true)
    }
  }, [])

  useEffect(() => {
    refreshInventoryData()
  }, [refreshInventoryData])

  /**
   * @returns {{
   *   totalCredits: number,
   *   screenPackages: Array<{ package: string, count: number }>,
   *   isMocked: boolean,
   *   showLoadError: boolean,
   * }}
   */
  const snapshotFor = useMemo(
    () =>
      function snapshot(provider) {
        const p = (provider || '').trim()
        if (!loadFinished || !p) {
          return {
            totalCredits: 0,
            screenPackages: [],
            isMocked: false,
            showLoadError: false,
          }
        }

        const mockTpl = MOCK_BY_PROVIDER[p]

        const av = availabilityByProvider[p]
        let totalCredits = 0
        let screenPackages = []

        if (av && av.total_credits != null && !Number.isNaN(Number(av.total_credits))) {
          totalCredits = Number(av.total_credits) || 0
          screenPackages = Array.isArray(av.screens)
            ? av.screens.map((s) => ({
                package: s.package,
                count: Number(s.count) || 0,
              }))
            : []
        } else {
          let realCredits = accountsFailed ? null : sumFullCreditsForProvider(accounts, p)
          const realScreens = screensFailed ? [] : groupScreensByPackage(p, screens)
          totalCredits = typeof realCredits === 'number' && realCredits !== null ? realCredits : 0
          screenPackages = realScreens
        }

        let isMocked = false

        if (mockTpl) {
          const lowCredits =
            !av &&
            (accountsFailed || sumFullCreditsForProvider(accounts, p) <= 0)
          const noScreens =
            !av &&
            (screensFailed || groupScreensByPackage(p, screens).length === 0)

          if (lowCredits) {
            totalCredits = mockTpl.total_credits
            isMocked = true
          }
          if (noScreens && Array.isArray(mockTpl.screens) && mockTpl.screens.length) {
            screenPackages = mockTpl.screens
            isMocked = true
          }
        }

        /** Error visible solo si no hay mocks y ambas llamadas fallaron para un proveedor no cubierto. */
        const showLoadError =
          loadFinished &&
          !mockTpl &&
          accountsFailed &&
          screensFailed &&
          !availabilityByProvider[p]

        return {
          totalCredits,
          screenPackages,
          isMocked,
          showLoadError,
        }
      },
    [
      accounts,
      screens,
      accountsFailed,
      screensFailed,
      loadFinished,
      availabilityByProvider,
    ],
  )

  const combinedProvidersList = useMemo(() => {
    const set = new Set()
    for (const x of inventoryProviders ?? []) set.add(String(x).trim())
    for (const a of accounts ?? []) {
      const pn = String(a.provider_name ?? '').trim()
      if (pn) set.add(pn)
    }
    for (const s of screens ?? []) {
      const pn = String(s.provider ?? '').trim()
      if (pn) set.add(pn)
    }
    Object.keys(MOCK_BY_PROVIDER).forEach((k) => set.add(k))
    const out = [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, 'es'))
    return out.length ? out : ['Flujo', 'Stella']
  }, [inventoryProviders, accounts, screens])

  const value = useMemo(
    () => ({
      loading,
      loadFinished,
      refreshInventoryData,
      snapshotFor,
      accounts,
      screens,
      combinedProvidersList,
      providersFailed,
      availabilityByProvider,
    }),
    [
      loading,
      loadFinished,
      refreshInventoryData,
      snapshotFor,
      accounts,
      screens,
      combinedProvidersList,
      providersFailed,
      availabilityByProvider,
    ],
  )

  return (
    <InventoryDataContext.Provider value={value}>
      {children}
    </InventoryDataContext.Provider>
  )
}

export function useInventoryData() {
  const ctx = useContext(InventoryDataContext)
  if (!ctx)
    throw new Error('useInventoryData must be used inside <InventoryDataProvider>')
  return ctx
}
