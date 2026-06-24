import { AlertTriangle, Monitor, TrendingUp, Wallet } from 'lucide-react'

function formatMoney(amount, currency) {
  const n = typeof amount === 'number' ? amount : parseFloat(String(amount ?? 0).replace(',', '.'))
  if (Number.isNaN(n)) return '—'
  const cur =
    String(currency ?? 'USD')
      .trim()
      .toUpperCase()
      .slice(0, 10) || 'USD'
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${cur} ${n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }
}

function DashboardCard({ title, value, sub, icon: Icon, iconClassName, valueClassName }) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-950/55 px-3 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="m-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{title}</p>
        {Icon ? (
          <Icon size={15} strokeWidth={2.25} className={`shrink-0 opacity-80 ${iconClassName ?? 'text-slate-400'}`} aria-hidden />
        ) : null}
      </div>
      <p className={`mt-1.5 mb-0 text-lg font-extrabold tabular-nums leading-tight ${valueClassName ?? 'text-slate-50'}`}>
        {value}
      </p>
      {sub ? <p className="mt-1 mb-0 text-[10px] tabular-nums text-slate-500">{sub}</p> : null}
    </div>
  )
}

/**
 * Mini-dashboard 2×2 del portal del distribuidor (debajo del saludo).
 */
export default function MiniDashboard({ metrics }) {
  if (!metrics) return null

  const ganancias = metrics.ganancias_totales ?? {}
  const profitCur = String(ganancias.currency ?? metrics.saldo_baas_currency ?? 'USD')
  const profitMonthly = Number(ganancias.mensual ?? 0)
  const profitDaily = Number(ganancias.diario ?? 0)
  const profitWeekly = Number(ganancias.semanal ?? 0)
  const saldoCur = String(metrics.saldo_baas_currency ?? profitCur)
  const saldo = Number(metrics.saldo_baas ?? 0)
  const activas = Number(metrics.pantallas_activas ?? 0)
  const vencen = Number(metrics.vencimientos_semana ?? 0)

  const profitSub = `D: ${formatMoney(profitDaily, profitCur)} | S: ${formatMoney(profitWeekly, profitCur)}`

  return (
    <div className="mb-4 grid grid-cols-2 gap-3">
      <DashboardCard
        title="Ganancias"
        value={formatMoney(profitMonthly, profitCur)}
        sub={profitSub}
        icon={TrendingUp}
        iconClassName="text-emerald-400"
        valueClassName="text-emerald-50"
      />
      <DashboardCard
        title="Saldo BaaS"
        value={formatMoney(saldo, saldoCur)}
        icon={Wallet}
        iconClassName="text-sky-400"
        valueClassName="text-sky-50"
      />
      <DashboardCard
        title="Pantallas Activas"
        value={Number.isFinite(activas) ? activas.toLocaleString('es-CO') : '0'}
        icon={Monitor}
        iconClassName="text-violet-400"
        valueClassName="text-violet-50"
      />
      <DashboardCard
        title="Vencen esta sem."
        value={Number.isFinite(vencen) ? vencen.toLocaleString('es-CO') : '0'}
        icon={AlertTriangle}
        iconClassName="text-amber-400"
        valueClassName="text-amber-300"
      />
    </div>
  )
}
