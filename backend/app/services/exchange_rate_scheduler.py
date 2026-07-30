"""Scheduler asyncio: sincroniza tasas Binance P2P cada hora."""

from __future__ import annotations

import asyncio
import logging
import os

from app.database import SessionLocal
from app.services.exchange_rate_service import sync_exchange_rates_from_binance

logger = logging.getLogger(__name__)

SYNC_INTERVAL_SECONDS = int(os.getenv("EXCHANGE_RATE_SYNC_INTERVAL_SECONDS", "3600") or "3600")
STARTUP_DELAY_SECONDS = int(os.getenv("EXCHANGE_RATE_STARTUP_DELAY_SECONDS", "30") or "30")


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


def start_exchange_rate_scheduler() -> tuple[asyncio.Task, asyncio.Event]:
    stop_event = asyncio.Event()
    task = asyncio.create_task(_exchange_rate_loop(stop_event), name="exchange-rate-scheduler")
    return task, stop_event


async def stop_exchange_rate_scheduler(task: asyncio.Task, stop_event: asyncio.Event) -> None:
    stop_event.set()
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
