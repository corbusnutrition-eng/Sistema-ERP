import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import axios from 'axios'

/**
 * Puerta de login del portal sobre el link permanente `/portal/:token`.
 *
 * El link ya no basta por sí solo: hace falta además una sesión de portal
 * (correo + contraseña, o "crear tu contraseña" la primera vez) — ver
 * `backend/app/api/v1/portal_auth.py`. Envuelve a `ClientPortalPageInner`
 * (ver `ClientPortalPage.jsx`) y solo la renderiza una vez autenticado.
 */

const ROOT_CLASS =
  'portal-public-root flex min-h-screen w-full items-center justify-center overflow-x-hidden bg-[linear-gradient(145deg,#0f0c29_0%,#1a1440_42%,#16324a_100%)] px-4 py-10 font-[DM_Sans,Inter,-apple-system,BlinkMacSystemFont,sans-serif] text-slate-50'

const CARD_CLASS =
  'w-full max-w-sm rounded-[20px] border border-white/10 bg-white/[0.06] px-5 py-7 shadow-[0_24px_48px_rgba(0,0,0,0.35)] md:px-7'

const INPUT_CLASS =
  'w-full min-h-[44px] rounded-xl border border-white/15 bg-white/[0.06] px-3 py-2.5 text-sm text-slate-50 outline-none transition placeholder:text-slate-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50 touch-manipulation'

const BUTTON_CLASS =
  'inline-flex min-h-[44px] h-12 w-full items-center justify-center rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 text-[15px] font-semibold text-white transition hover:from-violet-400 hover:to-fuchsia-400 disabled:cursor-not-allowed disabled:opacity-50 touch-manipulation'

const PortalSessionContext = createContext(null)

/** Permite a `ClientPortalPageInner` avisar que la sesión murió (401 a mitad de uso) y volver al login. */
export function usePortalSessionExpired() {
  const ctx = useContext(PortalSessionContext)
  return ctx?.notifySessionExpired ?? (() => {})
}

/** Permite a `ClientPortalPageInner` ofrecer un botón "Cerrar sesión". */
export function usePortalLogout() {
  const ctx = useContext(PortalSessionContext)
  return ctx?.logout ?? (() => {})
}

function publicAuthApi() {
  return axios.create({
    baseURL: (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/?$/, ''),
    withCredentials: true,
  })
}

function Spinner() {
  return (
    <svg className="h-4 w-4 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

function resolveErrorMessage(err, fallback) {
  if (!err?.response) return 'No se pudo conectar con el servidor.'
  const detail = err.response.data?.detail
  if (detail === 'ACCOUNT_BLOCKED') return 'Esta cuenta está suspendida. Contacta a tu administrador.'
  if (detail === 'PASSWORD_NOT_SET') return 'Aún no has creado tu contraseña en este portal.'
  if (detail === 'PASSWORD_ALREADY_SET') return 'Este portal ya tiene una contraseña creada.'
  if (typeof detail === 'string') return detail
  return fallback
}

export default function PortalLoginGate({ children }) {
  const { token } = useParams()
  const api = useMemo(() => publicAuthApi(), [])

  // loading | login | setup | authenticated | blocked | fatal
  const [status, setStatus] = useState('loading')
  const [emailMasked, setEmailMasked] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fetchStatus = useCallback(async () => {
    setStatus('loading')
    setError('')
    try {
      const { data } = await api.get(`/api/v1/portal/${token}/auth/status`)
      setEmailMasked(data?.email_masked || '')
      if (data?.blocked) {
        setStatus('blocked')
      } else if (data?.authenticated) {
        setStatus('authenticated')
      } else if (data?.has_password) {
        setStatus('login')
      } else {
        setStatus('setup')
      }
    } catch (err) {
      setError(err?.response?.status === 404 ? 'Este link no es válido.' : 'No se pudo cargar el portal.')
      setStatus('fatal')
    }
  }, [api, token])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  const notifySessionExpired = useCallback(() => {
    setPassword('')
    setStatus('login')
  }, [])

  const logout = useCallback(() => {
    void api.post(`/api/v1/portal/${token}/auth/logout`).finally(() => {
      setPassword('')
      setStatus('login')
    })
  }, [api, token])

  async function handleLogin(e) {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      await api.post(`/api/v1/portal/${token}/auth/login`, { email, password })
      setStatus('authenticated')
    } catch (err) {
      setError(resolveErrorMessage(err, 'No se pudo iniciar sesión.'))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSetup(e) {
    e.preventDefault()
    if (submitting) return
    if (password !== passwordConfirm) {
      setError('Las contraseñas no coinciden.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await api.post(`/api/v1/portal/${token}/auth/setup-password`, {
        email,
        password,
        password_confirm: passwordConfirm,
      })
      setStatus('authenticated')
    } catch (err) {
      setError(resolveErrorMessage(err, 'No se pudo crear la contraseña.'))
    } finally {
      setSubmitting(false)
    }
  }

  if (status === 'authenticated') {
    const contextValue = { notifySessionExpired, logout }
    return <PortalSessionContext.Provider value={contextValue}>{children}</PortalSessionContext.Provider>
  }

  if (status === 'loading') {
    return (
      <div className={ROOT_CLASS}>
        <Spinner />
      </div>
    )
  }

  if (status === 'blocked') {
    return (
      <div className={ROOT_CLASS}>
        <div className={`${CARD_CLASS} text-center`}>
          <div className="mb-5 text-5xl" aria-hidden>
            🔒
          </div>
          <h1 className="mb-3 text-xl font-bold text-white">Cuenta Suspendida</h1>
          <p className="text-sm leading-relaxed text-slate-300">
            Por favor, contacta a tu administrador para más información.
          </p>
        </div>
      </div>
    )
  }

  if (status === 'fatal') {
    return (
      <div className={ROOT_CLASS}>
        <div className={`${CARD_CLASS} text-center`}>
          <h1 className="mb-2 text-lg font-semibold text-white">Portal de cliente</h1>
          <p className="break-words text-sm text-red-200">{error || 'No disponible.'}</p>
        </div>
      </div>
    )
  }

  const isSetup = status === 'setup'

  return (
    <div className={ROOT_CLASS}>
      <div className={CARD_CLASS}>
        <h1 className="mb-1 text-xl font-bold text-white">{isSetup ? 'Crea tu contraseña' : 'Inicia sesión'}</h1>
        <p className="mb-6 text-sm text-slate-400">
          {isSetup
            ? 'Es la primera vez que entras por este link: crea una contraseña para proteger tu portal.'
            : `Ingresa con tu correo y contraseña${emailMasked ? ` (${emailMasked})` : ''}.`}
        </p>

        <form onSubmit={isSetup ? handleSetup : handleLogin} className="space-y-4" noValidate>
          <div>
            <label htmlFor="portal-login-email" className="mb-1.5 block text-sm font-medium text-slate-300">
              Correo electrónico
            </label>
            <input
              id="portal-login-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@correo.com"
              className={INPUT_CLASS}
            />
          </div>

          <div>
            <label htmlFor="portal-login-password" className="mb-1.5 block text-sm font-medium text-slate-300">
              Contraseña
            </label>
            <input
              id="portal-login-password"
              type="password"
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              required
              minLength={isSetup ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className={INPUT_CLASS}
            />
          </div>

          {isSetup ? (
            <div>
              <label htmlFor="portal-login-password-confirm" className="mb-1.5 block text-sm font-medium text-slate-300">
                Confirma tu contraseña
              </label>
              <input
                id="portal-login-password-confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                placeholder="••••••••"
                className={INPUT_CLASS}
              />
            </div>
          ) : null}

          {error ? (
            <div className="rounded-xl border border-red-400/30 bg-red-950/30 px-3 py-2.5 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <button type="submit" disabled={submitting} aria-busy={submitting} className={BUTTON_CLASS}>
            <span className="flex items-center justify-center gap-2">
              {submitting ? <Spinner /> : null}
              <span>{submitting ? 'Un momento…' : isSetup ? 'Crear contraseña' : 'Entrar'}</span>
            </span>
          </button>
        </form>
      </div>
    </div>
  )
}
