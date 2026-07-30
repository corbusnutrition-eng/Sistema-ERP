from __future__ import annotations

import logging
import uuid
from decimal import Decimal
from urllib.parse import quote as url_quote

from fastapi import HTTPException, BackgroundTasks, status
from sqlalchemy import func
from sqlalchemy.orm import Session, joinedload

from app.currency_utils import normalize_currency_code
from app.api.v1.sales import (
    SCREEN_STOCK_STATUS_FREE,
    _bind_screen_stock_rows_to_pending_sale,
    _confirm_screen_stock_reserved_rows_on_activation,
    _maybe_with_for_update,
    _merge_reserved_screen_credentials_into_invoice_lines,
    _screen_stock_delivery_credentials,
    _sync_client_after_sale,
)
from app.models.client import Client
from app.models.product import Product
from app.models.sale import Sale, SaleStatus
from app.models.screen_stock import ScreenStock
from app.models.wallet_transaction import WalletTransaction
from app.schemas.client_product_prices import PortalAutoPurchaseResponse
from app.services.client_product_price_service import (
    _get_package_catalog_line,
    _inventory_provider_for_product,
    _norm_provider,
    _package_display_name,
    _package_base_cost_usd,
    get_client_package_price_row,
    resolve_client_package_sale_price_usd,
    validate_custom_price_vs_package_cost,
)

# Autocompra portal: la billetera BaaS opera en USD (wallet_credit_usd / saldo USD).
PORTAL_WALLET_AUTO_PURCHASE_CURRENCY = "USD"
from app.services.sale_accounting_sync import sync_sale_accounting_ledgers

logger = logging.getLogger(__name__)

TX_AUTO_PURCHASE = "auto_purchase"


def _portal_credential_from_screen_row(row: ScreenStock) -> dict[str, object]:
    user = (row.iptv_username or "").strip() or None
    pwd = (row.iptv_password or "").strip() or None
    return {
        "screen_stock_id": int(row.id),
        "iptv_username": user,
        "iptv_password": pwd,
        "username": user,
        "password": pwd,
    }


def _portal_credentials_from_screen_rows(rows: list[ScreenStock]) -> list[dict[str, object]]:
    return [_portal_credential_from_screen_row(r) for r in rows]


def _any_portal_credentials_missing(credentials: list[dict[str, object]]) -> bool:
    if not credentials:
        return True
    for c in credentials:
        if not (c.get("iptv_username") or c.get("username")) or not (
            c.get("iptv_password") or c.get("password")
        ):
            return True
    return False


def _build_cp_inventory_key(product_id: int, package: str, provider: str) -> str:
    return f"cp|{int(product_id)}|{url_quote(package, safe='')}|{url_quote(provider, safe='')}"


def _pick_free_flujo_package_screens(
    db: Session,
    *,
    product_id: int,
    package_label: str,
    qty: int,
    inventory_provider: str,
) -> list[ScreenStock]:
    pkg = (package_label or "").strip().lower()
    prov = _norm_provider(inventory_provider)
    if qty < 1 or not pkg:
        return []
    q = (
        db.query(ScreenStock)
        .filter(
            ScreenStock.product_id == int(product_id),
            ScreenStock.status == SCREEN_STOCK_STATUS_FREE,
            ScreenStock.sale_id.is_(None),
            func.lower(func.trim(ScreenStock.provider)) == prov,
            func.lower(func.trim(ScreenStock.package)) == pkg,
        )
        .order_by(ScreenStock.created_at.asc(), ScreenStock.id.asc())
        .limit(int(qty))
    )
    rows = _maybe_with_for_update(q, db).all()
    return list(rows)


BAAS_WALLET_AUTO_PURCHASE_NOTE = "Autocompra portal BaaS — Flujo"


def _settle_baas_wallet_auto_purchase_sale_cxc(
    db: Session,
    client: Client,
    sale: Sale,
) -> None:
    """
    Cierra CxC de la autocompra BaaS: el cobro ya ocurrió vía débito de billetera.

    Registra ``ClientPayment`` aprobado + ``PaymentAllocation`` sin asiento bancario.
    """
    from app.models.client_payment import ClientPayment, ClientPaymentStatus, PaymentAllocation
    from app.services.client_payment_service import (
        next_payment_number,
        refresh_sale_status_after_payment,
        sync_sale_amount_paid_from_allocations,
        _sale_invoice_total,
    )
    from app.timezone_utils import now_ecuador

    real_total = _sale_invoice_total(db, sale)
    if real_total <= Decimal("0.00005"):
        return

    now = now_ecuador()
    cur = normalize_currency_code(str(sale.currency or "USD"))
    cp = ClientPayment(
        payment_number=next_payment_number(db),
        client_id=int(client.id),
        amount=real_total,
        currency=cur,
        exchange_rate=float(sale.exchange_rate or 1.0),
        status=ClientPaymentStatus.approved,
        payment_method_id=None,
        payment_method="Saldo BaaS",
        reference_number=f"BAAS-AUT-{int(sale.id)}",
        receipt_file_url=None,
        deposit_account_id=None,
        notes=(
            f"BAAS_WALLET_AUTO_PURCHASE=1\n"
            f"META_SALE_ID={int(sale.id)}\n"
            f"{BAAS_WALLET_AUTO_PURCHASE_NOTE} — cobro con billetera virtual."
        ),
        created_at=now,
        approved_at=now,
    )
    db.add(cp)
    db.flush()
    db.add(
        PaymentAllocation(
            payment_id=int(cp.id),
            sale_id=int(sale.id),
            amount_applied=real_total,
        )
    )
    db.flush()
    sync_sale_amount_paid_from_allocations(db, sale)
    refresh_sale_status_after_payment(db, sale)
    db.add(sale)


def _debit_client_wallet(
    db: Session,
    client: Client,
    amount: float,
    *,
    currency: str = "USD",
    product_name: str,
    sale_id: int,
) -> None:
    from app.services.wallet_balance_service import (
        resolve_client_portal_wallet_for_auto_purchase,
        subtract_client_wallet_balance,
    )

    bal, debit_cur = resolve_client_portal_wallet_for_auto_purchase(client)
    if float(bal) + 1e-9 < amount:
        cur = normalize_currency_code(debit_cur, "USD")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Saldo BaaS insuficiente en {cur} para completar la compra.",
        )
    subtract_client_wallet_balance(db, client, debit_cur, amount)
    db.add(client)
    db.add(
        WalletTransaction(
            user_id=None,
            client_id=int(client.id),
            amount=-float(amount),
            transaction_type=TX_AUTO_PURCHASE,
            description=f"Autocompra portal: {product_name} (venta #{sale_id})",
        )
    )


def execute_portal_auto_purchase(
    db: Session,
    *,
    client: Client,
    package_catalog_id: int,
    quantity: int = 1,
    end_customer_name: str | None = None,
    end_customer_phone: str | None = None,
    precio_venta: float | None = None,
    background_tasks: BackgroundTasks | None = None,
) -> PortalAutoPurchaseResponse:
    qty = int(quantity)
    if qty < 1 or qty > 200:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La cantidad debe estar entre 1 y 200.",
        )

    price_row = get_client_package_price_row(
        db,
        client_id=int(client.id),
        package_catalog_id=int(package_catalog_id),
    )
    catalog_line, product = _get_package_catalog_line(db, int(package_catalog_id))
    if price_row is None:
        price_row = get_client_package_price_row(
            db,
            client_id=int(client.id),
            package_catalog_id=int(package_catalog_id),
            product_id=int(product.id),
        )
    if price_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Este paquete Flujo no tiene un precio de venta asignado para tu cuenta.",
        )

    pkg_label = (catalog_line.package_label or "").strip()
    if not pkg_label:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Paquete sin etiqueta válida.")

    try:
        unit_price_usd = resolve_client_package_sale_price_usd(price_row)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc) or "Precio USD no configurado para este paquete.",
        ) from exc

    cost = _package_base_cost_usd(db, product=product, catalog_line=catalog_line)
    validate_custom_price_vs_package_cost(custom_price=unit_price_usd, cost_usd=cost)

    total_price_usd = round(unit_price_usd * qty, 4)
    display = _package_display_name(pkg_label)
    sale_xr = 1.0

    from app.services.wallet_balance_service import (
        lock_client_for_wallet_update,
        resolve_client_portal_wallet_balance_usd,
    )

    inv_prov = _inventory_provider_for_product(product)
    picked = _pick_free_flujo_package_screens(
        db,
        product_id=int(product.id),
        package_label=pkg_label,
        qty=qty,
        inventory_provider=inv_prov,
    )

    inv_key = _build_cp_inventory_key(int(product.id), pkg_label, inv_prov)
    inv_base = [
        {
            "description": display,
            "qty": qty,
            "rate": unit_price_usd,
            "amount": total_price_usd,
            "line_inventory_kind": "screen_stock",
            "inventory_option_key": inv_key,
        }
    ]

    amount_dec = Decimal(str(total_price_usd))
    credentials: list[dict] = []
    fulfilled = 0
    flow = "pending_assignment"
    message = "Solicitud enviada, en espera de asignación de pantalla."
    creds_missing = False

    ec_name = (end_customer_name or "").strip() or None
    ec_phone = (end_customer_phone or "").strip() or None
    if ec_name and len(ec_name) > 200:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El nombre del cliente final es demasiado largo (máx. 200 caracteres).",
        )
    if ec_phone and len(ec_phone) > 30:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El teléfono del cliente final es demasiado largo (máx. 30 caracteres).",
        )
    ec_price: Decimal | None = None
    if precio_venta is not None:
        try:
            price_f = float(precio_venta)
        except (TypeError, ValueError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El precio de venta al cliente final no es válido.",
            ) from None
        if price_f < 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="El precio de venta al cliente final no puede ser negativo.",
            )
        ec_price = Decimal(str(round(price_f, 4)))

    try:
        inventory_tg: list[str] = []
        client = lock_client_for_wallet_update(db, client)

        client_balance = float(resolve_client_portal_wallet_balance_usd(client))
        logger.info(
            "Auto-purchase intent: Client USD Balance=%s, Cost USD=%s",
            client_balance,
            total_price_usd,
        )
        if client_balance + 1e-9 < total_price_usd:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Saldo BaaS insuficiente en USD.",
            )

        sale = Sale(
            client_id=int(client.id),
            product_id=int(product.id),
            iptv_screen_id=None,
            screen_stock_id=None,
            amount=amount_dec,
            currency=PORTAL_WALLET_AUTO_PURCHASE_CURRENCY,
            exchange_rate=sale_xr,
            local_amount=amount_dec,
            amount_paid=amount_dec,
            status=SaleStatus.payment_submitted,
            payment_token=uuid.uuid4(),
            receipt_url=None,
            expires_at=None,
            credits_quantity=None,
            inventory_provider=inv_prov,
            inventory_channel="screen_stock",
            inventory_package=pkg_label,
            inventory_screen_units=qty,
            class_id=getattr(product, "transaction_class_id", None),
            payment_method_id=None,
            deposit_account_id=None,
            notes=BAAS_WALLET_AUTO_PURCHASE_NOTE,
            end_customer_name=ec_name,
            end_customer_phone=ec_phone,
            end_customer_sale_price=ec_price,
            invoice_lines=inv_base,
            allowed_payment_methods=None,
            allowed_deposit_accounts=None,
        )
        db.add(sale)
        db.flush()

        _debit_client_wallet(
            db,
            client,
            total_price_usd,
            currency=PORTAL_WALLET_AUTO_PURCHASE_CURRENCY,
            product_name=display,
            sale_id=int(sale.id),
        )

        _settle_baas_wallet_auto_purchase_sale_cxc(db, client, sale)

        from app.services.baas_commission_cascade_service import distribute_baas_commission_cascade

        try:
            distribute_baas_commission_cascade(
                db,
                buyer=client,
                package_catalog_id=int(package_catalog_id),
                quantity=qty,
                sale_id=int(sale.id),
                purchase_currency=PORTAL_WALLET_AUTO_PURCHASE_CURRENCY,
                unit_price_paid=float(unit_price_usd),
                product_name=display,
                product=product,
                catalog_line=catalog_line,
            )
        except HTTPException:
            raise
        except Exception as exc:
            logger.exception(
                "Cascada de comisiones falló en autocompra portal sale_id=%s client_id=%s package_catalog_id=%s",
                sale.id,
                client.id,
                package_catalog_id,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Error interno al procesar comisiones",
            ) from exc

        if len(picked) >= qty:
            inventory_tg = _bind_screen_stock_rows_to_pending_sale(db, sale, picked)
            sale.screen_stock_id = int(picked[0].id)
            inv_merged = _merge_reserved_screen_credentials_into_invoice_lines(inv_base, picked) or inv_base
            sale.invoice_lines = inv_merged
            db.add(sale)
            db.flush()

            _confirm_screen_stock_reserved_rows_on_activation(db, sale)
            sale.status = SaleStatus.approved
            _sync_client_after_sale(client, sale)
            db.flush()
            sync_sale_accounting_ledgers(db, sale, strict=True, strict_cogs=False)
            db.refresh(sale)
            for row in picked:
                db.refresh(row)
            fulfilled = qty
            credentials = _portal_credentials_from_screen_rows(picked)
            if _any_portal_credentials_missing(credentials):
                delivery = _screen_stock_delivery_credentials(db, sale)
                if delivery:
                    credentials = [
                        {
                            "screen_stock_id": int(cred.screen_stock_id),
                            "iptv_username": cred.iptv_username,
                            "iptv_password": cred.iptv_password,
                            "username": cred.iptv_username,
                            "password": cred.iptv_password,
                        }
                        for cred in delivery
                    ]
            creds_missing = _any_portal_credentials_missing(credentials)
            message = (
                f"Compra completada ({qty} pantalla{'s' if qty != 1 else ''}). "
                + (
                    "Tus credenciales están listas."
                    if not creds_missing
                    else "Pantalla asignada; revisa las credenciales abajo."
                )
            )
            flow = "fulfilled"
        else:
            sale.notes = (
                "Autocompra portal BaaS — Flujo: solicitud enviada, en espera de asignación de pantalla."
            )
            db.add(sale)
            message = "Solicitud enviada, en espera de asignación de pantalla."
            flow = "pending_assignment"

        creds_missing = flow == "fulfilled" and _any_portal_credentials_missing(credentials)

        db.commit()
        from app.services.inventory_alert_service import schedule_inventory_telegram_messages

        schedule_inventory_telegram_messages(background_tasks, inventory_tg)
    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        logger.exception(
            "Autocompra portal falló client_id=%s package_catalog_id=%s qty=%s",
            client.id,
            package_catalog_id,
            qty,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Error interno al procesar la compra. No se realizaron cargos.",
        ) from exc

    db.refresh(client)
    db.refresh(sale)

    from app.schemas.client_product_prices import PortalAutoPurchaseCredential

    from app.services.wallet_balance_service import resolve_client_portal_wallet_balance_usd

    return PortalAutoPurchaseResponse(
        ok=True,
        flow=flow,
        message=message,
        sale_id=int(sale.id),
        wallet_balance_remaining=float(resolve_client_portal_wallet_balance_usd(client)),
        quantity_requested=qty,
        quantity_fulfilled=fulfilled,
        credentials=[
            PortalAutoPurchaseCredential(
                screen_stock_id=int(c["screen_stock_id"]),
                iptv_username=c.get("iptv_username"),
                iptv_password=c.get("iptv_password"),
                username=c.get("username"),
                password=c.get("password"),
            )
            for c in credentials
        ],
        credentials_missing=creds_missing,
    )
