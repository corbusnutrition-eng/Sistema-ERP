import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { hierarchy, tree as d3tree } from 'd3-hierarchy'
import Tree from 'react-d3-tree'
import {
  GitBranch,
  Loader2,
  Move,
  RefreshCw,
  TrendingUp,
  UserCheck,
  Users,
  Wallet,
  ZoomIn,
} from 'lucide-react'

const TREE_LINK_CLASS = 'portal-neon-tree-link'
const TREE_DEPTH_FACTOR = 168
const TREE_NODE_SIZE_X = 300
const TREE_NODE_SIZE_Y = 150
const TREE_SIBLING_SEP = 1.12
const TREE_NODE_HALF_W = 140
const TREE_NODE_HALF_H = 59
const TREE_VIEWPORT_PADDING = 28
const TREE_TOP_OFFSET = 56

export const NETWORK_LEVEL_THEME = {
  1: {
    border: 'border-purple-400/80',
    glow: 'shadow-[0_0_18px_rgba(168,85,247,0.55)]',
    avatar: 'border-purple-400 bg-purple-500/20 text-purple-100',
    dot: 'bg-purple-400',
    badge: 'border-purple-400/50 bg-purple-500/25 text-purple-100',
    label: 'Nivel 1',
  },
  2: {
    border: 'border-cyan-400/80',
    glow: 'shadow-[0_0_18px_rgba(56,189,248,0.5)]',
    avatar: 'border-cyan-400 bg-cyan-500/15 text-cyan-100',
    dot: 'bg-cyan-400',
    badge: 'border-cyan-400/45 bg-cyan-500/20 text-cyan-100',
    label: 'Nivel 2',
  },
  3: {
    border: 'border-emerald-400/80',
    glow: 'shadow-[0_0_18px_rgba(52,211,153,0.48)]',
    avatar: 'border-emerald-400 bg-emerald-500/15 text-emerald-100',
    dot: 'bg-emerald-400',
    badge: 'border-emerald-400/45 bg-emerald-500/20 text-emerald-100',
    label: 'Nivel 3',
  },
  4: {
    border: 'border-amber-400/80',
    glow: 'shadow-[0_0_18px_rgba(251,191,36,0.48)]',
    avatar: 'border-amber-400 bg-amber-500/15 text-amber-100',
    dot: 'bg-amber-400',
    badge: 'border-amber-400/45 bg-amber-500/20 text-amber-100',
    label: 'Nivel 4',
  },
}

function themeForLevel(nivel) {
  const key = Number(nivel)
  if (NETWORK_LEVEL_THEME[key]) return NETWORK_LEVEL_THEME[key]
  return {
    border: 'border-slate-400/70',
    glow: 'shadow-[0_0_14px_rgba(148,163,184,0.35)]',
    avatar: 'border-slate-400 bg-slate-700/40 text-slate-200',
    dot: 'bg-slate-400',
    badge: 'border-slate-500/45 bg-slate-700/40 text-slate-200',
    label: `Nivel ${key}`,
  }
}

function formatDashboardMoney(amount, currency = 'USD') {
  const n = Number(amount)
  const cur = String(currency || 'USD').trim().slice(0, 10) || 'USD'
  if (!Number.isFinite(n)) return `${cur} 0.00`
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${cur} ${n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
}

function initialsForNode(name, username) {
  const src = String(name || username || '?').trim()
  return src.charAt(0).toUpperCase() || '?'
}

function apiNodeToRd3(node, fallbackNivel = 1) {
  if (!node) return null
  const nivel = Number(node.nivel ?? fallbackNivel)
  const out = {
    name: node.name || node.username || 'Cliente',
    attributes: {
      username: node.username || '—',
      walletBalance: Number(node.wallet_balance ?? 0),
      currency: String(node.currency || 'USD').trim().toUpperCase().slice(0, 10) || 'USD',
      status: node.status || 'Activo',
      nivel: Number.isFinite(nivel) && nivel >= 1 ? nivel : fallbackNivel,
      isRoot: fallbackNivel === 1 && Number(nivel) === 1,
    },
  }
  const kids = Array.isArray(node.children) ? node.children.filter(Boolean) : []
  if (kids.length > 0) {
    out.children = kids
      .map((child) => apiNodeToRd3(child, fallbackNivel + 1))
      .filter(Boolean)
  }
  return out
}

function cloneRd3Node(node) {
  if (!node) return null
  const out = {
    name: node.name,
    attributes: { ...(node.attributes || {}) },
  }
  const kids = Array.isArray(node.children) ? node.children.filter(Boolean) : []
  if (kids.length > 0) {
    out.children = kids.map(cloneRd3Node).filter(Boolean)
  }
  return out
}

function assignRd3InternalIds(node, depth = 0, idGen = { n: 0 }) {
  if (!node) return null
  node.__rd3t = { id: String(idGen.n++), depth, collapsed: false }
  for (const child of node.children || []) {
    assignRd3InternalIds(child, depth + 1, idGen)
  }
  return node
}

/** Réplica el layout de react-d3-tree para calcular bounds reales y centrar sin desfase. */
function computeRd3LayoutBounds(rd3Node) {
  const cloned = assignRd3InternalIds(cloneRd3Node(rd3Node))
  if (!cloned) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, rootX: 0, rootY: 0 }
  }

  const layout = d3tree()
    .nodeSize([TREE_NODE_SIZE_X, TREE_NODE_SIZE_Y])
    .separation((a, b) =>
      a.parent.data.__rd3t.id === b.parent.data.__rd3t.id ? TREE_SIBLING_SEP : 1.28,
    )

  const root = layout(hierarchy(cloned))
  root.eachBefore((node) => {
    node.y = node.depth * TREE_DEPTH_FACTOR
  })

  const nodes = root.descendants()
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const node of nodes) {
    minX = Math.min(minX, node.x - TREE_NODE_HALF_W)
    maxX = Math.max(maxX, node.x + TREE_NODE_HALF_W)
    minY = Math.min(minY, node.y - TREE_NODE_HALF_H)
    maxY = Math.max(maxY, node.y + TREE_NODE_HALF_H)
  }

  if (!Number.isFinite(minX)) {
    minX = 0
    maxX = 0
    minY = 0
    maxY = 0
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    rootX: root.x,
    rootY: root.y,
    width: Math.max(maxX - minX, TREE_NODE_SIZE_X),
    height: Math.max(maxY - minY, TREE_NODE_SIZE_Y),
  }
}

/** Zoom y traslación inicial: nodo raíz centrado horizontalmente y árbol completo visible. */
function computeTreeFitView(viewport, rd3Node) {
  const vpW = Math.max(Number(viewport?.width) || 320, 320)
  const vpH = Math.max(Number(viewport?.height) || 500, 500)
  if (!rd3Node) {
    return { zoom: 0.75, translate: { x: vpW / 2, y: TREE_TOP_OFFSET } }
  }

  const bounds = computeRd3LayoutBounds(rd3Node)
  const pad = TREE_VIEWPORT_PADDING
  const scaleX = (vpW - pad * 2) / bounds.width
  const scaleY = (vpH - pad * 2) / bounds.height
  const zoom = Math.max(0.12, Math.min(1, Math.min(scaleX, scaleY) * 0.92))

  // translate + nodeCoord * zoom = posición en pantalla
  const translate = {
    x: vpW / 2 - bounds.rootX * zoom,
    y: TREE_TOP_OFFSET - bounds.minY * zoom,
  }

  return { zoom, translate }
}

function NeonTreeNodeCard({ nodeDatum, toggleNode }) {
  const attrs = nodeDatum?.attributes || {}
  const children = Array.isArray(nodeDatum?.children) ? nodeDatum.children : []
  const hasChildren = children.length > 0
  const isExpanded = !nodeDatum?.__rd3t?.collapsed
  const nivel = Number(attrs.nivel) >= 1 ? Number(attrs.nivel) : 1
  const theme = themeForLevel(nivel)
  const isRoot = Boolean(attrs.isRoot)
  const label = String(nodeDatum?.name ?? '—').trim() || '—'
  const user = String(attrs.username ?? '—').trim() || '—'
  const blocked = String(attrs.status ?? '').trim().toLowerCase() === 'inactivo'

  return (
    <g>
      <foreignObject width={280} height={118} x={-140} y={-59} requiredExtensions="http://www.w3.org/1999/xhtml">
        <div
          xmlns="http://www.w3.org/1999/xhtml"
          className={`flex h-[110px] flex-col rounded-[1.75rem] border-2 bg-[#070b14]/95 px-3.5 py-2.5 ${theme.border} ${theme.glow}`}
        >
          <div className="flex min-h-0 flex-1 items-center gap-2.5">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold ${theme.avatar}`}
              aria-hidden
            >
              {initialsForNode(label, user)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate text-sm font-bold leading-tight text-white" title={label}>
                {isRoot ? 'TÚ' : label}
                {blocked ? (
                  <span className="ml-1.5 text-[9px] font-bold uppercase text-red-300">Inactivo</span>
                ) : null}
              </p>
              <p className="m-0 truncate font-mono text-[11px] text-slate-400" title={user}>
                @{user}
              </p>
            </div>
            {hasChildren ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleNode()
                }}
                className="shrink-0 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-300 hover:bg-white/10"
              >
                {isExpanded ? '−' : '+'}
              </button>
            ) : null}
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${theme.badge}`}
            >
              N{nivel}
            </span>
            <span className="inline-flex rounded-full border border-green-600/50 bg-green-950/50 px-2.5 py-0.5 text-[11px] font-bold tabular-nums text-green-400">
              {formatDashboardMoney(attrs.walletBalance, attrs.currency)}
            </span>
          </div>
        </div>
      </foreignObject>
    </g>
  )
}

function KpiCard({ icon: Icon, label, value, hint, accentClass }) {
  return (
    <div className="min-w-0 rounded-2xl border border-slate-700/50 bg-[#0a0f1a]/90 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
      <div className="mb-2 flex min-w-0 items-start gap-2">
        <span className={`inline-flex shrink-0 rounded-lg border p-1.5 ${accentClass}`}>
          <Icon size={16} aria-hidden />
        </span>
        <span className="min-w-0 flex-1 text-xs font-semibold uppercase leading-tight tracking-wide text-slate-400 text-center md:text-left">
          {label}
        </span>
      </div>
      <p className="m-0 truncate text-lg font-bold tabular-nums text-white md:text-xl" title={String(value)}>
        {value}
      </p>
      {hint ? (
        <p className="m-0 mt-1 truncate text-[11px] text-slate-500" title={hint}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export default function NetworkDashboard({ dashboard, loading = false, error = null, onRefresh, className = '' }) {
  const containerRef = useRef(null)
  const [viewportSize, setViewportSize] = useState(null)
  const [treeView, setTreeView] = useState(null)

  const tree = dashboard?.tree ?? null
  const metrics = dashboard?.metrics ?? null
  const levelCounts = Array.isArray(dashboard?.level_counts) ? dashboard.level_counts : []
  const currency = String(metrics?.currency ?? tree?.currency ?? 'USD').trim().slice(0, 10) || 'USD'

  const rd3Data = useMemo(() => apiNodeToRd3(tree), [tree])

  const fitView = useMemo(() => {
    if (!viewportSize || !rd3Data) return null
    return computeTreeFitView(viewportSize, rd3Data)
  }, [rd3Data, viewportSize])

  const activeTreeView = treeView ?? fitView
  const canRenderTree = Boolean(rd3Data && viewportSize && activeTreeView)

  const measureViewport = useCallback(() => {
    const el = containerRef.current
    if (!el) return false
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    const w = Math.max(Math.floor(rect.width), 320)
    const h = Math.max(Math.floor(rect.height), 500)
    setViewportSize((prev) => {
      if (prev && prev.width === w && prev.height === h) return prev
      return { width: w, height: h }
    })
    return true
  }, [])

  useLayoutEffect(() => {
    measureViewport()
  }, [measureViewport, rd3Data, loading])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined

    measureViewport()
    const ro = new ResizeObserver(() => {
      measureViewport()
    })
    ro.observe(el)
    window.addEventListener('resize', measureViewport)

    const retryId = window.setInterval(() => {
      measureViewport()
    }, 200)

    const stopRetryId = window.setTimeout(() => {
      window.clearInterval(retryId)
    }, 2000)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measureViewport)
      window.clearInterval(retryId)
      window.clearTimeout(stopRetryId)
    }
  }, [measureViewport])

  useLayoutEffect(() => {
    if (!fitView) {
      setTreeView(null)
      return
    }
    setTreeView(fitView)
  }, [fitView])

  useEffect(() => {
    if (!fitView || !rd3Data || !viewportSize) return undefined

    const recenterTree = () => {
      setTreeView(computeTreeFitView(viewportSize, rd3Data))
    }

    const timeoutId = window.setTimeout(recenterTree, 100)
    return () => window.clearTimeout(timeoutId)
  }, [fitView, rd3Data, viewportSize])

  const renderCustomNode = useCallback((props) => <NeonTreeNodeCard {...props} />, [])

  const totalInNetwork = Number(metrics?.total_network_count) || 0
  const activeCount = Number(metrics?.active_clients_count) || 0
  const totalBalance = Number(metrics?.total_network_balance) || 0
  const totalCommissions = Number(metrics?.total_commissions) || 0

  const descendantLevels = useMemo(
    () => levelCounts.filter((row) => Number(row?.level) > 1),
    [levelCounts],
  )

  if (loading) {
    return (
      <p className={`m-0 flex items-center gap-2 px-1 py-8 text-sm text-slate-300 ${className}`.trim()}>
        <Loader2 size={18} className="animate-spin" />
        Cargando dashboard de red…
      </p>
    )
  }

  if (error) {
    return <p className={`m-0 px-1 py-4 text-sm text-red-200 ${className}`.trim()}>{error}</p>
  }

  if (!dashboard || !tree) {
    return (
      <p className={`m-0 px-1 py-4 text-sm text-slate-400/85 ${className}`.trim()}>
        No hay datos de red disponibles. Pulsa «Actualizar lista» para reintentar.
      </p>
    )
  }

  return (
    <div className={`space-y-4 ${className}`.trim()}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-0.5">
        <div>
          <p className="m-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-violet-300/80">
            Mapa genealógico
          </p>
          <p className="m-0 mt-0.5 text-sm text-slate-400">
            Visualiza tu estructura en forma de mapa conceptual
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="hidden items-center gap-3 text-[10px] text-slate-500 sm:inline-flex">
            <span className="inline-flex items-center gap-1">
              <Move size={12} aria-hidden />
              Arrastra
            </span>
            <span className="inline-flex items-center gap-1">
              <ZoomIn size={12} aria-hidden />
              Zoom
            </span>
          </span>
          {onRefresh ? (
            <button
              type="button"
              onClick={() => void onRefresh()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-violet-400/40 bg-violet-950/35 px-3 py-1.5 text-xs font-semibold text-violet-100 transition hover:bg-violet-900/45"
            >
              <RefreshCw size={13} aria-hidden />
              Actualizar
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <KpiCard
          icon={Users}
          label="Red total"
          value={totalInNetwork}
          hint="Distribuidores"
          accentClass="border-purple-500/35 bg-purple-500/10 text-purple-300"
        />
        <KpiCard
          icon={UserCheck}
          label="Clientes activos"
          value={activeCount}
          hint="Activos"
          accentClass="border-cyan-500/35 bg-cyan-500/10 text-cyan-300"
        />
        <KpiCard
          icon={Wallet}
          label="Saldo total red"
          value={formatDashboardMoney(totalBalance, currency)}
          hint="Disponible"
          accentClass="border-emerald-500/35 bg-emerald-500/10 text-emerald-300"
        />
        <KpiCard
          icon={TrendingUp}
          label="Comisiones generadas"
          value={formatDashboardMoney(totalCommissions, currency)}
          hint="Este mes"
          accentClass="border-amber-500/35 bg-amber-500/10 text-amber-300"
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-700/45 bg-slate-950/60 px-3 py-2.5">
        {[1, 2, 3, 4].map((lvl) => {
          const theme = themeForLevel(lvl)
          return (
            <span key={`legend-${lvl}`} className="inline-flex items-center gap-1.5 text-[11px] text-slate-300">
              <span className={`h-2.5 w-2.5 rounded-full ${theme.dot}`} aria-hidden />
              {theme.label}
            </span>
          )
        })}
        <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-400">
          <span className="h-0 w-6 border-t-2 border-dashed border-slate-400/70" aria-hidden />
          Conexión
        </span>
      </div>

      <div
        ref={containerRef}
        className="portal-neon-tree-shell relative h-[min(72vh,680px)] w-full min-h-[500px] overflow-hidden rounded-2xl border border-slate-700/55 bg-[#0B1021] md:min-h-[600px] md:h-[600px]"
      >
        <style>{`
          .portal-neon-tree-shell .${TREE_LINK_CLASS} {
            stroke: rgba(148, 163, 184, 0.55);
            stroke-width: 2px;
            stroke-dasharray: 7 5;
            fill: none;
          }
          .portal-neon-tree-shell .rd3t-node,
          .portal-neon-tree-shell .rd3t-leaf-node {
            fill: transparent;
            stroke: none;
          }
          .portal-neon-tree-shell .rd3t-tree-container {
            width: 100%;
            height: 100%;
            margin: 0 auto;
          }
          .portal-neon-tree-shell .rd3t-svg {
            display: block;
            overflow: visible;
          }
          .portal-neon-tree-shell .rd3t-g {
            overflow: visible;
          }
        `}</style>
        {!rd3Data ? (
          <div className="flex h-full min-h-[500px] w-full items-center justify-center px-6 pb-20 text-center text-sm text-slate-400">
            Tu red aún no tiene subdistribuidores. Aparecerán aquí en cascada.
          </div>
        ) : !canRenderTree ? (
          <div className="flex h-full min-h-[500px] w-full items-center justify-center gap-2 text-sm text-slate-300">
            <Loader2 size={18} className="animate-spin" aria-hidden />
            Preparando mapa…
          </div>
        ) : (
          <div className="flex h-full w-full items-start justify-center">
            <Tree
              key={`${tree.id}-${activeTreeView.zoom}-${viewportSize.width}x${viewportSize.height}`}
              data={rd3Data}
              orientation="vertical"
              pathFunc="step"
              pathClassFunc={() => TREE_LINK_CLASS}
              translate={activeTreeView.translate}
              dimensions={viewportSize}
              nodeSize={{ x: TREE_NODE_SIZE_X, y: TREE_NODE_SIZE_Y }}
              separation={{ siblings: TREE_SIBLING_SEP, nonSiblings: 1.28 }}
              zoomable
              scaleExtent={{ min: 0.12, max: 2.4 }}
              zoom={activeTreeView.zoom}
              shouldRenderForeignObjects
              renderCustomNodeElement={renderCustomNode}
              enableLegacyTransitions={false}
              transitionDuration={0}
              depthFactor={TREE_DEPTH_FACTOR}
            />
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-xl">
        <section className="rounded-2xl border border-slate-700/50 bg-[#0a0f1a]/90 px-4 py-4">
          <h3 className="m-0 mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-slate-300">
            <GitBranch size={14} className="text-violet-300" aria-hidden />
            Resumen por nivel
          </h3>
          <ul className="m-0 list-none space-y-2 p-0">
            {descendantLevels.length > 0 ? (
              descendantLevels.map((row) => {
                const lvl = Number(row.level)
                const theme = themeForLevel(lvl)
                const count = Number(row.count) || 0
                return (
                  <li
                    key={`lvl-${lvl}`}
                    className="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2"
                  >
                    <span className="inline-flex items-center gap-2 text-sm text-slate-200">
                      <span className={`h-2.5 w-2.5 rounded-full ${theme.dot}`} aria-hidden />
                      Nivel {lvl}
                    </span>
                    <span className="text-sm font-semibold tabular-nums text-slate-100">
                      {count} distribuidor{count === 1 ? '' : 'es'}
                    </span>
                  </li>
                )
              })
            ) : (
              <li className="text-sm text-slate-500">Sin subdistribuidores en niveles inferiores.</li>
            )}
          </ul>
          <p className="m-0 mt-3 border-t border-slate-700/45 pt-3 text-xs text-slate-400">
            Total en tu red:{' '}
            <strong className="font-semibold text-violet-200">{totalInNetwork} distribuidores</strong>
          </p>
        </section>
      </div>
    </div>
  )
}
