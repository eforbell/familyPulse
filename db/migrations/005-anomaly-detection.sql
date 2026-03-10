-- 005-anomaly-detection.sql — extend anomalies table for category-level detection

ALTER TABLE anomalies
  ADD COLUMN IF NOT EXISTS category_id INT REFERENCES categories(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS period TEXT,
  ADD COLUMN IF NOT EXISTS current_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS avg_3mo NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS avg_12mo NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS pct_of_3mo NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS pct_of_12mo NUMERIC(5,1),
  ADD COLUMN IF NOT EXISTS note TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_anomalies_cat_period
  ON anomalies(category_id, period, anomaly_type);
