-- 030-link-session-binding.sql — who started a bank link, on which hostname, in which browser (tailnet mode, D22)
-- started_by is the household member's stable user ID; correlation_hash is the SHA-256 of the __Host-sv_oauth cookie
-- set on the browser that started it. All three stay NULL in local mode.

ALTER TABLE link_sessions ADD COLUMN IF NOT EXISTS started_by TEXT;
ALTER TABLE link_sessions ADD COLUMN IF NOT EXISTS hostname TEXT;
ALTER TABLE link_sessions ADD COLUMN IF NOT EXISTS correlation_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_link_sessions_correlation ON link_sessions(correlation_hash) WHERE correlation_hash IS NOT NULL;
