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
}) {
  const editable = Boolean(isManuallyEdited)

  return (
    <div style={{ marginBottom: 12 }}>
      {label ? (
        <label style={labelStyle}>
          {label}
        </label>
      ) : null}
      {hint ? (
        <p style={hintStyle}>
          {hint}
        </p>
      ) : null}
      <input
        type="number"
        readOnly={!editable}
        min="0.01"
        step="0.01"
        required
        placeholder="—"
        value={amount ?? ''}
        onChange={
          editable && onAmountChange
            ? (e) => onAmountChange(e.target.value)
            : undefined
        }
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
        className="mt-2 flex cursor-pointer items-start gap-2 text-left text-[12px] leading-snug text-violet-200/90"
      >
        <input
          type="checkbox"
          checked={Boolean(isManuallyEdited)}
          onChange={(e) => onManualEditChange?.(e.target.checked)}
          className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-white/30 bg-gray-950/60 accent-violet-400"
        />
        <span>¿La IA leyó mal tu recibo? Haz clic aquí para corregirlo manualmente</span>
      </label>
    </div>
  )
}
