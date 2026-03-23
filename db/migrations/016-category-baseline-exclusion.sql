-- 016-category-baseline-exclusion.sql — category-level forecast baseline controls

ALTER TABLE categories
ADD COLUMN IF NOT EXISTS exclude_from_baseline BOOLEAN NOT NULL DEFAULT false;
