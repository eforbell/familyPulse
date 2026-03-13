-- 008-liability-coverage.sql — Store Plaid liability fields on accounts

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS last_statement_balance NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS last_statement_issue_date DATE,
  ADD COLUMN IF NOT EXISTS minimum_payment_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS next_payment_due_date DATE,
  ADD COLUMN IF NOT EXISTS last_payment_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS last_payment_date DATE,
  ADD COLUMN IF NOT EXISTS is_overdue BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS apr_data JSONB;

-- Default coverage alert threshold (warn when 70% of checking consumed by statements)
INSERT INTO app_config (key, value) VALUES ('coverage_alert_threshold', '0.70')
ON CONFLICT (key) DO NOTHING;
