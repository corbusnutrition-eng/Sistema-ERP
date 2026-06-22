"""
Taxonomía del plan de cuentas (categoría matriz → tipo → detalle).

Fuente de verdad compartida con ``frontend/src/features/accounting/accountStructure.js``.
Los valores ``account_type`` persistidos en BD son los tipos ledger en inglés (QuickBooks).
"""

from __future__ import annotations

from typing import TypedDict


class AccountGroup(TypedDict, total=False):
    tipo: str
    account_type: str
    detalles: list[str]
    uses_payment_methods: bool


EFECTIVO_EQUIVALENTES_TIPO = "Efectivo y equivalentes"

# Categoría matriz → grupos (tipo de cuenta → detalles permitidos).
ACCOUNT_STRUCTURE: dict[str, list[AccountGroup]] = {
    "ACTIVOS": [
        {
            "tipo": "Activos Corrientes",
            "account_type": "asset",
            "detalles": [
                "Inventario",
                "Fondos sin depositar",
                "Anticipo empleados",
            ],
        },
        {
            "tipo": EFECTIVO_EQUIVALENTES_TIPO,
            "account_type": "asset",
            "detalles": [],
            "uses_payment_methods": True,
        },
    ],
    "RESPONSABILIDAD": [
        {
            "tipo": "Cuentas por pagar",
            "account_type": "liability",
            "detalles": [
                "Cuentas por pagar",
                "Anticipos de clientes",
                "Saldos a favor",
            ],
        },
    ],
    "INGRESOS": [
        {
            "tipo": "Ingresos",
            "account_type": "income",
            "detalles": [
                "Venta de productos y Servicios",
                "Ingresos recarga de saldo",
                "Otros ingresos principales",
            ],
        },
    ],
    "GASTO": [
        {
            "tipo": "Gastos",
            "account_type": "expense",
            "detalles": [
                "Deudas incobrables",
                "Gastos administrativos",
                "Gasto nómina",
                "Tasas y comisiones",
                "Publicidad y Promoción",
                "Reparación y mantenimiento",
                "Suministros y materiales",
                "Comida y ocio",
                "Servicios varios",
            ],
        },
        {
            "tipo": "Costos de venta",
            "account_type": "cost_of_sales",
            "detalles": ["Descuentos", "Otros"],
        },
        {
            "tipo": "Otros gastos",
            "account_type": "expense",
            "detalles": [
                "Pérdida de cambio",
                "Otros gastos",
                "Liquidaciones",
            ],
        },
    ],
}

# Alias legacy (BD antigua / migraciones) → detalle canónico actual.
LEGACY_DETAIL_TYPE_ALIASES: dict[str, str] = {
    "Gasto nomina": "Gasto nómina",
    "Publicidad y Promocion": "Publicidad y Promoción",
    "Reparacion y mantenimiento": "Reparación y mantenimiento",
    "Comida y osio": "Comida y ocio",
    "Perdida de cambio": "Pérdida de cambio",
    "otros gastos": "Otros gastos",
    "otros": "Otros",
    "descuentos": "Descuentos",
    "Ganancia por tipo de cambio": "Otros ingresos principales",
}

LIQUID_DEPOSIT_DETAIL_TYPES: frozenset[str] = frozenset({"Fondos sin depositar"})


def group_uses_payment_methods(tipo: str) -> bool:
    for grupos in ACCOUNT_STRUCTURE.values():
        for g in grupos:
            if g.get("tipo") == tipo:
                return bool(g.get("uses_payment_methods"))
    return False


def is_efectivo_equivalentes_detail(*, linked_payment_method: str | None) -> bool:
    return bool((linked_payment_method or "").strip())


def normalize_detail_type(value: str | None) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    return LEGACY_DETAIL_TYPE_ALIASES.get(s, s)


def all_detail_types() -> frozenset[str]:
    out: set[str] = set()
    for grupos in ACCOUNT_STRUCTURE.values():
        for g in grupos:
            if g.get("uses_payment_methods"):
                continue
            out.update(g.get("detalles") or [])
    return frozenset(out)


def detail_types_for_ledger(account_type: str) -> frozenset[str]:
    out: set[str] = set()
    for grupos in ACCOUNT_STRUCTURE.values():
        for g in grupos:
            if g.get("uses_payment_methods"):
                continue
            if g.get("account_type") == account_type:
                out.update(g.get("detalles") or [])
    return frozenset(out)


def validate_linked_payment_method_name(db, name: str | None) -> str:
    """Comprueba que el nombre exista en ``payment_methods`` activos. Devuelve nombre normalizado."""
    from app.models.payment_method import PaymentMethod

    raw = (name or "").strip()
    if not raw:
        raise ValueError("Selecciona un método de pago para la cuenta de efectivo y equivalentes.")
    row = (
        db.query(PaymentMethod)
        .filter(
            PaymentMethod.is_active.is_(True),
            PaymentMethod.name == raw,
        )
        .first()
    )
    if row is None:
        raise ValueError(f"El método de pago «{raw}» no existe o está inactivo.")
    return str(row.name)


def validate_chart_account_classification(
    *,
    account_type: str,
    detail_type: str | None,
    linked_payment_method: str | None = None,
) -> None:
    """Valida par (account_type, detail_type) contra la taxonomía maestra. Lanza ValueError."""
    dt_raw = (detail_type or "").strip()
    lp = (linked_payment_method or "").strip()

    if lp:
        if account_type != "asset":
            raise ValueError("Solo las cuentas de activo pueden vincular un método de pago.")
        # Efectivo y equivalentes: detalle dinámico (= nombre del método de pago).
        return

    if not dt_raw:
        raise ValueError("Indica el tipo de detalle de la cuenta.")

    dt = normalize_detail_type(dt_raw) or dt_raw
    allowed = detail_types_for_ledger(account_type)
    if dt not in allowed:
        allowed_txt = ", ".join(sorted(allowed))
        raise ValueError(
            f"Tipo de detalle «{dt_raw}» no permitido para account_type «{account_type}». "
            f"Valores válidos: {allowed_txt}."
        )
