import { useState } from 'react'
import { useModal } from '../../context/ModalContext'
import { useInventoryData } from '../../context/InventoryDataContext'
import { RegisterModal } from '../../pages/Clientes'
import NuevaVentaModal from '../../features/sales/components/NuevaVentaModal'
import ReceivePaymentModal from '../../features/sales/components/ReceivePaymentModal'
import CuentaMasterModal from '../../features/inventory/components/CuentaMasterModal'
import ExpenseFormModal from '../../features/expenses/ExpenseFormModal'
import TransferModal from '../../features/accounting/components/TransferModal'
import VendorFormModal from '../../features/vendors/VendorFormModal'
import ProductServiceFormModal from '../../features/inventory/components/ProductServiceFormModal'
import VendorBillFormModal from '../../features/vendors/VendorBillFormModal'
import PayBillsFormModal from '../../features/vendors/PayBillsFormModal'
import api from '../../api/axios'

// ── Toast ─────────────────────────────────────────────────────────────────────

function Toast({ message, variant = 'success', onDone }) {
  const isError = variant === 'error'
  return (
    <div
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] flex items-center gap-3
                 text-sm font-medium px-5 py-3 rounded-xl shadow-xl
                 animate-in fade-in slide-in-from-bottom-4 duration-300 ${
                   isError ? 'bg-red-950 text-red-50 ring-2 ring-red-800/60' : 'bg-gray-900 text-white'
                 }`}
    >
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${isError ? 'bg-red-400' : 'bg-green-400'}`}
      />
      {message}
      <button
        onClick={onDone}
        className="ml-2 text-white/60 hover:text-white transition-colors text-xs"
      >
        ✕
      </button>
    </div>
  )
}

// ── GlobalModals ──────────────────────────────────────────────────────────────

/**
 * Renders global quick-create modals (new client, new sale)
 * so the Sidebar "Crear" menu works from any route.
 *
 * After save, optional `afterSave` callbacks refresh the page that opened the modal.
 */
export default function GlobalModals() {
  const {
    newClientOpen, closeNewClient, newClientCb,
    newSaleOpen, closeNewSale, newSaleCb, newSalePrefillRef,
    rechargeOpen, rechargeParams, closeRechargeModal,
    rechargeOnSaveDraftRef, rechargeIsDraftFlow,
    receivePaymentOpen, closeReceivePayment, receivePaymentCb, receivePaymentPrefill,
    expenseOpen, closeNewExpense, expenseCb,
    transferOpen,
    transferModalState,
    closeTransferModal,
    transferCb,
    vendorFormOpen, closeVendorForm, vendorFormCb, vendorFormEditVendor,
    vendorBillOpen, closeVendorBillModal, vendorBillPrefillVendorIdRef,
    payBillsOpen, closePayBillsModal, payBillsPrefillVendorIdRef,
    productServiceOpen,
    productServiceMountKey,
    productServiceEditProduct,
    closeProductServiceModal,
  } = useModal()
  const { refreshInventoryData } = useInventoryData()

  const [toast, setToast] = useState(null)

  function showToast(message, variant = 'success') {
    setToast({ message, variant })
    setTimeout(() => setToast(null), variant === 'error' ? 5500 : 4000)
  }

  // ── New client handler ──
  async function handleSaveClient(payload) {
    const { data } = await api.post('/api/v1/clients/', payload)
    const afterSave = newClientCb.current
    closeNewClient()
    showToast('Cliente registrado correctamente.')
    afterSave?.(data)
  }

  // ── New sale handler ──
  // Importante: `closeNewSale` pone `newSaleCb.current = null`; hay que copiar el callback antes.
  async function handleSaleSuccess() {
    const afterSave = newSaleCb.current
    closeNewSale()
    showToast('Preventa reservada (Pendiente). Revísala en la lista y actívala cuando el pago esté auditorado.')
    try {
      await Promise.resolve(afterSave?.())
    } catch {
      /* el modal ya cerró; errores de refetch no deben bloquear UX */
    }
  }

  function handleRechargeInventoryDone() {
    closeRechargeModal()
    refreshInventoryData()
    showToast('Inventario actualizado.')
  }

  return (
    <>
      <ProductServiceFormModal
        key={productServiceMountKey}
        open={productServiceOpen}
        productToEdit={productServiceEditProduct}
        onClose={closeProductServiceModal}
        onSaved={() => {
          showToast('Producto guardado.')
          refreshInventoryData()
          window.dispatchEvent(new CustomEvent('products:changed'))
          window.dispatchEvent(new CustomEvent('notifications:refresh-stock-alerts'))
        }}
      />

      {newSaleOpen && (
        <NuevaVentaModal
          key={`sale-${newSalePrefillRef.current?.clientId ?? ''}-${newSalePrefillRef.current?.depositAccountId ?? ''}`}
          prefillClientId={newSalePrefillRef.current?.clientId ?? null}
          prefillDepositAccountId={newSalePrefillRef.current?.depositAccountId ?? null}
          onClose={closeNewSale}
          onSuccess={handleSaleSuccess}
          onToast={(message, variant) => showToast(message, variant)}
        />
      )}

      {/* Por encima de Nueva Venta (z-[55]): recarga rápida de bodega */}
      {rechargeOpen && (
        <CuentaMasterModal
          key={`${rechargeParams.defaultProvider}-${rechargeParams.defaultTab}`}
          overlayZIndexClass="z-[70]"
          defaultProvider={rechargeParams.defaultProvider}
          defaultTab={rechargeParams.defaultTab}
          onClose={closeRechargeModal}
          onSuccess={() => handleRechargeInventoryDone()}
          onSaveDraft={
            rechargeOpen && rechargeIsDraftFlow
              ? (data) => rechargeOnSaveDraftRef.current?.(data)
              : undefined
          }
        />
      )}

      {newClientOpen && (
        <RegisterModal
          onClose={closeNewClient}
          onSave={handleSaveClient}
        />
      )}

      {receivePaymentOpen && (
        <ReceivePaymentModal
          prefill={receivePaymentPrefill}
          onClose={closeReceivePayment}
          onToast={(message, variant) => showToast(message, variant)}
          onAfterSave={() => receivePaymentCb.current?.()}
        />
      )}

      {transferOpen && (
        <TransferModal
          defaultSourceAccountId={transferModalState.sourceAccountId ?? undefined}
          defaultDestinationAccountId={transferModalState.destinationAccountId ?? undefined}
          interbankMode={transferModalState.interbankMode}
          onClose={closeTransferModal}
          onToast={(message, variant = 'success') => showToast(message, variant)}
          onSuccess={({ keptOpen } = {}) => {
            try {
              transferCb.current?.()
            } catch {
              /* noop */
            }
            if (!keptOpen) closeTransferModal()
            window.dispatchEvent(new CustomEvent('chart-accounts:changed'))
          }}
        />
      )}

      <ExpenseFormModal
        open={expenseOpen}
        onClose={closeNewExpense}
        onSaved={() => {
          showToast('Gasto registrado correctamente.')
          try {
            expenseCb.current?.()
          } catch {
            /* no bloquear */
          }
          window.dispatchEvent(new CustomEvent('expenses:changed'))
        }}
      />

      <VendorFormModal
        open={vendorFormOpen}
        initialVendor={vendorFormEditVendor}
        onClose={closeVendorForm}
        onSaved={() => {
          showToast(vendorFormEditVendor ? 'Proveedor actualizado.' : 'Proveedor guardado.')
          try {
            vendorFormCb.current?.()
          } catch {
            /* noop */
          }
          window.dispatchEvent(new CustomEvent('vendors:changed'))
        }}
      />

      <VendorBillFormModal
        open={vendorBillOpen}
        onClose={closeVendorBillModal}
        prefillVendorId={vendorBillPrefillVendorIdRef.current}
        onSaved={() => {
          showToast('Factura de proveedor registrada.')
          window.dispatchEvent(new CustomEvent('vendors:changed'))
        }}
      />

      <PayBillsFormModal
        open={payBillsOpen}
        onClose={closePayBillsModal}
        prefillVendorId={payBillsPrefillVendorIdRef.current}
        onSaved={() => {
          showToast('Pago a proveedor registrado.')
          window.dispatchEvent(new CustomEvent('vendors:changed'))
        }}
      />

      {toast && (
        <Toast
          message={toast.message}
          variant={toast.variant}
          onDone={() => setToast(null)}
        />
      )}
    </>
  )
}
