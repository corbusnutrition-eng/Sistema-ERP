import Swal from 'sweetalert2'

const VOID_AUTHORIZATION_PASSWORD = '301985'

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
      '<p class="text-sm text-slate-700 text-left mb-2">Ingresa la contraseña de autorización para confirmar la anulación:</p>',
    input: 'password',
    inputPlaceholder: 'Ingresa la contraseña de autorización',
    inputAttributes: { autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off' },
    icon: 'error',
    showCancelButton: true,
    confirmButtonColor: '#b91c1c',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Confirmar anulación',
    cancelButtonText: 'Cancelar',
    preConfirm: (value) => {
      if (String(value || '') !== VOID_AUTHORIZATION_PASSWORD) {
        Swal.showValidationMessage(
          'Contraseña incorrecta. No tienes autorización para anular esta transacción.',
        )
        return false
      }
      return true
    },
  })

  return Boolean(second.isConfirmed)
}
