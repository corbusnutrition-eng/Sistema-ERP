/** Catálogo de informes (compartido entre dashboard y vistas detalle). */
export const REPORT_SECTIONS = [
  {
    id: 'favorites',
    title: 'Favoritos',
    defaultExpanded: true,
    reports: [
      { id: 'ar-aging', title: 'Saldos por cliente (CxC)', defaultFavorite: true },
      { id: 'balance-sheet', title: 'Balance general', defaultFavorite: true },
      { id: 'pnl', title: 'Pérdidas y ganancias', defaultFavorite: true },
    ],
  },
  {
    id: 'company-overview',
    title: 'Información general de la empresa',
    defaultExpanded: true,
    reports: [
      { id: 'audit-log', title: 'Registro de auditorías', defaultFavorite: false },
      { id: 'balance-sheet-corp', title: 'Balance general', defaultFavorite: true },
      { id: 'balance-detail', title: 'Detalles del balance', defaultFavorite: false },
      { id: 'cash-flow', title: 'Estado de flujo de efectivo', defaultFavorite: false },
      { id: 'company-snapshot', title: 'Panorama de la empresa', defaultFavorite: false },
      { id: 'pnl-corp', title: 'Pérdidas y ganancias', defaultFavorite: true },
      { id: 'pnl-monthly', title: 'Pérdidas y ganancias por mes', defaultFavorite: false },
      { id: 'pnl-compare', title: 'Comparación de pérdidas y ganancias', defaultFavorite: false },
    ],
  },
  {
    id: 'sales-customers',
    title: 'Ventas y clientes',
    defaultExpanded: false,
    reports: [
      { id: 'list-classification', title: 'Reporte por Clasificación (Listas)', defaultFavorite: false },
      { id: 'sales-by-customer', title: 'Ventas por cliente', defaultFavorite: false },
      { id: 'sales-by-product', title: 'Resumen de ventas por producto/servicio', defaultFavorite: false },
    ],
  },
]
