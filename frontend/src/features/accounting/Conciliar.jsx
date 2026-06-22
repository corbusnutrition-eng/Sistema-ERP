import { ChevronRight, Scale } from 'lucide-react'
import { useParams } from 'react-router-dom'

export default function Conciliar() {
  const { accountId } = useParams()

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
          <span>Contabilidad</span>
          <ChevronRight size={12} className="text-gray-300" />
          <span className="text-gray-700 font-medium">Conciliar</span>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Conciliación bancaria</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Cuadra extractos con movimientos del sistema
          {accountId != null && accountId !== '' && (
            <span className="block text-xs text-indigo-600 font-medium mt-1">Cuenta seleccionada (ID {accountId})</span>
          )}
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 text-center">
        <div className="w-14 h-14 rounded-2xl bg-indigo-50 flex items-center justify-center mx-auto mb-4">
          <Scale size={28} className="text-indigo-500" />
        </div>
        <p className="text-gray-600 text-sm max-w-md mx-auto">
          Aquí podrás importar extractos, marcar movimientos conciliados y cerrar periodos.{' '}
          <span className="font-medium text-gray-800">Módulo en preparación.</span>
        </p>
      </div>
    </div>
  )
}
