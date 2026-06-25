import { useAuth } from '../context/AuthContext'

/**
 * Hook de conveniencia para comprobar permisos granulares en la UI.
 * @returns {{ permissions: string[], hasPermission: (action: string) => boolean, isAdmin: boolean }}
 */
export default function usePermissions() {
  const { permissions, hasPermission, isAdmin } = useAuth()
  return { permissions, hasPermission, isAdmin }
}
