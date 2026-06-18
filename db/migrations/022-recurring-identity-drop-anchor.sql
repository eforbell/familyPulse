-- 022-recurring-identity-drop-anchor.sql
-- A recurring stream's identity is (merchant_key, cashflow_type, frequency).
--
-- The schedule anchor — especially schedule_anchor_value (day of month) — drifts
-- for weekday-anchored schedules. Social Security pays the Nth weekday of the
-- month, so the deposit day shifts month to month (e.g. Apr 15 -> May 20 ->
-- Jun 17 -> Jul 15). Because the anchor was part of the unique identity, each
-- shift produced a NEW row instead of updating the existing one, creating
-- duplicate recurring items. Drop the anchor from the identity and collapse any
-- duplicates that already resulted.

-- 1. Fold each duplicate group's earliest first_seen_date onto the survivor
--    (the most recently seen row in the group).
WITH grouped AS (
  SELECT merchant_key, cashflow_type, frequency,
         MIN(first_seen_date) AS group_first_seen
  FROM recurring_expenses
  GROUP BY merchant_key, cashflow_type, frequency
  HAVING COUNT(*) > 1
),
survivors AS (
  SELECT DISTINCT ON (merchant_key, cashflow_type, frequency)
         id, merchant_key, cashflow_type, frequency
  FROM recurring_expenses
  ORDER BY merchant_key, cashflow_type, frequency, last_seen_date DESC, id DESC
)
UPDATE recurring_expenses re
SET first_seen_date = g.group_first_seen
FROM survivors s
JOIN grouped g
  ON g.merchant_key = s.merchant_key
 AND g.cashflow_type = s.cashflow_type
 AND g.frequency = s.frequency
WHERE re.id = s.id;

-- 2. Delete the non-survivor duplicates (recurring_expense_history cascades).
DELETE FROM recurring_expenses re
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY merchant_key, cashflow_type, frequency
           ORDER BY last_seen_date DESC, id DESC
         ) AS rn
  FROM recurring_expenses
) ranked
WHERE re.id = ranked.id AND ranked.rn > 1;

-- 3. Replace the identity index, dropping the volatile anchor columns.
DROP INDEX IF EXISTS ux_recurring_expenses_identity;
CREATE UNIQUE INDEX IF NOT EXISTS ux_recurring_expenses_identity
  ON recurring_expenses(merchant_key, cashflow_type, frequency);
