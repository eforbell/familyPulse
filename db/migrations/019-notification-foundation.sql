-- 019-notification-foundation.sql — brrr notification onboarding + reminder foundation

CREATE TABLE IF NOT EXISTS member_notification_channels (
  id SERIAL PRIMARY KEY,
  member_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('brrr')),
  label TEXT,
  target_secret TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, channel_type)
);

CREATE INDEX IF NOT EXISTS idx_member_notification_channels_member
  ON member_notification_channels(member_id);

CREATE TABLE IF NOT EXISTS member_notification_subscriptions (
  id SERIAL PRIMARY KEY,
  member_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('month_in_review', 'large_expense', 'sync_issue', 'budget_overrun')),
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_member_notification_subscriptions_member
  ON member_notification_subscriptions(member_id);

CREATE TABLE IF NOT EXISTS notification_event_state (
  id SERIAL PRIMARY KEY,
  member_id INT NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('month_in_review', 'large_expense', 'sync_issue', 'budget_overrun')),
  source_key TEXT NOT NULL,
  last_delivery_attempt_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ,
  last_result TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (member_id, event_type, source_key)
);

CREATE INDEX IF NOT EXISTS idx_notification_event_state_lookup
  ON notification_event_state(member_id, event_type, source_key);

CREATE TABLE IF NOT EXISTS notification_delivery_log (
  id SERIAL PRIMARY KEY,
  member_id INT REFERENCES family_members(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('test', 'month_in_review', 'large_expense', 'sync_issue', 'budget_overrun')),
  source_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent', 'skipped', 'error')),
  response_status INT,
  payload_json JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_log_member_created
  ON notification_delivery_log(member_id, created_at DESC);

INSERT INTO app_config (key, value) VALUES
  ('notifications_enabled', 'false'),
  ('notification_base_url', ''),
  ('notification_default_interruption_level', 'active'),
  ('large_expense_threshold', '1000'),
  ('budget_overrun_threshold_pct', '15')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
