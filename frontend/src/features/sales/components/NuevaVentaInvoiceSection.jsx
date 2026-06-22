import { Fragment, useState } from 'react'
import { Plus, RefreshCw, Trash2, KeyRound, Warehouse, Eye, EyeOff } from 'lucide-react'
import SearchableSelect from '../../../components/ui/SearchableSelect'
import SaleQBTagsCreatable from './SaleQBTagsCreatable'
import SaleLineProductSelect from './SaleLineProductSelect'
import { SALES_CURRENCIES } from '../salesCurrencies'
import { invoiceLineCredentialKind } from '../invoiceLineCredentials'
import FinancialSummarySidebar from '../../../components/ui/FinancialSummarySidebar'
import PaymentMethodsDepositCheckboxes from './PaymentMethodsDepositCheckboxes'
import { salesApiOrigin } from '../saleTableHelpers'

function CurrencyFlag({ code }) {
  const cur = SALES_CURRENCIES.find((c) => c.code === code)
  return cur ? <span className="mr-1">{cur.flag}</span> : null
}

/** Contraseña IPTV con alternancia mostrar/ocultar (una instancia por línea de factura). */
function IptvPasswordField({ value, onChange, disabled, readOnly, inputCls }) {
  const [showPassword, setShowPassword] = useState(false)
  return (
    <div className="relative">
      <input
        type={showPassword ? 'text' : 'password'}
        autoComplete="new-password"
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        disabled={disabled}
        className={`${inputCls} text-sm py-2 pr-10 w-full`}
        placeholder="••••••••"
      />
      <button
        type="button"
        onClick={() => setShowPassword((v) => !v)}
        aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
        aria-pressed={showPassword}
        disabled={disabled}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 z-[1] flex items-center px-3 text-gray-500 hover:text-gray-700 disabled:opacity-40 disabled:pointer-events-none transition-colors rounded-r-md"
      >
        {showPassword ? <EyeOff size={18} aria-hidden strokeWidth={2} /> : <Eye size={18} aria-hidden strokeWidth={2} />}
      </button>
    </div>
  )
}

/**
 * Layout tipo QuickBooks: cabecera (fecha + etiquetas creatables), tabla de líneas, sidebar de totales/depósito.
 */
export default function NuevaVentaInvoiceSection(props) {
  const {
    saleDateLabel,
    formTagIds,
    onTagIdsChange,
    onOpenTagsAdmin,
    submitting,
    lineItems,
    invoiceProductOptions,
    invoiceProductOptionsLoading,
    saleTagsReloadKey,
    bumpSaleTagsReload,
    inputCls,
    handleInvoiceLineProduct,
    updateSaleLine,
    addSaleLine,
    removeSaleLine,
    openInvoiceRecharge,
    isDraftScreenSale,
    draftRecharge,
    form,
    handleChange,
    transactionClassSelectOptions,
    onOpenNewClassForLine,
    cobroCurrencyOptions,
    linesSubtotal,
    saleCurrencyCode,
    balanceDueReceivable,
    showDepositPaymentFields,
    salePaymentMethodOptions,
    depositAccountOptionsByMethodId,
    selectedPaymentMethodIds,
    togglePaymentMethodId,
    selectedDepositAccountIds,
    toggleDepositAccountId,
    depositCurrencyMismatch,
    depositAccountCurrencyCode,
    fifoCpCredPeekByPk = {},
    linkedPayments = [],
    onOpenLinkedPayment,
    pendingReviewPayments = [],
    onOpenPendingReviewPayment,
    saleIsViewOnly = false,
  } = props

  const apiOrigin = salesApiOrigin()

  const depositLocked = saleIsViewOnly

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-6 items-start border border-gray-100 rounded-2xl p-4 bg-slate-50/40 -mx-1">
      <div className="space-y-4 min-w-0">
        <div className="flex flex-col sm:flex-row sm:items-end gap-4 justify-between">
          <div>
            <span className="block text-xs font-medium text-gray-500 mb-0.5">Fecha de venta</span>
            <p className="text-sm font-semibold text-gray-900 tabular-nums">{saleDateLabel}</p>
          </div>
          <div className="flex-1 min-w-0 max-w-xl">
            <div className="flex justify-between items-center gap-2 mb-1">
              <label className="text-sm font-medium text-gray-700">Etiquetas</label>
              <button
                type="button"
                className="text-xs font-medium text-blue-600 hover:text-blue-800 bg-transparent border-0 cursor-pointer p-0"
                onClick={onOpenTagsAdmin}
              >
                Administrar etiquetas
              </button>
            </div>
            <SaleQBTagsCreatable
              key={saleTagsReloadKey}
              value={formTagIds}
              onChange={onTagIdsChange}
              disabled={submitting}
              onCatalogRefresh={bumpSaleTagsReload}
            />
          </div>
        </div>
        {invoiceProductOptionsLoading && (
          <p className="text-[11px] text-amber-800 bg-amber-50/80 border border-amber-100 rounded-lg px-3 py-2">
            Sincronizando inventario del catálogo para las líneas…
          </p>
        )}
        {isDraftScreenSale && draftRecharge && (
          <p className="mt-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
            La recarga irá al inventario <strong>solo</strong> al pulsar <strong>Registrar Venta</strong>. Si cierras el
            modal sin vender, no se creará stock.
          </p>
        )}
        {lineItems.length > 1 && (
          <p className="text-[11px] text-slate-600 bg-white border border-slate-200 rounded-lg px-3 py-2 leading-snug">
            Varias líneas del <strong>mismo inventario</strong> (mismo crédito catálogo, mismo pooled o mismo paquete
            FIFO) se consolidan en una venta; el total debe cuadrar con la suma de importes. Una pantalla explícita (
            <strong>ss:</strong>) solo admite una línea por venta.
          </p>
        )}
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-600">
                  <th className="px-3 py-2.5 font-semibold min-w-[220px]">Producto/Servicio</th>
                  <th className="px-3 py-2.5 font-semibold min-w-[140px]">Descripción</th>
                  <th className="px-2 py-2.5 font-semibold w-24">Cantidad</th>
                  <th className="px-2 py-2.5 font-semibold min-w-[10rem] w-36">Tarifa</th>
                  <th className="px-2 py-2.5 font-semibold min-w-[132px]">CLASE</th>
                  <th className="px-2 py-2.5 font-semibold w-28 text-right">Importe</th>
                  <th className="w-12 px-2 py-2.5" aria-label="Acción" />
                </tr>
              </thead>
              <tbody>
                {(Array.isArray(lineItems) ? lineItems : [])
                  .filter((line) => line && typeof line === 'object')
                  .map((line) => {
                  const qp = parseFloat(String(line.qty ?? '').replace(',', '.'))
                  const rp = parseFloat(String(line.rate ?? '').replace(',', '.'))
                  const imp =
                    Number.isFinite(qp) && Number.isFinite(rp) ? Math.round(qp * rp * 100) / 100 : 0
                  const classVal =
                    line.transaction_class_id != null && line.transaction_class_id !== ''
                      ? String(line.transaction_class_id)
                      : line.clase_id != null && line.clase_id !== ''
                        ? String(line.clase_id)
                        : ''
                  const invPk = String(line.productKey ?? '').trim()
                  const credKind = invoiceLineCredentialKind(line.productKey)
                  const fifoScreenCreditPkg = invPk.startsWith('cp|')
                  const warehouseAutoCredLine = credKind === 'screen_stock' && !fifoScreenCreditPkg
                  const credPeek = fifoCpCredPeekByPk[invPk]
                  const credPanelExpanded =
                    line.cred_panel_expandido === undefined || line.cred_panel_expandido === true
                  const showCredencialesPanel =
                    credKind === 'normal_credit' && line.asignar_credenciales && credPanelExpanded
                  const fifoPeekUser = String(line.iptv_usuario ?? '').trim()
                  const fifoPeekPass = String(line.iptv_password ?? '').trim()
                  const peekU = String(credPeek?.username ?? '').trim()
                  const peekP = String(credPeek?.password ?? '').trim()
                  const fifoDispUser = peekU || fifoPeekUser
                  const fifoDispPass = peekP || fifoPeekPass
                  const fifoCredLockedCls =
                    `${inputCls} text-sm py-2 bg-gray-100 cursor-not-allowed text-gray-600`
                  return (
                    <Fragment key={line.id}>
                      <tr className="border-t border-gray-100 align-top">
                        <td className="px-2 py-2">
                          <SaleLineProductSelect
                            value={line.productKey}
                            onChange={(v) => handleInvoiceLineProduct(line.id, v)}
                            options={invoiceProductOptions}
                            disabled={submitting}
                            placeholder="Seleccionar…"
                            onAddRecharge={openInvoiceRecharge}
                            clearLabel="Sin producto"
                          />
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="text"
                            value={line.description}
                            onChange={(e) => updateSaleLine(line.id, { description: e.target.value })}
                            className={`${inputCls} text-sm py-2`}
                            placeholder="Detalle"
                          />
                          {fifoScreenCreditPkg ? null : warehouseAutoCredLine ? (
                            <p
                              className="mt-1.5 inline-flex items-center gap-1.5 text-[10px] font-medium text-slate-600 bg-slate-100 border border-slate-200 rounded-md px-2 py-1.5 max-w-[min(100%,22rem)] leading-snug"
                              title="Las credenciales vienen de la unidad física en bodega (FIFO); no se editan aquí."
                            >
                              <Warehouse size={12} className="shrink-0 text-slate-500" aria-hidden />
                              Credenciales asignadas automáticamente desde la bodega
                            </p>
                          ) : credKind === 'normal_credit' ? (
                            <button
                              type="button"
                              disabled={submitting}
                              onClick={() => {
                                if (line.asignar_credenciales) {
                                  const expanded =
                                    line.cred_panel_expandido === undefined ||
                                    line.cred_panel_expandido === true
                                  updateSaleLine(line.id, { cred_panel_expandido: !expanded })
                                } else {
                                  updateSaleLine(line.id, {
                                    asignar_credenciales: true,
                                    cred_panel_expandido: true,
                                  })
                                }
                              }}
                              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 hover:text-blue-900 bg-transparent border-0 cursor-pointer p-0 transition-colors"
                            >
                              <KeyRound size={12} className="opacity-80 shrink-0" aria-hidden />
                              {!line.asignar_credenciales
                                ? '+ Asignar credenciales IPTV'
                                : credPanelExpanded
                                  ? 'Ocultar credenciales IPTV'
                                  : 'Mostrar credenciales IPTV'}
                            </button>
                          ) : null}
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={line.qty}
                            onChange={(e) => updateSaleLine(line.id, { qty: e.target.value })}
                            className={`${inputCls} text-sm py-2`}
                          />
                        </td>
                        <td className="px-2 py-2 min-w-[10rem] w-36 align-top">
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.rate}
                            onChange={(e) => updateSaleLine(line.id, { rate: e.target.value })}
                            className={`${inputCls} text-sm py-2 min-w-[9rem] w-full max-w-[12rem]`}
                          />
                        </td>
                        <td className="px-2 py-2 align-top">
                          <SearchableSelect
                            value={classVal}
                            onChange={(v) => {
                              const s =
                                v != null && String(v).trim() !== '' ? String(v) : ''
                              updateSaleLine(line.id, {
                                transaction_class_id: s,
                                clase_id: s,
                              })
                            }}
                            options={transactionClassSelectOptions}
                            placeholder="Sin clase"
                            clearLabel="Sin clase"
                            onAddNew={() => onOpenNewClassForLine?.(line.id)}
                            disabled={submitting}
                            className="[&_button]:min-h-9 [&_button]:text-xs [&_button]:py-1.5"
                            dropdownZClass="z-[6000]"
                          />
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-gray-900 font-medium align-top pt-3">
                          {imp.toLocaleString('es-ES', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </td>
                        <td className="px-1 py-2 text-center align-top">
                          <button
                            type="button"
                            onClick={() => removeSaleLine(line.id)}
                            className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"
                            aria-label="Eliminar línea"
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                      {fifoScreenCreditPkg && (
                      <tr className="border-0">
                        <td colSpan={7} className="px-2 pt-0 pb-1 bg-white border-t border-gray-50">
                          <div className="rounded-lg px-2 py-2 mb-1 border border-dashed border-slate-200/80 bg-slate-50/90">
                            <p className="mb-2 inline-flex items-center gap-1.5 text-[10px] font-medium text-slate-600">
                              <Warehouse size={12} className="shrink-0 text-slate-500" aria-hidden />
                              Vista previa FIFO (siguiente unidad libre en bodega); no editable — la venta confirmará esta fila.
                            </p>
                            {credPeek?.error && !fifoDispUser && !fifoDispPass ? (
                              <p className="text-[11px] text-red-700 font-medium leading-snug">
                                {String(credPeek.error)}
                              </p>
                            ) : credPeek?.loading &&
                              !fifoDispUser &&
                              !fifoDispPass &&
                              !credPeek?.error ? (
                              <p className="text-[11px] text-slate-600">
                                Cargando credenciales de bodega (vista previa)…
                              </p>
                            ) : (
                              <div className="flex flex-wrap gap-3">
                                <div className="flex-1 min-w-[140px]">
                                  <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
                                    Usuario IPTV
                                  </label>
                                  <input
                                    type="text"
                                    readOnly
                                    aria-readonly="true"
                                    autoComplete="off"
                                    value={fifoDispUser}
                                    disabled={submitting}
                                    className={fifoCredLockedCls}
                                  />
                                </div>
                                <div className="flex-1 min-w-[140px]">
                                  <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
                                    Contraseña IPTV
                                  </label>
                                  <IptvPasswordField
                                    value={fifoDispPass}
                                    readOnly
                                    onChange={() => {}}
                                    disabled={submitting}
                                    inputCls={fifoCredLockedCls}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                      )}
                      {credKind === 'normal_credit' && (
                      <tr className="border-0">
                        <td colSpan={7} className="px-2 pt-0 pb-1 bg-white border-t border-gray-50">
                          <div
                            className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
                              showCredencialesPanel ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                            }`}
                          >
                            <div className="overflow-hidden min-h-0">
                              <div className="flex flex-wrap gap-3 px-2 py-2 mb-1 rounded-lg bg-slate-50/90 border border-dashed border-slate-200/80">
                                <div className="flex-1 min-w-[140px]">
                                  <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
                                    Usuario IPTV
                                  </label>
                                  <input
                                    type="text"
                                    autoComplete="off"
                                    value={line.iptv_usuario}
                                    onChange={(e) =>
                                      updateSaleLine(line.id, { iptv_usuario: e.target.value })
                                    }
                                    disabled={submitting || !showCredencialesPanel}
                                    className={`${inputCls} text-sm py-2`}
                                    placeholder="usuario"
                                  />
                                </div>
                                <div className="flex-1 min-w-[140px]">
                                  <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
                                    Contraseña IPTV
                                  </label>
                                  <IptvPasswordField
                                    value={line.iptv_password}
                                    disabled={submitting || !showCredencialesPanel}
                                    inputCls={inputCls}
                                    onChange={(e) =>
                                      updateSaleLine(line.id, { iptv_password: e.target.value })
                                    }
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 border-t border-gray-100 bg-slate-50/60">
            <button
              type="button"
              onClick={addSaleLine}
              className="inline-flex items-center gap-2 text-sm font-semibold text-blue-700 hover:text-blue-900"
            >
              <Plus size={18} />
              Agregar producto o servicio
            </button>
          </div>
        </div>
      </div>
      <aside className="space-y-4 xl:sticky xl:top-2 rounded-xl border border-gray-200 bg-white p-4 shadow-sm self-start w-full max-w-full">
        <FinancialSummarySidebar
          subtotal={linesSubtotal}
          currency={saleCurrencyCode}
          linkedPayments={linkedPayments}
          pendingReviewPayments={pendingReviewPayments}
          balanceDue={balanceDueReceivable}
          apiOrigin={apiOrigin}
          onOpenLinkedPayment={onOpenLinkedPayment}
          onOpenPendingReviewPayment={onOpenPendingReviewPayment}
        />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            Importe del depósito ({saleCurrencyCode})
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs font-medium">
              <CurrencyFlag code={form.currency} />
            </span>
            <input
              type="number"
              name="amount_paid"
              value={form.amount_paid}
              onChange={handleChange}
              min="0"
              step="0.01"
              readOnly={depositLocked}
              disabled={depositLocked}
              placeholder={form.local_amount ? String(form.local_amount) : '0.00'}
              className={`${inputCls} pl-8 ${depositLocked ? 'bg-gray-50 text-gray-700 cursor-not-allowed' : ''}`}
            />
          </div>
        </div>
        {showDepositPaymentFields && (
          <PaymentMethodsDepositCheckboxes
            disabled={submitting}
            salePaymentMethodOptions={salePaymentMethodOptions}
            depositAccountOptionsByMethodId={depositAccountOptionsByMethodId}
            selectedPaymentMethodIds={selectedPaymentMethodIds}
            togglePaymentMethodId={togglePaymentMethodId}
            selectedDepositAccountIds={selectedDepositAccountIds}
            toggleDepositAccountId={toggleDepositAccountId}
            depositCurrencyMismatch={depositCurrencyMismatch}
            depositAccountCurrencyCode={depositAccountCurrencyCode}
            saleCurrencyCode={saleCurrencyCode}
          />
        )}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Moneda de cobro</label>
          <SearchableSelect
            value={form.currency}
            onChange={(v) => handleChange({ target: { name: 'currency', value: String(v) } })}
            options={cobroCurrencyOptions}
            hideClear
            disabled={submitting}
          />
          <p className="mt-1 text-[11px] text-gray-500">
            Se actualiza al marcar una cuenta de depósito según su moneda en el plan de cuentas; la tasa se
            completa con el último tipo de cambio usado.
          </p>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            <span className="inline-flex items-center gap-1">
              <RefreshCw size={11} className="text-gray-400" />
              Tipo de cambio (a USD) — 1 USD = X {form.currency}
            </span>
          </label>
          <input
            type="number"
            name="exchange_rate"
            value={form.exchange_rate}
            onChange={handleChange}
            required
            min="0.0001"
            step="any"
            placeholder="1.00"
            disabled={form.currency === 'USD'}
            className={`${inputCls} ${form.currency === 'USD' ? 'bg-gray-50 text-gray-400 cursor-not-allowed' : ''}`}
          />
        </div>
      </aside>
    </div>
  )
}
