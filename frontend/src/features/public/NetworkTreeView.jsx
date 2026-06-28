import { Users } from 'lucide-react'

function formatTreeBalance(amount, currency = 'USD') {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  const cur = String(currency || 'USD').trim().slice(0, 10) || 'USD'
  try {
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${n.toFixed(2)} ${cur}`
  }
}

const LEVEL_STYLES = {
  1: 'border-violet-400/55 bg-violet-500/20 text-violet-100',
  2: 'border-indigo-400/50 bg-indigo-500/18 text-indigo-100',
  3: 'border-cyan-400/45 bg-cyan-500/15 text-cyan-100',
}

function levelBadgeClass(nivel) {
  const key = Number(nivel)
  if (LEVEL_STYLES[key]) return LEVEL_STYLES[key]
  return 'border-slate-400/40 bg-slate-700/40 text-slate-200'
}

function NetworkTreeNodeRow({ node, isRoot = false }) {
  const label = String(node?.name ?? '—').trim() || '—'
  const user = String(node?.username ?? '—').trim() || '—'
  const cur = String(node?.currency ?? 'USD').trim().toUpperCase().slice(0, 10)
  const bal = Number(node?.wallet_balance) || 0
  const nivel = Number(node?.nivel) || 1

  return (
    <div
      className={`portal-network-tree-row flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2.5 md:px-4 md:py-3 ${
        isRoot
          ? 'border-violet-400/45 bg-violet-950/35 shadow-[inset_0_1px_0_rgba(167,139,250,0.12)]'
          : 'border-slate-600/45 bg-slate-950/50'
      }`}
    >
      <span
        className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${levelBadgeClass(nivel)}`}
        title={`Nivel ${nivel} en la red`}
      >
        N{nivel}
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate text-sm font-semibold text-slate-50" title={label}>
          {label}
          {isRoot ? (
            <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-violet-300/90">
              (Tú)
            </span>
          ) : null}
        </p>
        <p className="m-0 truncate font-mono text-[11px] text-cyan-100/80" title={user}>
          @{user}
        </p>
      </div>
      <span className="inline-flex shrink-0 rounded-md border border-green-700/60 bg-green-900/30 px-2.5 py-1 text-xs font-bold tabular-nums text-green-400">
        {formatTreeBalance(bal, cur)}
      </span>
    </div>
  )
}

function NetworkTreeBranch({ node, isRoot = false }) {
  const children = Array.isArray(node?.children) ? node.children : []
  const hasChildren = children.length > 0

  return (
    <li className={`portal-network-tree-item ${isRoot ? 'portal-network-tree-item--root' : ''}`}>
      <NetworkTreeNodeRow node={node} isRoot={isRoot} />
      {hasChildren ? (
        <ul className="portal-network-tree-children m-0 list-none space-y-2 p-0">
          {children.map((child) => (
            <NetworkTreeBranch key={String(child.id)} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function countDescendants(node) {
  const children = Array.isArray(node?.children) ? node.children : []
  return children.reduce((acc, child) => acc + 1 + countDescendants(child), 0)
}

export default function NetworkTreeView({ tree, className = '' }) {
  if (!tree || typeof tree !== 'object') {
    return (
      <p className="m-0 px-3 pb-4 text-sm text-slate-400/85">
        No hay datos de red disponibles. Pulsa «Actualizar lista» para reintentar.
      </p>
    )
  }

  const descendants = countDescendants(tree)
  const directCount = Array.isArray(tree.children) ? tree.children.length : 0

  return (
    <div className={`px-3 pb-4 pt-3 ${className}`.trim()}>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-violet-500/25 bg-violet-950/20 px-3 py-2.5">
        <Users size={16} className="shrink-0 text-violet-300" aria-hidden />
        <p className="m-0 text-xs leading-relaxed text-violet-100/90">
          {directCount > 0 ? (
            <>
              <strong className="font-semibold text-violet-50">{directCount}</strong> subdistribuidor
              {directCount === 1 ? '' : 'es'} directo{directCount === 1 ? '' : 's'}
              {descendants > directCount ? (
                <>
                  {' · '}
                  <strong className="font-semibold text-violet-50">{descendants}</strong> en total en tu red
                </>
              ) : null}
            </>
          ) : (
            <>Aún no tienes subdistribuidores en tu red. Los que crees aparecerán aquí en cascada.</>
          )}
        </p>
      </div>

      <ul className="portal-network-tree-root m-0 list-none p-0">
        <NetworkTreeBranch node={tree} isRoot />
      </ul>

      <style>{`
        .portal-network-tree-children {
          margin-left: 0.65rem;
          padding-left: 0.85rem;
          border-left: 2px solid rgba(129, 140, 248, 0.35);
        }
        @media (min-width: 768px) {
          .portal-network-tree-children {
            margin-left: 1rem;
            padding-left: 1.15rem;
          }
        }
        .portal-network-tree-item:not(.portal-network-tree-item--root) {
          position: relative;
        }
        .portal-network-tree-item:not(.portal-network-tree-item--root)::before {
          content: '';
          position: absolute;
          left: -0.85rem;
          top: 1.35rem;
          width: 0.85rem;
          height: 2px;
          background: rgba(129, 140, 248, 0.35);
        }
        @media (min-width: 768px) {
          .portal-network-tree-item:not(.portal-network-tree-item--root)::before {
            left: -1.15rem;
            width: 1.15rem;
          }
        }
        .portal-network-tree-children > .portal-network-tree-item + .portal-network-tree-item {
          margin-top: 0.5rem;
        }
        .portal-network-tree-root > .portal-network-tree-item > .portal-network-tree-children {
          margin-top: 0.65rem;
        }
      `}</style>
    </div>
  )
}
