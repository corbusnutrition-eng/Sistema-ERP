import { useState, useCallback } from 'react'
import Sidebar from './Sidebar'
import Header from './Header'
import GlobalModals from './GlobalModals'
import WebCatalogSyncPoller from './WebCatalogSyncPoller'

export default function MainLayout({ children }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  const closeMobileNav = useCallback(() => setMobileNavOpen(false), [])
  const toggleMobileNav = useCallback(() => setMobileNavOpen((o) => !o), [])

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <WebCatalogSyncPoller />

      {/* Backdrop: cierra el menú al tocar fuera (solo móvil/tablet) */}
      {mobileNavOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          aria-label="Cerrar menú"
          onClick={closeMobileNav}
        />
      )}

      <Sidebar mobileOpen={mobileNavOpen} onMobileClose={closeMobileNav} />

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header onMenuClick={toggleMobileNav} mobileNavOpen={mobileNavOpen} />

        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {children}
        </main>
      </div>

      <GlobalModals />
    </div>
  )
}
