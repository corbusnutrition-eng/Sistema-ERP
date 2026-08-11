import Swal from 'sweetalert2'

/**
 * Paso 2 compartido: solicita PIN maestro (validado en backend).
 * @returns {Promise<string|null>} PIN ingresado o null si canceló.
 */
async function promptMasterPinStep({ title = 'PIN maestro requerido' } = {}) {
  const second = await Swal.fire({
    title,
    html:
      '<p class="text-sm text-slate-700 text-left mb-2">Ingresa el PIN maestro para confirmar la anulación:</p>',
    input: 'password',
    inputPlaceholder: 'PIN maestro',
    inputAttributes: { autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off' },
    icon: 'error',
    showCancelButton: true,
    confirmButtonColor: '#b91c1c',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Confirmar anulación',
    cancelButtonText: 'Cancelar',
    preConfirm: (value) => {
      const pin = String(value || '').trim()
      if (!pin) {
        Swal.showValidationMessage('Debes ingresar el PIN maestro.')
        return false
      }
      return pin
    },
  })

  if (!second.isConfirmed) return null
  return String(second.value || '').trim() || null
}

/**
 * Doble confirmación para anular facturas (venta o recarga BaaS) con PIN maestro.
 * @param {{ entityLabel?: string, includeInventoryNote?: boolean }} [options]
 * @returns {Promise<string|null>} PIN maestro o null si canceló.
 */
export async function confirmVoidInvoiceWithMasterPin({
  entityLabel = 'factura',
  includeInventoryNote = true,
} = {}) {
  const inventoryNote = includeInventoryNote
    ? ' Se revertirán los asientos contables y se devolverán los créditos al inventario cuando aplique.'
    : ' Se revertirán los asientos contables y se actualizarán los saldos correspondientes.'

  const first = await Swal.fire({
    title: '¿Anular esta factura?',
    html: `<p class="text-sm text-slate-700 text-left">¿Estás seguro de anular esta ${entityLabel}? Si existen pagos asociados exclusivamente a esta factura, también serán anulados y se revertirá la contabilidad.${inventoryNote}</p>`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc2626',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Sí, continuar',
    cancelButtonText: 'Cancelar',
  })
  if (!first.isConfirmed) return null

  return promptMasterPinStep({ title: 'Confirmación de seguridad' })
}

/**
 * Doble confirmación para anular pagos CxC con PIN maestro.
 * @param {{ entityLabel?: string }} [options]
 * @returns {Promise<string|null>} PIN maestro o null si canceló.
 */
export async function confirmVoidTransaction({ entityLabel = 'transacción' } = {}) {
  const first = await Swal.fire({
    title: '¿Anular esta transacción?',
    html: `<p class="text-sm text-slate-700 text-left">¿Estás seguro que deseas anular este ${entityLabel}? Se revertirán los asientos contables y se actualizarán los saldos correspondientes.</p>`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#dc2626',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Sí, continuar',
    cancelButtonText: 'Cancelar',
  })
  if (!first.isConfirmed) return null

  return promptMasterPinStep({ title: 'Confirmación de seguridad' })
}

/**
 * Solicita PIN maestro para corregir un pago aprobado.
 * @returns {Promise<string|null>} PIN maestro o null si canceló.
 */
export async function confirmPaymentCorrectionWithMasterPin() {
  const first = await Swal.fire({
    title: '¿Aplicar corrección de pago?',
    html: '<p class="text-sm text-slate-700 text-left">Se recalcularán los saldos CxC, la contabilidad y las asignaciones del pago. Esta acción requiere PIN maestro.</p>',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: '#15803d',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Sí, continuar',
    cancelButtonText: 'Cancelar',
  })
  if (!first.isConfirmed) return null

  const second = await Swal.fire({
    title: 'PIN maestro requerido',
    html:
      '<p class="text-sm text-slate-700 text-left mb-2">Ingresa el PIN maestro para confirmar la corrección:</p>',
    input: 'password',
    inputPlaceholder: 'PIN maestro',
    inputAttributes: { autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off' },
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: '#15803d',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'Aplicar corrección',
    cancelButtonText: 'Cancelar',
    preConfirm: (value) => {
      const pin = String(value || '').trim()
      if (!pin) {
        Swal.showValidationMessage('Debes ingresar el PIN maestro.')
        return false
      }
      return pin
    },
  })

  if (!second.isConfirmed) return null
  return String(second.value || '').trim() || null
}
