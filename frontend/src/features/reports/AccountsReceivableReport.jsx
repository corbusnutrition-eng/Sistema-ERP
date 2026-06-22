import AccountsReceivable from '../accounting/AccountsReceivable'

export default function AccountsReceivableReport() {
  return (
    <AccountsReceivable
      backHref="/informes"
      backLabel="Volver a los informes estándar"
    />
  )
}
