-- Idempotente: columna is_bank_verified en journal_entry_lines (módulo Aprobaciones).
ALTER TABLE journal_entry_lines
  ADD COLUMN IF NOT EXISTS is_bank_verified BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE journal_entry_lines SET is_bank_verified = TRUE WHERE is_bank_verified IS NOT TRUE;
