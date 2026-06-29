import Swal from 'sweetalert2'

/**
 * Doble confirmación para anular facturas o pagos.
 * @param {{ entityLabel?: string, includeInventoryNote?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function confirmVoidTransaction({
  entityLabel = 'transacción',
  includeInventoryNote = true,
} = {}) {
  const inventoryNote = includeInventoryNote
    ? ' Se revertirán los asientos contables y se devolverán los créditos al inventario.'
    : ' Se revertirán los asientos contables y se actualizarán los saldos correspondientes.'

  const first = await Swal.fire({
    title: '¿Anular esta transacción?',
    html: `<p class="text-sm text-slate-700 text-left">¿Estás seguro que deseas anular esta ${entityLabel}?${inventoryNote}</p>`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc2626',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Sí, anular',
    cancelButtonText: 'Cancelar',
  })
  if (!first.isConfirmed) return false

  const second = await Swal.fire({
    title: 'Confirmación de seguridad',
    html:
      '<p class="text-sm text-slate-700 text-left mb-2">Para evitar anulaciones accidentales, escribe <strong>ANULAR</strong> en el campo:</p>',
    input: 'text',
    inputPlaceholder: 'ANULAR',
    inputAttributes: { autocapitalize: 'characters', autocorrect: 'off' },
    icon: 'error',
    showCancelButton: true,
    confirmButtonColor: '#b91c1c',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Confirmar anulación',
    cancelButtonText: 'Cancelar',
    preConfirm: (value) => {
      if (String(value || '').trim().toUpperCase() !== 'ANULAR') {
        Swal.showValidationMessage('Debes escribir ANULAR exactamente.')
        return false
      }
      return true
    },
  })

  return Boolean(second.isConfirmed)
}
