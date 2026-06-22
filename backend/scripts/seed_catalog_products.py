#!/usr/bin/env python3
"""
Semilla del catálogo IPTV para venta al público.

Uso (desde la raíz backend, con virtualenv activado):
  PYTHONPATH=. python scripts/seed_catalog_products.py

Idempotente: no crea duplicados con el mismo nombre + proveedor IPTV (texto).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.product import Product, TargetAudience

USD = 10.0
LIST_CURRENCY = "USD"

ROWS: list[tuple[str, str]] = [
    ("1 MES TODO", "Flujo"),
    ("3 MESES TODO", "Flujo"),
    ("6+1 MESES TODO", "Flujo"),
    ("12+2 MESES TODO", "Flujo"),
    ("1 MES + 3 DISPOSITIVOS", "Stella"),
    ("3 MESES + 3 DISPOSITIVOS", "Stella"),
    ("6 MESES + 1 MESES(PRO GRATIS) + 4 DISPOSITIVOS", "Stella"),
    ("12 MESES + 2 MESES (PRO GRATIS) + 4 DISPOSITIVOS", "Stella"),
]


def run(db: Session) -> int:
    created = 0
    for name, iptv_prov in ROWS:
        exists = db.query(Product).filter(Product.name == name, Product.iptv_provider == iptv_prov).first()
        if exists:
            continue
        db.add(
            Product(
                name=name,
                product_type="credito_normal",
                service_type="Paquete público",
                iptv_provider=iptv_prov,
                target_audience=TargetAudience.cliente,
                listing_price=USD,
                listing_currency=LIST_CURRENCY,
                description=None,
                is_active=True,
            )
        )
        created += 1
    db.commit()
    return created


def main() -> None:
    db = SessionLocal()
    try:
        n = run(db)
        print(f"Catálogo: {n} producto(s) nuevos insertados ({len(ROWS)} filas conocidas).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
