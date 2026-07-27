import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Rastrea qué fila acaba de copiar un enlace y limpia el feedback tras un breve delay.
 * @param {{ clearMs?: number }} [options]
 */
export function useCopyLinkFeedback({ clearMs = 2000 } = {}) {
  const [copiedId, setCopiedId] = useState(null)
  const timerRef = useRef(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const copyWithFeedback = useCallback(
    async (id, copyTask) => {
      await copyTask()
      if (timerRef.current) clearTimeout(timerRef.current)
      setCopiedId(id)
      timerRef.current = setTimeout(() => {
        setCopiedId(null)
        timerRef.current = null
      }, clearMs)
    },
    [clearMs],
  )

  return { copiedId, copyWithFeedback }
}
