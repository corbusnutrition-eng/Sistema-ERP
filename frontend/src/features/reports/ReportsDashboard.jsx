import { useMemo, useRef, useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  List,
  MoreHorizontal,
  Search,
  Star,
} from 'lucide-react'
import { REPORT_SECTIONS } from './reportCatalog'

function buildFavoriteKey(sectionId, reportId) {
  return `${sectionId}::${reportId}`
}

function ReportRowMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function close(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
        aria-label="Más opciones"
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-[160px] py-1 bg-white rounded-xl shadow-lg ring-1 ring-gray-100 text-sm">
          <button
            type="button"
            className="w-full px-3 py-2 text-left text-gray-600 hover:bg-gray-50"
            onClick={() => setOpen(false)}
          >
            Ejecutar informe
          </button>
          <button
            type="button"
            className="w-full px-3 py-2 text-left text-gray-600 hover:bg-gray-50"
            onClick={() => setOpen(false)}
          >
            Personalizar…
          </button>
        </div>
      )}
    </div>
  )
}

export default function ReportsDashboard() {
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(() => {
    const m = {}
    REPORT_SECTIONS.forEach((s) => {
      m[s.id] = s.defaultExpanded
    })
    return m
  })

  const initialFavorites = useMemo(() => {
    const set = new Set()
    REPORT_SECTIONS.forEach((sec) => {
      sec.reports.forEach((r) => {
        if (r.defaultFavorite) set.add(buildFavoriteKey(sec.id, r.id))
      })
    })
    return set
  }, [])

  const [favorites, setFavorites] = useState(() => new Set(initialFavorites))

  function toggleFavorite(sectionId, reportId) {
    const key = buildFavoriteKey(sectionId, reportId)
    setFavorites((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleSection(sectionId) {
    setExpanded((prev) => ({ ...prev, [sectionId]: !prev[sectionId] }))
  }

  const q = search.trim().toLowerCase()

  const visibleSections = useMemo(() => {
    if (!q) return REPORT_SECTIONS
    return REPORT_SECTIONS.map((sec) => ({
      ...sec,
      reports: sec.reports.filter((r) => r.title.toLowerCase().includes(q)),
    })).filter((sec) => sec.reports.length > 0)
  }, [q])

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-12 px-4">
      <div
        className="rounded-2xl border border-gray-200 bg-white shadow-md px-5 py-5 flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between sm:gap-6"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
            <BarChart3 size={14} className="text-blue-500" />
            <span>QuickBooks · Informes</span>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Informes</h1>
          <p className="text-sm text-gray-500 mt-1">
            Ejecuta y organiza informes financieros y operativos.
          </p>
        </div>
        <Link
          to="/listas"
          className="inline-flex items-center justify-center gap-2 shrink-0 w-full sm:w-auto px-5 py-3 rounded-xl text-sm font-bold
                     border-2 border-green-700 bg-green-50 text-green-900 shadow-sm
                     hover:bg-green-100 hover:border-green-800 hover:text-green-950 transition-colors"
        >
          <List size={20} className="text-green-800 shrink-0" />
          Administrar Listas
        </Link>
      </div>

      <Link
        to="/informes/clasificacion-listas"
        className="block rounded-2xl border border-green-200 bg-gradient-to-br from-green-50 to-white shadow-sm px-5 py-4 hover:border-green-300 hover:shadow-md transition-all group"
      >
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-xl bg-green-100 p-2.5 text-green-800 group-hover:bg-green-200 transition-colors">
            <BarChart3 size={22} />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-gray-900 group-hover:text-green-950">
              Reporte por Clasificación (Listas)
            </p>
            <p className="text-sm text-gray-500 mt-0.5">
              Filtra por fechas, agrupa por clases, métodos de pago, monedas o etiquetas y exporta a CSV.
            </p>
          </div>
          <ChevronRight size={20} className="shrink-0 text-green-600 mt-1 opacity-70 group-hover:opacity-100" />
        </div>
      </Link>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nombre de informe…"
          className="w-full pl-10 pr-4 py-3 rounded-xl border border-gray-200 bg-white text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-500 shadow-sm"
        />
      </div>

      <div className="space-y-3">
        {visibleSections.length === 0 ? (
          <div className="rounded-2xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
            No hay informes que coincidan con «{search.trim()}».
          </div>
        ) : (
          visibleSections.map((section) => {
            const isOpen = expanded[section.id]
            return (
              <div
                key={section.id}
                className="rounded-2xl border border-gray-200/90 bg-white shadow-sm overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => toggleSection(section.id)}
                  className="flex items-center gap-3 w-full px-5 py-4 text-left hover:bg-gray-50/80 transition-colors border-b border-gray-100"
                >
                  {isOpen ? (
                    <ChevronDown size={20} className="text-gray-400 shrink-0" />
                  ) : (
                    <ChevronRight size={20} className="text-gray-400 shrink-0" />
                  )}
                  <span className="font-semibold text-gray-900">{section.title}</span>
                  <span className="ml-auto text-xs font-medium text-gray-400 tabular-nums">
                    {section.reports.length}
                  </span>
                </button>

                {isOpen && (
                  <ul className="divide-y divide-gray-50">
                    {section.reports.map((report) => {
                      const favKey = buildFavoriteKey(section.id, report.id)
                      const isFav = favorites.has(favKey)
                      return (
                        <li
                          key={report.id}
                          className="flex items-center gap-2 px-4 py-3.5 hover:bg-slate-50/60 transition-colors"
                        >
                          <button
                            type="button"
                            onClick={() => toggleFavorite(section.id, report.id)}
                            className="p-2 rounded-lg shrink-0 text-gray-300 hover:bg-amber-50/80 hover:text-amber-500 transition-colors"
                            title={isFav ? 'Quitar de favoritos' : 'Añadir a favoritos'}
                            aria-pressed={isFav}
                          >
                            <Star
                              size={18}
                              className={
                                isFav
                                  ? 'fill-emerald-500 text-emerald-600'
                                  : 'fill-transparent text-gray-400'
                              }
                              strokeWidth={isFav ? 0 : 2}
                            />
                          </button>
                          <Link
                            to={`/informes/standard/${encodeURIComponent(section.id)}/${encodeURIComponent(report.id)}`}
                            className="flex-1 text-sm text-gray-800 font-medium leading-snug text-left hover:text-blue-700 hover:underline underline-offset-2"
                          >
                            {report.title}
                          </Link>
                          <ReportRowMenu />
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
