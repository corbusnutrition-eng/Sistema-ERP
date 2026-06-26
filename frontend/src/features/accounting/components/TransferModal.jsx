import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  X,
  History,
  MessageSquare,
  HelpCircle,
  ChevronDown,
  Paperclip,
  Clock,
} from 'lucide-react'
import api from '../../../api/axios'
import SearchableSelect from '../../../components/ui/SearchableSelect'
import { isLiquidDepositChartAccount } from '../accountStructure'
import { SALES_CURRENCIES, salesCurrencyDefaultRate } from '../../sales/salesCurrencies'
import { normalizeCurrencyCode } from '../../../lib/currencyCode'
import { todayIsoDateEcuador } from '../../../utils/datetime'

/** Unidades destino por 1 unidad origen, heurística LATAM usando catálogo de ventas vs USD. */
function defaultDstPerOneSrcUnits(srcRaw, dstRaw) {
  const s = normalizeCurrencyCode(srcRaw, 'USD')
  const d = normalizeCurrencyCode(dstRaw, 'USD')
  if (!s || !d || s === d) return '1'
  const ru = String(s) === 'USD' ? 1 : Number(salesCurrencyDefaultRate(s))
  const rv = String(d) === 'USD' ? 1 : Number(salesCurrencyDefaultRate(d))
  if (!Number.isFinite(ru) || !Number.isFinite(rv) || ru === 0) return '1'
  const v = rv / ru
  return String(Math.round(v * 1e10) / 1e10)
}

function currencyMeta(code) {
  const c = normalizeCurrencyCode(code, 'USD')
  const row = SALES_CURRENCIES.find((x) => x.code === c)
  return { code: c, flag: row?.flag ?? '🏷️', label: row?.label ?? c }
}

function formatMoneyQty(code, value) {
  const n = Number(value)
  const abs = Number.isFinite(n) ? Math.abs(n) : 0
  const s = abs.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${normalizeCurrencyCode(code, 'USD')}$ ${Number.isFinite(n) && n < 0 ? `(${s})` : s}`
}

const TRANSFER_ATTACH_MAX_BYTES = 20 * 1024 * 1024

const QB_GREEN = '#2ca01c'
const TRIGGER_ROW = `box-border flex items-start gap-3 py-3 border-b border-gray-200`

/**
 * Modal de transferencia entre cuentas líquidas (estilo QuickBooks Online).
 *
 * @param {() => void} onClose
 * @param {(msg: string, variant?: string) => void} [onToast]
 * @param {number | null} [defaultSourceAccountId]
 * @param {number | null} [defaultDestinationAccountId]
 * @param {boolean} [interbankMode] — marca la línea destino como acreditación interbancaria pendiente.
 */
export default function TransferModal({
  onClose,
  onSuccess,
  onToast,
  defaultSourceAccountId = null,
  defaultDestinationAccountId = null,
  interbankMode = false,
}) {
  const [accounts, setAccounts] = useState([])
  const [loadingAccounts, setLoadingAccounts] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [sourceId, setSourceId] = useState('')
  const [destId, setDestId] = useState('')
  const [txnCurrency, setTxnCurrency] = useState('USD')
  const [amount, setAmount] = useState('')
  const [exchangeCross, setExchangeCross] = useState('1')
  const [txnDate, setTxnDate] = useState(todayIsoDateEcuador)
  const [notes, setNotes] = useState('')
  const [pendingFiles, setPendingFiles] = useState([])
  const [dragOver, setDragOver] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [saveSplitOpen, setSaveSplitOpen] = useState(false)
  const saveSplitRef = useRef(null)
  const fileInputRef = useRef(null)

  const [depositIds, setDepositIds] = useState(null)

  /** Cuentas elegibles mismas que el POST /accounts/transfer (`is_liquid_deposit`). */
  const liquidAccounts = useMemo(() => {
    const list = Array.isArray(accounts) ? accounts : []
    if (!list.length) return []

    function byLocalStructure(a) {
      return a?.is_active !== false && isLiquidDepositChartAccount(a)
    }

    /** `null`: aún sin respuesta deposit-options → filtro local. `Set`: ids del API (intersección explícita). */
    if (depositIds instanceof Set && depositIds.size > 0) {
      return list.filter((a) => a?.is_active !== false && depositIds.has(Number(a.id)))
    }

    return list.filter(byLocalStructure)
  }, [accounts, depositIds])

  const sourceOpts = useMemo(
    () =>
      liquidAccounts.map((a) => ({
        value: String(a.id),
        label: `${a.name}${a.account_number ? ` · ${a.account_number}` : ''} — ${normalizeCurrencyCode(a.currency)}`,
      })),
    [liquidAccounts],
  )

  const destOpts = useMemo(
    () =>
      liquidAccounts
        .filter((a) => String(a.id) !== String(sourceId))
        .map((a) => ({
          value: String(a.id),
          label: `${a.name}${a.account_number ? ` · ${a.account_number}` : ''} — ${normalizeCurrencyCode(a.currency)}`,
        })),
    [liquidAccounts, sourceId],
  )

  const sourceAcc = liquidAccounts.find((a) => String(a.id) === String(sourceId))
  const destAcc = liquidAccounts.find((a) => String(a.id) === String(destId))
  const srcCur = sourceAcc ? normalizeCurrencyCode(sourceAcc.currency) : ''
  const dstCur = destAcc ? normalizeCurrencyCode(destAcc.currency) : ''

  const needsCrossFx = Boolean(srcCur && dstCur && srcCur !== dstCur)

  const currencyTxnOptions = useMemo(() => {
    const seen = new Set()
    const out = []
    for (const row of SALES_CURRENCIES) {
      if (!row?.code || seen.has(row.code)) continue
      seen.add(row.code)
      out.push({ value: row.code, label: `${row.flag} ${row.code}` })
    }
    if (srcCur && !seen.has(srcCur))
      out.unshift({ value: srcCur, label: `${currencyMeta(srcCur).flag} ${srcCur}` })
    if (dstCur && !seen.has(dstCur))
      out.unshift({ value: dstCur, label: `${currencyMeta(dstCur).flag} ${dstCur}` })
    return out
  }, [srcCur, dstCur])

  /** Conversión libro → cuenta origen: unidades SRC por 1 unidad TXN cuando el importe no va en SRC. */
  const [txnToSrcRate, setTxnToSrcRate] = useState('1')

  /** Importe está en DEST y hay par multimoneda → solo fila COP=USD (+ importe ya en DST). */
  const needsTxnToSrcFxRow = Boolean(
    srcCur &&
      txnCurrency &&
      txnCurrency !== srcCur &&
      !(needsCrossFx && txnCurrency === dstCur),
  )

  function deriveAmountSrc() {
    const raw = String(amount).trim().replace(/\s/g, '').replace(',', '.')
    const amt = Number.parseFloat(raw)
    if (!Number.isFinite(amt) || amt <= 0) return null
    if (!srcCur || !txnCurrency) return null
    if (txnCurrency === srcCur) return amt
    if (needsCrossFx && txnCurrency === dstCur) {
      const xc = Number.parseFloat(String(exchangeCross).replace(',', '.'))
      if (!Number.isFinite(xc) || xc <= 0) return null
      return amt / xc
    }
    const m = Number.parseFloat(String(txnToSrcRate).replace(',', '.'))
    if (!Number.isFinite(m) || m <= 0) return null
    return amt * m
  }

  const fetchAccountsData = useCallback(async ({ showSpinner = true } = {}) => {
    if (showSpinner) {
      setLoadingAccounts(true)
      setLoadError(null)
    }
    try {
      const settled = await Promise.allSettled([
        api.get('/api/v1/accounts/').then(({ data }) => (Array.isArray(data) ? data : [])),
        api.get('/api/v1/accounts/deposit-options').then(({ data }) => (Array.isArray(data) ? data : [])),
      ])
      const chartRows = settled[0].status === 'fulfilled' ? settled[0].value : null
      const depsRows = settled[1].status === 'fulfilled' ? settled[1].value : null

      if (showSpinner && settled[0].status === 'rejected') {
        setLoadError('No se pudo cargar el plan de cuentas.')
      } else if (!showSpinner && settled[0].status === 'rejected') {
        console.warn('No se pudo actualizar el plan de cuentas tras la transferencia.')
      }
      if (chartRows !== null) {
        setAccounts(chartRows)
      } else if (showSpinner) {
        setAccounts([])
      }

      if (depsRows != null) {
        if (depsRows.length > 0) {
          const ids = new Set(depsRows.map((d) => Number(d?.id)).filter((n) => Number.isFinite(n) && n >= 1))
          setDepositIds(ids)
        } else {
          setDepositIds(new Set())
        }
      }
    } catch {
      if (showSpinner) {
        setLoadError('No se pudo cargar datos de cuentas.')
        setAccounts([])
        setDepositIds(null)
      }
    } finally {
      if (showSpinner) {
        setLoadingAccounts(false)
      }
    }
  }, [])

  useEffect(() => {
    fetchAccountsData({ showSpinner: true })
  }, [fetchAccountsData])

  const lockDestination = interbankMode && defaultDestinationAccountId != null && defaultDestinationAccountId >= 1

  /** Prefijo desde libro mayor (origen) */
  useEffect(() => {
    const id = defaultSourceAccountId
    if (id == null || id < 1) return
    if (!liquidAccounts.length || loadingAccounts) return
    const exists = liquidAccounts.some((a) => Number(a.id) === Number(id))
    if (exists) setSourceId(String(Number(id)))
  }, [defaultSourceAccountId, liquidAccounts, loadingAccounts])

  /** Prefijo destino (p. ej. transferencia interbancaria entrante) */
  useEffect(() => {
    const id = defaultDestinationAccountId
    if (id == null || id < 1) return
    if (!liquidAccounts.length || loadingAccounts) return
    const exists = liquidAccounts.some((a) => Number(a.id) === Number(id))
    if (exists) setDestId(String(Number(id)))
  }, [defaultDestinationAccountId, liquidAccounts, loadingAccounts])

  useEffect(() => {
    setExchangeCross(defaultDstPerOneSrcUnits(srcCur, dstCur))
  }, [srcCur, dstCur])

  useEffect(() => {
    if (
      !srcCur ||
      !txnCurrency ||
      txnCurrency === srcCur ||
      (needsCrossFx && txnCurrency === dstCur)
    ) {
      setTxnToSrcRate('1')
      return
    }
    setTxnToSrcRate(defaultDstPerOneSrcUnits(txnCurrency, srcCur))
  }, [srcCur, dstCur, txnCurrency, needsCrossFx])

  /** Al cambiar cuenta origen, usar su moneda como moneda del importe por defecto. */
  useEffect(() => {
    setTxnCurrency(srcCur || 'USD')
  }, [sourceId])

  useEffect(() => {
    function onMd(e) {
      if (!saveSplitRef.current?.contains(e.target)) setSaveSplitOpen(false)
    }
    document.addEventListener('mousedown', onMd)
    return () => document.removeEventListener('mousedown', onMd)
  }, [])

  const resetAfterNewTransfer = useCallback(() => {
    setAmount('')
    setNotes('')
    setPendingFiles([])
    setSaveSplitOpen(false)
    setTxnDate(todayIsoDateEcuador)
    if (defaultSourceAccountId != null && defaultSourceAccountId >= 1) {
      setSourceId(String(Number(defaultSourceAccountId)))
    } else {
      setSourceId('')
    }
    if (defaultDestinationAccountId != null && defaultDestinationAccountId >= 1) {
      setDestId(String(Number(defaultDestinationAccountId)))
    } else {
      setDestId('')
    }
  }, [defaultSourceAccountId, defaultDestinationAccountId])

  async function uploadPendingFiles() {
    const urls = []
    for (const file of pendingFiles) {
      const fd = new FormData()
      fd.append('file', file)
      const { data } = await api.post('/api/v1/expenses/attachments/upload', fd)
      if (data?.url) urls.push(data.url)
    }
    return urls
  }

  async function performSave(andNewAfter) {
    setSubmitting(true)
    try {
      const srcFk = Number(sourceId)
      const dstFk = Number(destId)
      if (!Number.isFinite(srcFk) || srcFk < 1) {
        window.alert('Selecciona la cuenta desde la que transfieres.')
        return
      }
      if (!Number.isFinite(dstFk) || dstFk < 1) {
        window.alert('Selecciona la cuenta destino.')
        return
      }
      if (srcFk === dstFk) {
        window.alert('Las cuentas deben ser distintas.')
        return
      }

      const amtSrc = deriveAmountSrc()
      if (amtSrc == null || amtSrc <= 0) {
        const xc = Number.parseFloat(String(exchangeCross).replace(',', '.'))
        if (needsTxnToSrcFxRow) {
          const m = Number.parseFloat(String(txnToSrcRate).replace(',', '.'))
          if (!Number.isFinite(m) || m <= 0) {
            window.alert(
              'Indica equivalencia entre moneda seleccionada y moneda del origen (unidades cuenta origen por 1 moneda seleccionada).',
            )
            return
          }
        }
        if (needsCrossFx && txnCurrency === dstCur && (!Number.isFinite(xc) || xc <= 0)) {
          window.alert('Indica el tipo de cambio entre cuentas (origen → destino).')
          return
        }
        window.alert('Indica un importe de transferencia válido (> 0) y tasas donde correspondan.')
        return
      }

      let xrBackend = undefined
      if (needsCrossFx) {
        const xr = Number.parseFloat(String(exchangeCross).replace(',', '.'))
        if (!Number.isFinite(xr) || xr <= 0) {
          window.alert('Indica el tipo de cambio entre cuentas (unidades destino por 1 unidad origen).')
          return
        }
        xrBackend = xr
      }

      let noteOut = notes.trim() || null
      if (pendingFiles.length > 0) {
        try {
          const urls = await uploadPendingFiles()
          if (urls.length) {
            const block = `\nAdjuntos (${urls.length}): ${urls.join(', ')}`
            noteOut = ((noteOut || '') + block).slice(0, 3900)
          }
        } catch {
          window.alert('No se pudieron subir algunos adjuntos. Revisa el tamaño y el formato.')
          return
        }
      }

      const payload = {
        source_account_id: srcFk,
        destination_account_id: dstFk,
        amount: String(amtSrc),
        date: txnDate,
        notes: noteOut,
        ...(xrBackend !== undefined ? { exchange_rate: String(xrBackend) } : {}),
        ...(interbankMode ? { destination_verification_status: 'interbank' } : {}),
      }

      await api.post('/api/v1/accounts/transfer', payload)

      await fetchAccountsData({ showSpinner: false })

      onToast?.(
        interbankMode ? 'Transferencia interbancaria pendiente registrada' : 'Transferencia registrada',
        'success',
      )

      if (andNewAfter) {
        resetAfterNewTransfer()
        window.dispatchEvent(new CustomEvent('chart-accounts:changed'))
        if (typeof onSuccess === 'function') {
          onSuccess({ keptOpen: true })
        }
      } else {
        if (typeof onSuccess === 'function') {
          onSuccess({ keptOpen: false })
        } else {
          onClose?.()
        }
      }
    } catch (err) {
      const d = err?.response?.data?.detail
      window.alert(typeof d === 'string' ? d : 'No se pudo registrar la transferencia.')
    } finally {
      setSubmitting(false)
    }
  }

  function onDropZoneDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const next = [...pendingFiles]
    for (const f of [...e.dataTransfer.files]) {
      if (f.size > TRANSFER_ATTACH_MAX_BYTES) {
        window.alert(`«${f.name}» supera 20 MB.`)
        continue
      }
      next.push(f)
    }
    setPendingFiles(next)
  }

  function onFileInput(ev) {
    const next = [...pendingFiles]
    for (const f of [...(ev.target.files || [])]) {
      if (f.size > TRANSFER_ATTACH_MAX_BYTES) {
        window.alert(`«${f.name}» supera 20 MB.`)
        continue
      }
      next.push(f)
    }
    setPendingFiles(next)
    ev.target.value = ''
  }

  function removeFile(i) {
    setPendingFiles((prev) => prev.filter((_, j) => j !== i))
  }

  const srcMeta = currencyMeta(srcCur || 'USD')
  const dstMeta = currencyMeta(dstCur || txnCurrency || 'USD')
  const txnMeta = currencyMeta(txnCurrency)

  return (
    <div className="fixed inset-0 z-[215] flex items-center justify-center p-3 sm:p-6 font-sans text-gray-900">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="Cerrar"
        onClick={onClose}
      />

      <div
        role="dialog"
        aria-labelledby="transfer-modal-title"
        className="relative w-full max-w-5xl h-[min(92vh,900px)] flex flex-col bg-white rounded-md shadow-2xl border border-gray-200 overflow-hidden"
      >
        {/* Header QB */}
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-gray-200 shrink-0 bg-white">
          <div className="flex items-center gap-2 min-w-0">
            {interbankMode ? (
              <Clock size={20} className="text-amber-600 shrink-0" aria-hidden />
            ) : (
              <History size={20} className="text-green-900 shrink-0" aria-hidden />
            )}
            <div className="min-w-0">
              <h2 id="transfer-modal-title" className="text-lg font-semibold text-gray-900 truncate">
                {interbankMode ? 'Transferencia interbancaria pendiente' : 'Transferencia'}
              </h2>
              {interbankMode ? (
                <p className="text-xs text-amber-800 mt-0.5">
                  Se marcará como interbancaria hasta confirmar el abono en el estado de cuenta.
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              title="Comentarios (próximamente)"
              className="p-2 rounded-md text-green-900 hover:bg-gray-50"
            >
              <MessageSquare size={18} aria-hidden />
            </button>
            <button type="button" title="Ayuda" className="p-2 rounded-md text-green-900 hover:bg-gray-50">
              <HelpCircle size={18} aria-hidden />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-md text-gray-500 hover:bg-gray-100"
              aria-label="Cerrar"
            >
              <X size={20} aria-hidden />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-5 pt-6 pb-32 max-w-[960px] mx-auto space-y-6">
            {loadError && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                {loadError}
              </div>
            )}
            {loadingAccounts && (
              <p className="text-sm text-gray-500">Cargando cuentas de banco y caja…</p>
            )}

            {/* Cuentas — grid 2 col: campo | saldos */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-8">
              <div className="lg:col-span-7 space-y-0 divide-y divide-gray-100 rounded-md border border-gray-200 px-4 bg-white">
                <div className={TRIGGER_ROW}>
                  <label className="block text-xs font-semibold text-gray-600 pt-2.5 shrink-0 w-[42%] min-w-[8rem]">
                    Transferir fondos de:
                  </label>
                  <div className="flex-1 min-w-0">
                    <SearchableSelect
                      value={sourceId}
                      onChange={setSourceId}
                      options={sourceOpts}
                      placeholder="Selecciona cuenta…"
                      disabled={loadingAccounts || submitting || !liquidAccounts.length}
                      hideClear={false}
                    />
                  </div>
                </div>
                <div className={`${TRIGGER_ROW} border-none`}>
                  <label className="block text-xs font-semibold text-gray-600 pt-2.5 shrink-0 w-[42%] min-w-[8rem]">
                    Transferir fondos a:
                  </label>
                  <div className="flex-1 min-w-0">
                    <SearchableSelect
                      value={destId}
                      onChange={setDestId}
                      options={destOpts}
                      placeholder="Selecciona cuenta…"
                      disabled={loadingAccounts || submitting || !sourceId || !destOpts.length || lockDestination}
                      hideClear={lockDestination}
                    />
                  </div>
                </div>
              </div>
              <div className="lg:col-span-5 space-y-4 text-sm pt-1">
                <div className="min-h-[2.5rem] flex items-start justify-end text-right pt-8">
                  {sourceAcc ? (
                    <div>
                      <div className="text-xs text-gray-500">Saldo {normalizeCurrencyCode(sourceAcc.currency)}</div>
                      <div className="text-base font-medium tabular-nums text-gray-900">
                        {formatMoneyQty(sourceAcc.currency, sourceAcc.current_balance)}
                      </div>
                    </div>
                  ) : (
                    <span className="text-gray-400 text-xs">Selecciona cuenta origen</span>
                  )}
                </div>
                <div className="min-h-[2.5rem] flex items-start justify-end text-right pt-4">
                  {destAcc ? (
                    <div>
                      <div className="text-xs text-gray-500">Saldo {normalizeCurrencyCode(destAcc.currency)}</div>
                      <div className="text-base font-medium tabular-nums text-gray-900">
                        {formatMoneyQty(destAcc.currency, destAcc.current_balance)}
                      </div>
                    </div>
                  ) : (
                    <span className="text-gray-400 text-xs">Selecciona cuenta destino</span>
                  )}
                </div>
              </div>
            </div>

            {/* Moneda, tasa, importe */}
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
                <div className="lg:col-span-6">
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">Moneda</label>
                  <SearchableSelect
                    value={txnCurrency}
                    onChange={(v) => setTxnCurrency(normalizeCurrencyCode(v))}
                    options={currencyTxnOptions}
                    placeholder="Moneda…"
                    hideClear
                    disabled={submitting || !srcCur}
                  />
                </div>
                <div className="lg:col-span-6 flex flex-col lg:items-end">
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5 lg:text-right">
                    Fecha
                  </label>
                  <input
                    type="date"
                    value={txnDate}
                    onChange={(e) => setTxnDate(e.target.value)}
                    disabled={submitting}
                    className="box-border h-10 w-full max-w-[11rem] rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:outline-none focus-visible:ring-0"
                  />
                </div>
              </div>

              {needsTxnToSrcFxRow && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-gray-200 bg-gray-50/70 px-3 py-2.5">
                  <span className="text-sm text-gray-800 tabular-nums">{`1 ${txnMeta.code}`}</span>
                  <span className="text-base" aria-hidden>
                    {txnMeta.flag}
                  </span>
                  <span className="text-gray-500">=</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={txnToSrcRate}
                    onChange={(e) => setTxnToSrcRate(e.target.value)}
                    disabled={submitting}
                    className="w-28 h-10 px-2 rounded-md border border-gray-300 bg-white text-sm text-center focus:outline-none focus-visible:ring-0"
                  />
                  <span className="text-sm text-gray-800 tabular-nums">{srcMeta.code}</span>
                  <span className="text-base" aria-hidden>
                    {srcMeta.flag}
                  </span>
                  <span className="text-xs text-gray-500 lg:ml-2">
                    Unidades de la cuenta origen por 1 {txnCurrency}
                  </span>
                </div>
              )}

              {needsCrossFx && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-gray-200 bg-gray-50/70 px-3 py-2.5">
                  <span className="text-sm text-gray-800 tabular-nums">
                    {`1 ${srcMeta.code}`}
                  </span>
                  <span className="text-base" aria-hidden>
                    {srcMeta.flag}
                  </span>
                  <span className="text-gray-500">=</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={exchangeCross}
                    onChange={(e) => setExchangeCross(e.target.value)}
                    disabled={submitting}
                    className="w-28 h-10 px-2 rounded-md border border-gray-300 bg-white text-sm text-center focus:outline-none focus-visible:ring-0"
                  />
                  <span className="text-sm text-gray-800 tabular-nums">{dstMeta.code}</span>
                  <span className="text-base" aria-hidden>
                    {dstMeta.flag}
                  </span>
                  <span className="text-xs text-gray-500 lg:ml-2">
                    Unidades destino por 1 unidad origen
                  </span>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">
                  Importe de la transferencia
                  {txnCurrency ? (
                    <span className="font-normal text-gray-500"> ({txnCurrency})</span>
                  ) : null}
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="0,00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={submitting || !txnCurrency}
                  className="box-border w-full max-w-md h-10 rounded-md border border-gray-300 bg-white px-3 text-sm tabular-nums focus:outline-none focus-visible:ring-0"
                />
              </div>
            </div>

            {/* Notas / adjuntos */}
            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1.5">Nota</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={6}
                className="w-full min-h-[8rem] h-32 rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus-visible:ring-0 resize-y"
                placeholder="Información sobre la transferencia para el equipo contable."
                disabled={submitting}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-600 mb-1.5">
                Archivos adjuntos
              </label>
              <div
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (submitting) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    fileInputRef.current?.click()
                  }
                }}
                onClick={() => {
                  if (!submitting) fileInputRef.current?.click()
                }}
                onDragEnter={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDropZoneDrop}
                className={`flex flex-col cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-4 py-8 transition-colors ${
                  dragOver ? 'border-green-700 bg-green-50/60' : 'border-gray-300 bg-white hover:bg-gray-50'
                }`}
              >
                <Paperclip size={20} className="text-green-900" aria-hidden />
                <span className="text-sm font-medium text-blue-700">Añadir archivo adjunto</span>
                <span className="text-xs text-gray-500">Arrastra y suelta o haz clic</span>
                <span className="text-[11px] text-gray-400">
                  Tamaño máximo de archivo: 20 MB
                </span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                multiple
                onChange={onFileInput}
                disabled={submitting}
              />
              {pendingFiles.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {pendingFiles.map((f, i) => (
                    <li
                      key={`${f.name}-${i}`}
                      className="flex items-center justify-between gap-2 text-xs bg-gray-50 border border-gray-100 rounded px-2 py-1"
                    >
                      <span className="truncate">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => removeFile(i)}
                        className="text-red-600 shrink-0"
                      >
                        Quitar
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        {/* Footer QB */}
        <div className="border-t border-gray-200 bg-white px-4 py-4 shrink-0">
          <div className="max-w-[960px] mx-auto flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="px-2 py-1.5 text-sm font-medium text-green-900 hover:underline disabled:opacity-40"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => resetAfterNewTransfer()}
                className="px-2 py-1.5 text-sm font-medium text-green-900 border border-transparent rounded hover:border-green-800 disabled:opacity-40"
              >
                Borrar
              </button>
            </div>

            <button
              type="button"
              className="text-sm font-medium text-green-900 hover:underline lg:mx-auto"
              title="Próximamente"
              disabled={submitting}
            >
              Hacer recurrente
            </button>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => performSave(false)}
                className="inline-flex items-center justify-center px-4 h-10 rounded-md border border-green-800 text-green-950 text-sm font-semibold hover:bg-green-50 disabled:opacity-40"
              >
                {submitting ? 'Guardando…' : 'Guardar'}
              </button>

              <div ref={saveSplitRef} className="relative inline-flex rounded-md shadow-sm">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => performSave(true)}
                  className="inline-flex items-center justify-center px-4 h-10 rounded-l-md text-sm font-semibold text-white disabled:opacity-40"
                  style={{ backgroundColor: QB_GREEN }}
                >
                  Guardar y crear nueva
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => setSaveSplitOpen((o) => !o)}
                  className="inline-flex items-center justify-center px-2 h-10 rounded-r-md border-l border-white/35 text-white disabled:opacity-40"
                  style={{ backgroundColor: QB_GREEN }}
                  aria-label="Opciones de guardado"
                  aria-expanded={saveSplitOpen}
                >
                  <ChevronDown size={18} aria-hidden />
                </button>
                {saveSplitOpen && (
                  <div className="absolute right-0 bottom-full mb-1 w-52 rounded-md border border-gray-200 bg-white py-1 shadow-lg z-[1]">
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                      onClick={() => {
                        setSaveSplitOpen(false)
                        performSave(false)
                      }}
                    >
                      Guardar y cerrar
                    </button>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                      onClick={() => {
                        setSaveSplitOpen(false)
                        performSave(true)
                      }}
                    >
                      Guardar y nueva
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
