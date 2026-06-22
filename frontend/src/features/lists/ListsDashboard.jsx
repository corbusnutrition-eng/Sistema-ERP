import { Link, useNavigate } from 'react-router-dom'
import { ChevronLeft, LayoutList } from 'lucide-react'

const LIST_ITEMS = [
  {
    title: 'Plan de cuentas',
    description:
      'Muestra tus cuentas. Las cuentas de balances realizan un seguimiento de tus activos y pasivos...',
    to: '/contabilidad/plan-de-cuentas',
  },
  {
    title: 'Clases',
    description:
      'Muestra las clases que puedes usar para clasificar las transacciones contables.',
    to: '/informes/clases',
  },
  {
    title: 'Métodos de pago',
    description:
      'Muestra los modos en los que clasifica los pagos que recibe de los clientes (Efectivo, Transferencia, Crypto).',
    to: '/listas/metodos-pago',
  },
  {
    title: 'Monedas',
    description:
      'Gestiona las divisas y los tipos de cambio para tus clientes y proveedores.',
    to: '/listas/monedas',
  },
  {
    title: 'Etiquetas',
    description:
      'Muestra la lista de todas las etiquetas creadas. Aquí puedes añadir, editar y eliminar tus etiquetas.',
    to: '/listas/etiquetas',
  },
]

export default function ListsDashboard() {
  const navigate = useNavigate()

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-12 px-4">
      <button
        type="button"
        onClick={() => navigate('/informes')}
        className="text-green-700 hover:text-green-800 font-medium flex items-center gap-1 cursor-pointer mb-6 bg-transparent border-0 p-0 text-sm"
      >
        <ChevronLeft size={18} strokeWidth={2.25} className="shrink-0 -ml-0.5" aria-hidden />
        Volver a Informes
      </button>

      <div>
        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
          <LayoutList size={14} className="text-blue-500" />
          <span>QuickBooks · Listas</span>
        </div>
        <h1 className="text-3xl font-bold text-gray-900 tracking-tight">Listas</h1>
        <p className="text-sm text-gray-500 mt-1">
          Centro de clasificación: cuentas, clases, métodos de pago y más.
        </p>
      </div>

      <ul className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {LIST_ITEMS.map((item) => (
          <li key={item.to} className="rounded-2xl border border-gray-200/90 bg-white p-6 shadow-sm">
            <Link
              to={item.to}
              className="text-lg font-semibold text-blue-600 hover:text-blue-800 underline-offset-2 hover:underline"
            >
              {item.title}
            </Link>
            <p className="mt-2 text-sm text-gray-600 leading-relaxed">{item.description}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
