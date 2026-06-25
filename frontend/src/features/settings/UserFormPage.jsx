import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, Loader2 } from 'lucide-react'
import SearchableSelect from '../../components/ui/SearchableSelect'
import PermissionMatrix from './components/PermissionMatrix'
import { createTeamUser, fetchPermissionsMatrix, fetchTeamUser, updateTeamUser } from '../../api/users'
import {
  ROLE_TEMPLATE_CUSTOM,
  ROLE_TEMPLATE_FULL_ADMIN,
  collectMatrixKeys,
  expandPermissionsForMatrixDisplay,
  joinFullName,
  matrixPermissionsOnly,
  permissionsFromRoleTemplate,
  splitFullName,
} from '../../lib/permissionMatrix'

function parseErrorDetail(err) {
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string') return detail
  return 'No se pudo guardar el usuario.'
}

export default function UserFormPage() {
  const { userId } = useParams()
  const navigate = useNavigate()
  const isEdit = Boolean(userId)

  const [loading, setLoading] = useState(isEdit)
  const [matrixLoading, setMatrixLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [roleTemplate, setRoleTemplate] = useState('')
  const [granted, setGranted] = useState([])
  const [rawUserPermissions, setRawUserPermissions] = useState(null)

  const [matrixData, setMatrixData] = useState({ modules: [], actions: [], predefined_roles: [] })
  const [showPermissions, setShowPermissions] = useState(false)

  const allMatrixKeys = useMemo(
    () => collectMatrixKeys(matrixData.modules),
    [matrixData.modules],
  )

  const isCustomRole = roleTemplate === ROLE_TEMPLATE_CUSTOM
  const isFullAdmin = roleTemplate === ROLE_TEMPLATE_FULL_ADMIN
  const matrixReadOnly = Boolean(roleTemplate) && !isCustomRole

  const roleOptions = useMemo(
    () =>
      (matrixData.predefined_roles ?? []).map((r) => ({
        value: r.id,
        label: r.label,
      })),
    [matrixData.predefined_roles],
  )

  const selectedRoleMeta = useMemo(
    () => (matrixData.predefined_roles ?? []).find((r) => r.id === roleTemplate),
    [matrixData.predefined_roles, roleTemplate],
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setMatrixLoading(true)
      try {
        const data = await fetchPermissionsMatrix()
        if (!cancelled) {
          setMatrixData({
            modules: data?.modules ?? [],
            actions: data?.actions ?? [],
            predefined_roles: data?.predefined_roles ?? [],
          })
        }
      } finally {
        if (!cancelled) setMatrixLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isEdit || !userId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const user = await fetchTeamUser(userId)
        if (cancelled) return
        const { firstName: fn, lastName: ln } = splitFullName(user.name)
        setFirstName(fn)
        setLastName(ln)
        setEmail(user.email ?? '')
        setRoleTemplate(user.role_template ?? (user.role === 'admin' ? ROLE_TEMPLATE_FULL_ADMIN : ROLE_TEMPLATE_CUSTOM))
        setRawUserPermissions(user.permissions ?? [])
        setShowPermissions(true)
      } catch {
        if (!cancelled) setError('No se pudo cargar el usuario.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isEdit, userId])

  useEffect(() => {
    if (!rawUserPermissions?.length || !matrixData.modules.length) return
    setGranted(expandPermissionsForMatrixDisplay(rawUserPermissions, matrixData.modules))
  }, [rawUserPermissions, matrixData.modules])

  const applyRoleTemplate = useCallback(
    (templateId) => {
      setRoleTemplate(templateId)
      setShowPermissions(Boolean(templateId))
      if (!templateId) {
        setGranted([])
        return
      }
      const perms = permissionsFromRoleTemplate(
        templateId,
        matrixData.predefined_roles,
        allMatrixKeys,
      )
      setGranted(perms)
    },
    [allMatrixKeys, matrixData.predefined_roles],
  )

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    const name = joinFullName(firstName, lastName)
    if (!name || !email.trim()) {
      setError('Nombre y correo electrónico son obligatorios.')
      return
    }
    if (!roleTemplate) {
      setError('Selecciona un rol para continuar.')
      return
    }
    if (!isEdit && !password.trim()) {
      setError('La contraseña es obligatoria para usuarios nuevos.')
      return
    }
    if (isCustomRole && granted.length === 0) {
      setError('El rol personalizado requiere al menos un permiso en la matriz.')
      return
    }

    const payload = {
      name,
      email: email.trim(),
      role_template: roleTemplate,
      permissions: isCustomRole ? matrixPermissionsOnly(new Set(granted), matrixData.modules) : granted,
    }
    if (password.trim()) payload.password = password

    setSaving(true)
    try {
      if (isEdit) {
        await updateTeamUser(userId, payload)
      } else {
        await createTeamUser(payload)
      }
      navigate('/equipo', { replace: true })
    } catch (err) {
      setError(parseErrorDetail(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-sm text-gray-500">
        <Loader2 size={18} className="animate-spin mr-2" />
        Cargando usuario…
      </div>
    )
  }

  return (
    <div className="min-h-full bg-gray-50">
      <form onSubmit={handleSubmit} className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        <div>
          <Link
            to="/equipo"
            className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:text-emerald-800 mb-4"
          >
            <ChevronLeft size={16} />
            Volver
          </Link>
          <h1 className="text-2xl font-bold text-gray-900">
            {isEdit ? 'Editar usuario' : 'Agregar usuario'}
          </h1>
          {!isEdit && (
            <p className="text-sm text-gray-500 mt-1">
              Crea una cuenta de acceso al ERP y asigna sus permisos por módulo.
            </p>
          )}
        </div>

        {/* Información personal */}
        <section className="space-y-4">
          <h2 className="text-base font-semibold text-gray-900">Introducir información personal</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Nombre</label>
              <input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600 bg-white"
                placeholder="Juan"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Apellido</label>
              <input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600 bg-white"
                placeholder="García"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Correo electrónico</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600 bg-white"
                placeholder="juan@empresa.com"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-xl">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">
                {isEdit ? 'Nueva contraseña (opcional)' : 'Contraseña'}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600 bg-white"
                placeholder={isEdit ? 'Dejar en blanco para no cambiar' : 'Mínimo 6 caracteres'}
              />
            </div>
          </div>
        </section>

        {/* Asignar roles */}
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-gray-900">Asignar roles</h2>
          <p className="text-sm text-gray-500">
            Elige entre los roles existentes o configura un acceso personalizado.
          </p>
          <div className="max-w-xl">
            <SearchableSelect
              value={roleTemplate}
              onChange={applyRoleTemplate}
              options={roleOptions}
              placeholder="Seleccionar un rol"
            />
            {!roleTemplate && (
              <p className="text-xs text-red-600 mt-1.5 flex items-center gap-1">
                Seleccionar un rol
              </p>
            )}
            {selectedRoleMeta?.description && (
              <p className="text-xs text-gray-500 mt-2">{selectedRoleMeta.description}</p>
            )}
          </div>
        </section>

        {/* Matriz de permisos */}
        {showPermissions && (
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Permisos por módulo</h2>
                <p className="text-sm text-gray-500 mt-0.5">
                  {matrixReadOnly
                    ? 'Vista de solo lectura según el rol seleccionado.'
                    : 'Marca las acciones permitidas para este trabajador.'}
                </p>
              </div>
              {!isCustomRole && (
                <button
                  type="button"
                  onClick={() => applyRoleTemplate(ROLE_TEMPLATE_CUSTOM)}
                  className="text-sm font-medium text-emerald-700 hover:text-emerald-800 whitespace-nowrap"
                >
                  Personalizar permisos →
                </button>
              )}
            </div>

            {isFullAdmin && (
              <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-100 rounded-md px-3 py-2">
                Este rol tiene acceso completo a todos los módulos del ERP.
              </p>
            )}

            <PermissionMatrix
              modules={matrixData.modules}
              actions={matrixData.actions}
              granted={granted}
              readOnly={matrixReadOnly}
              onChange={setGranted}
              loading={matrixLoading}
            />
          </section>
        )}

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-md px-4 py-3">
            {error}
          </div>
        )}

        <div className="flex justify-end pt-2 pb-8">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-6 py-2.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shadow-sm disabled:opacity-60 transition-colors"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : null}
            {saving ? 'Guardando…' : isEdit ? 'Guardar cambios' : 'Enviar invitación'}
          </button>
        </div>
      </form>
    </div>
  )
}
