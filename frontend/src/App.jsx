import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ModalProvider } from './context/ModalContext'
import { AuthProvider, useAuth } from './context/AuthContext'
import { PERMS, hasAnyPermissionPrefix, hasAnyBaasPermission, hasPermission as checkPermission } from './lib/permissions'
import {
  getPrimaryAssignedAccountPath,
  isRestrictedLedgerUser,
  resolvePostLoginPath,
} from './lib/permissionMatrix'
import { InventoryDataProvider } from './context/InventoryDataContext'
import MainLayout from './components/layout/MainLayout'
import Dashboard from './pages/Dashboard'
import Clientes from './pages/Clientes'
import ClientDetail from './pages/ClientDetail'
import Inventory from './features/inventory/Inventory'
import Sales from './features/sales/Sales'
import Login from './features/auth/Login'
import Accounting from './features/accounting/Accounting'
import ExpensesList from './features/expenses/ExpensesList'
import VendorsList from './features/vendors/VendorsList'
import VendorDetail from './features/vendors/VendorDetail'
import ChartOfAccounts from './features/accounting/ChartOfAccounts'
import AccountHistoryPage from './features/accounting/AccountHistoryPage'
import Conciliar from './features/accounting/Conciliar'
import AccountsReceivable from './features/accounting/AccountsReceivable'
import Subscriptions from './features/subscriptions/Subscriptions'
import PaymentPage from './features/public/PaymentPage'
import CheckoutPage from './features/public/CheckoutPage'
import ClientPortalPage from './features/public/ClientPortalPage'
import RechargePortalPage from './features/public/RechargePortalPage'
import UsersPage from './features/settings/Users'
import UserFormPage from './features/settings/UserFormPage'
import DistributorsBaaSPage from './features/settings/DistributorsBaaS'
import DistributorTreeMap from './features/settings/DistributorTreeMap'
import ReportsDashboard from './features/reports/ReportsDashboard'
import ReportStandardPlaceholder from './features/reports/ReportStandardPlaceholder'
import ListClassificationReport from './features/reports/ListClassificationReport'
import ClassList from './features/reports/ClassList'
import ListsDashboard from './features/lists/ListsDashboard'
import PaymentMethodsList from './features/lists/PaymentMethodsList'
import CurrenciesList from './features/lists/CurrenciesList'
import TagsList from './features/lists/TagsList'
function AuthLoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <p className="text-sm text-slate-500">Cargando sesión…</p>
    </div>
  )
}

function ProtectedRoute({ children }) {
  const { loading, user } = useAuth()
  const hasToken = Boolean(localStorage.getItem('access_token'))

  if (hasToken && loading) {
    return <AuthLoadingScreen />
  }
  if (!hasToken || !user) {
    return <Navigate to="/login" replace />
  }
  return children
}

function PermissionRoute({ permission, permissionAny, children, fallback = '/clientes' }) {
  const { user, hasPermission, permissions } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (user.role === 'admin') return children
  if (permission && !hasPermission(permission)) {
    return <Navigate to={fallback} replace />
  }
  if (permissionAny && !hasAnyPermissionPrefix(user.role, permissions, permissionAny)) {
    return <Navigate to={fallback} replace />
  }
  return children
}

function BaasRoute({ children }) {
  const { user, hasAnyBaasAccess } = useAuth()
  if (!user || (!hasAnyBaasAccess && user.role !== 'admin')) {
    return <Navigate to="/clientes" replace />
  }
  return children
}

function DefaultRedirect() {
  const { user, permissions } = useAuth()
  const destination = resolvePostLoginPath(user, {
    hasPermission: (perm) => checkPermission(user?.role, permissions, perm),
    hasAnyBaasPermission,
  })
  return <Navigate to={destination} replace />
}

function AccountingHomeRedirect() {
  const { user } = useAuth()
  const ledgerPath = getPrimaryAssignedAccountPath(user)
  if (isRestrictedLedgerUser(user) && ledgerPath) {
    return <Navigate to={ledgerPath} replace />
  }
  return <Navigate to="/contabilidad/plan-de-cuentas" replace />
}

function DashboardPage() {
  const { user } = useAuth()
  const ledgerPath = getPrimaryAssignedAccountPath(user)
  if (isRestrictedLedgerUser(user) && ledgerPath) {
    return <Navigate to={ledgerPath} replace />
  }
  return <Dashboard />
}

function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/pay/:paymentId" element={<PaymentPage />} />
        <Route path="/checkout/:token" element={<CheckoutPage />} />
        <Route path="/portal/recharge/:linkHash" element={<RechargePortalPage />} />
        <Route path="/portal/:token" element={<ClientPortalPage />} />

        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <InventoryDataProvider>
                <MainLayout>
                  <Routes>
                    <Route path="/dashboard" element={<PermissionRoute permission={PERMS.DASHBOARD_VIEW}><DashboardPage /></PermissionRoute>} />
                    <Route path="/inventario" element={<PermissionRoute permission={PERMS.INVENTORY_VIEW}><Inventory /></PermissionRoute>} />
                    <Route path="/contabilidad" element={<PermissionRoute permissionAny="accounting"><AccountingHomeRedirect /></PermissionRoute>} />
                    <Route path="/contabilidad/plan-de-cuentas" element={<PermissionRoute permission={PERMS.ACCOUNTING_CHART_VIEW}><ChartOfAccounts /></PermissionRoute>} />
                    <Route path="/contabilidad/cuenta/:id" element={<PermissionRoute permission={PERMS.ACCOUNTING_CHART_VIEW}><AccountHistoryPage /></PermissionRoute>} />
                    <Route path="/contabilidad/conciliar/:accountId" element={<PermissionRoute permission={PERMS.ACCOUNTING_RECONCILE_VIEW}><Conciliar /></PermissionRoute>} />
                    <Route path="/contabilidad/conciliar" element={<PermissionRoute permission={PERMS.ACCOUNTING_RECONCILE_VIEW}><Conciliar /></PermissionRoute>} />
                    <Route path="/contabilidad/cuentas-por-cobrar" element={<PermissionRoute permission={PERMS.ACCOUNTING_RECEIVABLES_VIEW}><AccountsReceivable /></PermissionRoute>} />
                    <Route path="/contabilidad/resumen" element={<PermissionRoute permissionAny="accounting"><Accounting /></PermissionRoute>} />
                    <Route path="/contabilidad/gastos" element={<PermissionRoute permission={PERMS.ACCOUNTING_EXPENSES_VIEW}><ExpensesList /></PermissionRoute>} />
                    <Route path="/contabilidad/proveedores" element={<PermissionRoute permission={PERMS.ACCOUNTING_VENDORS_VIEW}><VendorsList /></PermissionRoute>} />
                    <Route path="/contabilidad/proveedores/:vendorId" element={<PermissionRoute permission={PERMS.ACCOUNTING_VENDORS_VIEW}><VendorDetail /></PermissionRoute>} />
                    <Route path="/informes" element={<PermissionRoute permission={PERMS.REPORTS_FINANCIAL_VIEW}><ReportsDashboard /></PermissionRoute>} />
                    <Route
                      path="/informes/standard/:sectionId/:reportId"
                      element={<PermissionRoute permission={PERMS.REPORTS_FINANCIAL_VIEW}><ReportStandardPlaceholder /></PermissionRoute>}
                    />
                    <Route
                      path="/informes/clasificacion-listas"
                      element={<PermissionRoute permission={PERMS.REPORTS_FINANCIAL_VIEW}><ListClassificationReport /></PermissionRoute>}
                    />
                    <Route path="/informes/clases" element={<PermissionRoute permission={PERMS.REPORTS_CLASSES_VIEW}><ClassList /></PermissionRoute>} />
                    <Route path="/listas" element={<PermissionRoute permission={PERMS.REPORTS_LISTS_VIEW}><ListsDashboard /></PermissionRoute>} />
                    <Route path="/listas/metodos-pago" element={<PermissionRoute permission={PERMS.REPORTS_LISTS_VIEW}><PaymentMethodsList /></PermissionRoute>} />
                    <Route path="/listas/monedas" element={<PermissionRoute permission={PERMS.REPORTS_LISTS_VIEW}><CurrenciesList /></PermissionRoute>} />
                    <Route path="/listas/etiquetas" element={<PermissionRoute permission={PERMS.REPORTS_LISTS_VIEW}><TagsList /></PermissionRoute>} />
                    <Route path="/equipo" element={<PermissionRoute permission={PERMS.TEAM_USERS_VIEW}><UsersPage /></PermissionRoute>} />
                    <Route path="/equipo/nuevo" element={<PermissionRoute permission={PERMS.TEAM_USERS_VIEW}><UserFormPage /></PermissionRoute>} />
                    <Route path="/equipo/:userId/editar" element={<PermissionRoute permission={PERMS.TEAM_USERS_VIEW}><UserFormPage /></PermissionRoute>} />
                    <Route path="/equipo/distribuidores" element={<BaasRoute><DistributorsBaaSPage /></BaasRoute>} />
                    <Route
                      path="/equipo/distribuidores/:uuid/arbol"
                      element={
                        <PermissionRoute permission={PERMS.BAAS_TREE_VIEW}>
                          <DistributorTreeMap />
                        </PermissionRoute>
                      }
                    />

                    <Route path="/clientes/:clientId" element={<PermissionRoute permission={PERMS.CLIENTS_VIEW}><ClientDetail /></PermissionRoute>} />
                    <Route path="/clientes" element={<PermissionRoute permission={PERMS.CLIENTS_VIEW}><Clientes /></PermissionRoute>} />
                    <Route path="/ventas" element={<PermissionRoute permissionAny="sales"><Sales /></PermissionRoute>} />
                    <Route path="/suscripciones" element={<PermissionRoute permission={PERMS.SALES_SUBSCRIPTIONS_VIEW}><Subscriptions /></PermissionRoute>} />

                    <Route path="/" element={<DefaultRedirect />} />
                    <Route path="*" element={<DefaultRedirect />} />
                  </Routes>
                </MainLayout>
              </InventoryDataProvider>
            </ProtectedRoute>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}

function App() {
  return (
    <ModalProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ModalProvider>
  )
}

export default App
