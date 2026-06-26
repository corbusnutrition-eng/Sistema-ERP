/** Estados de verificación bancaria en libro mayor (Efectivo y equivalentes). */
export const LEDGER_VERIFICATION_OPTIONS = Object.freeze([
  {
    value: 'confirmed',
    label: 'Confirmado',
    activeClass: 'bg-emerald-600 text-white ring-emerald-700 shadow-sm',
    idleClass: 'bg-emerald-50 text-emerald-800 ring-emerald-100 hover:bg-emerald-100',
  },
  {
    value: 'not_found',
    label: 'No existe',
    activeClass: 'bg-rose-600 text-white ring-rose-700 shadow-sm',
    idleClass: 'bg-rose-50 text-rose-800 ring-rose-100 hover:bg-rose-100',
  },
  {
    value: 'interbank',
    label: 'Interbancaria',
    activeClass: 'bg-amber-500 text-white ring-amber-600 shadow-sm',
    idleClass: 'bg-amber-50 text-amber-900 ring-amber-100 hover:bg-amber-100',
  },
  {
    value: 'wrong_account',
    label: 'Cuenta incorrecta',
    activeClass: 'bg-slate-700 text-white ring-slate-800 shadow-sm',
    idleClass: 'bg-slate-100 text-slate-700 ring-slate-200 hover:bg-slate-200',
  },
])

export const BANK_VERIFICATION_COLUMN = Object.freeze({
  id: 'bank_verification',
  label: 'VERIFICACIÓN BANCARIA',
  defaultWidth: 340,
  minWidth: 280,
  maxWidth: 520,
})

export function lineIsBankDeposit(line) {
  const cargo = line?.charge_amount ?? line?.deposit
  if (cargo == null || cargo === '') return false
  const n = Number(cargo)
  return Number.isFinite(n) && n > 0
}
