import { CheckCircle2 } from 'lucide-react'

export const PORTAL_PAYMENT_SUBMITTED_MSG =
  '¡Comprobante enviado con éxito! Tu pago se encuentra en revisión. Te notificaremos o tu saldo se actualizará automáticamente en cuanto un operador lo apruebe.'

export default function PortalPaymentSubmittedSuccessCard({
  message = PORTAL_PAYMENT_SUBMITTED_MSG,
  className = '',
}) {
  return (
    <div
      role="status"
      className={`rounded-2xl border-2 border-green-400 bg-green-50 px-5 py-6 text-center shadow-sm ${className}`.trim()}
    >
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
        <CheckCircle2 className="h-7 w-7 text-green-600" aria-hidden />
      </div>
      <p className="m-0 text-[15px] font-semibold leading-relaxed text-green-900">{message}</p>
    </div>
  )
}
