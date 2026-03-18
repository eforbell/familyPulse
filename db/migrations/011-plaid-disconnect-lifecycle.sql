-- 011-plaid-disconnect-lifecycle.sql — preserve history on disconnect, purge explicitly

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;
