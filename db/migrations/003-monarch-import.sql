-- 003-monarch-import.sql — Schema additions for Monarch Money CSV import

-- Add columns to import_runs for Monarch-specific tracking
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS filename TEXT;
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS category_mappings JSONB;
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS txns_skipped INT DEFAULT 0;

-- Sentinel item for Monarch-imported accounts
INSERT INTO items (access_token, item_id, institution_name, status)
VALUES ('n/a', 'monarch-import', 'Monarch Money (Import)', 'import')
ON CONFLICT (item_id) DO NOTHING;

-- Index for efficient Monarch dedup queries
CREATE INDEX IF NOT EXISTS idx_transactions_source ON transactions(source);
