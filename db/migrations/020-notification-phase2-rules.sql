-- 020-notification-phase2-rules.sql — budget overrun event + threshold config

UPDATE member_notification_subscriptions
SET event_type = 'budget_overrun'
WHERE event_type = 'forecast_shift';

UPDATE notification_event_state
SET event_type = 'budget_overrun'
WHERE event_type = 'forecast_shift';

UPDATE notification_delivery_log
SET event_type = 'budget_overrun'
WHERE event_type = 'forecast_shift';

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

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'member_notification_subscriptions'::regclass
      AND conname = 'member_notification_subscriptions_event_type_check'
  ) THEN
    ALTER TABLE member_notification_subscriptions
      ADD CONSTRAINT member_notification_subscriptions_event_type_check
      CHECK (event_type IN ('month_in_review', 'large_expense', 'sync_issue', 'budget_overrun'));
  END IF;
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'notification_event_state'::regclass
      AND conname = 'notification_event_state_event_type_check'
  ) THEN
    ALTER TABLE notification_event_state
      ADD CONSTRAINT notification_event_state_event_type_check
      CHECK (event_type IN ('month_in_review', 'large_expense', 'sync_issue', 'budget_overrun'));
  END IF;
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'notification_delivery_log'::regclass
      AND conname = 'notification_delivery_log_event_type_check'
  ) THEN
    ALTER TABLE notification_delivery_log
      ADD CONSTRAINT notification_delivery_log_event_type_check
      CHECK (event_type IN ('test', 'month_in_review', 'large_expense', 'sync_issue', 'budget_overrun'));
  END IF;
END $$;

INSERT INTO app_config (key, value)
VALUES ('budget_overrun_threshold_pct', '15')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
