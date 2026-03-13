-- 009: Add custom_name column for user-defined account names
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS custom_name TEXT;
