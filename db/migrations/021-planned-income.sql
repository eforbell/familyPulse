-- 021-planned-income.sql — add type column to planned_expenses to support planned income

-- Add a type column: 'expense' (default, existing rows) or 'income'
ALTER TABLE planned_expenses
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'expense'
    CHECK (type IN ('expense', 'income'));

-- Index to make filtering by type efficient alongside status/date
CREATE INDEX IF NOT EXISTS idx_planned_expenses_type ON planned_expenses(type, status, scheduled_date);
