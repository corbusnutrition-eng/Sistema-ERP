/**
 * Casillas «Métodos de pago y cuentas de depósito» compartidas entre Nueva Venta y otros flujos (p. ej. recarga BaaS).
 */
export default function PaymentMethodsDepositCheckboxes({
  disabled = false,
  salePaymentMethodOptions = [],
  depositAccountOptionsByMethodId = {},
  selectedPaymentMethodIds = [],
  togglePaymentMethodId,
  selectedDepositAccountIds = [],
  toggleDepositAccountId,
  depositCurrencyMismatch = false,
  depositAccountCurrencyCode = '',
  saleCurrencyCode = '',
  title = 'Métodos de pago y cuentas de depósito',
  titleHint = '(opcional · portal del cliente)',
  footerNote = 'Solo cuentas efectivo y equivalentes. El cliente solo verá las opciones marcadas en su portal.',
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1.5">
        {title}{' '}
        {titleHint ? (
          <span className="text-[10px] text-gray-500 font-normal">{titleHint}</span>
        ) : null}
      </label>
      <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-gray-100 bg-slate-50/60 divide-y divide-gray-100">
        {salePaymentMethodOptions.length === 0 ? (
          <p className="text-xs text-gray-500 px-3 py-2">No hay métodos de pago activos.</p>
        ) : (
          salePaymentMethodOptions.map((opt) => {
            const checked = selectedPaymentMethodIds.some((x) => Number(x) === Number(opt.value))
            const acctOpts = depositAccountOptionsByMethodId[String(opt.value)] ?? []
            return (
              <div key={opt.value} className="px-3 py-2.5">
                <label className="flex items-center gap-2.5 cursor-pointer hover:bg-white -mx-1 px-1 py-1 rounded">
                  <input
                    type="checkbox"
                    className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 shrink-0"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => togglePaymentMethodId(opt.value)}
                  />
                  <span className="text-sm font-medium text-gray-900">{opt.label}</span>
                </label>
                {checked && (
                  <div className="ml-6 pl-2 border-l-2 border-gray-200 mt-2 flex flex-col gap-2">
                    {acctOpts.length === 0 ? (
                      <p className="text-sm text-gray-500">No hay cuentas vinculadas a este método.</p>
                    ) : (
                      acctOpts.map((aOpt) => {
                        const accChecked = selectedDepositAccountIds.some(
                          (x) => Number(x) === Number(aOpt.value),
                        )
                        return (
                          <label
                            key={aOpt.value}
                            className={`flex items-center gap-2 text-sm text-gray-600 ${
                              aOpt.disabled
                                ? 'opacity-50 cursor-not-allowed'
                                : 'cursor-pointer hover:text-gray-800'
                            }`}
                          >
                            <input
                              type="checkbox"
                              className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 shrink-0"
                              checked={accChecked}
                              disabled={disabled || aOpt.disabled}
                              onChange={() => toggleDepositAccountId(aOpt.value, aOpt.disabled)}
                            />
                            <span>{aOpt.label}</span>
                          </label>
                        )
                      })
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
      {footerNote ? (
        <p className="mt-1 text-[11px] text-gray-500">{footerNote}</p>
      ) : null}
      {depositCurrencyMismatch ? (
        <p className="mt-1 text-xs text-red-600 font-medium leading-snug">
          La moneda de cobro ({saleCurrencyCode}) no coincide con la moneda de alguna cuenta elegida (
          {depositAccountCurrencyCode}).
        </p>
      ) : null}
    </div>
  )
}
