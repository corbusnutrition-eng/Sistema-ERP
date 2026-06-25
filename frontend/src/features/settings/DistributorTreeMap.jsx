import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import Tree from 'react-d3-tree'
import { ArrowLeft, GitBranch, Loader2, ZoomIn, ZoomOut, Move, X } from 'lucide-react'
import api from '../../api/axios'
import { getApiErrorMessage } from '../../lib/apiErrors'
import usePermissions from '../../hooks/usePermissions'
import { PERMS } from '../../lib/permissions'

const TREE_LINK_CLASS = 'baas-tree-link'
const MASTER_PIN = '301985'

function formatBaasMoney(amount, currency = 'USD') {
  const n = Number(amount)
  const cur =
    String(currency || 'USD')
      .trim()
      .toUpperCase()
      .slice(0, 10) || 'USD'
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

function countTreeNodes(node) {
  if (!node) return 0
  let n = 1
  for (const ch of node.children || []) {
    n += countTreeNodes(ch)
  }
  return n
}

function isBlockedStatus(status) {
  return String(status || '').trim().toLowerCase() === 'inactivo'
}

/** Convierte respuesta API → formato react-d3-tree. */
function apiNodeToRd3(node, fallbackNivel = 1) {
  if (!node) return null
  const nivel = Number(node.nivel ?? fallbackNivel)
  const out = {
    name: node.name || node.username || 'Cliente',
    attributes: {
      username: node.username || '—',
      email: node.email || '—',
      walletBalance: Number(node.wallet_balance ?? 0),
      currency: String(node.currency || 'USD').trim().toUpperCase().slice(0, 10) || 'USD',
      clientId: String(node.id ?? ''),
      paymentToken: String(node.payment_token ?? ''),
      status: node.status || 'Activo',
      nivel: Number.isFinite(nivel) && nivel >= 1 ? nivel : fallbackNivel,
    },
  }
  const kids = Array.isArray(node.children) ? node.children : []
  if (kids.length > 0) {
    out.children = kids.map((child) => apiNodeToRd3(child, fallbackNivel + 1)).filter(Boolean)
  }
  return out
}

function nodeFromDatum(nodeDatum) {
  const attrs = nodeDatum?.attributes || {}
  return {
    name: nodeDatum?.name || attrs.username || 'Cliente',
    username: attrs.username || '—',
    email: attrs.email || '—',
    paymentToken: attrs.paymentToken || '',
    status: attrs.status || 'Activo',
    walletBalance: Number(attrs.walletBalance ?? 0),
    currency: String(attrs.currency || 'USD').trim().toUpperCase().slice(0, 10) || 'USD',
  }
}

function BaasTreeNodeCard({ nodeDatum, toggleNode, onOpenAction, canEditTree }) {
  const attrs = nodeDatum?.attributes || {}
  const hasChildren = Array.isArray(nodeDatum?.children) && nodeDatum.children.length > 0
  const isExpanded = !nodeDatum?.__rd3t?.collapsed
  const blocked = isBlockedStatus(attrs.status)
  const nivel = Number(attrs.nivel) >= 1 ? Number(attrs.nivel) : 1

  const handleAction = (action, e) => {
    e.preventDefault()
    e.stopPropagation()
    onOpenAction?.(action, nodeFromDatum(nodeDatum))
  }

  return (
    <g>
      <foreignObject width={300} height={canEditTree ? 168 : 132} x={-150} y={canEditTree ? -84 : -66} requiredExtensions="http://www.w3.org/1999/xhtml">
        <div
          xmlns="http://www.w3.org/1999/xhtml"
          className={`${canEditTree ? 'h-[160px]' : 'h-[124px]'} rounded-xl border px-3 py-2.5 text-left text-slate-100 shadow-lg shadow-black/40 ${
            blocked
              ? 'border-red-500/60 bg-slate-950/95'
              : 'border-slate-600 bg-slate-900/95'
          }`}
        >
          <div className="flex items-start justify-between gap-2 mb-1">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-white truncate leading-tight" title={nodeDatum.name}>
                {nodeDatum.name}
              </p>
              {blocked ? (
                <span className="mt-0.5 inline-flex rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide bg-red-600 text-white">
                  Bloqueado
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="inline-flex rounded-md bg-gray-800 px-1.5 py-0.5 text-[10px] font-medium text-gray-400 tabular-nums">
                Nivel {nivel}
              </span>
              {hasChildren ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleNode()
                  }}
                  className="text-[10px] font-semibold uppercase tracking-wide text-violet-300 hover:text-violet-200"
                >
                  {isExpanded ? 'Ocultar' : 'Expandir'}
                </button>
              ) : null}
            </div>
          </div>
          <p className="text-[11px] text-slate-400 truncate" title={attrs.username}>
            <span className="text-slate-500">IPTV:</span> {attrs.username}
          </p>
          <p className="text-[11px] text-slate-400 truncate mt-0.5" title={attrs.email}>
            <span className="text-slate-500">Email:</span> {attrs.email}
          </p>
          <div className="mt-1.5 inline-flex items-center rounded-md bg-emerald-500/15 px-2 py-0.5 ring-1 ring-emerald-400/40">
            <span className="text-[10px] font-semibold uppercase text-emerald-300/90 mr-1.5">Saldo BaaS</span>
            <span className="text-xs font-bold tabular-nums text-emerald-300">
              {formatBaasMoney(attrs.walletBalance, attrs.currency)}
            </span>
          </div>
          {canEditTree ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={(e) => handleAction('block', e)}
                className="rounded-md border border-red-500/40 bg-red-950/50 px-2 py-0.5 text-[10px] font-semibold text-red-200 hover:bg-red-900/60"
              >
                {blocked ? '🔓 Desbloquear' : '🚫 Bloquear'}
              </button>
              <button
                type="button"
                onClick={(e) => handleAction('balance', e)}
                className="rounded-md border border-amber-500/40 bg-amber-950/40 px-2 py-0.5 text-[10px] font-semibold text-amber-200 hover:bg-amber-900/50"
              >
                💰 Ajustar Saldo
              </button>
            </div>
          ) : null}
        </div>
      </foreignObject>
    </g>
  )
}

function TreeNodeActionModal({ modal, onClose, onSuccess }) {
  const [pin, setPin] = useState('')
  const [operation, setOperation] = useState('add')
  const [amount, setAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const isBlock = modal?.action === 'block'
  const node = modal?.node
  const blocked = isBlockedStatus(node?.status)
  const pinOk = pin === MASTER_PIN
  const amountNum = Number(amount)
  const amountOk = isBlock || (Number.isFinite(amountNum) && amountNum > 0)
  const canSubmit = pinOk && amountOk && !submitting && node?.paymentToken

  useEffect(() => {
    setPin('')
    setOperation('add')
    setAmount('')
    setError('')
    setSubmitting(false)
  }, [modal?.action, modal?.node?.paymentToken])

  if (!modal || !node) return null

  async function handleSubmit(e) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError('')
    try {
      if (isBlock) {
        const { data } = await api.post(
          `/api/v1/admin/clients/${node.paymentToken}/toggle-status`,
          { pin },
        )
        onSuccess(data?.message || `Estado actualizado: ${data?.status || ''}`)
      } else {
        const { data } = await api.post(
          `/api/v1/admin/clients/${node.paymentToken}/adjust-balance`,
          { pin, operation, amount: amountNum },
        )
        onSuccess(data?.message || 'Saldo ajustado correctamente.')
      }
      onClose()
    } catch (err) {
      const d = err?.response?.data?.detail
      setError(typeof d === 'string' ? d : 'No se pudo completar la acción.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/55 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">
            {isBlock ? (blocked ? 'Desbloquear cliente' : 'Bloquear cliente') : 'Ajustar saldo BaaS'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100"
            aria-label="Cerrar"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {isBlock ? (
            <p className="text-sm text-gray-700">
              {blocked
                ? <>¿Confirmar <strong>desbloqueo</strong> de <strong>{node.username}</strong>?</>
                : <>¿Confirmar <strong>bloqueo</strong> de <strong>{node.username}</strong>?</>}
            </p>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                Cliente: <strong>{node.name}</strong> ({node.username}) · Saldo actual{' '}
                <strong>{formatBaasMoney(node.walletBalance, node.currency)}</strong>
              </p>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Operación</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setOperation('add')}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                      operation === 'add'
                        ? 'border-emerald-500 bg-emerald-50 text-emerald-800'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    Añadir
                  </button>
                  <button
                    type="button"
                    onClick={() => setOperation('remove')}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${
                      operation === 'remove'
                        ? 'border-red-500 bg-red-50 text-red-800'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    Quitar
                  </button>
                </div>
              </div>
              <div>
                <label htmlFor="adjust-amount" className="block text-xs font-semibold text-gray-600 mb-1.5">
                  Monto ({node.currency || 'USD'})
                </label>
                <input
                  id="adjust-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/40"
                  placeholder="0.00"
                />
              </div>
            </>
          )}

          <div>
            <label htmlFor="master-pin" className="block text-xs font-semibold text-gray-600 mb-1.5">
              PIN maestro
            </label>
            <input
              id="master-pin"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoComplete="off"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/40"
              placeholder="••••••"
            />
            {pin.length > 0 && !pinOk && (
              <p className="mt-1.5 text-xs text-red-600 font-medium">PIN maestro incorrecto.</p>
            )}
          </div>

          {error && (
            <p className="text-sm text-red-600 font-medium">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? 'Procesando…' : 'Confirmar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export default function DistributorTreeMap() {
  const { uuid } = useParams()
  const { hasPermission } = usePermissions()
  const canEditTree = hasPermission(PERMS.BAAS_TREE_EDIT)
  const containerRef = useRef(null)
  const [treeApi, setTreeApi] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [dimensions, setDimensions] = useState({ width: 960, height: 640 })
  const [actionModal, setActionModal] = useState(null)
  const [toast, setToast] = useState('')
  const [treeKey, setTreeKey] = useState(0)

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(''), 4000)
  }, [])

  const loadTree = useCallback(async () => {
    if (!uuid) {
      setError('UUID de cliente no válido.')
      setTreeApi(null)
      return false
    }
    setLoading(true)
    setError('')
    try {
      const { data } = await api.get(`/api/v1/distributors/${uuid}/tree-data`)
      setTreeApi(data)
      setTreeKey((k) => k + 1)
      return true
    } catch (err) {
      setError(getApiErrorMessage(err, { fallback: 'No se pudo cargar el árbol genealógico.' }))
      setTreeApi(null)
      return false
    } finally {
      setLoading(false)
    }
  }, [uuid])

  useEffect(() => {
    function measure() {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      setDimensions({
        width: Math.max(Math.floor(rect.width), 320),
        height: Math.max(Math.floor(rect.height), 420),
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  useEffect(() => {
    loadTree()
  }, [loadTree])

  const rd3Data = useMemo(() => apiNodeToRd3(treeApi), [treeApi])
  const totalNodes = useMemo(() => countTreeNodes(treeApi), [treeApi])
  const childCount = Math.max(0, totalNodes - 1)

  const handleOpenAction = useCallback((action, node) => {
    setActionModal({ action, node })
  }, [])

  const renderCustomNode = useCallback(
    (rd3tProps) => (
      <BaasTreeNodeCard {...rd3tProps} onOpenAction={handleOpenAction} canEditTree={canEditTree} />
    ),
    [handleOpenAction, canEditTree],
  )

  const translate = useMemo(
    () => ({ x: dimensions.width / 2, y: 72 }),
    [dimensions.width],
  )

  const handleActionSuccess = useCallback(
    async (message) => {
      showToast(message)
      await loadTree()
    },
    [loadTree, showToast],
  )

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] min-h-[520px] px-4 py-4 gap-4">
      {toast && (
        <div className="fixed top-5 right-5 z-[130] flex items-center gap-2 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg">
          <span className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
          {toast}
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3 shrink-0">
        <div>
          <Link
            to="/equipo/distribuidores"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 hover:text-emerald-700 mb-2"
          >
            <ArrowLeft size={16} aria-hidden />
            Volver a Distribuidores BaaS
          </Link>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <GitBranch size={22} className="text-violet-600" aria-hidden />
            Árbol genealógico BaaS
          </h1>
          {treeApi && (
            <p className="text-sm text-gray-500 mt-1">
              <span className="font-semibold text-gray-800">{treeApi.name}</span>
              {' · '}
              {childCount} sub-cliente{childCount !== 1 ? 's' : ''} en la cadena
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
          <span className="inline-flex items-center gap-1">
            <Move size={14} aria-hidden />
            Arrastra para mover
          </span>
          <span className="inline-flex items-center gap-1">
            <ZoomIn size={14} aria-hidden />
            <ZoomOut size={13} aria-hidden />
            Rueda del ratón para zoom
          </span>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 min-h-0 rounded-2xl border border-slate-200 bg-slate-950 overflow-hidden relative baas-tree-shell"
      >
        <style>{`
          .baas-tree-shell .${TREE_LINK_CLASS} {
            stroke: rgb(100 116 139);
            stroke-width: 1.5px;
          }
          .baas-tree-shell .rd3t-node,
          .baas-tree-shell .rd3t-leaf-node {
            fill: transparent;
            stroke: none;
          }
        `}</style>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-slate-300 z-10">
            <Loader2 className="animate-spin" size={22} />
            Cargando árbol…
          </div>
        )}
        {!loading && error && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-red-400 z-10">
            {error}
          </div>
        )}
        {!loading && !error && rd3Data && (
          <Tree
            key={treeKey}
            data={rd3Data}
            orientation="vertical"
            pathFunc="step"
            pathClassFunc={() => TREE_LINK_CLASS}
            translate={translate}
            dimensions={dimensions}
            nodeSize={{ x: 320, y: 190 }}
            separation={{ siblings: 1.15, nonSiblings: 1.35 }}
            zoomable
            scaleExtent={{ min: 0.15, max: 2.5 }}
            zoom={0.85}
            shouldRenderForeignObjects
            renderCustomNodeElement={renderCustomNode}
            enableLegacyTransitions
            transitionDuration={300}
            depthFactor={200}
            rootNodeClassName="baas-tree-root"
            branchNodeClassName="baas-tree-branch"
            leafNodeClassName="baas-tree-leaf"
          />
        )}
      </div>

      {canEditTree && actionModal && (
        <TreeNodeActionModal
          modal={actionModal}
          onClose={() => setActionModal(null)}
          onSuccess={handleActionSuccess}
        />
      )}
    </div>
  )
}
