-- Idempotente: columna verified_at en journal_entry_lines (confirmación bancaria).
ALTER TABLE journal_entry_lines
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ NULL;
