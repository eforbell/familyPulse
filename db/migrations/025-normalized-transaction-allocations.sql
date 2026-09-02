-- 025-normalized-transaction-allocations.sql
-- Make category allocations the canonical categorization model.
--
-- Every transaction receives at least one allocation. Allocation amounts are
-- signed and must sum to transactions.amount. Signed lines intentionally leave
-- room for future compound entries such as gross paycheck income plus positive
-- withholding/deduction lines that reconcile to the net Plaid deposit.

CREATE TABLE IF NOT EXISTS transaction_allocations (
  id             SERIAL PRIMARY KEY,
  transaction_id INT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id    INT REFERENCES categories(id) ON DELETE RESTRICT,
  amount         NUMERIC(12,2) NOT NULL,
  position       SMALLINT NOT NULL CHECK (position > 0),
  created_by     INT REFERENCES family_members(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id, position)
);

CREATE INDEX IF NOT EXISTS idx_transaction_allocations_transaction
  ON transaction_allocations(transaction_id, position);
CREATE INDEX IF NOT EXISTS idx_transaction_allocations_category
  ON transaction_allocations(category_id, transaction_id);

-- Hold off transaction writers until both the backfill and compatibility
-- trigger are installed. A writer that committed before this lock was acquired
-- is included in the backfill; one that starts afterward resumes only once the
-- migration commits and is then covered by the trigger.
LOCK TABLE transactions IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
SELECT t.id, t.category_id, t.amount, 1
FROM transactions t
WHERE NOT EXISTS (
  SELECT 1 FROM transaction_allocations ta WHERE ta.transaction_id = t.id
);

-- Keep the legacy category_id column as a short-lived deployment compatibility
-- projection. Application reads use transaction_allocations exclusively. This
-- trigger protects inserts from an old process during the expand/contract deploy
-- and keeps older test/import fixtures valid until the column is removed in a
-- later cleanup migration.
CREATE OR REPLACE FUNCTION sync_legacy_transaction_allocation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
    VALUES (NEW.id, NEW.category_id, NEW.amount, 1)
    ON CONFLICT (transaction_id, position) DO NOTHING;
    RETURN NEW;
  END IF;

  IF NEW.category_id IS DISTINCT FROM OLD.category_id THEN
    DELETE FROM transaction_allocations WHERE transaction_id = NEW.id;
    INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
    VALUES (NEW.id, NEW.category_id, NEW.amount, 1);
  ELSIF NEW.amount IS DISTINCT FROM OLD.amount
        AND (SELECT count(*) FROM transaction_allocations WHERE transaction_id = NEW.id) = 1 THEN
    UPDATE transaction_allocations
    SET amount = NEW.amount, updated_at = now()
    WHERE transaction_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_legacy_transaction_allocation ON transactions;
CREATE TRIGGER trg_sync_legacy_transaction_allocation
AFTER INSERT OR UPDATE OF category_id, amount ON transactions
FOR EACH ROW EXECUTE FUNCTION sync_legacy_transaction_allocation();

CREATE OR REPLACE FUNCTION prevent_transaction_allocation_reparenting()
RETURNS trigger AS $$
BEGIN
  IF NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
    RAISE EXCEPTION 'Transaction allocation % cannot move from transaction % to transaction %',
      OLD.id, OLD.transaction_id, NEW.transaction_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_transaction_allocation_reparenting ON transaction_allocations;
CREATE TRIGGER trg_prevent_transaction_allocation_reparenting
BEFORE UPDATE OF transaction_id ON transaction_allocations
FOR EACH ROW EXECUTE FUNCTION prevent_transaction_allocation_reparenting();

CREATE OR REPLACE FUNCTION check_transaction_allocation_balance()
RETURNS trigger AS $$
DECLARE
  target_transaction_id INT;
  transaction_amount NUMERIC(12,2);
  transaction_is_transfer BOOLEAN;
  transaction_pending BOOLEAN;
  allocation_amount NUMERIC(12,2);
  allocation_count INT;
  has_transfer_class BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'transactions' THEN
    IF TG_OP = 'DELETE' THEN target_transaction_id := OLD.id;
    ELSE target_transaction_id := NEW.id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN target_transaction_id := OLD.transaction_id;
    ELSE target_transaction_id := NEW.transaction_id;
    END IF;
  END IF;

  SELECT amount, is_transfer, pending
  INTO transaction_amount, transaction_is_transfer, transaction_pending
  FROM transactions
  WHERE id = target_transaction_id;

  -- Cascading deletion removes the parent first; there is nothing to verify.
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  SELECT count(*)::int,
         COALESCE(SUM(ta.amount), 0),
         COALESCE(bool_or(COALESCE(c.is_transfer_class, false)), false)
  INTO allocation_count, allocation_amount, has_transfer_class
  FROM transaction_allocations ta
  LEFT JOIN categories c ON c.id = ta.category_id
  WHERE ta.transaction_id = target_transaction_id;

  IF allocation_count = 0 THEN
    RAISE EXCEPTION 'Transaction % must have at least one allocation', target_transaction_id
      USING ERRCODE = '23514';
  END IF;

  IF allocation_amount <> transaction_amount THEN
    RAISE EXCEPTION 'Transaction % allocations total % but transaction amount is %',
      target_transaction_id, allocation_amount, transaction_amount
      USING ERRCODE = '23514';
  END IF;

  IF transaction_is_transfer AND allocation_count > 1 THEN
    RAISE EXCEPTION 'Transfer transaction % cannot have multiple allocations', target_transaction_id
      USING ERRCODE = '23514';
  END IF;

  IF transaction_pending AND allocation_count > 1 THEN
    RAISE EXCEPTION 'Pending transaction % cannot have multiple allocations', target_transaction_id
      USING ERRCODE = '23514';
  END IF;

  IF allocation_count > 1 AND has_transfer_class THEN
    RAISE EXCEPTION 'Transaction % cannot use transfer categories in a split', target_transaction_id
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_conflicting_transfer_category_update()
RETURNS trigger AS $$
BEGIN
  IF NEW.is_transfer_class = true
     AND NEW.is_transfer_class IS DISTINCT FROM OLD.is_transfer_class
     AND EXISTS (
       SELECT 1
       FROM transaction_allocations own_allocation
       WHERE own_allocation.category_id = NEW.id
         AND (SELECT count(*) FROM transaction_allocations sibling
              WHERE sibling.transaction_id = own_allocation.transaction_id) > 1
     ) THEN
    RAISE EXCEPTION 'Category % transfer classification conflicts with an existing split', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_conflicting_transfer_category_update ON categories;
CREATE TRIGGER trg_prevent_conflicting_transfer_category_update
BEFORE UPDATE OF is_transfer_class ON categories
FOR EACH ROW EXECUTE FUNCTION prevent_conflicting_transfer_category_update();

DROP TRIGGER IF EXISTS trg_transaction_allocation_balance ON transaction_allocations;
CREATE CONSTRAINT TRIGGER trg_transaction_allocation_balance
AFTER INSERT OR UPDATE OR DELETE ON transaction_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_transaction_allocation_balance();

DROP TRIGGER IF EXISTS trg_transaction_amount_allocation_balance ON transactions;
CREATE CONSTRAINT TRIGGER trg_transaction_amount_allocation_balance
AFTER INSERT OR UPDATE ON transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_transaction_allocation_balance();

COMMENT ON TABLE transaction_allocations IS
  'Canonical signed category allocations; allocation amounts sum to the parent transaction amount.';
COMMENT ON COLUMN transactions.category_id IS
  'Deprecated deployment compatibility projection; use transaction_allocations.';
