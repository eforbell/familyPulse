-- 002-link-sessions.sql — Ephemeral Plaid Link sessions for OAuth flow

CREATE TABLE IF NOT EXISTS link_sessions (
  id              SERIAL PRIMARY KEY,
  link_token      TEXT NOT NULL,
  oauth_state_id  TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  owner           TEXT,
  item_id_for_update INT REFERENCES items(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_link_sessions_oauth_state ON link_sessions(oauth_state_id) WHERE oauth_state_id IS NOT NULL;
