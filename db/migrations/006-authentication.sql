-- 006-authentication.sql — passphrase auth with persistent sessions

-- Add passphrase hash to family members
ALTER TABLE family_members
  ADD COLUMN IF NOT EXISTS passphrase_hash TEXT;

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  member_id   INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_member ON sessions(member_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Account-to-member linking for kid scoping
CREATE TABLE IF NOT EXISTS account_members (
  account_id  INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  member_id   INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, member_id)
);
