-- 023-learned-categorization.sql — learned merchant-fingerprint categorization

ALTER TABLE categories
ADD COLUMN IF NOT EXISTS exclude_from_learning BOOLEAN NOT NULL DEFAULT false;

UPDATE categories
SET exclude_from_learning = true
WHERE name IN ('Vacation', 'Travel');

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS merchant_fingerprint TEXT,
ADD COLUMN IF NOT EXISTS categorization_source TEXT,
ADD COLUMN IF NOT EXISTS suggested_category_id INT REFERENCES categories(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS suggestion_source TEXT;

ALTER TABLE transactions
DROP CONSTRAINT IF EXISTS transactions_categorization_source_check;
ALTER TABLE transactions
ADD CONSTRAINT transactions_categorization_source_check
CHECK (categorization_source IS NULL OR categorization_source IN ('manual', 'rule', 'learned', 'plaid'));

ALTER TABLE transactions
DROP CONSTRAINT IF EXISTS transactions_suggestion_source_check;
ALTER TABLE transactions
ADD CONSTRAINT transactions_suggestion_source_check
CHECK (suggestion_source IS NULL OR suggestion_source IN ('history', 'plaid'));

CREATE TABLE IF NOT EXISTS learned_category_rules (
  id SERIAL PRIMARY KEY,
  merchant_fingerprint TEXT NOT NULL UNIQUE,
  category_id INT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  occurrence_count INT NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learned_category_rules_category ON learned_category_rules(category_id);

CREATE TABLE IF NOT EXISTS suggestion_rejections (
  id SERIAL PRIMARY KEY,
  merchant_fingerprint TEXT NOT NULL,
  category_id INT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  transaction_id INT REFERENCES transactions(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INT REFERENCES family_members(id) ON DELETE SET NULL,
  UNIQUE (merchant_fingerprint, category_id)
);

CREATE INDEX IF NOT EXISTS idx_suggestion_rejections_fingerprint ON suggestion_rejections(merchant_fingerprint);
CREATE INDEX IF NOT EXISTS idx_transactions_merchant_fingerprint ON transactions(merchant_fingerprint);
CREATE INDEX IF NOT EXISTS idx_transactions_pending_suggestion ON transactions(suggested_category_id) WHERE suggested_category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_categorization_source ON transactions(categorization_source);

-- Conservative SQL approximation of buildMerchantFingerprint for existing rows; JS paths refresh exact values later.
UPDATE transactions
SET merchant_fingerprint = COALESCE(NULLIF(trim(regexp_replace(lower(COALESCE(merchant_name, name, '')), '[^a-z0-9]+', ' ', 'g')), ''), 'unknown')
WHERE merchant_fingerprint IS NULL;

UPDATE transactions
SET categorization_source = 'manual'
WHERE category_id IS NOT NULL
  AND categorization_source IS NULL;
