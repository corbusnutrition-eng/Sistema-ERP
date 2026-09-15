"""Alcance de la auditoría: qué tablas se auditan y por qué se excluyen las demás.

``test_cobertura_exhaustiva_del_alcance`` (tests/test_audit_log.py) falla el
build si alguien añade una tabla nueva a ``Base.metadata`` sin decidir
explícitamente si entra en ``AUDITED`` o en ``EXCLUDED`` — es lo que mantiene
vivo este archivo con el tiempo.
"""

from __future__ import annotations

from typing import NamedTuple


class AuditSpec(NamedTuple):
    table: str
    label: str


# Nota sobre el historial de columnas (before/after de un update): el listener
# (``app.audit.listeners``) usa ``get_history()`` con el passive flag por
# defecto — SIN restringirlo — así que si un atributo viene expirado (p. ej.
# tras un commit previo en la misma Session) SQLAlchemy hace un SELECT
# puntual para poder comparar contra el valor real anterior. No es el riesgo
# que parece para la cascada BaaS: cada nivel se re-consulta fresco vía
# ``SELECT ... FOR UPDATE`` (nunca reutiliza un objeto expirado dentro del
# bucle con locks), así que su historial ya está en memoria y esto no
# dispara SQL adicional ahí. Verificar con ``pytest -m concurrency`` si algún
# cambio futuro reutilizara objetos expirados dentro de ese bucle.
_SPECS: tuple[AuditSpec, ...] = (
    # ═══ Dinero, contabilidad y control de acceso ═══════════════════════════
    AuditSpec("users", "Usuario ERP"),
    AuditSpec("clients", "Cliente / Distribuidor"),
    AuditSpec("sales", "Venta"),
    AuditSpec("client_payments", "Pago de cliente"),
    AuditSpec("payment_allocations", "Aplicación de pago"),
    AuditSpec("client_debt_payments", "Abono de deuda"),
    AuditSpec("wallet_transactions", "Movimiento de billetera"),
    AuditSpec("wallet_recharge_requests", "Solicitud de recarga"),
    AuditSpec("transactions", "Transacción BaaS"),
    AuditSpec("journal_entries", "Asiento contable"),
    AuditSpec("journal_entry_lines", "Línea de asiento"),
    AuditSpec("accounts", "Cuenta contable"),
    AuditSpec("exchange_rates", "Tasa de cambio"),
    AuditSpec("transaction_classes", "Clase contable"),
    # ═══ Inventario, catálogo y cuentas por pagar ═══════════════════════════
    AuditSpec("screen_stock", "Pantalla en bodega"),
    AuditSpec("iptv_accounts", "Cuenta IPTV"),
    AuditSpec("iptv_screens", "Pantalla IPTV"),
    AuditSpec("products", "Producto"),
    AuditSpec("product_package_catalog", "Paquete de producto"),
    AuditSpec("client_product_prices", "Precio asignado a cliente"),
    AuditSpec("distributor_custom_prices", "Precio de distribuidor"),
    AuditSpec("expenses", "Gasto"),
    AuditSpec("expense_lines", "Línea de gasto"),
    AuditSpec("vendors", "Proveedor"),
    AuditSpec("vendor_bills", "Factura de proveedor"),
    AuditSpec("vendor_bill_lines", "Línea de factura de proveedor"),
    AuditSpec("vendor_payments", "Pago a proveedor"),
    AuditSpec("vendor_payment_lines", "Línea de pago a proveedor"),
    AuditSpec("payment_methods", "Método de pago"),
    AuditSpec("client_payment_methods", "Método asignado a cliente"),
    AuditSpec("client_payment_method_accounts", "Cuenta asignada a cliente"),
    AuditSpec("payment_link_templates", "Plantilla de enlace de pago"),
)

AUDITED: dict[str, AuditSpec] = {s.table: s for s in _SPECS}

#: Exclusiones EXPLÍCITAS, con motivo.
EXCLUDED: dict[str, str] = {
    "audit_logs": "auto-referencia: recursión",
    "refresh_tokens": "credenciales de sesión, no un hecho de negocio; ya tiene su propia "
    "trazabilidad (issued_at/revoked_at/replaced_by_jti)",
    "client_notifications": "alto volumen; se generan con bulk_save_objects "
    "(client_notification_service.py) y 'marcar todas leídas' generaría miles de filas de ruido",
    "system_notifications": "ruido operativo interno, sin valor forense",
    "client_notes": "ya es un log append-only visible para el usuario",
    "inventory_audit_reports": "artefacto de reporte, no entidad de negocio",
    "inventory_screen_credit_drawdown": "libro derivado de sales; se audita el origen",
    "tags": "catálogo cosmético (CRM, colores de cliente)",
    "tag_groups": "catálogo cosmético (agrupación de etiquetas de venta)",
    "sale_tags": "catálogo cosmético (etiquetas de venta)",
    "sale_tag_association": "tabla secundaria sin clase ORM propia: la maneja el dependency "
    "processor del flush directamente, los eventos before_flush/after_flush ni siquiera disparan",
    "catalog_package_types": "catálogo estático",
}
