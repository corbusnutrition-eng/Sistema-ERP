/**
 * Taxonomía del plan de cuentas.
 * Mantener sincronizado con backend/app/account_structure.py
 */
export const EFECTIVO_EQUIVALENTES_TIPO = 'Efectivo y equivalentes'

export const ACCOUNT_STRUCTURE = {
  ACTIVOS: [
    {
      tipo: 'Activos Corrientes',
      accountType: 'asset',
      detalles: ['Inventario', 'Fondos sin depositar', 'Anticipo empleados'],
    },
    {
      tipo: EFECTIVO_EQUIVALENTES_TIPO,
      accountType: 'asset',
      detalles: [],
      usesPaymentMethods: true,
    },
  ],
  RESPONSABILIDAD: [
    {
      tipo: 'Cuentas por pagar',
      accountType: 'liability',
      detalles: ['Cuentas por pagar', 'Anticipos de clientes', 'Saldos a favor'],
    },
  ],
  INGRESOS: [
    {
      tipo: 'Ingresos',
      accountType: 'income',
      detalles: [
        'Venta de productos y Servicios',
        'Ingresos recarga de saldo',
        'Otros ingresos principales',
      ],
    },
  ],
  GASTO: [
    {
      tipo: 'Gastos',
      accountType: 'expense',
      detalles: [
        'Deudas incobrables',
        'Gastos administrativos',
        'Gasto nómina',
        'Tasas y comisiones',
        'Publicidad y Promoción',
        'Reparación y mantenimiento',
        'Suministros y materiales',
        'Comida y ocio',
        'Servicios varios',
      ],
    },
    {
      tipo: 'Costos de venta',
      accountType: 'cost_of_sales',
      detalles: ['Descuentos', 'Otros'],
    },
    {
      tipo: 'Otros gastos',
      accountType: 'expense',
      detalles: ['Pérdida de cambio', 'Otros gastos', 'Liquidaciones'],
    },
  ],
}

export const LEGACY_DETAIL_TYPE_ALIASES = {
  'Gasto nomina': 'Gasto nómina',
  'Publicidad y Promocion': 'Publicidad y Promoción',
  'Reparacion y mantenimiento': 'Reparación y mantenimiento',
  'Comida y osio': 'Comida y ocio',
  'Perdida de cambio': 'Pérdida de cambio',
  'otros gastos': 'Otros gastos',
  otros: 'Otros',
  descuentos: 'Descuentos',
  'Ganancia por tipo de cambio': 'Otros ingresos principales',
}

export const TIPO_CUENTA_SEP = ':::'

export function normalizeDetailType(value) {
  if (value == null) return ''
  const s = String(value).trim()
  if (!s) return ''
  return LEGACY_DETAIL_TYPE_ALIASES[s] ?? s
}

export function buildTipoCuentaValue(categoriaMatriz, tipoEtiqueta) {
  return `${categoriaMatriz}${TIPO_CUENTA_SEP}${tipoEtiqueta}`
}

export function parseTipoCuentaValue(value) {
  if (!value || typeof value !== 'string') return { categoriaMatriz: '', tipo: '' }
  const i = value.indexOf(TIPO_CUENTA_SEP)
  if (i === -1) return { categoriaMatriz: '', tipo: '' }
  return {
    categoriaMatriz: value.slice(0, i),
    tipo: value.slice(i + TIPO_CUENTA_SEP.length),
  }
}

export function findGrupoByTipoCuentaValue(composite) {
  const { categoriaMatriz, tipo } = parseTipoCuentaValue(composite)
  const list = ACCOUNT_STRUCTURE[categoriaMatriz]
  if (!Array.isArray(list)) return null
  return list.find((g) => g.tipo === tipo) ?? null
}

export function usesPaymentMethodsForTipoCuenta(composite) {
  const g = findGrupoByTipoCuentaValue(composite)
  return Boolean(g?.usesPaymentMethods)
}

export function isEfectivoYEquivalentesTipoCuenta(composite) {
  const { tipo } = parseTipoCuentaValue(composite)
  return tipo === EFECTIVO_EQUIVALENTES_TIPO
}

/** Detalles estáticos del grupo; vacío si el grupo usa métodos de pago dinámicos. */
export function getDetallesForTipoCuenta(composite) {
  const g = findGrupoByTipoCuentaValue(composite)
  if (g?.usesPaymentMethods) return []
  return Array.isArray(g?.detalles) ? [...g.detalles] : []
}

export function getBackendAccountTypeForTipoCuenta(composite) {
  const g = findGrupoByTipoCuentaValue(composite)
  return g?.accountType ?? 'income'
}

export function getDefaultTipoCuentaValue() {
  const firstCat = Object.keys(ACCOUNT_STRUCTURE)[0]
  const firstGrupo = ACCOUNT_STRUCTURE[firstCat]?.[0]
  if (!firstCat || !firstGrupo?.tipo) return ''
  return buildTipoCuentaValue(firstCat, firstGrupo.tipo)
}

export function getFirstDetalleForTipoCuenta(composite, paymentMethodNames = []) {
  if (usesPaymentMethodsForTipoCuenta(composite)) {
    return paymentMethodNames[0] || ''
  }
  const d = getDetallesForTipoCuenta(composite)
  return d.length ? d[0] : ''
}

export function inferTipoCuentaFromApi(accountType, detailType, linkedPaymentMethod = null) {
  const lp = linkedPaymentMethod != null ? String(linkedPaymentMethod).trim() : ''
  if (accountType === 'asset' && lp) {
    return buildTipoCuentaValue('ACTIVOS', EFECTIVO_EQUIVALENTES_TIPO)
  }

  const dtNorm = normalizeDetailType(detailType)
  let fallback = null
  for (const [categoriaMatriz, grupos] of Object.entries(ACCOUNT_STRUCTURE)) {
    for (const g of grupos) {
      if (g.accountType !== accountType) continue
      if (g.usesPaymentMethods) continue
      if (fallback === null) {
        fallback = buildTipoCuentaValue(categoriaMatriz, g.tipo)
      }
      if (dtNorm && Array.isArray(g.detalles)) {
        const match = g.detalles.find((d) => normalizeDetailType(d) === dtNorm || d === detailType)
        if (match) {
          return buildTipoCuentaValue(categoriaMatriz, g.tipo)
        }
      }
    }
  }
  return fallback ?? getDefaultTipoCuentaValue()
}

const LIQUID_DEPOSIT_DETAIL_TYPES = new Set(['Fondos sin depositar'])

export function isLiquidDepositChartAccount(account) {
  if (!account || account.account_type !== 'asset') return false
  const dt = normalizeDetailType(account.detail_type)
  if (LIQUID_DEPOSIT_DETAIL_TYPES.has(dt)) return true
  const lp = String(account.linked_payment_method ?? '').trim()
  return lp.length > 0
}

export function isInventoryChartAccount(account) {
  if (!account || account.account_type !== 'asset') return false
  const dt = normalizeDetailType(account.detail_type)
  return dt === 'Inventario' || String(account.detail_type ?? '').trim().toLowerCase() === 'inventario'
}

export function sortPaymentMethodNames(list) {
  return [...(Array.isArray(list) ? list : [])]
    .filter((m) => m?.is_active !== false)
    .map((m) => String(m?.name || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }))
}
