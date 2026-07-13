import { useEffect, useState } from 'react'

/** Retorna `value` tras `delayMs` sin cambios (útil para búsquedas asíncronas). */
export default function useDebounce(value, delayMs = 400) {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(id)
  }, [value, delayMs])

  return debounced
}
