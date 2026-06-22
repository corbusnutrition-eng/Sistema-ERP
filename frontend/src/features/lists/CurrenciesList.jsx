import { Link } from 'react-router-dom'
import { ArrowLeft, Coins } from 'lucide-react'

export default function CurrenciesList() {
  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12 px-4">
      <div className="flex flex-wrap items-center gap-4 justify-between">
        <Link
          to="/listas"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
        >
          <ArrowLeft size={16} />
          Volver a Listas
        </Link>
        <button
          type="button"
          disabled
          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border border-gray-200 bg-white text-gray-400 cursor-not-allowed"
        >
          + Nuevo
        </button>
      </div>

      <div className="flex items-center gap-2">
        <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center ring-1 ring-amber-100">
          <Coins size={20} className="text-amber-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900">Monedas</h1>
      </div>

      <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50/80 px-6 py-16 text-center">
        <p className="text-gray-600 font-medium">Módulo en construcción</p>
        <p className="text-sm text-gray-500 mt-2">
          Aquí administrarás divisas y tipos de cambio para operaciones.
        </p>
      </div>
    </div>
  )
}
