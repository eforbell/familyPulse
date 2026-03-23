-- 014-recurring-expenses.sql — recurring cashflow detection substrate

CREATE TABLE IF NOT EXISTS recurring_expenses (
  id                    SERIAL PRIMARY KEY,
  merchant_key          TEXT NOT NULL,
  merchant_name         TEXT NOT NULL,
  cashflow_type         TEXT NOT NULL CHECK (cashflow_type IN ('expense', 'income')),
  frequency             TEXT NOT NULL,
  confidence            TEXT NOT NULL DEFAULT 'low' CHECK (confidence IN ('low', 'medium', 'high')),
  status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ignored', 'stale', 'likely_cancelled')),
  latest_account_id     INT REFERENCES accounts(id) ON DELETE SET NULL,
  latest_amount         NUMERIC(12,2) NOT NULL,
  prior_amount          NUMERIC(12,2),
  price_change_pct      NUMERIC(8,2),
  price_change_direction TEXT CHECK (price_change_direction IN ('up', 'down')),
  price_change_date     DATE,
  first_seen_date       DATE NOT NULL,
  last_seen_date        DATE NOT NULL,
  expected_next_date    DATE,
  interval_days         INT,
  tolerance_days        INT NOT NULL DEFAULT 3,
  schedule_anchor_type  TEXT CHECK (schedule_anchor_type IN ('weekday', 'day_of_month', 'last_day_of_month')),
  schedule_anchor_value TEXT,
  source_txn_count      INT NOT NULL DEFAULT 0,
  override_frequency    TEXT,
  override_expected_next_date DATE,
  ignored_reason        TEXT,
  last_detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recurring_expenses_status ON recurring_expenses(status);
CREATE INDEX IF NOT EXISTS idx_recurring_expenses_expected_next_date ON recurring_expenses(expected_next_date);
CREATE INDEX IF NOT EXISTS idx_recurring_expenses_merchant_key ON recurring_expenses(merchant_key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_recurring_expenses_identity
  ON recurring_expenses(
    merchant_key,
    cashflow_type,
    frequency,
    COALESCE(schedule_anchor_type, ''),
    COALESCE(schedule_anchor_value, '')
  );

CREATE TABLE IF NOT EXISTS recurring_expense_history (
  id                   SERIAL PRIMARY KEY,
  recurring_expense_id INT NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,
  transaction_id       INT REFERENCES transactions(id) ON DELETE SET NULL,
  amount               NUMERIC(12,2) NOT NULL,
  transaction_date     DATE NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recurring_expense_id, transaction_date, amount)
);

CREATE INDEX IF NOT EXISTS idx_recurring_history_expense_date
  ON recurring_expense_history(recurring_expense_id, transaction_date DESC);
