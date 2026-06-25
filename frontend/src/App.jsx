import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ModalProvider } from './context/ModalContext'
import { AuthProvider, useAuth } from './context/AuthContext'
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
import DistributorsBaaSPage from './features/settings/DistributorsBaaS'
import DistributorTreeMap from './features/settings/DistributorTreeMap'
import ReportsDashboard from './features/reports/ReportsDashboard'
import ReportStandardPlaceholder from './features/reports/ReportStandardPlaceholder'
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

function AdminRoute({ children }) {
  const { user } = useAuth()
  if (!user || user.role !== 'admin') {
    return <Navigate to="/clientes" replace />
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
  const { user, hasAnyBaasAccess } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (user.role === 'admin') return <Navigate to="/dashboard" replace />
  if (hasAnyBaasAccess) return <Navigate to="/equipo/distribuidores" replace />
  return <Navigate to="/clientes" replace />
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
                    <Route path="/dashboard" element={<AdminRoute><Dashboard /></AdminRoute>} />
                    <Route path="/inventario" element={<AdminRoute><Inventory /></AdminRoute>} />
                    <Route path="/contabilidad" element={<AdminRoute><Navigate to="/contabilidad/plan-de-cuentas" replace /></AdminRoute>} />
                    <Route path="/contabilidad/plan-de-cuentas" element={<AdminRoute><ChartOfAccounts /></AdminRoute>} />
                    <Route path="/contabilidad/cuenta/:id" element={<AdminRoute><AccountHistoryPage /></AdminRoute>} />
                    <Route path="/contabilidad/conciliar/:accountId" element={<AdminRoute><Conciliar /></AdminRoute>} />
                    <Route path="/contabilidad/conciliar" element={<AdminRoute><Conciliar /></AdminRoute>} />
                    <Route path="/contabilidad/cuentas-por-cobrar" element={<AdminRoute><AccountsReceivable /></AdminRoute>} />
                    <Route path="/contabilidad/resumen" element={<AdminRoute><Accounting /></AdminRoute>} />
                    <Route path="/contabilidad/gastos" element={<AdminRoute><ExpensesList /></AdminRoute>} />
                    <Route path="/contabilidad/proveedores" element={<AdminRoute><VendorsList /></AdminRoute>} />
                    <Route path="/contabilidad/proveedores/:vendorId" element={<AdminRoute><VendorDetail /></AdminRoute>} />
                    <Route path="/informes" element={<AdminRoute><ReportsDashboard /></AdminRoute>} />
                    <Route
                      path="/informes/standard/:sectionId/:reportId"
                      element={<AdminRoute><ReportStandardPlaceholder /></AdminRoute>}
                    />
                    <Route path="/informes/clases" element={<AdminRoute><ClassList /></AdminRoute>} />
                    <Route path="/listas" element={<AdminRoute><ListsDashboard /></AdminRoute>} />
                    <Route path="/listas/metodos-pago" element={<AdminRoute><PaymentMethodsList /></AdminRoute>} />
                    <Route path="/listas/monedas" element={<AdminRoute><CurrenciesList /></AdminRoute>} />
                    <Route path="/listas/etiquetas" element={<AdminRoute><TagsList /></AdminRoute>} />
                    <Route path="/equipo" element={<AdminRoute><UsersPage /></AdminRoute>} />
                    <Route path="/equipo/distribuidores" element={<BaasRoute><DistributorsBaaSPage /></BaasRoute>} />
                    <Route
                      path="/equipo/distribuidores/:uuid/arbol"
                      element={<BaasRoute><DistributorTreeMap /></BaasRoute>}
                    />

                    <Route path="/clientes/:clientId" element={<ClientDetail />} />
                    <Route path="/clientes" element={<Clientes />} />
                    <Route path="/ventas" element={<Sales />} />
                    <Route path="/suscripciones" element={<Subscriptions />} />

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
