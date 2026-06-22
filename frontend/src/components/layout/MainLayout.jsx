import Sidebar from './Sidebar'
import Header from './Header'
import GlobalModals from './GlobalModals'
import WebCatalogSyncPoller from './WebCatalogSyncPoller'

export default function MainLayout({ children }) {
  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <WebCatalogSyncPoller />
      {/* Fixed sidebar */}
      <Sidebar />

      {/* Main column: header + scrollable content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header />

        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>

      {/* Global modals — rendered outside the scroll container so they always overlay */}
      <GlobalModals />
    </div>
  )
}
