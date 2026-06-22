import { useNavigate, useParams } from 'react-router-dom'
import { BarChart3 } from 'lucide-react'
import { REPORT_SECTIONS } from './reportCatalog'
import ProfitAndLossReport from './ProfitAndLossReport'
import AccountsReceivableReport from './AccountsReceivableReport'

export default function ReportStandardPlaceholder() {
  const navigate = useNavigate()
  const { sectionId, reportId } = useParams()

  const section = REPORT_SECTIONS.find((s) => s.id === sectionId)
  const report = section?.reports.find((r) => r.id === reportId)
  const title = report?.title ?? 'Informe'

  const isPnl = reportId === 'pnl' || reportId === 'pnl-corp'
  const isArSummary = reportId === 'ar-aging'

  if (isPnl) {
    return <ProfitAndLossReport />
  }

  if (isArSummary) {
    return <AccountsReceivableReport />
  }

  return (
    <div className="max-w-4xl mx-auto pb-12 px-4">
      <button
        type="button"
        onClick={() => navigate('/informes')}
        className="text-green-700 hover:text-green-800 font-medium flex items-center gap-1 cursor-pointer mb-6 bg-transparent border-0 p-0 text-left text-sm"
      >
        {'< Volver a los informes estándar'}
      </button>

      <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
        <BarChart3 size={14} className="text-blue-500" />
        <span>QuickBooks · Informe</span>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 tracking-tight">{title}</h1>

      <div className="mt-10 rounded-2xl border border-dashed border-gray-200 bg-gray-50/80 px-6 py-14 text-center">
        <p className="text-gray-600 font-medium">Módulo en construcción</p>
        <p className="text-sm text-gray-500 mt-2">
          Este informe se generará aquí cuando esté disponible.
        </p>
      </div>
    </div>
  )
}
