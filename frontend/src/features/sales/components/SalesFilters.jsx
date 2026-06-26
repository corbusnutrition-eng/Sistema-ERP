import SearchableSelect from '../../../components/ui/SearchableSelect'

const filterLabelCls =
  'block text-[10px] sm:text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1'
const filterInputCls =
  'h-8 text-sm px-2.5 py-1 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 bg-white shadow-sm w-full'

/** Barra de filtros — siempre montada; no depende del estado de carga de la tabla. */
export default function SalesFilters({
  filterDateFrom,
  filterDateTo,
  filterClientOrUser,
  filterNumber,
  filterPaymentMethod,
  filterCurrency,
  filterTags,
  onFilterDateFromChange,
  onFilterDateToChange,
  onFilterClientOrUserChange,
  onFilterNumberChange,
  onFilterPaymentMethodChange,
  onFilterCurrencyChange,
  onFilterTagsChange,
  onClearFilters,
  paymentMethodOptions,
  currencyOptions,
}) {
  return (
    <div
      className="flex flex-wrap items-end gap-3 mb-4 bg-white rounded-xl px-4 py-3 ring-1 ring-gray-100 shadow-sm min-h-[4.75rem]"
      aria-label="Filtros de ventas"
    >
      <label className="flex flex-col w-36 shrink-0">
        <span className={filterLabelCls}>Desde</span>
        <input
          type="date"
          value={filterDateFrom}
          onChange={(e) => onFilterDateFromChange(e.target.value)}
          className={filterInputCls}
        />
      </label>
      <label className="flex flex-col w-36 shrink-0">
        <span className={filterLabelCls}>Hasta</span>
        <input
          type="date"
          value={filterDateTo}
          onChange={(e) => onFilterDateToChange(e.target.value)}
          className={filterInputCls}
        />
      </label>
      <label className="flex flex-col w-40 max-w-[160px] shrink-0">
        <span className={filterLabelCls}>Cliente o usuario</span>
        <input
          type="search"
          value={filterClientOrUser}
          onChange={(e) => onFilterClientOrUserChange(e.target.value)}
          placeholder="Nombre, email…"
          className={`${filterInputCls} min-w-0`}
        />
      </label>
      <label className="flex flex-col w-24 shrink-0">
        <span className={filterLabelCls}>N.º ref.</span>
        <input
          type="search"
          value={filterNumber}
          onChange={(e) => onFilterNumberChange(e.target.value)}
          placeholder="0034…"
          className={filterInputCls}
        />
      </label>
      <label className="flex flex-col min-w-[136px] max-w-[200px] shrink-0">
        <span className={filterLabelCls}>Método de pago</span>
        <SearchableSelect
          value={filterPaymentMethod}
          onChange={onFilterPaymentMethodChange}
          options={paymentMethodOptions}
          clearLabel="Todos"
          placeholder="Todos"
        />
      </label>
      <label className="flex flex-col w-28 shrink-0">
        <span className={filterLabelCls}>Moneda</span>
        <SearchableSelect
          value={filterCurrency}
          onChange={onFilterCurrencyChange}
          options={currencyOptions}
          clearLabel="Todas"
          placeholder="Todas"
        />
      </label>
      <label className="flex flex-col min-w-[120px] max-w-[200px] shrink-0">
        <span className={filterLabelCls}>Etiquetas</span>
        <input
          type="search"
          value={filterTags}
          onChange={(e) => onFilterTagsChange(e.target.value)}
          placeholder="Buscar etiqueta…"
          className={filterInputCls}
        />
      </label>
      <button
        type="button"
        onClick={onClearFilters}
        className="h-8 px-3 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 border border-gray-200 rounded-md transition-colors shadow-sm flex items-center justify-center shrink-0 ml-auto"
      >
        Limpiar filtros
      </button>
    </div>
  )
}
