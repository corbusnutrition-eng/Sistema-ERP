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
    label: 'No efectiva',
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

export const LEDGER_VERIFICATION_CONFIRMED = 'confirmed'

/** PIN requerido para revertir o cambiar una transacción ya confirmada. */
export const LEDGER_UNCONFIRM_PIN = '301985'

export function verificationStatusLabel(value) {
  if (value == null || value === '') return '—'
  const v = String(value).trim().toLowerCase()
  const opt = LEDGER_VERIFICATION_OPTIONS.find((o) => o.value === v)
  return opt?.label ?? String(value)
}

/** Texto natural en femenino/minúscula para copy de confirmación («marcar como …»). */
const FORMATTED_STATUS_BY_VALUE = Object.freeze({
  confirmed: 'confirmada',
  not_found: 'no efectiva',
  interbank: 'interbancaria',
  wrong_account: 'cuenta incorrecta',
})

const FORMATTED_STATUS_BY_LABEL = Object.freeze({
  confirmado: 'confirmada',
  'no efectiva': 'no efectiva',
  interbancaria: 'interbancaria',
  'cuenta incorrecta': 'cuenta incorrecta',
})

export function getFormattedStatusText(status) {
  if (status == null || status === '') return '—'
  const raw = String(status).trim()
  const byValue = FORMATTED_STATUS_BY_VALUE[raw.toLowerCase()]
  if (byValue) return byValue
  const byLabel = FORMATTED_STATUS_BY_LABEL[raw.toLowerCase()]
  if (byLabel) return byLabel
  return raw.toLowerCase()
}

export const BANK_VERIFICATION_COLUMN = Object.freeze({
  id: 'bank_verification',
  label: 'VERIFICACIÓN BANCARIA',
  defaultWidth: 148,
  minWidth: 128,
  maxWidth: 180,
})

export function lineIsBankDeposit(line) {
  const cargo = line?.charge_amount ?? line?.deposit
  if (cargo == null || cargo === '') return false
  const n = Number(cargo)
  return Number.isFinite(n) && n > 0
}
