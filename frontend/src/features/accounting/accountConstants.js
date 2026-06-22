/**
 * Re-exporta la taxonomía del plan de cuentas.
 */
export {
  ACCOUNT_STRUCTURE,
  EFECTIVO_EQUIVALENTES_TIPO,
  LEGACY_DETAIL_TYPE_ALIASES,
  TIPO_CUENTA_SEP,
  buildTipoCuentaValue,
  findGrupoByTipoCuentaValue,
  getBackendAccountTypeForTipoCuenta,
  getDefaultTipoCuentaValue,
  getDetallesForTipoCuenta,
  getFirstDetalleForTipoCuenta,
  inferTipoCuentaFromApi,
  isEfectivoYEquivalentesTipoCuenta,
  isLiquidDepositChartAccount,
  normalizeDetailType,
  parseTipoCuentaValue,
  sortPaymentMethodNames,
  usesPaymentMethodsForTipoCuenta,
} from './accountStructure'
