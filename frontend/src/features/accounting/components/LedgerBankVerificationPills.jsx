import { Loader2 } from 'lucide-react'
import { LEDGER_VERIFICATION_OPTIONS } from '../ledgerVerificationConstants'

/**
 * Botonera compacta de verificación bancaria (4 estados tipo píldora).
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
      className="flex flex-wrap gap-1 min-w-0"
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
            onClick={() => onSelect?.(lineId, opt.value)}
            className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ring-1 transition-all whitespace-nowrap
              ${isActive ? opt.activeClass : opt.idleClass}
              ${dimmed ? 'opacity-45' : ''}
              disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {saving && isActive ? (
              <Loader2 size={11} className="animate-spin mr-0.5" aria-hidden />
            ) : null}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
