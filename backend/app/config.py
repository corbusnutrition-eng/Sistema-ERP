"""Configuración centralizada desde variables de entorno."""

from __future__ import annotations

import os
from functools import lru_cache


class Settings:
    TELEGRAM_BOT_TOKEN: str = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
    TELEGRAM_CHAT_ID: str = (os.getenv("TELEGRAM_CHAT_ID") or "").strip()

    @property
    def telegram_enabled(self) -> bool:
        return bool(self.TELEGRAM_BOT_TOKEN and self.TELEGRAM_CHAT_ID)


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
