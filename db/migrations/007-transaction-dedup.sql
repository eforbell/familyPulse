-- 007-transaction-dedup.sql — Hide/suppress duplicate imported transactions in favor of Plaid.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS hidden_reason TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS duplicate_of_transaction_id INT REFERENCES transactions(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS dedup_run_id INT;

CREATE INDEX IF NOT EXISTS idx_transactions_visible ON transactions(is_hidden);
CREATE INDEX IF NOT EXISTS idx_transactions_source_visible_date ON transactions(source, is_hidden, date);
CREATE INDEX IF NOT EXISTS idx_transactions_duplicate_of ON transactions(duplicate_of_transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactions_dedup_run ON transactions(dedup_run_id);

CREATE TABLE IF NOT EXISTS dedup_runs (
  id               SERIAL PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'complete',
  strategy         TEXT NOT NULL DEFAULT 'prefer_plaid',
  txns_hidden      INT NOT NULL DEFAULT 0,
  category_copied  INT NOT NULL DEFAULT 0,
  ambiguous_count  INT NOT NULL DEFAULT 0,
  details          JSONB,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

