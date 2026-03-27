-- 018-transaction-identity-overrides.sql — local display-name overrides and future rename rules

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS display_name_override TEXT,
  ADD COLUMN IF NOT EXISTS display_name_override_updated_by INT REFERENCES family_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS display_name_override_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_transactions_display_name_override
  ON transactions(display_name_override)
  WHERE display_name_override IS NOT NULL;

CREATE TABLE IF NOT EXISTS merchant_rename_rules (
  id              SERIAL PRIMARY KEY,
  raw_source_text TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  match_type      TEXT NOT NULL DEFAULT 'exact',
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_by      INT REFERENCES family_members(id) ON DELETE SET NULL,
  last_matched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchant_rename_rules_enabled
  ON merchant_rename_rules(enabled, raw_source_text);
