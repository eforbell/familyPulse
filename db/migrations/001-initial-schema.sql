-- 001-initial-schema.sql — Family Pulse core tables

-- ── Items (Plaid linked institutions) ────────────────────────

CREATE TABLE IF NOT EXISTS items (
  id              SERIAL PRIMARY KEY,
  access_token    TEXT NOT NULL,
  item_id         TEXT UNIQUE NOT NULL,
  institution_id  TEXT,
  institution_name TEXT,
  status          TEXT NOT NULL DEFAULT 'good',
  error_code      TEXT,
  sync_cursor     TEXT,
  last_sync_at    TIMESTAMPTZ,
  token_last_used_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Accounts ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accounts (
  id                SERIAL PRIMARY KEY,
  plaid_account_id  TEXT UNIQUE NOT NULL,
  item_id           INT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  official_name     TEXT,
  type              TEXT NOT NULL,
  subtype           TEXT,
  mask              TEXT,
  current_balance   NUMERIC(12,2),
  available_balance NUMERIC(12,2),
  iso_currency_code TEXT DEFAULT 'USD',
  owner             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Categories ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS categories (
  id                SERIAL PRIMARY KEY,
  name              TEXT UNIQUE NOT NULL,
  color             TEXT DEFAULT '#6b7280',
  budget_amount     NUMERIC(10,2),
  is_income         BOOLEAN NOT NULL DEFAULT false,
  is_transfer_class BOOLEAN NOT NULL DEFAULT false,
  icon              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Transactions ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transactions (
  id                  SERIAL PRIMARY KEY,
  plaid_transaction_id TEXT UNIQUE NOT NULL,
  account_id          INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount              NUMERIC(12,2) NOT NULL,
  date                DATE NOT NULL,
  authorized_date     DATE,
  merchant_name       TEXT,
  name                TEXT,
  plaid_category      TEXT,
  category_id         INT REFERENCES categories(id) ON DELETE SET NULL,
  pending             BOOLEAN NOT NULL DEFAULT false,
  iso_currency_code   TEXT DEFAULT 'USD',
  is_transfer         BOOLEAN NOT NULL DEFAULT false,
  transfer_type       TEXT,
  transfer_pair_id    INT REFERENCES transactions(id) ON DELETE SET NULL,
  source              TEXT DEFAULT 'plaid',
  raw_json            JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_transactions_plaid_id ON transactions(plaid_transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);

-- ── Category Rules ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS category_rules (
  id              SERIAL PRIMARY KEY,
  merchant_pattern TEXT NOT NULL,
  category_id     INT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  match_type      TEXT NOT NULL DEFAULT 'contains',
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Budgets ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budgets (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  amount      NUMERIC(10,2) NOT NULL,
  period      TEXT NOT NULL DEFAULT 'monthly',
  category_id INT REFERENCES categories(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS budget_periods (
  id          SERIAL PRIMARY KEY,
  budget_id   INT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  start_date  DATE NOT NULL,
  end_date    DATE NOT NULL,
  spent       NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Planning & Signals ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS planning_goals (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  target      NUMERIC(12,2),
  current     NUMERIC(12,2) DEFAULT 0,
  deadline    DATE,
  status      TEXT DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS savings_signals (
  id            SERIAL PRIMARY KEY,
  signal_type   TEXT NOT NULL,
  description   TEXT,
  amount        NUMERIC(12,2),
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged  BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS magic_actions_log (
  id          SERIAL PRIMARY KEY,
  action_type TEXT NOT NULL,
  input       TEXT,
  output      TEXT,
  model       TEXT,
  tokens_used INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS anomalies (
  id            SERIAL PRIMARY KEY,
  transaction_id INT REFERENCES transactions(id) ON DELETE SET NULL,
  anomaly_type  TEXT NOT NULL,
  description   TEXT,
  severity      TEXT DEFAULT 'info',
  acknowledged  BOOLEAN DEFAULT false,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_runs (
  id            SERIAL PRIMARY KEY,
  source        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  items_synced  INT DEFAULT 0,
  txns_added    INT DEFAULT 0,
  txns_modified INT DEFAULT 0,
  txns_removed  INT DEFAULT 0,
  errors        JSONB,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);

-- ── Family Members ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS family_members (
  id          SERIAL PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  avatar_emoji TEXT,
  color       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── App Config ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
