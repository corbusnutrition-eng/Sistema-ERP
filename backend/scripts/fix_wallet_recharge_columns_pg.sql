-- Fix físico rápido: columnas esperadas por SQLAlchemy en wallet_recharge_requests (PostgreSQL).
-- Uso: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/fix_wallet_recharge_columns_pg.sql

DO $$
BEGIN
  IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = 'wallet_recharge_requests'
  ) THEN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'wallet_recharge_requests'
          AND column_name = 'recharge_currency'
    ) THEN
      ALTER TABLE wallet_recharge_requests
        ADD COLUMN recharge_currency VARCHAR(10) NOT NULL DEFAULT 'USD';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'wallet_recharge_requests'
          AND column_name = 'recharge_exchange_rate'
    ) THEN
      ALTER TABLE wallet_recharge_requests
        ADD COLUMN recharge_exchange_rate DOUBLE PRECISION NOT NULL DEFAULT 1;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'wallet_recharge_requests'
          AND column_name = 'admin_precheck_receipt_url'
    ) THEN
      ALTER TABLE wallet_recharge_requests
        ADD COLUMN admin_precheck_receipt_url VARCHAR(2048);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'wallet_recharge_requests'
          AND column_name = 'portal_submitted_deposit_account_id'
    ) THEN
      ALTER TABLE wallet_recharge_requests
        ADD COLUMN portal_submitted_deposit_account_id INTEGER;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'wallet_recharge_requests'
          AND column_name = 'portal_declared_payment_amount'
    ) THEN
      ALTER TABLE wallet_recharge_requests
        ADD COLUMN portal_declared_payment_amount DOUBLE PRECISION;
    END IF;
  END IF;
END $$;
