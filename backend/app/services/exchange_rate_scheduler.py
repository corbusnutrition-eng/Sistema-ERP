"""Schedulers asyncio: sync horario de tasas y reporte matutino 9 AM Ecuador."""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import timedelta

from app.database import SessionLocal
from app.services.exchange_rate_service import (
    send_morning_exchange_rate_report,
    sync_exchange_rates_from_binance,
)
from app.timezone_utils import now_ecuador

logger = logging.getLogger(__name__)

SYNC_INTERVAL_SECONDS = int(os.getenv("EXCHANGE_RATE_SYNC_INTERVAL_SECONDS", "3600") or "3600")
STARTUP_DELAY_SECONDS = int(os.getenv("EXCHANGE_RATE_STARTUP_DELAY_SECONDS", "30") or "30")
MORNING_REPORT_HOUR = int(os.getenv("EXCHANGE_RATE_MORNING_HOUR", "9") or "9")
MORNING_REPORT_MINUTE = int(os.getenv("EXCHANGE_RATE_MORNING_MINUTE", "0") or "0")


def _seconds_until_next_morning_report() -> float:
    """Segundos hasta la próxima ejecución a las 09:00 (America/Guayaquil)."""
    now = now_ecuador()
    target = now.replace(
        hour=MORNING_REPORT_HOUR,
        minute=MORNING_REPORT_MINUTE,
        second=0,
        microsecond=0,
    )
    if now >= target:
        target += timedelta(days=1)
    return max(1.0, (target - now).total_seconds())


async def _exchange_rate_loop(stop_event: asyncio.Event) -> None:
    if STARTUP_DELAY_SECONDS > 0:
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=STARTUP_DELAY_SECONDS)
            return
        except asyncio.TimeoutError:
            pass

    while not stop_event.is_set():
        try:
            db = SessionLocal()
            try:
                synced, failed = sync_exchange_rates_from_binance(db)
                logger.info(
                    "Scheduler exchange rates: synced=%s failed=%s",
                    synced,
                    failed or "—",
                )
            finally:
                db.close()
        except Exception:
            logger.exception("Error en scheduler de exchange rates")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=max(60, SYNC_INTERVAL_SECONDS))
            break
        except asyncio.TimeoutError:
            continue


async def _morning_report_loop(stop_event: asyncio.Event) -> None:
    """Reporte diario de divisas a las 09:00 hora Ecuador (America/Guayaquil)."""
    while not stop_event.is_set():
        delay = _seconds_until_next_morning_report()
        logger.info(
            "Reporte matutino divisas programado en %.0f s (09:00 America/Guayaquil).",
            delay,
        )
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=delay)
            return
        except asyncio.TimeoutError:
            pass

        if stop_event.is_set():
            break

        try:
            db = SessionLocal()
            try:
                send_morning_exchange_rate_report(db)
                logger.info("Reporte matutino de divisas enviado.")
            finally:
                db.close()
        except Exception:
            logger.exception("Error en reporte matutino de divisas")

        # Evita doble disparo si el reloj del sistema oscila en el mismo minuto.
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=90)
            return
        except asyncio.TimeoutError:
            continue


def start_exchange_rate_scheduler() -> tuple[list[asyncio.Task], asyncio.Event]:
    stop_event = asyncio.Event()
    tasks = [
        asyncio.create_task(_exchange_rate_loop(stop_event), name="exchange-rate-sync"),
        asyncio.create_task(_morning_report_loop(stop_event), name="exchange-rate-morning"),
    ]
    return tasks, stop_event


async def stop_exchange_rate_scheduler(
    tasks: list[asyncio.Task],
    stop_event: asyncio.Event,
) -> None:
    stop_event.set()
    for task in tasks:
        task.cancel()
    for task in tasks:
        try:
            await task
        except asyncio.CancelledError:
            pass
