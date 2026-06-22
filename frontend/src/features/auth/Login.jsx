import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { loginWithEmailPassword, parseAuthErrorDetail } from '../../api/auth'

function LoginSpinner() {
  return (
    <svg className="w-4 h-4 animate-spin shrink-0" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

function resolveLoginError(err) {
  if (!err?.response) {
    return 'No se pudo conectar con el servidor. Verifica que el backend esté activo y que CORS permita este dominio.'
  }
  const detail = err.response.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail[0]?.msg || parseAuthErrorDetail(detail, 'Error de validación al iniciar sesión')
  }
  return parseAuthErrorDetail(detail, 'Credenciales incorrectas o error del servidor.')
}

export default function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (loading) return

    setError('')
    setLoading(true)

    try {
      const data = await loginWithEmailPassword(email, password)
      localStorage.setItem('access_token', data.access_token)
      localStorage.setItem('user', JSON.stringify(data.user))
      const destination = data.user.role === 'admin' ? '/dashboard' : '/clientes'
      navigate(destination, { replace: true })
    } catch (err) {
      setError(resolveLoginError(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center px-4">

      {/* Logo / branding */}
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 shadow-lg mb-4">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9 12h3.75M9 15h3.75M9 18h3.75m3-10.125c0-.621-.504-1.125-1.125-1.125H5.625c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125h10.75c.621 0 1.125-.504 1.125-1.125v-1.5Z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Sistema ERP</h1>
          <p className="text-slate-400 text-sm mt-1">Gestión de Facturación</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <h2 className="text-xl font-semibold text-slate-800 mb-1">Iniciar Sesión</h2>
          <p className="text-slate-400 text-sm mb-6">Ingresa tus credenciales para continuar</p>

          <form onSubmit={handleSubmit} className="space-y-5" noValidate>

            {/* Email */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-700 mb-1.5">
                Correo electrónico
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="admin@erp.com"
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-slate-800 text-sm
                           placeholder-slate-300 outline-none
                           focus:border-blue-500 focus:ring-2 focus:ring-blue-100
                           transition duration-150"
              />
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1.5">
                Contraseña
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-slate-800 text-sm
                           placeholder-slate-300 outline-none
                           focus:border-blue-500 focus:ring-2 focus:ring-blue-100
                           transition duration-150"
              />
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-100 text-red-600 text-sm rounded-xl px-4 py-3">
                <svg className="w-4 h-4 mt-0.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                <span>{error}</span>
              </div>
            )}

            {/* Submit — estructura DOM estable (evita removeChild con extensiones del navegador) */}
            <button
              type="submit"
              disabled={loading}
              aria-busy={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800
                         disabled:opacity-60 disabled:cursor-not-allowed
                         text-white font-semibold text-sm py-2.5 rounded-xl
                         transition duration-150 shadow-sm shadow-blue-200"
            >
              <span className="flex items-center justify-center gap-2 min-h-[1.25rem]">
                {loading ? <LoginSpinner /> : null}
                <span>{loading ? 'Verificando...' : 'Iniciar Sesión'}</span>
              </span>
            </button>
          </form>
        </div>

        <p className="text-center text-slate-500 text-xs mt-6">
          © {new Date().getFullYear()} Sistema de Facturación ERP
        </p>
      </div>
    </div>
  )
}
