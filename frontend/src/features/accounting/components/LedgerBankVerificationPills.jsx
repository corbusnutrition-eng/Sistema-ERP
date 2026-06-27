import { Loader2 } from 'lucide-react'
import { LEDGER_VERIFICATION_OPTIONS } from '../ledgerVerificationConstants'

/**
 * Botonera vertical de verificación bancaria (4 estados apilados).
 */
export default function LedgerBankVerificationPills({
  lineId,
  currentStatus,
  disabled = false,
  saving = false,
  onSelect,
}) {
  const active = currentStatus ? String(currentStatus).trim() : null

  return (
    <div
      className="flex flex-col gap-1 items-stretch w-full min-w-[7rem] max-w-[8.5rem] mx-auto"
      onClick={(e) => e.stopPropagation()}
      role="group"
      aria-label="Verificación bancaria"
    >
      {LEDGER_VERIFICATION_OPTIONS.map((opt) => {
        const isActive = active === opt.value
        const dimmed = active != null && !isActive
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled || saving || lineId == null}
            title={opt.label}
            onClick={() => {
              if (isActive) return
              onSelect?.(lineId, opt.value)
            }}
            className={`w-full flex items-center justify-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold ring-1 transition-all
              ${isActive ? opt.activeClass : opt.idleClass}
              ${dimmed ? 'opacity-45' : ''}
              disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {saving && isActive ? (
              <Loader2 size={11} className="animate-spin shrink-0" aria-hidden />
            ) : null}
            <span className="truncate">{opt.label}</span>
          </button>
        )
      })}
    </div>
  )
}
