-- Promote a paycheck from a single imported transaction to a pay event with
-- one or more ACH deposit legs.

DROP TRIGGER IF EXISTS trg_mark_paycheck_source_revision ON transactions;
DROP FUNCTION IF EXISTS mark_paycheck_source_revision();

CREATE TABLE IF NOT EXISTS paycheck_events (
  id                  SERIAL PRIMARY KEY,
  member_id           INT NOT NULL REFERENCES family_members(id) ON DELETE RESTRICT,
  employer            TEXT NOT NULL CHECK (char_length(trim(employer)) BETWEEN 1 AND 160),
  pay_date             DATE NOT NULL,
  gross_earnings      NUMERIC(12,2) NOT NULL CHECK (gross_earnings > 0),
  federal_tax         NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (federal_tax >= 0),
  social_security_tax NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (social_security_tax >= 0),
  medicare_tax        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (medicare_tax >= 0),
  retirement_401k     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (retirement_401k >= 0),
  health_insurance    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (health_insurance >= 0),
  other_deductions    JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(other_deductions) = 'array'),
  total_net_amount    NUMERIC(12,2) NOT NULL CHECK (total_net_amount > 0),
  created_by          INT REFERENCES family_members(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paycheck_deposits (
  id                    SERIAL PRIMARY KEY,
  paycheck_event_id     INT NOT NULL REFERENCES paycheck_events(id) ON DELETE CASCADE,
  transaction_id        INT NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  gross_attribution     NUMERIC(12,2) NOT NULL CHECK (gross_attribution > 0),
  deductions_applied    BOOLEAN NOT NULL DEFAULT false,
  source_net_amount     NUMERIC(12,2) NOT NULL CHECK (source_net_amount > 0),
  reconciliation_status TEXT NOT NULL DEFAULT 'matched'
    CHECK (reconciliation_status IN ('matched', 'source_changed')),
  position              SMALLINT NOT NULL CHECK (position > 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (paycheck_event_id, position)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_paycheck_deposits_deduction_leg
  ON paycheck_deposits(paycheck_event_id) WHERE deductions_applied = true;
CREATE INDEX IF NOT EXISTS idx_paycheck_events_member_employer_recent
  ON paycheck_events(member_id, lower(employer), pay_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_paycheck_deposits_event
  ON paycheck_deposits(paycheck_event_id, position);

CREATE OR REPLACE FUNCTION prevent_paycheck_deposit_reparent()
RETURNS trigger AS $$
BEGIN
  IF NEW.paycheck_event_id IS DISTINCT FROM OLD.paycheck_event_id
     OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id THEN
    RAISE EXCEPTION 'Paycheck deposits cannot be reparented'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_paycheck_deposit_reparent ON paycheck_deposits;
CREATE TRIGGER trg_prevent_paycheck_deposit_reparent
BEFORE UPDATE OF paycheck_event_id, transaction_id ON paycheck_deposits
FOR EACH ROW EXECUTE FUNCTION prevent_paycheck_deposit_reparent();

DO $$
BEGIN
  IF to_regclass('public.paychecks') IS NOT NULL THEN
    EXECUTE $migration$
      INSERT INTO paycheck_events (
        id, member_id, employer, pay_date, gross_earnings, federal_tax,
        social_security_tax, medicare_tax, retirement_401k, health_insurance,
        other_deductions, total_net_amount, created_by, created_at, updated_at
      )
      SELECT p.id, p.member_id, p.employer, t.date, p.gross_earnings, p.federal_tax,
             p.social_security_tax, p.medicare_tax, p.retirement_401k, p.health_insurance,
             p.other_deductions, p.source_net_amount, p.created_by, p.created_at, p.updated_at
      FROM paychecks p
      JOIN transactions t ON t.id = p.transaction_id
      ON CONFLICT (id) DO NOTHING
    $migration$;
    EXECUTE $migration$
      INSERT INTO paycheck_deposits (
        paycheck_event_id, transaction_id, gross_attribution, deductions_applied,
        source_net_amount, reconciliation_status, position, created_at, updated_at
      )
      SELECT p.id, p.transaction_id, p.gross_earnings, true,
             p.source_net_amount, p.reconciliation_status, 1, p.created_at, p.updated_at
      FROM paychecks p
      ON CONFLICT (transaction_id) DO NOTHING
    $migration$;
  END IF;
END;
$$;

SELECT setval(pg_get_serial_sequence('paycheck_events', 'id'),
  COALESCE((SELECT MAX(id) FROM paycheck_events), 1), true);

DROP TABLE IF EXISTS paychecks;

CREATE OR REPLACE FUNCTION mark_paycheck_deposit_source_revision()
RETURNS trigger AS $$
DECLARE
  next_status TEXT;
BEGIN
  next_status := CASE
    WHEN NEW.amount = -(SELECT source_net_amount FROM paycheck_deposits WHERE transaction_id = NEW.id)
      THEN 'matched'
    ELSE 'source_changed'
  END;
  UPDATE paycheck_deposits
  SET reconciliation_status = next_status,
      updated_at = now()
  WHERE transaction_id = NEW.id
    AND reconciliation_status IS DISTINCT FROM next_status;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mark_paycheck_deposit_source_revision ON transactions;
CREATE TRIGGER trg_mark_paycheck_deposit_source_revision
AFTER UPDATE OF amount ON transactions
FOR EACH ROW
WHEN (NEW.amount IS DISTINCT FROM OLD.amount)
EXECUTE FUNCTION mark_paycheck_deposit_source_revision();

CREATE OR REPLACE FUNCTION validate_paycheck_event()
RETURNS trigger AS $$
DECLARE
  target_event_id INT;
  stored paycheck_events%ROWTYPE;
  deposit_count INT;
  deduction_count INT;
  attributed_gross NUMERIC(12,2);
  attributed_net NUMERIC(12,2);
BEGIN
  IF TG_ARGV[0] = 'event' THEN
    target_event_id := NEW.id;
  ELSIF TG_OP <> 'DELETE' THEN
    target_event_id := NEW.paycheck_event_id;
  ELSE
    target_event_id := OLD.paycheck_event_id;
  END IF;
  SELECT * INTO stored FROM paycheck_events WHERE id = target_event_id;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  SELECT count(*)::int,
         count(*) FILTER (WHERE deductions_applied)::int,
         COALESCE(sum(gross_attribution), 0),
         COALESCE(sum(source_net_amount), 0)
  INTO deposit_count, deduction_count, attributed_gross, attributed_net
  FROM paycheck_deposits WHERE paycheck_event_id = target_event_id;

  IF deposit_count = 0 OR deduction_count <> 1
     OR attributed_gross <> stored.gross_earnings
     OR attributed_net <> stored.total_net_amount THEN
    RAISE EXCEPTION 'Paycheck event % has inconsistent deposit allocations', target_event_id
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_remove_empty_paycheck_event ON paycheck_deposits;
CREATE OR REPLACE FUNCTION remove_empty_paycheck_event()
RETURNS trigger AS $$
BEGIN
  DELETE FROM paycheck_events pe
  WHERE pe.id = OLD.paycheck_event_id
    AND NOT EXISTS (SELECT 1 FROM paycheck_deposits pd WHERE pd.paycheck_event_id = pe.id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_remove_empty_paycheck_event
AFTER DELETE ON paycheck_deposits
FOR EACH ROW EXECUTE FUNCTION remove_empty_paycheck_event();

DROP TRIGGER IF EXISTS trg_validate_paycheck_deposit ON paycheck_deposits;
CREATE CONSTRAINT TRIGGER trg_validate_paycheck_deposit
AFTER INSERT OR UPDATE OR DELETE ON paycheck_deposits
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_paycheck_event('deposit');

DROP TRIGGER IF EXISTS trg_validate_paycheck_event ON paycheck_events;
CREATE CONSTRAINT TRIGGER trg_validate_paycheck_event
AFTER INSERT OR UPDATE ON paycheck_events
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_paycheck_event('event');

COMMENT ON TABLE paycheck_events IS
  'One payroll event containing total gross pay and deductions across one or more ACH deposits.';
COMMENT ON TABLE paycheck_deposits IS
  'Imported Plaid deposit legs belonging to a paycheck event, with per-transaction gross attribution.';
