-- 029-suite-member-link.sql — the Home Base household member each Family Pulse member is (tailnet mode)

ALTER TABLE family_members ADD COLUMN IF NOT EXISTS suite_member_id TEXT UNIQUE;
