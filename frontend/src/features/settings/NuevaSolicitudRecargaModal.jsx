/**
 * Alias (`NuevaSolicitudRecargaModal.jsx`): misma implementación que `NewRechargeModal.jsx`.
 *
 * Incluye la tabla compacta «Asignación de precios de venta — Flujo» anidada en
 * Conceptos (debajo de «+ Agregar producto o servicio»). Implementación única en
 * `NewRechargeModal.jsx` para que Nueva y Edición permanezcan sincronizadas.
 */
export { default } from './NewRechargeModal'
export {
  newRechargeLineRow,
  normalizeClienteDesdeWebhook,
  saleClientComboLabelRecarga,
  clienteOptionsParaRecarga,
} from './NewRechargeModal'
