import { createContext, useCallback, useContext, useRef, useState } from 'react'

const ModalContext = createContext(null)

/**
 * Provides global open/close for quick-create modals (New Client, New Sale, Receive Payment, Recharge Inventory).
 *
 * Callers can pass an optional `afterSave` callback to `openNewClient` or
 * `openNewSale` — GlobalModals invokes it after save.
 */
const RECHARGE_DEFAULT_PARAMS = Object.freeze({
  defaultProvider: 'Flujo',
  defaultTab: 'full',
})

export function ModalProvider({ children }) {
  const [newClientOpen, setNewClientOpen]   = useState(false)
  const [newSaleOpen, setNewSaleOpen]       = useState(false)
  const [rechargeOpen, setRechargeOpen]     = useState(false)
  const [rechargeParams, setRechargeParams] = useState(RECHARGE_DEFAULT_PARAMS)
  const [rechargeIsDraftFlow, setRechargeIsDraftFlow] = useState(false)
  const [receivePaymentOpen, setReceivePaymentOpen] = useState(false)
  const [receivePaymentPrefill, setReceivePaymentPrefill] = useState(null)
  const [expenseOpen, setExpenseOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferModalState, setTransferModalState] = useState(() => ({
    sourceAccountId: null,
    destinationAccountId: null,
    interbankMode: false,
  }))

  const [vendorFormOpen, setVendorFormOpen] = useState(false)
  const [vendorFormEditVendor, setVendorFormEditVendor] = useState(null)
  const [vendorBillOpen, setVendorBillOpen] = useState(false)
  const [payBillsOpen, setPayBillsOpen] = useState(false)
  const [productServiceOpen, setProductServiceOpen] = useState(false)
  const [productServiceEditProduct, setProductServiceEditProduct] = useState(null)
  /** Incrementa en cada apertura para remontar ProductServiceFormModal y limpiar estado local. */
  const [productServiceMountKey, setProductServiceMountKey] = useState(0)

  const newClientCb  = useRef(null)
  const newSaleCb    = useRef(null)
  const newSalePrefillRef = useRef(null)
  /** Callback después de guardar «Recibir pago». */
  const receivePaymentCb = useRef(null)
  /** Callback después de guardar un gasto (p. ej. refrescar lista). */
  const expenseCb = useRef(null)
  /** Callback después de registrar transferencia entre cuentas. */
  const transferCb = useRef(null)
  const vendorFormCb = useRef(null)
  const vendorBillPrefillVendorIdRef = useRef(null)
  const payBillsPrefillVendorIdRef = useRef(null)
  /** Guarda onSaveDraft cuando se abre recarga desde Nueva venta (no pasa por estado). */
  const rechargeOnSaveDraftRef = useRef(null)

  const openNewClient = useCallback((afterSave) => {
    newClientCb.current = afterSave ?? null
    setNewClientOpen(true)
  }, [])

  const closeNewClient = useCallback(() => {
    setNewClientOpen(false)
    newClientCb.current = null
  }, [])

  const openNewSale = useCallback((afterSave, prefill = null) => {
    newSaleCb.current = afterSave ?? null
    newSalePrefillRef.current = prefill
    setNewSaleOpen(true)
  }, [])

  const closeNewSale = useCallback(() => {
    setNewSaleOpen(false)
    newSaleCb.current = null
    newSalePrefillRef.current = null
  }, [])

  const openRechargeModal = useCallback((params = {}) => {
    const { onSaveDraft, ...rest } = params
    const isDraft = typeof onSaveDraft === 'function'
    rechargeOnSaveDraftRef.current = isDraft ? onSaveDraft : null
    setRechargeIsDraftFlow(isDraft)
    setRechargeParams({
      ...RECHARGE_DEFAULT_PARAMS,
      ...rest,
    })
    setRechargeOpen(true)
  }, [])

  const closeRechargeModal = useCallback(() => {
    rechargeOnSaveDraftRef.current = null
    setRechargeIsDraftFlow(false)
    setRechargeOpen(false)
    setRechargeParams(RECHARGE_DEFAULT_PARAMS)
  }, [])

  const openReceivePayment = useCallback((afterSave, prefill = null) => {
    receivePaymentCb.current = afterSave ?? null
    setReceivePaymentPrefill(prefill)
    setReceivePaymentOpen(true)
  }, [])

  const closeReceivePayment = useCallback(() => {
    setReceivePaymentOpen(false)
    receivePaymentCb.current = null
    setReceivePaymentPrefill(null)
  }, [])

  const openNewExpense = useCallback((afterSave) => {
    expenseCb.current = afterSave ?? null
    setExpenseOpen(true)
  }, [])

  const closeNewExpense = useCallback(() => {
    setExpenseOpen(false)
    expenseCb.current = null
  }, [])

  const openTransferModal = useCallback((opts = null) => {
    const o = opts != null && typeof opts === 'object' ? opts : {}
    transferCb.current = typeof o.afterSave === 'function' ? o.afterSave : null
    setTransferModalState({
      sourceAccountId:
        o.defaultSourceAccountId != null ? Number(o.defaultSourceAccountId) || null : null,
      destinationAccountId:
        o.defaultDestinationAccountId != null ? Number(o.defaultDestinationAccountId) || null : null,
      interbankMode: Boolean(o.interbankMode),
    })
    setTransferOpen(true)
  }, [])

  const closeTransferModal = useCallback(() => {
    setTransferOpen(false)
    setTransferModalState({
      sourceAccountId: null,
      destinationAccountId: null,
      interbankMode: false,
    })
    transferCb.current = null
  }, [])

  const openVendorForm = useCallback((opts) => {
    if (typeof opts === 'function') {
      vendorFormCb.current = opts
      setVendorFormEditVendor(null)
    } else if (opts != null && typeof opts === 'object') {
      vendorFormCb.current = typeof opts.afterSave === 'function' ? opts.afterSave : null
      setVendorFormEditVendor(opts.vendor ?? null)
    } else {
      vendorFormCb.current = null
      setVendorFormEditVendor(null)
    }
    setVendorFormOpen(true)
  }, [])

  const closeVendorForm = useCallback(() => {
    setVendorFormOpen(false)
    setVendorFormEditVendor(null)
    vendorFormCb.current = null
  }, [])

  const openVendorBillModal = useCallback((opts = {}) => {
    const o = opts != null && typeof opts === 'object' ? opts : {}
    const vid = o.vendorId
    vendorBillPrefillVendorIdRef.current = vid != null && vid !== '' ? Number(vid) || null : null
    setVendorBillOpen(true)
  }, [])

  const closeVendorBillModal = useCallback(() => {
    setVendorBillOpen(false)
    vendorBillPrefillVendorIdRef.current = null
  }, [])

  const openPayBillsModal = useCallback((opts = {}) => {
    const o = opts != null && typeof opts === 'object' ? opts : {}
    const vid = o.vendorId
    payBillsPrefillVendorIdRef.current = vid != null && vid !== '' ? Number(vid) || null : null
    setPayBillsOpen(true)
  }, [])

  const closePayBillsModal = useCallback(() => {
    setPayBillsOpen(false)
    payBillsPrefillVendorIdRef.current = null
  }, [])

  const openProductServiceModal = useCallback((product = null) => {
    setProductServiceMountKey((k) => k + 1)
    setProductServiceEditProduct(product ?? null)
    setProductServiceOpen(true)
  }, [])

  const closeProductServiceModal = useCallback(() => {
    setProductServiceOpen(false)
    setProductServiceEditProduct(null)
  }, [])

  return (
    <ModalContext.Provider value={{
      newClientOpen, openNewClient, closeNewClient, newClientCb,
      newSaleOpen, openNewSale, closeNewSale, newSaleCb, newSalePrefillRef,
      rechargeOpen, rechargeParams, openRechargeModal, closeRechargeModal,
      rechargeOnSaveDraftRef, rechargeIsDraftFlow,
      receivePaymentOpen, openReceivePayment, closeReceivePayment, receivePaymentCb, receivePaymentPrefill,
      expenseOpen, openNewExpense, closeNewExpense, expenseCb,
      transferOpen,
      transferModalState,
      openTransferModal,
      closeTransferModal,
      transferCb,
      vendorFormOpen, openVendorForm, closeVendorForm, vendorFormCb, vendorFormEditVendor,
      vendorBillOpen, openVendorBillModal, closeVendorBillModal, vendorBillPrefillVendorIdRef,
      payBillsOpen, openPayBillsModal, closePayBillsModal, payBillsPrefillVendorIdRef,
      productServiceOpen,
      productServiceMountKey,
      productServiceEditProduct,
      openProductServiceModal,
      closeProductServiceModal,
    }}>
      {children}
    </ModalContext.Provider>
  )
}

export function useModal() {
  const ctx = useContext(ModalContext)
  if (!ctx) throw new Error('useModal must be used inside <ModalProvider>')
  return ctx
}
