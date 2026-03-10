-- 004-budget-framework.sql — Budget snapshots + default budget amounts

-- ── Drop empty legacy tables ────────────────────────────────
-- These were created in 001 but never populated. Replace with budget_snapshots.

DROP TABLE IF EXISTS budget_periods;
DROP TABLE IF EXISTS budgets;

-- ── Budget snapshots ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budget_snapshots (
  id          SERIAL PRIMARY KEY,
  category_id INT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  period      TEXT NOT NULL,                    -- 'YYYY-MM'
  budgeted    NUMERIC(10,2) NOT NULL DEFAULT 0,
  actual_spent NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(category_id, period)
);

CREATE INDEX IF NOT EXISTS idx_budget_snapshots_period ON budget_snapshots(period);

-- ── Seed default budget amounts into categories ─────────────
-- ~$5,100/mo total for a household of four

UPDATE categories SET budget_amount = 1000 WHERE name = 'Groceries';
UPDATE categories SET budget_amount =  400 WHERE name = 'Dining Out';
UPDATE categories SET budget_amount =  400 WHERE name = 'Gas & Auto';
UPDATE categories SET budget_amount =  350 WHERE name = 'Utilities';
UPDATE categories SET budget_amount =  200 WHERE name = 'Healthcare';
UPDATE categories SET budget_amount =  200 WHERE name = 'Entertainment';
UPDATE categories SET budget_amount =  400 WHERE name = 'Shopping';
UPDATE categories SET budget_amount =  300 WHERE name = 'Kids Activities';
UPDATE categories SET budget_amount =  200 WHERE name = 'Subscriptions';
UPDATE categories SET budget_amount =  300 WHERE name = 'Home & Garden';
UPDATE categories SET budget_amount =  500 WHERE name = 'Insurance';
UPDATE categories SET budget_amount =  500 WHERE name = 'Travel';
