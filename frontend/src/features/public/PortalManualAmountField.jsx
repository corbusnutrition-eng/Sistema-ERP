import { useId } from 'react'

/** Campo de monto bloqueado por IA con desbloqueo manual opcional (portal cliente). */
export default function PortalManualAmountField({
  label,
  hint,
  amount,
  onAmountChange,
  isManuallyEdited,
  onManualEditChange,
  inputClassName = '',
  labelStyle,
  hintStyle,
  fieldId: fieldIdProp,
}) {
  const autoId = useId()
  const fieldId = fieldIdProp || `portal-manual-amt-${autoId.replace(/:/g, '')}`
  const checkboxId = `${fieldId}-manual-edit`
  const editable = Boolean(isManuallyEdited)

  const handleManualToggle = (e) => {
    e.stopPropagation()
    onManualEditChange?.(e.target.checked)
  }

  return (
    <div style={{ marginBottom: 12 }} className="relative z-[2]">
      {label ? (
        <label htmlFor={fieldId} style={labelStyle}>
          {label}
        </label>
      ) : null}
      {hint ? (
        <p style={hintStyle}>
          {hint}
        </p>
      ) : null}
      <input
        id={fieldId}
        type="number"
        readOnly={!editable}
        disabled={false}
        min="0.01"
        step="0.01"
        required={!editable}
        placeholder="—"
        value={amount ?? ''}
        onChange={editable ? (e) => onAmountChange?.(e.target.value) : undefined}
        className={
          inputClassName ||
          'w-full rounded-xl border border-white/18 bg-gray-950/55 px-4 py-3 text-[15px] text-fuchsia-50 box-border'
        }
        style={{
          MozAppearance: 'textfield',
          opacity: editable ? 1 : 0.8,
          cursor: editable ? 'text' : 'not-allowed',
        }}
      />
      <label
        htmlFor={checkboxId}
        className="relative z-[3] mt-2 flex cursor-pointer select-none items-start gap-2.5 text-left text-[12px] leading-snug text-violet-200/90"
        style={{ pointerEvents: 'auto', WebkitTapHighlightColor: 'transparent' }}
      >
        <input
          id={checkboxId}
          type="checkbox"
          checked={Boolean(isManuallyEdited)}
          onChange={handleManualToggle}
          onClick={(e) => e.stopPropagation()}
          disabled={false}
          readOnly={false}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-white/30 bg-gray-950/60 accent-violet-400"
          style={{ pointerEvents: 'auto' }}
        />
        <span className="cursor-pointer pt-px">
          ¿La IA leyó mal tu recibo? Haz clic aquí para corregirlo manualmente
        </span>
      </label>
    </div>
  )
}
