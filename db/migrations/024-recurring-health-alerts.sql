-- 024-recurring-health-alerts.sql — recurring stream health alert events

CREATE TABLE IF NOT EXISTS recurring_alert_events (
  id SERIAL PRIMARY KEY,
  recurring_expense_id INT NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('recurring_price_creep', 'recurring_missed_income', 'recurring_new_commitment')),
  source_key TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_on DATE NOT NULL DEFAULT current_date,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_type, source_key)
);

CREATE INDEX IF NOT EXISTS idx_recurring_alert_events_recurring
  ON recurring_alert_events(recurring_expense_id, occurred_on DESC);

CREATE INDEX IF NOT EXISTS idx_recurring_alert_events_active
  ON recurring_alert_events(occurred_on DESC)
  WHERE dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_recurring_alert_events_type_source
  ON recurring_alert_events(event_type, source_key);

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'member_notification_subscriptions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%event_type%'
  LOOP
    EXECUTE format('ALTER TABLE member_notification_subscriptions DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  ALTER TABLE member_notification_subscriptions
    ADD CONSTRAINT member_notification_subscriptions_event_type_check
    CHECK (event_type IN (
      'month_in_review', 'large_expense', 'sync_issue', 'budget_overrun',
      'recurring_price_creep', 'recurring_missed_income', 'recurring_new_commitment'
    ));
END $$;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'notification_event_state'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%event_type%'
  LOOP
    EXECUTE format('ALTER TABLE notification_event_state DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  ALTER TABLE notification_event_state
    ADD CONSTRAINT notification_event_state_event_type_check
    CHECK (event_type IN (
      'month_in_review', 'large_expense', 'sync_issue', 'budget_overrun',
      'recurring_price_creep', 'recurring_missed_income', 'recurring_new_commitment'
    ));
END $$;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'notification_delivery_log'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%event_type%'
  LOOP
    EXECUTE format('ALTER TABLE notification_delivery_log DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  ALTER TABLE notification_delivery_log
    ADD CONSTRAINT notification_delivery_log_event_type_check
    CHECK (event_type IN (
      'test', 'month_in_review', 'large_expense', 'sync_issue', 'budget_overrun',
      'recurring_price_creep', 'recurring_missed_income', 'recurring_new_commitment'
    ));
END $$;

INSERT INTO app_config (key, value) VALUES
  ('price_creep_threshold_pct', '5'),
  ('recurring_alerts_new_commitment_high_water_id', COALESCE((SELECT max(id)::text FROM recurring_expenses), '0'))
ON CONFLICT (key) DO NOTHING;
