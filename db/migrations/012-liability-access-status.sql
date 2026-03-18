-- 012-liability-access-status.sql — persist Plaid liability access state on items

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS liability_access_status TEXT NOT NULL DEFAULT 'unknown';

UPDATE items i
SET liability_access_status = 'missing'
WHERE liability_access_status = 'unknown'
  AND status <> 'disconnected'
  AND EXISTS (
    SELECT 1
    FROM accounts a
    WHERE a.item_id = i.id
      AND a.type IN ('credit', 'loan')
  );
