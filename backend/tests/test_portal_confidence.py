"""Tests for portal OCR confidence anti-bypass rules."""
from app.security.portal_confidence import (
    portal_sanitize_client_confidence,
    portal_stored_allows_zero_amount,
)


def test_stored_zero_allows_bypass_only_from_db():
    assert portal_stored_allows_zero_amount(0) is True
    assert portal_stored_allows_zero_amount(100) is False
    assert portal_stored_allows_zero_amount(None) is False


def test_client_cannot_forge_zero_confidence():
    assert portal_sanitize_client_confidence(stored=100, form_score=0) == 100
    assert portal_sanitize_client_confidence(stored=None, form_score=0) == 100


def test_admin_stored_zero_preserved():
    assert portal_sanitize_client_confidence(stored=0, form_score=0) == 0
    assert portal_sanitize_client_confidence(stored=0, form_score=42) == 42
