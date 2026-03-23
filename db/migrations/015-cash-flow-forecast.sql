-- 015-cash-flow-forecast.sql — predictive cash flow engine substrate

CREATE TABLE IF NOT EXISTS planned_expenses (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  scheduled_date  DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'deleted')),
  notes           TEXT,
  created_by      INT REFERENCES family_members(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_planned_expenses_status_date ON planned_expenses(status, scheduled_date);

CREATE TABLE IF NOT EXISTS cash_flow_snapshots (
  id                  SERIAL PRIMARY KEY,
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  horizon_days        INT NOT NULL DEFAULT 90,
  starting_balance    NUMERIC(12,2) NOT NULL,
  input_fingerprint   TEXT,
  daily_projections   JSONB NOT NULL DEFAULT '[]',
  danger_zones        JSONB NOT NULL DEFAULT '[]',
  monthly_outlook     JSONB NOT NULL DEFAULT '[]',
  excess_liquidity    JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_cash_flow_snapshots_computed ON cash_flow_snapshots(computed_at DESC);
