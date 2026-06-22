#!/usr/bin/env python3
"""Compatibilidad: delega en seed_accounts.py (taxonomía unificada)."""

from seed_accounts import main, seed_accounts

__all__ = ["main", "seed_accounts"]

if __name__ == "__main__":
    main()
