-- Idempotente: columna verification_status en journal_entry_lines (libro mayor bancario).
ALTER TABLE journal_entry_lines
  ADD COLUMN IF NOT EXISTS verification_status VARCHAR(32) NULL;
