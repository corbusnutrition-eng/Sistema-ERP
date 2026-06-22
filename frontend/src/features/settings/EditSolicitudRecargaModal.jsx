/**
 * Alias (`EditSolicitudRecargaModal.jsx`): misma implementación que `NewRechargeModal.jsx`
 * con `editMode={true}` desde el panel BaaS (`DistributorsBaaS.jsx`).
 *
 * La tabla «Asignación de precios de venta — Flujo» vive en `NewRechargeModal.jsx`
 * (dentro de Conceptos); este archivo no duplica JSX para evitar divergencias.
 */
export { default } from './NewRechargeModal'
export {
  newRechargeLineRow,
  normalizeClienteDesdeWebhook,
  saleClientComboLabelRecarga,
  clienteOptionsParaRecarga,
} from './NewRechargeModal'
