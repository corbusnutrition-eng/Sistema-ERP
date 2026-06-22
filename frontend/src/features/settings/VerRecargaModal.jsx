import { useMemo } from 'react'
import NewRechargeModal, { newRechargeLineRow, normalizeClienteDesdeWebhook } from './NewRechargeModal'
import { normalizeCurrencyCode } from '../../lib/currencyCode'

const noop = () => {}

/** Líneas de conceptos coherentes con el JSON ERP (`WalletRechargeRequestAdminRow`). */
function rechargeLinesFromAdminDetail(row) {
  if (!row || typeof row !== 'object') return []
  const cur = normalizeCurrencyCode(row.recharge_currency, 'USD')
  const stored = row.recharge_detail_lines
  if (!Array.isArray(stored) || stored.length === 0) {
    const base = newRechargeLineRow()
    base.producto = 'Recarga de saldo BaaS'
    base.tipo_moneda = cur
    base.saldo_recargar = row.amount_requested != null ? String(row.amount_requested) : ''
    return [base]
  }
  return stored.map((li, idx) => {
    const line = newRechargeLineRow()
    const rawId = li?.id ?? li?.line_id ?? li?.concept_id
    line.id =
      rawId != null && String(rawId).trim() !== ''
        ? `wr-li-${String(rawId)}`
        : `wr-ro-${String(row?.id ?? 'x')}-${idx}`
    line.producto = String(li.product_name ?? li.producto ?? 'Saldo BaaS')
    line.tipo_moneda = normalizeCurrencyCode(li.tipo_moneda ?? li.balance_currency ?? cur, cur)
    const imp = li.importe ?? li.saldo_recargar ?? li.line_amount ?? li.balance_to_recharge
    line.saldo_recargar = imp != null ? String(imp) : ''
    return line
  })
}

/**
 * Modal de sólo lectura (auditoría) alineado con «Nueva solicitud de recarga».
 */
export default function VerRecargaModal({ open, detail, onClose }) {
  const lineItems = useMemo(() => rechargeLinesFromAdminDetail(detail), [detail])

  const clientSnapshotForEdit = useMemo(() => {
    if (!detail) return null
    const rawName = detail.client_name != null ? String(detail.client_name).trim() : ''
    return normalizeClienteDesdeWebhook({
      id: detail.client_id,
      name: rawName || 'Cliente',
      full_name: rawName || 'Cliente',
      email: detail.client_email,
      username: detail.client_username,
      iptv_username: detail.client_username,
    })
  }, [detail])

  const rechargeComment = useMemo(() => {
    if (!detail) return ''
    const a = detail.admin_note != null ? String(detail.admin_note).trim() : ''
    const n = detail.notes_preview != null ? String(detail.notes_preview).trim() : ''
    return [a, n].filter(Boolean).join('\n\n')
  }, [detail])

  if (!detail) return null

  const cid = detail.client_id != null ? String(detail.client_id) : ''

  return (
    <NewRechargeModal
      open={open && Boolean(detail)}
      editMode={false}
      isReadOnly
      clientSnapshotForEdit={clientSnapshotForEdit}
      readOnlyAuditRequestId={detail.id}
      summarySubtotalOverride={detail.amount_requested}
      summaryBalancePendingOverride={detail.balance_pending}
      rechargeLineItems={lineItems}
      onRechargeLineItemsChange={noop}
      depositUsd=""
      onDepositUsdChange={noop}
      rechargeComment={rechargeComment}
      onRechargeCommentChange={noop}
      salePaymentMethodOptions={[]}
      depositAccountOptionsByMethodId={{}}
      selectedPaymentMethodIds={[]}
      togglePaymentMethodId={noop}
      selectedDepositAccountIds={[]}
      toggleDepositAccountId={noop}
      depositCurrencyMismatch={false}
      depositAccountCurrencyCode=""
      linkReceiptFile={null}
      onLinkReceiptFileChange={noop}
      generatingLink={false}
      onSubmitGenerateLink={noop}
      linkedPaymentsForReadOnly={Array.isArray(detail.linked_payments) ? detail.linked_payments : []}
      onClose={onClose}
      linkClientId={cid}
      onLinkClientIdChange={noop}
    />
  )
}
