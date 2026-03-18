-- 013-account-selection-lifecycle.sql — preserve historical accounts when sync membership changes

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS sync_disabled_at TIMESTAMPTZ;
